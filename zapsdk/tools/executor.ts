import { currentRuntimeObservation, observeRuntime } from "../runtime/observation.js";
import type { ToolResultGuard } from "./result-source-policy.js";
import type { CheckpointEditTracker } from "../checkpoint/types.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";
import { PartialObservations } from "./partial-observations.js";
import { earliestDeadlineAt, hasDeadlineExpired } from "../execution/deadline.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolRegistry } from "./registry.js";
import { resolveDefinitionEffects } from "./compatibility.js";
import type { ToolEffects } from "./effects.js";
import { resolveToolApprovalFacts, type ToolApprovalFacts } from "./approval.js";
import { adaptLegacyTool } from "./manifest.js";
import {
  DefaultToolPolicyEngine,
  type AgentIdentity,
  type CapabilityGrant,
  type PolicyDecision,
  type ToolPolicyEngine,
  type WorkspaceIdentity,
} from "../policy/index.js";
import { canonicalizeJsonSchema } from "./schema.js";
import {
  DefaultExecutionBroker,
  ExecutionBoundaryError,
  executionFailureResult,
  normalizeToolFailure,
  operationFailure,
  type ExecutionBroker,
  type ExecutionObservation,
  type OperationFailure,
  type ShellExecutionEnvironment,
} from "../execution/index.js";

/** Only literal true grants approval. Structured denials retain the host's
 * factual reason; legacy false deliberately does not imply a human decision. */
export interface ApprovalDenial {
  approved: false;
  source: "policy" | "approval";
  reason: string;
}
export type ApprovalResponse = boolean | ApprovalDenial;
/** Executor-owned path facts, separate from model-authored tool arguments.
 * These are host workspace paths; they do not describe a remote filesystem. */
export interface ApprovalContext {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly shell: Readonly<ShellExecutionEnvironment>;
  readonly authorization?: Readonly<ToolApprovalFacts>;
}
export type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context?: Readonly<ApprovalContext>,
) => Promise<ApprovalResponse>;

export type ApprovalLifecycleStatus =
  | "requested"
  | "approved"
  | "denied"
  | "cancelled"
  | "failed";

export interface ApprovalLifecycleEvent {
  approvalId: string;
  toolName: string;
  toolCallId?: string;
  sessionId?: string;
  step?: number;
  argumentsHash: string;
  status: ApprovalLifecycleStatus;
  timestamp: number;
  error?: string;
}

export type ApprovalLifecycleHandler = (
  event: ApprovalLifecycleEvent,
) => void | Promise<void>;

export type ToolExecutionLifecycleStatus =
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolExecutionLifecycleEvent {
  executionId: string;
  toolName: string;
  toolCallId?: string;
  sessionId?: string;
  step?: number;
  argumentsHash: string;
  status: ToolExecutionLifecycleStatus;
  timestamp: number;
  error?: string;
  failure?: OperationFailure;
  execution?: ExecutionObservation;
}

export type ToolExecutionLifecycleHandler = (
  event: ToolExecutionLifecycleEvent,
) => void | Promise<void>;

export type PostProcessCallback = (
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult
) => ToolResult | Promise<ToolResult>;

export interface ApprovalCoordinator {
  current: Promise<void>;
}

export interface ToolAuthorization {
  /** Stable Host identity for this approval, reused on replay. */
  serviceOperationNonce?: string;
  kind: "authorized";
  name: string;
  args: Record<string, unknown>;
  effects: ToolEffects;
  grant: CapabilityGrant;
  policy: Exclude<PolicyDecision, { decision: "deny" }>;
  context?: Readonly<ToolExecutionContext>;
  /** Internal resolved handler. Callers must treat the authorization as an
   * opaque, single-call value. */
  tool: Tool;
}

export function isToolAuthorization(
  value: ToolAuthorization | ToolResult,
): value is ToolAuthorization {
  return "kind" in value && value.kind === "authorized";
}

export interface ToolExecutorOptions {
  /** Fallback for tools without a declared timeout. To impose a hard host
   * ceiling, supply an executionBroker with explicit timeout limits. */
  timeoutMs?: number;
  /** Harness adds coverage requirements without weakening tool requirements. */
  checkpointMode?: "never" | "best-effort" | "before-destructive" | "before-write";
  /** Base cwd used while resolving relative effect paths. */
  cwd?: string;
  /** Central policy evaluator. Defaults to a legacy-compatible policy engine;
   * set askOnUnknownEffects on DefaultToolPolicyEngine for strict mode. */
  policyEngine?: ToolPolicyEngine;
  actor?: AgentIdentity;
  workspace?: Partial<WorkspaceIdentity>;
  executionBroker?: ExecutionBroker;
  interactive?: boolean;
  approvalCoordinator?: ApprovalCoordinator;
  onApproval?: ApprovalCallback;
  /** Durable runtime observer. Unlike onApproval, it never decides policy. */
  onApprovalLifecycle?: ApprovalLifecycleHandler;
  /** Durable execution boundary. `started` completes before handler effects. */
  onExecutionLifecycle?: ToolExecutionLifecycleHandler;
  /** Synchronous host admission after authorization, before lifecycle/handler.
   * Throwing can only prevent execution; it never grants permission. */
  admitExecution?: () => void;
  /**
   * Compatibility escape hatch for trusted embedders that intentionally run
   * confirm tools without an approval callback. Defaults to false so bare SDK
   * usage fails closed instead of silently executing writes or shell commands.
   */
  allowConfirmWithoutApproval?: boolean;
  postProcess?: PostProcessCallback;
  /** Final Host content scope, before events/history/model projection. */
  resultGuard?: ToolResultGuard;
  /**
   * Called just before a tool handler executes, with the paths the tool declares
   * it will write to (via ToolDefinition.writesPath). Checkpoint subsystem uses
   * this to record pre-edit backups. Errors are swallowed for best-effort
   * writes, but tools with checkpointRequirement="required" fail closed.
   * Return explicit coverage when any declared path can be skipped. Legacy
   * void callbacks attest coverage by resolving and must throw if unavailable.
   */
  onTrackEdit?: CheckpointEditTracker;
}

type WriteFingerprint = NonNullable<NonNullable<ToolResult["runtime"]>["writeEvidence"]>["paths"][number]["before"];

const WRITE_EVIDENCE_HASH_LIMIT_BYTES = 1024 * 1024;

async function fingerprintWritePath(path: string): Promise<WriteFingerprint> {
  try {
    const entry = await lstat(path);
    if (entry.isFile()) {
      const fingerprint: WriteFingerprint = {
        exists: true,
        kind: "file",
        size: entry.size,
      };
      if (entry.size <= WRITE_EVIDENCE_HASH_LIMIT_BYTES) {
        fingerprint.sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
      }
      return fingerprint;
    }
    return {
      exists: true,
      kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other",
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { exists: false };
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export class ToolExecutor {
  private registry: ToolRegistry;
  private _timeoutMs: number;
  private _onApproval?: ApprovalCallback;
  private _onApprovalLifecycle?: ApprovalLifecycleHandler;
  private _onExecutionLifecycle?: ToolExecutionLifecycleHandler;
  private _admitExecution?: () => void;
  private _allowConfirmWithoutApproval: boolean;
  private _postProcess?: PostProcessCallback;
  private readonly _resultGuard?: ToolResultGuard;
  private _onTrackEdit?: CheckpointEditTracker;
  private _checkpointMode: ToolExecutorOptions["checkpointMode"];
  private _cwd: string;
  private _policyEngine: ToolPolicyEngine;
  private _actor?: AgentIdentity;
  private _workspace: WorkspaceIdentity;
  private _executionBroker: ExecutionBroker;
  private _interactive: boolean;
  /** Serializes concurrent approval requests so UI only shows one at a time. */
  private approvalQueue: ApprovalCoordinator;

  constructor(
    registry: ToolRegistry,
    options: ToolExecutorOptions = {},
    approvalQueue?: ApprovalCoordinator,
  ) {
    this.registry = registry;
    this._checkpointMode = options.checkpointMode;
    this._timeoutMs = options.timeoutMs ?? 30_000;
    this._cwd = options.cwd ?? process.cwd();
    this._policyEngine = options.policyEngine ?? new DefaultToolPolicyEngine();
    this._actor = options.actor;
    this._executionBroker = options.executionBroker ?? new DefaultExecutionBroker();
    const sandboxStatus = this._executionBroker.sandboxStatus();
    this._workspace = {
      root: options.workspace?.root ?? this._cwd,
      id: options.workspace?.id,
      mode: options.workspace?.mode ?? "root",
      ...(options.workspace?.privateGitDirectory
        ? { privateGitDirectory: options.workspace.privateGitDirectory } : {}),
      sandbox: options.workspace?.sandbox
        ?? (sandboxStatus.available ? "enforced" : "none"),
    };
    this._interactive = options.interactive ?? Boolean(options.onApproval);
    this._onApproval = options.onApproval;
    this._onApprovalLifecycle = options.onApprovalLifecycle;
    this._onExecutionLifecycle = options.onExecutionLifecycle;
    this._admitExecution = options.admitExecution;
    this._allowConfirmWithoutApproval = options.allowConfirmWithoutApproval === true;
    this._postProcess = options.postProcess;
    this._resultGuard = options.resultGuard;
    this._onTrackEdit = options.onTrackEdit;
    this.approvalQueue = approvalQueue ?? options.approvalCoordinator ?? { current: Promise.resolve() };
  }

  /** Expose config for subagent tool creation */
  get checkpointMode(): ToolExecutorOptions["checkpointMode"] { return this._checkpointMode; }
  get timeoutMs(): number { return this._timeoutMs; }
  get onApproval(): ApprovalCallback | undefined { return this._onApproval; }
  get onApprovalLifecycle(): ApprovalLifecycleHandler | undefined { return this._onApprovalLifecycle; }
  get onExecutionLifecycle(): ToolExecutionLifecycleHandler | undefined { return this._onExecutionLifecycle; }
  get allowConfirmWithoutApproval(): boolean { return this._allowConfirmWithoutApproval; }
  get postProcess(): PostProcessCallback | undefined { return this._postProcess; }
  get resultGuard(): ToolResultGuard | undefined { return this._resultGuard; }

  withResultGuard(guard: ToolResultGuard): ToolExecutor {
    const existing = this._resultGuard;
    return this.clone(this.registry, { resultGuard: existing ? (name, args, result) => guard(name, args, existing(name, args, result)) : guard });
  }
  get onTrackEdit(): CheckpointEditTracker | undefined { return this._onTrackEdit; }
  get approvalCoordinator(): ApprovalCoordinator { return this.approvalQueue; }
  get policyEngine(): ToolPolicyEngine { return this._policyEngine; }
  get executionBroker(): ExecutionBroker { return this._executionBroker; }

  /** Clone while retaining lifecycle hooks, broker and the shared approval queue. */
  withRuntimePolicy(policyEngine: ToolPolicyEngine, checkpointMode: ToolExecutorOptions["checkpointMode"], requireApproval = false): ToolExecutor {
    return this.clone(this.registry, { policyEngine, checkpointMode, ...(requireApproval ? { allowConfirmWithoutApproval: false } : {}) });
  }

  private clone(registry: ToolRegistry, overrides: Partial<ToolExecutorOptions> = {}): ToolExecutor {
    return new ToolExecutor(registry, {
      timeoutMs: this._timeoutMs, checkpointMode: this._checkpointMode,
      cwd: this._cwd, policyEngine: this._policyEngine, actor: this._actor,
      workspace: this._workspace, executionBroker: this._executionBroker,
      interactive: this._interactive, onApproval: this._onApproval,
      onApprovalLifecycle: this._onApprovalLifecycle, onExecutionLifecycle: this._onExecutionLifecycle,
      admitExecution: this._admitExecution,
      allowConfirmWithoutApproval: this._allowConfirmWithoutApproval,
      postProcess: this._postProcess, resultGuard: this._resultGuard, onTrackEdit: this._onTrackEdit, ...overrides,
    }, this.approvalQueue);
  }

  /** Return an executor with the same policy callbacks but a different tool registry. */
  withRegistry(registry: ToolRegistry): ToolExecutor { return this.clone(registry); }

  /** Compose restrictive, synchronous admission without creating a started receipt. */
  withExecutionAdmission(admit: () => void): ToolExecutor {
    const existing = this._admitExecution;
    return this.clone(this.registry, { admitExecution: () => { existing?.(); admit(); } });
  }

  /** Clone this executor while composing a runtime lifecycle observer. */
  withApprovalLifecycle(observer: ApprovalLifecycleHandler): ToolExecutor {
    const existing = this._onApprovalLifecycle;
    return new ToolExecutor(this.registry, {
      timeoutMs: this._timeoutMs,
      checkpointMode: this._checkpointMode,
      cwd: this._cwd,
      policyEngine: this._policyEngine,
      actor: this._actor,
      workspace: this._workspace,
      executionBroker: this._executionBroker,
      interactive: this._interactive,
      onApproval: this._onApproval,
      onApprovalLifecycle: async (event) => {
        await existing?.(event);
        await observer(event);
      },
      onExecutionLifecycle: this._onExecutionLifecycle,
      admitExecution: this._admitExecution,
      allowConfirmWithoutApproval: this._allowConfirmWithoutApproval,
      postProcess: this._postProcess, resultGuard: this._resultGuard,
      onTrackEdit: this._onTrackEdit,
    }, this.approvalQueue);
  }

  /** Clone this executor while composing a durable tool execution observer. */
  withExecutionLifecycle(observer: ToolExecutionLifecycleHandler): ToolExecutor {
    const existing = this._onExecutionLifecycle;
    return new ToolExecutor(this.registry, {
      timeoutMs: this._timeoutMs,
      checkpointMode: this._checkpointMode,
      cwd: this._cwd,
      policyEngine: this._policyEngine,
      actor: this._actor,
      workspace: this._workspace,
      executionBroker: this._executionBroker,
      interactive: this._interactive,
      onApproval: this._onApproval,
      onApprovalLifecycle: this._onApprovalLifecycle,
      onExecutionLifecycle: async (event) => {
        await existing?.(event);
        await observer(event);
      },
      admitExecution: this._admitExecution,
      allowConfirmWithoutApproval: this._allowConfirmWithoutApproval,
      postProcess: this._postProcess, resultGuard: this._resultGuard,
      onTrackEdit: this._onTrackEdit,
    }, this.approvalQueue);
  }

  private guardResult(name: string, parsedArgs: Record<string, unknown>, value: ToolResult): ToolResult {
    if (!this._resultGuard) return value;
    try { return this._resultGuard(name, parsedArgs, value); }
    catch {
      return { success: false, output: "", error: "Tool result withheld because the Host result guard failed.",
        failure: operationFailure("POLICY_DENIED", "policy"),
        runtime: { execution: value.runtime?.execution, command: value.runtime?.command,
          service: value.runtime?.service, serviceOperation: value.runtime?.serviceOperation } };
    }
  }

  /** Whether this call is safe to schedule as read-only. Unknown tools and
   *  calls that don't explicitly opt in are treated as mutating. */
  isReadOnly(name: string, args: Record<string, unknown> = {}): boolean {
    const effects = this.resolveEffects(name, args);
    return effects.confidence !== "unknown" &&
      effects.filesystem.every((effect) => effect.operation === "read") &&
      effects.network.every((effect) => effect.operation === "connect") &&
      effects.process.length === 0 &&
      effects.external.every((effect) => effect.operation === "read") &&
      !["isolated-write", "root-integration"].includes(effects.workspace.mode);
  }

  resolveEffects(name: string, args: Record<string, unknown> = {}): ToolEffects {
    const known = this.registry.resolveName(name);
    return resolveDefinitionEffects(known ? this.registry.get(known)?.definition : undefined, args, this._cwd);
  }

  authorize(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: Readonly<ToolExecutionContext>,
  ): ToolAuthorization | ToolResult | Promise<ToolAuthorization | ToolResult> {
    // A near-miss spelling is repaired; everything downstream sees the real name.
    const repaired = this.registry.resolveName(name);
    const tool = repaired ? this.registry.get(repaired) : undefined;
    if (repaired) name = repaired;
    if (!tool) {
      return { success: false, output: "", error: `Tool "${name}" not found`,
        failure: operationFailure("TOOL_NOT_FOUND", "executor", context?.toolCallId) };
    }

    if (signal?.aborted) {
      return { success: false, output: "", error: "aborted",
        failure: operationFailure("CANCELLED", "executor", context?.toolCallId) };
    }

    if (hasDeadlineExpired(context?.deadlineAtMs)) {
      return { success: false, output: "", error: `Tool "${name}" execution deadline expired`,
        failure: operationFailure("DEADLINE_EXCEEDED", "executor", context?.toolCallId) };
    }

    const parsed = tool.definition.parameters.safeParse(args);
    if (!parsed.success) {
      return {
        success: false,
        output: "",
        error: `Invalid arguments: ${parsed.error.message}`,
        failure: operationFailure("INVALID_ARGUMENTS", "executor", context?.toolCallId),
      };
    }
    const parsedArgs = parsed.data as Record<string, unknown>;

    const effects = this.resolveEffects(name, parsedArgs);
    const manifest = adaptLegacyTool(tool, this._cwd);
    const callId = context?.toolCallId ?? `direct:${name}:${Date.now()}`;
    let evaluated: PolicyDecision | Promise<PolicyDecision>;
    try {
      evaluated = this._policyEngine.evaluate({
        call: {
          id: callId,
          name,
          arguments: parsedArgs,
          sourceStep: context?.step,
        },
        toolId: manifest.id,
        source: manifest.source,
        definition: tool.definition,
        effects,
        actor: this._actor,
        workspace: this._workspace,
        interactive: this._interactive,
      });
    } catch (err) {
      return this.policyFailure(name, err);
    }
    if (evaluated instanceof Promise) {
      return evaluated
        .then((policy) => this.finishAuthorization(tool, name, parsedArgs, effects, policy, signal, context))
        .catch((err) => this.policyFailure(name, err));
    }
    return this.finishAuthorization(tool, name, parsedArgs, effects, evaluated, signal, context);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: Readonly<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const pending = this.authorize(name, args, signal, context);
    const authorization = pending instanceof Promise ? await pending : pending;
    if (!isToolAuthorization(authorization)) return authorization;
    return this.executeAuthorized(authorization, signal);
  }

  async executeAuthorized(
    authorization: ToolAuthorization,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const { name, args: parsedArgs, grant, context } = authorization;
    if (signal?.aborted) {
      return { success: false, output: "", error: "aborted",
        failure: operationFailure("CANCELLED", "executor", context?.toolCallId) };
    }
    if (hasDeadlineExpired(context?.deadlineAtMs)) {
      return { success: false, output: "", error: `Tool "${name}" execution deadline expired`,
        failure: operationFailure("DEADLINE_EXCEEDED", "executor", context?.toolCallId) };
    }
    if (grant.expiresAt < Date.now()) {
      return { success: false, output: "", error: `Tool "${name}" authorization expired`,
        failure: operationFailure("POLICY_DENIED", "executor", context?.toolCallId) };
    }

    this._admitExecution?.();

    const executionId = context?.toolCallId
      ? `execution:${context.toolCallId}`
      : `execution:${randomUUID()}`;
    const argumentsHash = hashArguments(parsedArgs);
    const observation = currentRuntimeObservation();
    const executionSpanId = observation ? randomUUID() : "";
    const notify = async (
      status: ToolExecutionLifecycleStatus,
      error?: string,
      result?: ToolResult,
    ): Promise<void> => {
      const event: ToolExecutionLifecycleEvent = {
        executionId,
        toolName: name,
        toolCallId: context?.toolCallId,
        sessionId: context?.sessionId,
        step: context?.step,
        argumentsHash,
        status,
        timestamp: Date.now(),
        error,
        ...(result?.failure ? { failure: result.failure } : {}),
        ...(result?.runtime?.execution ? { execution: result.runtime.execution } : {}),
      };
      await this._onExecutionLifecycle?.(event);
      if (observation) observeRuntime({ kind: "tool_execution", scope: observation.scope, executionSpanId, event }, observation);
    };
    if (this._onExecutionLifecycle || observation) await notify("started");
    const result = await this.executeAuthorizedInner(authorization, executionId, signal);
    if (this._onExecutionLifecycle || observation) {
      await notify(
        result.success ? "completed" : result.failure?.code === "CANCELLED" ? "cancelled" : "failed",
        result.error,
        result,
      );
    }
    return result;
  }

  private async executeAuthorizedInner(
    authorization: ToolAuthorization,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const { tool, name, args: parsedArgs, effects, grant, policy, context } = authorization;

    const effectiveTimeout = tool.definition.resolveTimeoutMs?.(parsedArgs)
      ?? tool.definition.timeoutMs ?? tool.definition.limits?.timeoutMs ?? this.timeoutMs;
    const toolDeadlineAtMs = Date.now() + effectiveTimeout;
    const deadlineAtMs = earliestDeadlineAt(context?.deadlineAtMs, toolDeadlineAtMs);
    const executionAbort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    let checkpoint: NonNullable<ToolResult["runtime"]>["checkpoint"] | undefined;
    let brokerObservation: ExecutionObservation | undefined;
    let serviceEvidence: Pick<NonNullable<ToolResult["runtime"]>, "service" | "serviceOperation"> = {};
    const observations = new PartialObservations();
    if (tool.definition.limits?.maxOutputBytes !== undefined) observations.limit(tool.definition.limits.maxOutputBytes);
    try {
      if (hasDeadlineExpired(deadlineAtMs)) {
        throw new ExecutionBoundaryError(`Tool "${name}" execution deadline expired`,
          operationFailure("DEADLINE_EXCEEDED", "executor"));
      }
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            abortListener = () => {
              reject(new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "executor")));
              executionAbort.abort(signal.reason);
            };
            signal.addEventListener("abort", abortListener, { once: true });
          })
        : undefined;

      if (signal?.aborted) {
        executionAbort.abort(signal.reason);
        throw new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "executor"));
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new ExecutionBoundaryError(deadlineAtMs! < toolDeadlineAtMs
              ? `Tool "${name}" exceeded its execution deadline`
              : `Tool "${name}" timed out after ${effectiveTimeout}ms`,
              operationFailure("DEADLINE_EXCEEDED", "executor"));
            reject(error);
            executionAbort.abort(error);
          },
          Math.max(0, deadlineAtMs! - Date.now())
        );
      });

      const guardPromises = abortPromise
        ? [timeoutPromise, abortPromise]
        : [timeoutPromise];

      // Checkpoint: track pre-edit content of paths the tool will modify.
      // This shares the same timeout/abort guard as the handler; otherwise a
      // hung checkpoint backup can wedge the whole tool call before execution
      // even starts.
      const effectWritePaths = effects.filesystem
        .filter((effect) => effect.operation !== "read")
        .flatMap((effect) => effect.paths);
      let legacyWritePaths: string[] = [];
      if (tool.definition.writesPath) {
        try {
          legacyWritePaths = tool.definition.writesPath(parsedArgs) ?? [];
        } catch {
          // Effect resolution already downgraded the call when this failed.
        }
      }
      // Cover both declarations, deduplicated by absolute path. Retain the
      // legacy spelling for hosts that expect relative checkpoint paths.
      const declaredWrites = new Map<string, string>();
      for (const path of [...legacyWritePaths, ...effectWritePaths]) {
        const absolutePath = resolve(this._cwd, path);
        if (!declaredWrites.has(absolutePath)) declaredWrites.set(absolutePath, path);
      }
      const writePaths = [...declaredWrites.values()];
      const requiresCheckpoint = tool.definition.checkpointRequirement === "required"
        || (this._checkpointMode === "before-write" && writePaths.length > 0)
        || (this._checkpointMode === "before-destructive" && effects.filesystem.some((effect) => effect.operation === "delete"));
      const evidencePaths = [...declaredWrites.keys()];
      const writeEvidenceBefore = evidencePaths.length === 0
        ? []
        : await Promise.all(evidencePaths.map(async (path) => ({
          path,
          before: await fingerprintWritePath(path),
        })));
      const supportsCheckpoint = tool.definition.checkpointTracking !== "unsupported";
      // Optional native undo follows lexical files (and skips links). Strict
      // coverage must retain the complete declared union, including any Host
      // augmentation; an exact-file hint cannot narrow an explicit gate.
      const trackedPaths = !requiresCheckpoint && tool.definition.checkpointTracking === "files" ? legacyWritePaths : writePaths;
      let trackingEnabled = true;
      try { trackingEnabled = this._onTrackEdit?.describeCoverage?.().enabled !== false; } catch { /* Unknown is not a grant. */ }
      if (!supportsCheckpoint && requiresCheckpoint) checkpoint = { attempted: false, covered: false, error: "This process tool does not expose exact files for checkpoint coverage" };
      if (supportsCheckpoint && trackedPaths.length > 0 && (trackingEnabled || requiresCheckpoint) && (this._checkpointMode !== "never" || requiresCheckpoint)) {
        checkpoint = this._onTrackEdit
          ? { attempted: true, covered: false }
          : { attempted: false, covered: false, error: "checkpoint hook is not configured" };
      }
      if (supportsCheckpoint && this._onTrackEdit && trackedPaths.length > 0 && (trackingEnabled || requiresCheckpoint) && (this._checkpointMode !== "never" || requiresCheckpoint)) {
        try {
          const coverage = await Promise.race([
            this._onTrackEdit(trackedPaths, { required: requiresCheckpoint }),
            ...guardPromises,
          ]);
          checkpoint = coverage === undefined || coverage.covered
            ? { attempted: true, covered: true }
            : {
                attempted: true,
                covered: false,
                error: `Checkpoint coverage is missing for declared paths: ${coverage.uncoveredPaths.join(", ") || "unspecified"}`,
              };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ExecutionBoundaryError
            && ["CANCELLED", "DEADLINE_EXCEEDED"].includes(err.failure.code)) throw err;
          checkpoint = { attempted: true, covered: false, error: message };
          // Checkpoint failures do not block the legacy handler, but coverage
          // is now visible in the result so the UI cannot imply safe rewind.
        }
      }

      if (requiresCheckpoint && !checkpoint?.covered) {
        return {
          success: false,
          output: "",
          error: `Tool "${name}" requires a checkpoint before modifying files; no handler was executed. ` +
            `Coverage failed: ${checkpoint?.error ?? "checkpoint coverage is unavailable"}. ` +
            `For temporary diagnostics, use an authorized path inside the workspace (${this._cwd}); ` +
            "other paths require checkpoint coverage from the host.",
          failure: operationFailure("CHECKPOINT_REQUIRED", "checkpoint", executionId),
          runtime: {
            effects,
            policy: { decision: policy.decision, reason: policy.reason },
            checkpoint,
            writeEvidence: {
              paths: await Promise.all(writeEvidenceBefore.map(async ({ path, before }) => ({
                path,
                before,
                after: await fingerprintWritePath(path),
              }))),
            },
          },
        };
      }

      if (signal?.aborted) {
        executionAbort.abort(signal.reason);
        throw new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "executor"));
      }

      if (hasDeadlineExpired(deadlineAtMs)) {
        throw new ExecutionBoundaryError(`Tool "${name}" execution deadline expired before dispatch`,
          operationFailure("DEADLINE_EXCEEDED", "executor"));
      }
      const raceTargets: Promise<ToolResult>[] = [
        this._executionBroker.execute({
          executionId,
          serviceOperationNonce: authorization.serviceOperationNonce,
          onServiceObservation: value => { serviceEvidence = value; },
          tool,
          name,
          args: parsedArgs,
          effects,
          grant,
          workspace: this._workspace,
          context: { ...context, observations, deadlineAtMs },
          limits: {
            ...tool.definition.limits,
            timeoutMs: effectiveTimeout,
          },
        }, executionAbort.signal),
        ...guardPromises,
      ];

      let result = await Promise.race(raceTargets);
      brokerObservation = result.runtime?.execution;
      serviceEvidence = { ...(result.runtime?.service ? { service: result.runtime.service } : {}),
        ...(result.runtime?.serviceOperation ? { serviceOperation: result.runtime.serviceOperation } : {}) };
      result = this.guardResult(name, parsedArgs, result);
      if (serviceEvidence.service || serviceEvidence.serviceOperation) result.runtime = { ...result.runtime, ...serviceEvidence };
      // A Host denial is terminal for this result. Do not let a formatter,
      // its exception or retained partial output restore a withheld body.
      if (this._resultGuard && result.failure?.code === "POLICY_DENIED") {
        return normalizeToolFailure(result, executionId);
      }
      if (this.postProcess) {
        const brokerFailure = result.failure;
        const commandReceipt = result.runtime?.command;
        result = await Promise.race([
          this.postProcess(name, parsedArgs, result),
          ...guardPromises,
        ]);
        // A formatter may replace ToolResult, but cannot erase host audit.
        result = { ...result,
          ...(!result.success && brokerFailure && !result.failure ? { failure: brokerFailure } : {}),
          ...((brokerObservation || commandReceipt) ? { runtime: { ...result.runtime, ...(brokerObservation ? { execution: brokerObservation } : {}), ...(commandReceipt ? { command: commandReceipt } : {}) } } : {}),
        };
      }
      const { service: _service, serviceOperation: _operation, ...formattedRuntime } = result.runtime ?? {};
      result.runtime = {
        ...formattedRuntime,
        ...serviceEvidence,
        effects,
        policy: { decision: policy.decision, reason: policy.reason },
        ...(checkpoint ? { checkpoint } : {}),
      };
      if (writeEvidenceBefore.length > 0) {
        result.runtime = {
          ...result.runtime,
          writeEvidence: {
            paths: await Promise.all(writeEvidenceBefore.map(async ({ path, before }) => ({
              path,
              before,
              after: await fingerprintWritePath(path),
            }))),
          },
        };
      }
      // Recheck formatter additions before any result leaves the executor.
      return normalizeToolFailure(this.guardResult(name, parsedArgs, observations.retain(normalizeToolFailure(result, executionId))), executionId);
    } catch (err) {
      return this.guardResult(name, parsedArgs, observations.retain({ ...executionFailureResult(err, executionId),
        runtime: { effects, ...serviceEvidence, ...(brokerObservation ? { execution: brokerObservation } : {}) },
      }));
    } finally {
      observations.close();
      if (timer) clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private finishAuthorization(
    tool: Tool,
    name: string,
    parsedArgs: Record<string, unknown>,
    effects: ToolEffects,
    policy: PolicyDecision,
    signal?: AbortSignal,
    context?: Readonly<ToolExecutionContext>,
  ): ToolAuthorization | ToolResult | Promise<ToolAuthorization | ToolResult> {
    if (policy.decision === "deny") {
      return {
        success: false,
        output: "",
        error: `Tool "${name}" execution denied by permission policy: ${policy.reason}`,
        failure: operationFailure("POLICY_DENIED", "policy", context?.toolCallId),
      };
    }
    const grant = policy.decision === "allow" ? policy.grant : policy.request.proposedGrant;
    const authorized = (): ToolAuthorization => ({
      kind: "authorized",
      ...(tool.definition.serviceOperation ? { serviceOperationNonce: randomUUID() } : {}),
      name,
      args: parsedArgs,
      effects,
      grant,
      policy,
      context,
      tool,
    });
    if (policy.decision !== "ask") return authorized();
    if (!this.onApproval) {
      return this._allowConfirmWithoutApproval
        ? authorized()
        : {
            success: false,
            output: "",
            error: `Tool "${name}" requires approval but no approval callback is configured`,
            failure: operationFailure("APPROVAL_REQUIRED", "approval", context?.toolCallId),
          };
    }
    return this.requestApproval(tool, name, parsedArgs, effects, signal, context).then((result) => (
      result === true ? authorized() : result
    ));
  }

  private async requestApproval(
    tool: Tool,
    name: string,
    parsedArgs: Record<string, unknown>,
    effects: ToolEffects,
    signal?: AbortSignal,
    context?: Readonly<ToolExecutionContext>,
  ): Promise<true | ToolResult> {
    const onApproval = this.onApproval!;
    let shell: ShellExecutionEnvironment = { syntax: "unknown", filesystem: "unknown" };
    try {
      shell = this._executionBroker.shellEnvironment?.({ name, executionLocation: tool.definition.executionLocation }) ?? shell;
    } catch { /* Unavailable facts do not imply a host filesystem. */ }
    const approvalContext = Object.freeze({
      cwd: this._cwd, workspaceRoot: this._workspace.root, shell: Object.freeze({ ...shell }),
      authorization: resolveToolApprovalFacts(tool.definition, parsedArgs, effects),
    });
    const approvalId = context?.toolCallId
      ? `approval:${context.toolCallId}`
      : `approval:${randomUUID()}`;
    const argumentsHash = hashArguments(parsedArgs);
    const observation = currentRuntimeObservation();
    const approvalOccurrence = observation ? randomUUID() : "";
    const notify = async (
      status: ApprovalLifecycleStatus,
      error?: string,
    ): Promise<void> => {
      const event: ApprovalLifecycleEvent = {
        approvalId,
        toolName: name,
        toolCallId: context?.toolCallId,
        sessionId: context?.sessionId,
        step: context?.step,
        argumentsHash,
        status,
        timestamp: Date.now(),
        error,
      };
      await this._onApprovalLifecycle?.(event);
      if (observation) observeRuntime({ kind: "approval", scope: observation.scope, approvalOccurrence, event }, observation);
    };
    let abortListener: (() => void) | undefined;
    try {
      // Lifecycle observers may release/reacquire Agent capacity. Never hold
      // the shared approval queue while awaiting them: other Agents need to
      // reach approval to release their own capacity.
      await notify("requested");
      const previousApproval = this.approvalQueue.current.catch(() => undefined);
      const approval = previousApproval.then(() => {
        if (signal?.aborted) throw new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "approval"));
        return onApproval(name, parsedArgs, signal, approvalContext);
      });
      const approvalOrAbort = signal
        ? Promise.race([
            approval,
            new Promise<boolean>((_, reject) => {
              abortListener = () => reject(new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "approval")));
              signal.addEventListener("abort", abortListener, { once: true });
              if (signal.aborted) abortListener();
            }),
          ])
        : approval;
      approval.catch(() => undefined);
      this.approvalQueue.current = previousApproval
        .then(() => approvalOrAbort)
        .then(() => undefined, () => undefined);
      const response = await approvalOrAbort;
      const approved = response === true;
      const denial = response && typeof response === "object" && response.approved === false
        && (response.source === "policy" || response.source === "approval")
        && typeof response.reason === "string" ? response : undefined;
      const reason = denial?.reason ?? "approval not granted";
      await notify(approved ? "approved" : "denied", approved ? undefined : reason);
      return approved ? true : { success: false, output: "",
        error: `Tool "${name}" denied: ${reason}`,
        failure: operationFailure("POLICY_DENIED", denial?.source ?? "approval", approvalId) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = signal?.aborted || (err instanceof ExecutionBoundaryError && err.failure.code === "CANCELLED");
      // A failed observer must not turn cleanup into an unhandled rejection.
      try { await notify(cancelled ? "cancelled" : "failed", message); } catch {}
      return cancelled
        ? executionFailureResult(new ExecutionBoundaryError(message, operationFailure("CANCELLED", "approval")), approvalId)
        : { success: false, output: "", error: `Tool "${name}" approval failed: ${message}`,
            failure: operationFailure("EXECUTION_FAILED", "approval", approvalId) };
    } finally {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  private policyFailure(name: string, err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: "",
      error: `Tool "${name}" policy evaluation failed: ${message}`,
      failure: operationFailure("EXECUTION_FAILED", "policy"),
    };
  }
}

function hashArguments(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonSchema(args)))
    .digest("hex");
}

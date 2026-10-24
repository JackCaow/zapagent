import { ServiceExecutionHost, type AuthorizedServiceBackend } from "../services/execution.js";
import { serviceEffects } from "../services/tools.js";
import { executionDigest } from "./observation.js";
import { lstatSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { DEFAULT_TOOL_RESOURCE_LIMITS, type ToolResourceLimits } from "../tools/effects.js";
import type { ToolResult } from "../tools/types.js";
import { createPlatformSandbox } from "./sandbox.js";
import { DefaultExecutionProcessBroker } from "./process.js";
import { earliestDeadlineAt, hasDeadlineExpired } from "./deadline.js";
import { ExecutionBoundaryError, executionFailureResult, normalizeToolFailure, operationFailure } from "./failure.js";
import { observeLegacyExecution, type ExecutionObservationProgress } from "./observation.js";
import type { EnforcementReceipt, OperationFailureCode } from "./contracts.js";
import type {
  ExecutionBroker,
  ExecutionBrokerRequest,
  ExecutionProcessBroker,
  ExecutionResourceBudget,
  ExecutionResourceUsage,
  OsSandbox,
  SandboxExecutionContext,
  SandboxMode,
  SandboxStatus,
  ShellExecutionEnvironment,
} from "./types.js";

export interface DefaultExecutionBrokerOptions {
  /** Host-selected independent owner. No owner or process fallback is created. */
  services?: AuthorizedServiceBackend;
  /** Required to describe a custom process launcher; omission stays unknown. */
  shellEnvironment?: ShellExecutionEnvironment;
  sandbox?: OsSandbox;
  sandboxMode?: SandboxMode;
  /** Honor per-call unsandboxed process requests. Defaults to true; callers
   * must still obtain approval before the request reaches the broker. */
  allowUnsandboxed?: boolean;
  /** Explicit host ceilings. An omitted timeout uses the SDK fallback, which
   * a trusted tool's declared timeout may override. */
  limits?: Partial<ToolResourceLimits>;
  /** Override the broker-owned process launcher while retaining capability,
   * resource, timeout, and audit enforcement. Runtime adapters such as zapVM
   * use this seam to move process execution across a VM boundary without
   * teaching individual tools about the transport. */
  processBrokerFactory?: (input: {
    request: Readonly<ExecutionBrokerRequest>;
    sandbox?: SandboxExecutionContext;
    signal: AbortSignal;
    limits: Readonly<ToolResourceLimits>;
  }) => ExecutionProcessBroker;
}

export class DefaultExecutionBroker implements ExecutionBroker {
  private readonly services?: ServiceExecutionHost;
  private readonly shellFacts: ShellExecutionEnvironment;
  private readonly sandbox: OsSandbox;
  private readonly sandboxMode: SandboxMode;
  private readonly allowUnsandboxed: boolean;
  private readonly limits: ToolResourceLimits;
  private readonly hardTimeout: boolean;
  private readonly processBrokerFactory?: DefaultExecutionBrokerOptions["processBrokerFactory"];

  constructor(options: DefaultExecutionBrokerOptions = {}) {
    if (options.services && options.processBrokerFactory) throw new Error("Service ownership must be implemented by the selected backend, not a local process fallback");
    this.services = options.services ? new ServiceExecutionHost(options.services) : undefined;
    this.shellFacts = options.shellEnvironment ?? (options.processBrokerFactory
      ? { syntax: "unknown", filesystem: "unknown" }
      : { syntax: process.platform === "win32" ? "cmd" : "posix", filesystem: "host" });
    this.sandbox = options.sandbox ?? createPlatformSandbox();
    this.sandboxMode = options.sandboxMode ?? "disabled";
    this.allowUnsandboxed = options.allowUnsandboxed !== false;
    this.limits = configureLimits(DEFAULT_TOOL_RESOURCE_LIMITS, options.limits);
    this.hardTimeout = options.limits?.timeoutMs !== undefined;
    this.processBrokerFactory = options.processBrokerFactory;
  }

  serviceCapabilities(workspace: ExecutionBrokerRequest["workspace"]) { return this.services?.capabilities(workspace); }

  shellEnvironment(): ShellExecutionEnvironment { return { ...this.shellFacts }; }

  sandboxStatus(): SandboxStatus {
    if (this.sandboxMode === "disabled") {
      return { provider: "none", available: false, reason: "OS sandbox is disabled" };
    }
    return this.sandbox.status();
  }

  async execute(request: ExecutionBrokerRequest, signal?: AbortSignal): Promise<ToolResult> {
    let limits: ToolResourceLimits;
    try {
      configureLimits(this.limits, request.limits);
      limits = mergeLimits(this.limits, request.limits);
      if (!this.hardTimeout && request.limits?.timeoutMs !== undefined) {
        limits.timeoutMs = request.limits.timeoutMs;
      }
    } catch (error) {
      return { ...executionFailureResult(error, request.executionId),
        failure: operationFailure("RESOURCE_LIMIT", "broker", request.executionId),
        runtime: { execution: observeLegacyExecution(request, undefined, this.sandboxMode, this.limits)("rejected") },
      };
    }
    const progress: ExecutionObservationProgress = {};
    let serviceEvidence: Pick<NonNullable<ToolResult["runtime"]>, "service" | "serviceOperation"> | undefined;
    let sandboxStatus: SandboxStatus;
    try {
      sandboxStatus = this.sandboxStatus();
    } catch (error) {
      return { ...executionFailureResult(error, request.executionId),
        failure: operationFailure("BACKEND_UNAVAILABLE", "backend", request.executionId),
        runtime: { execution: observeLegacyExecution(request, undefined, this.sandboxMode, limits)("rejected") },
      };
    }
    const observe = observeLegacyExecution(request, sandboxStatus, this.sandboxMode, limits);
    let sandbox: SandboxExecutionContext | undefined;
    let processBroker: ExecutionProcessBroker | undefined;
    const budget = new DefaultExecutionResourceBudget(limits);
    const finish = (result: ToolResult, outcome: EnforcementReceipt["outcome"]): ToolResult => {
      const denials = processBroker?.networkDenials?.slice(0, 16) ?? [];
      if (denials.length) {
        result = { ...result,
          output: `${result.output}\n[Sandbox network refusals] ${JSON.stringify(denials)}\nThe proxy refused these destinations. Resolve the network policy or request authorization before retrying; a zero shell exit does not prove all requests succeeded.`,
          ...(!result.success && !result.runtime?.command?.timedOut && !result.runtime?.command?.aborted
            && (!result.failure || result.failure.source === "unknown") ? { failure: {
            ...operationFailure("SANDBOX_DENIED", "backend", request.executionId),
            missingCapabilities: denials.map(item => `network:${item.host}`),
            safeAlternatives: ["Ask the user to authorize the required destination in sandboxNetwork.allowedDomains, or an approved unsandboxed command."],
          } } : {}),
        };
      }
      const normalized = normalizeToolFailure(result, request.executionId);
      // Ordinary handlers cannot manufacture service-owner evidence.
      const { service: _service, serviceOperation: _operation, ...runtime } = normalized.runtime ?? {};
      const usage = budget.usage;
      return { ...normalized, runtime: {
        ...runtime, ...serviceEvidence,
        ...(denials.length ? { networkDenials: denials } : {}),
        ...(this.sandboxMode !== "disabled" ? { broker: {
          executionId: request.executionId,
          sandbox: sandbox?.provider ?? "none",
          sandboxEnforced: sandbox?.enforced === true && !!processBroker?.spawnCount
            && processBroker.sandboxedSpawnCount === processBroker.spawnCount,
          resources: usage,
        } } : {}),
        execution: observe(outcome, { ...progress,
          spawnedProcesses: processBroker?.spawnCount,
          sandboxedProcesses: processBroker?.sandboxedSpawnCount,
          sandboxUsed: !!processBroker?.sandboxedSpawnCount,
          metersUsed: Object.values(usage).some((value) => value > 0),
        }),
      } };
    };
    const reject = (message: string, code: OperationFailureCode): ToolResult => finish({
      ...brokerFailure(message), failure: operationFailure(code, "broker", request.executionId),
    }, "rejected");
    const brokerDeadlineAtMs = Date.now() + limits.timeoutMs;
    const deadlineAtMs = earliestDeadlineAt(request.context?.deadlineAtMs, brokerDeadlineAtMs);
    if (hasDeadlineExpired(deadlineAtMs)) return reject("tool execution deadline expired", "DEADLINE_EXCEEDED");
    const inputBytes = Buffer.byteLength(JSON.stringify(request.args), "utf8");
    progress.inputChecked = true;
    if (inputBytes > limits.maxInputBytes) {
      return reject(`tool input exceeds broker limit (${inputBytes} > ${limits.maxInputBytes} bytes)`, "RESOURCE_LIMIT");
    }
    const grantError = validateExecutionGrant(request);
    progress.grantChecked = true;
    if (grantError) return reject(grantError, "POLICY_DENIED");
    const resourceError = validateDeclaredResources(request, limits);
    if (resourceError) return reject(resourceError, "RESOURCE_LIMIT");

    const serviceOperation = request.tool.definition.serviceOperation;
    if (serviceOperation) {
      const cap = this.serviceCapabilities(request.workspace);
      if (request.context?.toolCallId && request.grant.callId !== request.context.toolCallId) return reject("Service grant belongs to a different tool call", "POLICY_DENIED");
      if (!cap || request.tool.definition.executionLocation !== "workspace") return reject("Selected backend has no service owner for this workspace", "CAPABILITY_UNSUPPORTED");
      try {
        if (request.name !== `service_${serviceOperation}` || executionDigest(request.effects) !== executionDigest(serviceEffects(serviceOperation, cap, request.workspace, request.args))) {
          return reject("Service effects do not match the authorized operation", "POLICY_DENIED");
        }
      } catch { return reject("Malformed service operation", "INVALID_ARGUMENTS"); }
    }
    const needsProcessSandbox = !serviceOperation && request.effects.process.length > 0;
    const unsandboxed = needsProcessSandbox && request.effects.process.some((effect) => effect.unsandboxed === true);
    if (unsandboxed && !this.allowUnsandboxed) {
      return reject("unsandboxed execution is disabled by host policy", "POLICY_DENIED");
    }
    if (needsProcessSandbox && !request.tool.definition.sandboxAware) {
      return reject(`process tool ${request.name} is not sandbox-aware`, "CAPABILITY_UNSUPPORTED");
    }
    if (needsProcessSandbox && !unsandboxed && this.sandboxMode === "required" && !sandboxStatus.available) {
      return finish({ ...brokerFailure(`OS sandbox required but unavailable: ${sandboxStatus.reason ?? "unknown reason"}`),
        failure: operationFailure("BACKEND_UNAVAILABLE", "backend", request.executionId),
      }, "rejected");
    }

    const executionAbort = new AbortController();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const onAbort = () => {
      const error = new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "broker"));
      rejectAbort?.(error);
      executionAbort.abort(signal?.reason);
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (signal?.aborted) return reject("aborted", "CANCELLED");
      sandbox = needsProcessSandbox && !unsandboxed && sandboxStatus.available
        ? this.sandbox.createContext({ executionId: request.executionId,
            workspace: request.workspace, effects: request.effects, grant: request.grant,
            externalCliIntegration: request.tool.definition.name === "delegate_agent"
              && request.tool.definition.executionLocation === "host"
              && request.workspace.mode !== "shared-readonly"
              && request.effects.workspace.mode === "root-integration"
              && request.effects.process.some(effect => effect.commandClass === "external-cli") })
        : undefined;
      processBroker = needsProcessSandbox
        ? this.processBrokerFactory?.({ request, sandbox, signal: executionAbort.signal, limits })
          ?? new DefaultExecutionProcessBroker(sandbox, executionAbort.signal)
        : undefined;
      if (signal?.aborted) {
        executionAbort.abort(signal.reason);
        return reject("aborted", "CANCELLED");
      }
      const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new ExecutionBoundaryError(deadlineAtMs! < brokerDeadlineAtMs
            ? "tool execution exceeded its context deadline"
            : `tool execution exceeded broker timeout (${limits.timeoutMs}ms)`,
            operationFailure("DEADLINE_EXCEEDED", "broker"));
          reject(error);
          executionAbort.abort(error);
        }, Math.max(0, deadlineAtMs! - Date.now()));
      });
      progress.deadlineInstalled = true;
      request.context?.observations?.limit(limits.maxOutputBytes);
      const invoke = async () => {
        if (processBroker?.ensureReady) await processBroker.ensureReady();
        if (executionAbort.signal.aborted) {
          throw new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "broker"));
        }
        if (hasDeadlineExpired(deadlineAtMs)) {
          throw new ExecutionBoundaryError("tool execution deadline expired before handler invocation",
            operationFailure("DEADLINE_EXCEEDED", "broker"));
        }
        if (serviceOperation) return this.services!.execute(serviceOperation, {
          ...request, context: { ...request.context, deadlineAtMs },
          onServiceObservation: value => { serviceEvidence = value; request.onServiceObservation?.(value); },
        }, limits, this.sandboxMode, executionAbort.signal);
        return request.tool.handler(request.args, executionAbort.signal, {
          ...request.context,
          toolCallId: request.context?.toolCallId ?? request.grant.callId,
          deadlineAtMs,
          executionId: request.executionId,
          effects: request.effects,
          grant: request.grant,
          process: processBroker,
          limits,
          resources: budget,
        });
      };
      const result = await Promise.race([invoke(), timeoutPromise, abortPromise]);
      if (result.success && needsProcessSandbox && processBroker?.spawnCount === 0) {
        return finish({ ...brokerFailure(
          `process tool ${request.name} returned success without using the broker-owned process launcher`),
          failure: operationFailure("CAPABILITY_UNSUPPORTED", "broker", request.executionId),
        }, "failed");
      }
      const outputBytes = Buffer.byteLength(result.output, "utf8");
      progress.outputChecked = true;
      if (outputBytes > limits.maxOutputBytes) {
        return finish({ ...brokerFailure(
          `tool output exceeds broker limit (${outputBytes} > ${limits.maxOutputBytes} bytes)`,
          truncateUtf8(result.output, limits.maxOutputBytes)),
          failure: operationFailure("RESOURCE_LIMIT", "broker", request.executionId),
          // The output boundary failed after the handler completed. Retain its
          // observations (including process exit status); finish records the
          // broker failure independently of those underlying observations.
          runtime: result.runtime,
        }, "failed");
      }
      return finish(result, result.success ? "succeeded" : "failed");
    } catch (error) {
      return finish(executionFailureResult(error, request.executionId), "failed");
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

class DefaultExecutionResourceBudget implements ExecutionResourceBudget {
  private readonly counters: ExecutionResourceUsage = {
    files: 0,
    fileBytes: 0,
    maxDepth: 0,
    networkBytes: 0,
    backgroundOutputBytes: 0,
  };

  constructor(readonly limits: Readonly<ToolResourceLimits>) {}
  get usage(): Readonly<ExecutionResourceUsage> { return { ...this.counters }; }
  consumeFiles(count = 1): void { this.add("files", "maxFiles", count, this.limits.maxFiles); }
  consumeFileBytes(bytes: number): void { this.add("fileBytes", "maxFileBytes", bytes, this.limits.maxFileBytes); }
  observeDepth(depth: number): void {
    assertResourceAmount("maxDepth", depth);
    this.counters.maxDepth = Math.max(this.counters.maxDepth, depth);
    if (this.counters.maxDepth > this.limits.maxDepth) throw limitError("maxDepth", this.counters.maxDepth, this.limits.maxDepth);
  }
  consumeNetworkBytes(bytes: number): void { this.add("networkBytes", "maxNetworkBytes", bytes, this.limits.maxNetworkBytes); }
  consumeBackgroundOutputBytes(bytes: number): void {
    this.add("backgroundOutputBytes", "maxBackgroundOutputBytes", bytes, this.limits.maxBackgroundOutputBytes);
  }
  private add(
    key: Exclude<keyof ExecutionResourceUsage, "maxDepth">,
    limitName: string,
    amount: number,
    limit: number,
  ): void {
    assertResourceAmount(limitName, amount);
    this.counters[key] += amount;
    if (this.counters[key] > limit) throw limitError(limitName, this.counters[key], limit);
  }
}

function validateDeclaredResources(
  request: ExecutionBrokerRequest,
  limits: ToolResourceLimits,
): string | undefined {
  const paths = [...new Set(request.effects.filesystem
    .flatMap((effect) => effect.paths)
    .map((path) => resolve(path)))];
  if (paths.length > limits.maxFiles) return limitError("maxFiles", paths.length, limits.maxFiles).message;
  for (const path of paths) {
    const rel = relative(request.workspace.root, path);
    const depth = rel.split(sep).filter((part) => part && part !== "..").length;
    if (depth > limits.maxDepth) return limitError("maxDepth", depth, limits.maxDepth).message;
    try {
      const info = lstatSync(path);
      if (info.isFile() && info.size > limits.maxFileBytes) {
        return limitError("maxFileBytes", info.size, limits.maxFileBytes).message;
      }
    } catch {
      // New paths and concurrently removed resources are validated by adapters.
    }
  }
  return undefined;
}

function assertResourceAmount(name: string, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`invalid ${name} resource usage: ${amount}`);
}

function limitError(name: string, actual: number, limit: number): Error {
  return new ExecutionBoundaryError(`tool resource limit ${name} exceeded (${actual} > ${limit})`,
    operationFailure("RESOURCE_LIMIT", "broker"));
}

export function validateExecutionGrant(request: Pick<ExecutionBrokerRequest, "grant" | "effects">): string | undefined {
  if (request.grant.expiresAt < Date.now()) return "capability grant expired before broker execution";
  const grantedRead = new Set((request.grant.filesystem?.read ?? []).map((path) => resolve(path)));
  const grantedWrite = new Set((request.grant.filesystem?.write ?? []).map((path) => resolve(path)));
  for (const effect of request.effects.filesystem) {
    const granted = effect.operation === "read" ? grantedRead : grantedWrite;
    for (const path of effect.paths) {
      if (!granted.has(resolve(path))) return `capability grant does not cover ${effect.operation} path ${path}`;
    }
  }
  if (request.effects.process.length > 0 && request.grant.process?.spawn !== true) {
    return "capability grant does not allow process spawn";
  }
  for (const effect of request.effects.network) {
    const grant = request.grant.network;
    if (!grant) return "capability grant does not allow network access";
    for (const destination of effect.destinations) {
      if (!coversValue(grant.destinations, destination)) {
        return `capability grant does not cover network destination ${destination}`;
      }
    }
    for (const method of effect.methods ?? []) {
      if (!coversValue(grant.methods, method)) {
        return `capability grant does not cover network method ${method}`;
      }
    }
  }
  for (const effect of request.effects.external) {
    const covered = request.grant.external?.some((grant) => (
      grant.system === effect.system
      && grant.operations.includes(effect.operation)
      && (grant.resource === undefined || grant.resource === effect.resource)
    ));
    if (!covered) {
      return `capability grant does not cover external ${effect.system}:${effect.operation}`;
    }
  }
  if (request.grant.workspace?.mode !== request.effects.workspace.mode) {
    return `capability grant does not cover workspace mode ${request.effects.workspace.mode}`;
  }
  return undefined;
}

function coversValue(granted: string[], expected: string): boolean {
  return granted.includes("*") || granted.includes(expected);
}

function mergeLimits(
  upper: ToolResourceLimits,
  requested: Partial<ToolResourceLimits> | undefined,
): ToolResourceLimits {
  if (!requested) return { ...upper };
  return Object.fromEntries(Object.entries(upper).map(([key, value]) => [
    key,
    Math.min(value, requested[key as keyof ToolResourceLimits] ?? value),
  ])) as unknown as ToolResourceLimits;
}

function configureLimits(
  defaults: ToolResourceLimits,
  configured: Partial<ToolResourceLimits> | undefined,
): ToolResourceLimits {
  const limits = { ...defaults, ...configured };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`ExecutionBroker limit ${name} must be a non-negative safe integer`);
    }
  }
  return limits;
}

function brokerFailure(error: string, output = ""): ToolResult {
  return { success: false, output, error };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

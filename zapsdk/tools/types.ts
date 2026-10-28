import type { ServiceOperation } from "../services/execution.js";
import type { ServiceOperationObservation } from "../services/contracts.js";
import type { ServiceReceipt } from "../services/contracts.js";
import { z } from "zod";
import type { ResultSourcePolicyObservation } from "./result-source-policy.js";
import type { BackgroundTaskOwner } from "../tasks/lifecycle.js";
import type { ContentBlock } from "../core/types.js";
import type { ExecutionObservation, OperationFailure } from "../execution/contracts.js";
import type {
  ToolEffectContext,
  ToolEffects,
  ToolResourceLimits,
} from "./effects.js";
import type { CapabilityGrant, PolicyDecision } from "../policy/types.js";
import type {
  ExecutionProcessBroker,
  ExecutionResourceBudget,
  SandboxProviderKind,
} from "../execution/types.js";

export type ToolPermission = "auto" | "confirm" | "deny";

export interface ToolDefinition {
  /** Trusted definition; service calls are executed by the broker, never the handler. */
  serviceOperation?: ServiceOperation;
  name: string;
  /** Host-only registry identity for descriptive background lifecycle facts.
   * Never part of tool arguments, a permission grant or process control. */
  backgroundTaskStoreId?: string;
  /** Brief summary for tool schema (1-3 lines). Tells the model WHAT the tool does. */
  description: string;
  /**
   * Extended usage guidance injected into the model's context.
   * Tells the model WHEN/HOW/WHY to use this tool. Not sent in the tool schema —
   * appended to the system prompt so it doesn't bloat every tool call.
   */
  prompt?: string;
  parameters: z.ZodType;
  /**
   * Optional raw JSON Schema for the tool's parameters. When present, this is
   * sent to the LLM verbatim instead of running `parameters` through
   * `zodToJsonSchema`. Used by MCP-bridged tools whose schemas come from
   * external servers and would lose fidelity (oneOf/$ref/integer/nullable/…)
   * through a Zod round-trip. `parameters` is still required (kept as a
   * permissive passthrough for MCP tools) so the executor's safeParse path
   * stays uniform.
   */
  rawSchema?: Record<string, unknown>;
  permission?: ToolPermission;
  /** Per-tool timeout override (ms). Takes precedence over ToolExecutor's global timeout. */
  timeoutMs?: number;
  /** Per-call timeout (ms) when it depends on the arguments, e.g. a model-supplied
   *  `timeout_ms`. Wins over `timeoutMs`; the executor and broker deadlines follow it. */
  resolveTimeoutMs?: (args: Record<string, unknown>) => number | undefined;
  /**
   * Optional: tool declares which paths it will modify. Used by the checkpoint
   * subsystem to record pre-edit backups via `trackEdit`. Returns absolute or
   * cwd-relative paths; null/undefined means the call does not modify files.
   */
  writesPath?: (args: Record<string, unknown>) => string[] | null;
  /**
   * Checkpoint coverage required before this tool may execute. Use this only
   * for operations that irreversibly remove or replace user data. The default
   * remains best-effort so existing embedders can adopt checkpoint storage
   * incrementally without turning ordinary edits into silent no-ops.
   */
  checkpointRequirement?: "best-effort" | "required";
  /**
   * Whether this tool is safe to run in parallel with other tools.
   * `true` → executor launches it concurrently (Read/Glob/Grep/web_search/…).
   * `false`/omitted → executor serializes it through a shared write-chain so
   *   consecutive write→read on the same file sees post-write content and two
   *   edits to the same path can't race.
   *
   * Conservative default (treat as mutating) means a new tool that forgets to
   * set this loses some parallelism but stays correct. bash / http_fetch /
   * monitor / delegate_agent stay opt-out because they can mutate local or
   * external state. Tools whose safety depends on arguments can additionally
   * opt in per call through `isReadOnlyCall`.
   */
  readOnly?: boolean;
  /**
   * Optional per-call read-only classification. This is evaluated only after
   * the streamed JSON arguments form a complete object. Static `readOnly:
   * true` wins; false, omission, or an exception keeps the conservative
   * serialized behavior.
   */
  isReadOnlyCall?: (args: Record<string, unknown>) => boolean;
  /** Structured, per-call side effects used by policy, scheduling and audit.
   * Legacy tools may omit this; the compatibility resolver then falls back to
   * readOnly/isReadOnlyCall/writesPath and otherwise returns unknown effects. */
  /** Shell/external process effects are permission scopes, not enumerable undo files. */
  checkpointTracking?: "files" | "unsupported";
  /** Exact shell payloads from this trusted adapter. Used for command-rule
   * compatibility and risk review, never as proof of all program effects. */
  resolveShellCommands?: (args: Record<string, unknown>) => readonly string[];
  resolveEffects?: (
    args: Record<string, unknown>,
    context: Readonly<ToolEffectContext>,
  ) => ToolEffects;
  /** Tool-specific resource limits. Runtime hard caps always win. */
  limits?: Partial<ToolResourceLimits>;
  /** Process-capable handlers must opt in and launch through
   * ToolExecutionContext.process. ExecutionBroker rejects process effects
   * from handlers that do not make this contract explicit. */
  sandboxAware?: boolean;
  /** Trusted adapter declaration, never a model argument. Workspace process
   * tools execute through the selected workspace backend regardless of name;
   * host integration tools retain their host-owned execution boundary. */
  executionLocation?: "workspace" | "host";
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** Structured boundary evidence. Legacy failures use EXECUTION_FAILED /
   * unknown rather than guessing sandbox or network policy from prose. */
  failure?: OperationFailure;
  /** Tool-specific metadata consumed by UI/telemetry only. Not fed back to the
   *  LLM (so it doesn't bloat the context). Shape is per-tool; consumers cast
   *  to the expected interface. Example: write_file / edit_file return DiffMeta. */
  meta?: unknown;
  /** Multimodal payload shipped to the model alongside `output`. Currently used
   *  by read_file when the target is an image: `output` carries a text stub
   *  ("Loaded image foo.png"), `contentBlocks` carries the actual image block.
   *  Providers serialize this into tool_result multimodal content (Anthropic)
   *  or into a follow-up user message (OpenAI-compatible). */
  contentBlocks?: ContentBlock[];
  /** Runtime metadata for audit/UI. Only bounded command/check status fields
   * are projected into model-visible results; the rest stays host-side. */
  runtime?: {
    /** Broker-authored evidence only after every launched process was sealed. */
    processSeal?: { state: "sealed"; executionId: string };
    /** Actual refusals observed by this command's filtering proxy. */
    networkDenials?: Array<{ host: string; reason: string }>;
    /** Host-generated duplicate notice; no tool execution or fresh content occurred. */
    suppression?: "duplicate";
    service?: ServiceReceipt;
    serviceOperation?: ServiceOperationObservation;
    /** Host content scope observation; no excluded body or URL is retained here. */
    resultSourcePolicy?: ResultSourcePolicyObservation;
    /** Actual foreground process status; commandRef is runtime-authored. */
    command?: {
      commandRef: string;
      exitCode?: number;
      timedOut?: boolean;
      aborted?: boolean;
      /** Nonblank stderr in any foreground step; not proof of failure. */
      stderrPresent?: boolean;
    };
    /** Executor-resolved effects, independent of model output. */
    effects?: ToolEffects;
    /** Explicit foreground checks, observed rather than inferred from output.
     * A null exit includes a step whose process could not be started. */
    verification?: { passed: boolean; steps: Array<{ command: string; exitCode: number | null }> };
    /** Fresh state from the session-owned task registry, never parsed from prose. */
    taskObservation?: { tasks: Array<{ taskId: string; status: "running" | "exited" }> };
    /** Host-authored observation, not model context or a permission grant. */
    execution?: ExecutionObservation;
    policy?: Pick<PolicyDecision, "decision" | "reason">;
    /** Coverage of declared paths only; shell descendants may write elsewhere. */
    checkpoint?: {
      attempted: boolean;
      covered: boolean;
      error?: string;
    };
    /** Before/after fingerprints for the paths the tool declared it would
     * write. Kept out of model-visible tool output; hosts can persist it as
     * audit evidence and use it when deciding whether a rewind is safe. */
    writeEvidence?: {
      paths: Array<{
        path: string;
        before: {
          exists: boolean;
          kind?: "file" | "directory" | "symlink" | "other";
          size?: number;
          sha256?: string;
          error?: string;
        };
        after: {
          exists: boolean;
          kind?: "file" | "directory" | "symlink" | "other";
          size?: number;
          sha256?: string;
          error?: string;
        };
      }>;
    };
    broker?: {
      executionId: string;
      sandbox: SandboxProviderKind;
      sandboxEnforced: boolean;
      resources?: ExecutionResourceBudget["usage"];
    };
  };
}

/** Host-authored identity for one tool execution. This metadata is never part
 *  of the model-visible tool schema or arguments, so tools can use it for
 *  audit/provenance without trusting model-supplied identifiers. */
export interface ToolExecutionContext {
  /** Current Runtime-owned task registry; absent or mismatched means unknown. */
  backgroundTaskOwner?: BackgroundTaskOwner;
  /** Earliest known outer deadline in epoch ms, for child budget feedback.
   * Enforcement remains owned by the originating timeout/cancellation signal. */
  deadlineAtMs?: number;
  /** Execution-local completed observations. Never serialized or model-authored. */
  observations?: ToolObservationSink;
  executionId?: string;
  sessionId?: string;
  toolCallId?: string;
  step?: number;
  effects?: ToolEffects;
  grant?: CapabilityGrant;
  /** Broker-owned process launcher for every child process. */
  process?: ExecutionProcessBroker;
  limits?: ExecutionResourceBudget["limits"];
  resources?: ExecutionResourceBudget;
  /** Runtime-authored lifecycle binding for an Agent Tool executed by the
   * first-class AgentCoordinator. Never populated from model arguments. */
  agentRun?: {
    runId: string;
    parentRunId?: string;
    reportStatus: (status: import("../agent/run-state.js").AgentRunStatus, detail?: string) => Promise<void>;
  };
}

export interface ToolObservationSink {
  record(observation: { toolName: string; success: boolean; output: string; error?: string }): void;
  /** Bound by the broker's effective output limit; can only reduce retention. */
  limit(maxBytes: number): void;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context?: Readonly<ToolExecutionContext>,
) => Promise<ToolResult>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

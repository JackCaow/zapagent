import { backgroundTaskLifecycle, describeBackgroundTaskLifecycle, type BackgroundTaskOwner } from "../tasks/lifecycle.js";
import { describeCheckpointCoverage } from "../checkpoint/facts.js";
import { conciseAgentProtocol, DELIVERABLE_SCOPE_GUIDANCE, resolvePromptProfile, type PromptProfile } from "./prompt-profile.js";
import { executeNonStreamingTurn } from "./nonstreaming-tool-executor.js";
import { earliestDeadlineAt } from "../execution/deadline.js";
import { toolOutputTool } from "../builtin-tools/tool-output.js";
import { assembleSubagentTool } from "./subagent-assembly.js";
import { type TaskDecompositionMode, primaryArgSig, stepSignature, createRunToolExecutionHooks, isRepeatFriendlyStep, isLiveTaskWait, progressPollSignature } from "./tool-execution-guards.js";
import type { LLMProvider, LLMCallOptions } from "../core/llm.js";
import { hasMeaningfulOutput } from "../core/provider-request.js";
import { assertProviderRequestAllowed } from "../core/provider-deadline.js";
import { isRetryableProviderError } from "../core/retry.js";
import { withModelOverride } from "../core/llm.js";
import type { Message, TokenUsage, ToolCallRequest } from "../core/types.js";
import { type Turn, type CompletedCall, type IncompleteCall, buildToolTurn, turnToMessages } from "../core/turn.js";
import {
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "../core/types.js";
import type { Tool, ToolDefinition, ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor, type ApprovalCallback, type PostProcessCallback, type ToolExecutorOptions } from "../tools/executor.js";
import { formatToolResultForModel, formatToolResultContent, normalizeToolFailure, operationFailure } from "../execution/failure.js";
import {
  AgentEventEmitter,
  nextContentId,
  type AgentEventType,
  type AgentEventHandler,
  type AgentEvent,
  type ContextDiagnostics,
  type RuntimeTimeBudget,
} from "./events.js";
import { AgentBudget } from "./budget.js";
import { RequestMeter, BudgetLimitError } from "./request-meter.js";
import {
  ProgressController,
  type BudgetDecision,
  type ProgressObservation,
} from "../harness/progress.js";
import { ToolProgressTracker } from "../harness/tool-progress.js";
import type { CompletionAssessment } from "../harness/completion.js";
import type { HarnessBudgetConstraints } from "../harness/policy.js";
import { computeCacheUsageStats } from "./cache-metrics.js";
import type { ConversationManager } from "../memory/conversation.js";
import type { TodoStore } from "../builtin-tools/todo.js";
import type { ResultCompressor } from "../context/result-compressor.js";
import { HistoricalImageRetention } from "../context/historical-images.js";
import { ReactiveCompact, type RecoveryCallOptions } from "../context/reactive-compact.js";
import { contextFingerprint, recoveryReason, RequestRecoveryError, mergeRecoveredProviderView, rebaseMessageBoundary } from "../context/request-recovery.js";
import { AutoCompact } from "../context/autocompact.js";
import { buildConversationCacheDiagnostics } from "./conversation-cache-diagnostics.js";
import { generateToolUseSummary } from "../context/tool-use-summary.js";
import {
  StreamingToolExecutor,
  isAbortedStreamError,
  InterruptedStreamError,
  type StreamingToolResult,
  type ToolExecutionHooks,
} from "./streaming-tool-executor.js";
import { maybePersistToolResult, PERSIST_THRESHOLD_CHARS } from "../utils/tool-result-storage.js";
import { countCodePoints, sliceHeadCodePoints } from "../utils/logical-lines.js";
import { createHash, randomUUID } from "node:crypto";
import { TokenCounter } from "../context/token-counter.js";
import { restoreRecentFiles } from "../context/restore-files.js";
import {
  ContextOverflowError,
  isLikelyContextLimitErrorMessage,
  looksLikeImageContentRejection,
} from "../core/errors.js";
import { DYNAMIC_BOUNDARY, splitAtBoundary, stripBoundary } from "../core/prompt-boundary.js";
import {
  createInitialLoopState,
  isOutputTokenLimit,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  type LoopState,
} from "./state.js";
import { accumulateTokenUsage, sanitizeTokenUsage } from "./token-usage.js";
import { computeCallBudget } from "./call-budget.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { MergeCoordinator } from "../merge/coordinator.js";
import type { AgentCoordinator } from "../coordinator/coordinator.js";
import type { DeferredAgentCoordinatorExecutor } from "../coordinator/executor-bridge.js";

export interface SteeringInput {
  id: string;
  text: string;
  images?: import("../core/types.js").ImageContent[];
}

export interface RunOptions {
  /** Host-authored observation. AgentRuntime overrides it from its own registry
   * and outcome mode; descendants never inherit it automatically. */
  backgroundTaskOwner?: BackgroundTaskOwner;
  /** Known outer execution deadline, epoch ms. Supplies transient feedback and
   * propagates to nested tools; the owning signal still enforces the boundary. */
  deadlineAtMs?: number;
  /** Runtime-selected result semantics inherited by child executions. */
  resultSchema?: "outcome-v1" | "legacy";
  signal?: AbortSignal;
  images?: import("../core/types.js").ImageContent[];
  /** Fire only after real user input is in the canonical conversation. */
  onInputAccepted?: () => void;
  /** Hosts retain ownership until a safe boundary accepts the input. Steering
   * never interrupts tools, starts a new run, or resets the current budget. */
  hasSteering?: () => boolean;
  takeSteering?: () => SteeringInput | undefined;
  onSteeringAccepted?: (input: SteeringInput) => void;
  /** Stable run context (RepoMap, recalled memory, initial todo/runtime
   * snapshot). A function is evaluated exactly once per run. The resulting
   * transient message is fixed immediately before the current user turn so
   * later tool iterations can reuse the provider's prompt-prefix cache. */
  contextPrefix?: string | (() => string | null | undefined);
  /** Small live delta for state that can genuinely change during the run
   * (currently the active todo plan). Re-evaluated before each LLM call and
   * appended at the tail only when it differs from the run-start snapshot. */
  contextDelta?: () => string | null | undefined;
  /**
   * Optional diagnostics for the stable context and current live delta. Hosts should return
   * segment-level token/hash data for the same data sources used by
   * contextPrefix so cache investigations can distinguish memory churn from
   * todo/plan churn without persisting the context itself.
   */
  contextDiagnostics?: () => ContextDiagnostics | null | undefined;
  /**
   * One-shot turn-end guard. Called immediately before the loop breaks on
   * a natural finish (model emits text with no tool calls). Returning a
   * non-empty string injects that string as a synthetic user-role message
   * and forces one more iteration instead of ending the turn. Returning
   * null/undefined/empty lets the turn end normally.
   *
   * Fires at most ONCE per run — the second natural finish always ends the
   * turn, even if the guard would still return a continuation. This is a
   * hard safety rail against infinite loops when the model refuses to
   * finalize (e.g. keeps saying "done" without calling the tool).
   *
   * Does NOT fire on forced exits (max_steps, max_tokens, budget): those
   * are abnormal terminations where the guard's assumption (model thinks
   * it's done) doesn't hold.
   *
   * Current use case: detect dangling `in_progress` todos and nudge the
   * model to call todo_write one more time before the turn ends. Runtime also
   * uses this hook for explicit completion evidence. Async hooks receive a
   * deadline/cancellation signal and the current candidate result.
   */
  turnEndGuard?: (result: LoopAgentResult, signal?: AbortSignal) => string | null | undefined | Promise<string | null | undefined>;
}

/**
 * A wall-clock budget snapshot published at the model-facing transient tail
 * and on `run_step`. It is deliberately not persisted into the conversation:
 * exact remaining time changes on every request and would otherwise invalidate
 * prompt-cache prefixes as well as pollute resumed sessions.
 */
export type { RuntimeTimeBudget } from "./events.js";

/**
 * Build the small, dynamic deadline instruction appended after host runtime
 * state. The invariant is intentional: the model sees actionable time state,
 * while the cacheable system prompt and stable RepoMap/memory prefix never
 * change because of the clock.
 */
export function buildRuntimeTimeBudgetContext(budget: RuntimeTimeBudget): string {
  const seconds = Math.max(0, Math.ceil(budget.remainingMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  const remaining = minutes > 0 ? `${minutes}m ${remainderSeconds}s` : `${seconds}s`;
  const executionWindow = budget.executionRemainingMs !== undefined && budget.finalizationReserveMs !== undefined
    ? `\nModel/tool execution window: ${budget.executionRemainingMs}ms; reserved within the remaining budget for the final response without tools: ${budget.finalizationReserveMs}ms. These windows share the same total deadline.`
    : "";
  const roundTiming = budget.recentRoundDurationsMs?.length
    ? `\nRecent completed rounds took ${budget.recentRoundDurationsMs.map(ms => `${(ms / 1_000).toFixed(1)}s`).join(", ")} (oldest first, including model responses, recovery, and foreground tools). These are historical observations, not predictions or additional limits. Use them when allocating time for investigation, implementation, and verification.`
    : "";
  const policy = budget.stage === "execute"
    ? "Work toward the complete requested behavior. Use focused diagnostics to test uncertain assumptions, and leave time to verify the final deliverable."
    : budget.stage === "converge"
      ? "Converge now: do not start broad research, package installs, or open-ended background work. Implement the smallest remaining change and verify it."
      : "Finalize now: report completed work and unresolved checks from available evidence, then return the final answer before the deadline.";
  return `[Runtime time budget — transient, do not quote]
Self-managed wall-clock budget: ${remaining} remaining (${budget.remainingPercent}%), stage: ${budget.stage}.${executionWindow}${roundTiming}
${policy}`;
}

interface StepDeadlineSignal {
  signal?: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

export interface SubagentConfig {
  /** Host-selected instructions shared by every descendant, independent of
   * model-authored briefings. Do not pass the parent's entire workflow prompt. */
  inheritedInstructions?: string;
  /** Max steps per subagent (default: 50, capped to main agent's maxSteps) */
  maxSteps?: number;
  /** Subagent execution timeout in ms (default: 600_000) */
  timeoutMs?: number;
  /** Max nesting depth (default: 2) */
  maxDepth?: number;
  /** Event listener for subagent events (tool_call, tool_result, etc.) */
  onEvent?: AgentEventHandler;
  /** Shared todo store (main + subagent keys). When set, general-type
   *  subagents get their own keyed list via this store, preventing them
   *  from clobbering the main agent's list. */
  todoStore?: TodoStore;
  workspaceManager?: WorkspaceManager;
  mergeCoordinator?: MergeCoordinator;
  createRegistryForCwd?: (cwd: string) => ToolRegistry;
  requireWriteIsolation?: boolean;
  coordinator?: AgentCoordinator;
  coordinatorExecutorBridge?: DeferredAgentCoordinatorExecutor;
}

/**
 * Arguments the LoopAgent passes when it asks the factory to produce an `agent` tool.
 * `subagentTool` from `zapsdk/builtin-tools/subagent.ts` satisfies this shape.
 */
export interface SubagentFactoryArgs {
  inheritedInstructions?: string;
  promptProfile?: PromptProfile;
  getResultSchema?: () => "outcome-v1" | "legacy";
  provider: LLMProvider;
  registry: ToolRegistry;
  maxSteps?: number;
  timeoutMs?: number;
  maxDepth?: number;
  onApproval?: ApprovalCallback;
  executorOptions?: Omit<ToolExecutorOptions, "onApproval">;
  onEvent?: AgentEventHandler;
  /** Shared tree-wide budget; subagents check/charge the same instance. */
  budget?: AgentBudget;
  /** Fallback provider to pass through to subagents. */
  fallbackProvider?: LLMProvider;
  /** Shared todo store; subagents re-register todo_write with their own key. */
  todoStore?: TodoStore;
  /** Budget planning params inherited from parent LoopAgent. */
  contextWindow?: number;
  inputTokenLimit?: number;
  outputTokenCeiling?: number;
  reservedOutputTokens?: number;
  /** Project cwd for persisted oversized tool outputs. */
  storageProjectCwd?: string;
  workspaceManager?: WorkspaceManager;
  mergeCoordinator?: MergeCoordinator;
  createRegistryForCwd?: (cwd: string) => ToolRegistry;
  requireWriteIsolation?: boolean;
  coordinator?: AgentCoordinator;
  coordinatorExecutorBridge?: DeferredAgentCoordinatorExecutor;
}

export type SubagentFactory = (args: SubagentFactoryArgs) => Tool;

export interface LoopAgentOptions {
  /** Already metered host maintenance for this run; never charged twice. */
  initialUsage?: TokenUsage;
  provider: LLMProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  systemPrompt?: string;
  /** Optional behavior profile; omitted SDK callers retain legacy prompt assembly. */
  promptProfile?: PromptProfile;
  maxSteps?: number;
  maxTokens?: number;
  /**
   * V2 shared Harness budget constraints. They drive generic convergence
   * decisions; legacy callers can continue using maxSteps/reserveSteps.
   */
  adaptiveBudget?: HarnessBudgetConstraints;
  reserveSteps?: number;
  /**
   * How strongly the loop requires an explicit todo-based task decomposition
   * before executing tools. "auto" lets the model choose a useful plan without
   * blocking simple tasks; "required" permits only one read-only baseline
   * action before an actionable plan is mandatory. "off" disables the gate.
   * The gate is inert when todo_write is not registered.
   */
  taskDecomposition?: "off" | "auto" | "required";
  maxToolRetries?: number;
  conversation?: ConversationManager;
  resultCompressor?: ResultCompressor;
  /** Fallback provider tried when the primary fails for non-context reasons */
  fallbackProvider?: LLMProvider;
  /** Provider used for LLM-based context summarization (defaults to primary provider) */
  summarizer?: LLMProvider;
  /** Character count above which AutoCompact triggers (default: 320_000 ≈ 80k tokens) */
  autoCompactThreshold?: number;
  /**
   * Token count above which AutoCompact triggers. Supplements the char
   * threshold — important because char/token ratios vary wildly by language
   * (CJK: ~1.5 chars/token; English code: ~4 chars/token). For a Chinese-
   * heavy conversation, the char threshold is hit much later than the
   * token one, so by the time char-compact fires, the API is already near
   * its real token ceiling. Includes image tokens for both managed and
   * run-local conversation history.
   */
  autoCompactTokenThreshold?: number;
  /** Max number of max_output_tokens recovery injections per run (default: 3) */
  maxOutputTokensRecoveries?: number;
  /**
   * Enable multi-agent capability. When set, the `agent` tool is automatically
   * registered, allowing the model to spawn parallel subagents.
   * Set to `true` for defaults, or pass a config object.
   *
   * Note: this registers the `agent` tool on a per-LoopAgent registry clone.
   * The caller-provided registry is left untouched; the cloned executor and
   * agent share that clone so the model can invoke subagents via normal tool
   * calls without cross-wiring concurrent runs.
   *
   * Requires `subagentFactory` to also be provided.
   */
  subagent?: boolean | SubagentConfig;
  /**
   * Factory that produces the `agent` tool. Required when `subagent` is set.
   * Usually `import { subagentTool } from "zapsdk"`. Injected here to avoid
   * a circular dependency between `agent/loop.ts` and `builtin-tools/subagent.ts`.
   */
  subagentFactory?: SubagentFactory;
  /**
   * Shared budget for step/spawn/token caps across the whole agent tree.
   * If omitted, the root LoopAgent creates a permissive default
   * (3× maxSteps, 10 spawns, no token cap). Subagents receive the same
   * instance so fan-out is globally bounded.
   */
  budget?: AgentBudget;
  /**
   * Scoping id for persisted tool outputs. When a tool_result exceeds the
   * persistence threshold, its full content is written to
   * `~/.zapcode/projects/<project-id>/tool-outputs/<storageSessionId>/<tool-call-id>.txt`.
   * Groups outputs by project + session so they can be cleaned up together. If
   * omitted, a random id is generated at construction (fine for short-lived
   * runs; set this explicitly when LoopAgent lives across multiple user turns).
   */
  storageSessionId?: string;
  /** Project cwd used to derive where oversized tool outputs are persisted.
   *  Defaults to `process.cwd()` for backwards compatibility; hosts that embed
   *  multiple workspaces in one process should pass this explicitly. */
  storageProjectCwd?: string;

  /** Session identifier. Threaded through to onRunEnd for checkpoint binding. Default: "default". */
  sessionId?: string;

  /** Called at the end of each run, before the run_ended event is emitted.
   *  Checkpoint subsystem uses this to commit the turn's pending backups
   *  into a snapshot. Errors are swallowed. */
  onRunStart?: (ctx: { turnStartIndex: number; sessionId: string; input: string }) => Promise<void>;
  onRunEnd?: (ctx: { turnStartIndex: number; sessionId: string }) => Promise<void>;

  /** Per-agent model override. When set, every LLM call in this run uses
   *  this model id regardless of what the underlying provider was
   *  constructed with. Used by cheaper-model subagents (e.g. Haiku for
   *  explore) without needing to instantiate a separate provider. */
  modelOverride?: string;

  /** Model's full context window (input + output combined) in tokens. When
   *  set alongside `outputTokenCeiling`, enables per-call output budget
   *  planning: before each LLM call the loop estimates input token cost
   *  and caps `max_tokens` so `input + max_tokens ≤ contextWindow`. If
   *  there's not even room for `reservedOutputTokens` worth of output,
   *  throws `ContextOverflowError` — caught in the main loop to trigger
   *  autoCompact + retry. Without this, the provider's constructor
   *  maxTokens is used as-is (legacy behavior). */
  contextWindow?: number;

  /** Optional hard prompt-input ceiling published separately from the
   * combined context window. When set, estimated input plus the safety margin
   * must fit this limit even if combined input + output would otherwise fit. */
  inputTokenLimit?: number;

  /** Maximum `max_tokens` the loop will send in any single call. When
   *  `contextWindow` is set, effective cap is `min(this, remaining)`.
   *  Defaults to `contextWindow / 2` when contextWindow is set, else
   *  undefined (provider's own default applies). */
  outputTokenCeiling?: number;

  /** Minimum output budget guaranteed per call. If the remaining budget
   *  falls below this, `ContextOverflowError` is thrown instead of sending
   *  a request whose output would be too truncated to be useful. Default:
   *  8192 tokens. Only effective when `contextWindow` is set. */
  reservedOutputTokens?: number;

  /** Wall-clock cap for one `run()` call, in milliseconds. Before beginning
   *  another step, the loop reserves `forceFinishTimeoutMs` for a tool-less
   *  synthesis and publishes the remaining budget in transient context. This
   *  gives an outer evaluator time to receive a coherent result instead of
   *  killing the process at its own deadline. Independent of `AbortSignal`
   *  (which remains user-initiated). Omit to disable. */
  timeoutMs?: number;

  /** Hard cap for the tool-less synthesis attempted on forced exits. The
   *  provider receives an abort signal, while a local deadline also releases
   *  the run when a custom provider ignores cancellation. Default: 15s. */
  forceFinishTimeoutMs?: number;

  /**
   * Injectable clock for deterministic runtime-budget tests. Production uses
   * Date.now. Hosts should set `timeoutMs`, never a fake clock.
   */
  now?: () => number;

  /** Fired once per run when the loop self-heals an image-rejection 400 by
   *  flipping the provider into image-stripping mode. Hosts use this to
   *  persist the resolution back to config (e.g. `setVisionSupport(provider,
   *  model, false)`) so future runs don't pay the failed-call cost again. */
  onImageStripSelfHeal?: () => void;
}

export interface LoopAgentResult {
  /** Runtime delivery assessment, independent from the loop stop reason. */
  completion?: CompletionAssessment;
  text: string;
  steps: number;
  toolResults: ToolResult[];
  totalUsage: TokenUsage;
  stopped?: "max_steps" | "max_tokens" | "budget" | "timeout" | "max_repeat";
}

type ForceFinishReason = NonNullable<LoopAgentResult["stopped"]> | "empty_output";

function forceFinishCause(reason: ForceFinishReason): string {
  const cause: Record<ForceFinishReason, string> = {
    max_steps: "the run reached its step limit",
    max_tokens: "the run reached its token limit",
    budget: "the shared agent budget was exhausted",
    timeout: "the run reached its wall-clock limit",
    max_repeat: "the loop detected repeated tool calls without enough progress",
    empty_output: "the previous model turn returned no final text after tool work",
  };
  return cause[reason];
}

function forceFinishInstruction(reason: ForceFinishReason): string {
  return `The run is stopping because ${forceFinishCause(reason)}. Respond with the final answer now. Summarize completed work, verified results, remaining gaps, and the next concrete step. Do not call tools.`;
}

type AddMessage = (msg: Message) => void;
type CommitTurn = (turn: Turn) => void;
type GetMessages = () => Message[];
type ReplaceMessages = (msgs: Message[]) => void;
type ErrorTracker = Map<string, Map<string, number>>;
type SeenFiles = Map<string, string>;

const REFUSAL_PROMPT_LEAK =
  "I can't share my system instructions or private memory verbatim. Ask me what I can do and I'll explain.";
const MAX_INLINE_TOOL_RESULT_CONTEXT_SHARE = 0.1;
const MIN_INLINE_TOOL_RESULT_TOKENS = 2_048;

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function nonNegativeIntegerOrDefault(value: number | undefined, fallback: number): number {
  return nonNegativeInteger(value) ?? fallback;
}

const DEFAULT_FORCE_FINISH_TIMEOUT_MS = 15_000;

export class LoopAgent {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private systemPrompt?: string;
  private maxSteps: number;
  private maxTokens: number;
  private adaptiveBudget?: HarnessBudgetConstraints;
  private reserveSteps: number;
  private taskDecomposition: TaskDecompositionMode;
  private readonly promptProfile: PromptProfile;
  private readonly explicitPromptProfile: boolean;
  private maxToolRetries: number;
  private emitter = new AgentEventEmitter();
  private conversation?: ConversationManager;
  private resultCompressor?: ResultCompressor;
  private fallbackProvider?: LLMProvider;
  private summarizer?: LLMProvider;
  private autoCompact: AutoCompact;
  private autoCompactCharThreshold: number;
  private autoCompactTokenThreshold?: number;
  private storageSessionId: string;
  private storageProjectCwd: string;
  private sessionId: string;
  private onRunStart?: LoopAgentOptions["onRunStart"];
  private onRunEnd?: (ctx: { turnStartIndex: number; sessionId: string }) => Promise<void>;
  // onRetry surfaces a system log via the observation event bus so the
  // user can see "Context overflowed; auto-retrying with aggressive
  // compaction" instead of a silent ~3s pause before the retry. Wired
  // via lambda to defer `this.emitter` capture until after construction.
  private reactiveCompact = new ReactiveCompact({
    onRetry: (detail) => {
      this.emitter.emit({
        type: "observation",
        kind: "reactive_compact",
        detail: { ...detail },
      });
    },
  });
  private recoveryContext?: (messages: Message[]) => RecoveryCallOptions;
  private retainTransientRecovery?: (before: Message[], after: Message[]) => void;
  private maxOutputTokensRecoveries: number;
  private budget: AgentBudget;
  private requestMeter?: RequestMeter;
  private initialUsage?: TokenUsage;
  private contextWindow?: number;
  private inputTokenLimit?: number;
  private outputTokenCeiling?: number;
  private reservedOutputTokens: number;
  private budgetTokenCounter = new TokenCounter();
  /** Wall-clock cap in ms; undefined = no cap. Resolved once in ctor. */
  private timeoutMs?: number;
  /** Independent hard cap for the final tool-less synthesis. */
  private forceFinishTimeoutMs: number;
  private now: () => number;
  private providerDeadlines = new WeakMap<AbortSignal, NonNullable<LLMCallOptions["deadline"]>>();
  private progressController: ProgressController;
  /** Per-run: the contextPrefix being injected this turn. Set at start of
   *  run(), cleared in finally. Read by guardOutput so memory content
   *  living in the transient attachment is still scanned for leak. */
  private turnContextPrefix?: string;
  /** Host callback fired the first time a run self-heals an image rejection. */
  private onImageStripSelfHeal?: () => void;

  constructor(options: LoopAgentOptions) {
    // Per-call model override: wrap the provider so every call in this run
    // substitutes `modelOverride` for the provider's constructor-bound model.
    // Keeps the main loop oblivious to the override — no per-call plumbing
    // throughout streamWithTools / forceFinish / reactive-compact paths.
    this.provider = options.modelOverride
      ? withModelOverride(options.provider, options.modelOverride)
      : options.provider;
    this.registry = options.registry;
    this.executor = options.executor;
    this.systemPrompt = options.systemPrompt;
    this.promptProfile = resolvePromptProfile(options.promptProfile);
    this.initialUsage = options.initialUsage;
    this.explicitPromptProfile = options.promptProfile !== undefined;
    this.adaptiveBudget = options.adaptiveBudget;
    this.maxSteps = nonNegativeIntegerOrDefault(
      options.maxSteps ?? this.adaptiveBudget?.modelTurns,
      10,
    );
    this.maxTokens = nonNegativeIntegerOrDefault(options.maxTokens, Infinity);
    this.reserveSteps = nonNegativeIntegerOrDefault(options.reserveSteps, 2);
    this.taskDecomposition = options.taskDecomposition ?? "auto";
    this.maxToolRetries = options.maxToolRetries ?? 2;
    this.budgetTokenCounter = new TokenCounter(() => this.provider.getImageTokenContext?.() ?? {});
    this.conversation = options.conversation;
    this.conversation?.setTokenCounter(this.budgetTokenCounter);
    this.resultCompressor = options.resultCompressor;
    this.fallbackProvider = options.fallbackProvider;
    this.summarizer = options.summarizer;
    this.maxOutputTokensRecoveries = options.maxOutputTokensRecoveries ?? 3;
    this.autoCompactCharThreshold = options.autoCompactThreshold ?? 320_000;
    this.autoCompact = new AutoCompact({
      charThreshold: this.autoCompactCharThreshold,
      keepRecent: 10,
    });
    this.autoCompactTokenThreshold = options.autoCompactTokenThreshold;
    this.storageSessionId = options.storageSessionId ?? randomUUID();
    this.storageProjectCwd = options.storageProjectCwd ?? process.cwd();
    this.sessionId = options.sessionId ?? "default";
    this.onRunStart = options.onRunStart;
    this.onRunEnd = options.onRunEnd;
    this.contextWindow = nonNegativeInteger(options.contextWindow);
    this.inputTokenLimit = nonNegativeInteger(options.inputTokenLimit);
    // Default ceiling is conservative (8192) — safe across all mainstream
    // models' real API max_tokens (Claude 3.5 = 8192, GPT-4o = 16384, most
    // local models ≥ 4096). Callers who want a larger ceiling (e.g. zap's
    // useAgentRunner passing user's config.maxTokens = 65536) pass it
    // explicitly. Earlier we defaulted to contextWindow/2 but that overshoots
    // on models whose real output cap is much smaller than window/2 (Claude
    // 200k window with 8k output cap → 100k default → API rejects).
    this.outputTokenCeiling = nonNegativeInteger(options.outputTokenCeiling)
      ?? (this.contextWindow !== undefined ? 8192 : undefined);
    this.reservedOutputTokens = nonNegativeIntegerOrDefault(options.reservedOutputTokens, 8192);
    this.timeoutMs = options.timeoutMs ?? this.adaptiveBudget?.wallTimeMs;
    this.forceFinishTimeoutMs = nonNegativeIntegerOrDefault(
      options.forceFinishTimeoutMs,
      DEFAULT_FORCE_FINISH_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.progressController = new ProgressController({
      maxSteps: this.maxSteps,
      reserveSteps: this.reserveSteps,
      constraints: this.adaptiveBudget,
      adaptive: this.adaptiveBudget !== undefined,
      timeoutMs: this.timeoutMs,
      forceFinishTimeoutMs: this.forceFinishTimeoutMs,
      now: this.now,
    });
    this.onImageStripSelfHeal = options.onImageStripSelfHeal;

    // Root creates a default budget; subagents receive the parent's instance.
    this.budget = options.budget ?? new AgentBudget({
      maxSteps: this.maxSteps * 3,
      maxSpawns: 10,
    });

    this.budget.constrain(this.adaptiveBudget ?? {});

    // Each agent owns its output namespace, including when it inherits a
    // parent's registry. Never retain a parent's output-reader closure.
    this.registry = this.registry.clone();
    this.registry.unregister("read_tool_output");
    this.registry.register(toolOutputTool(this.storageSessionId, this.storageProjectCwd));
    this.executor = this.executor.withRegistry(this.registry);
    const assembly = assembleSubagentTool({
      getResultSchema: () => this.resultSchema,
      provider: this.provider, registry: this.registry, executor: this.executor,
      maxSteps: this.maxSteps, budget: this.budget, fallbackProvider: this.fallbackProvider,
      contextWindow: this.contextWindow, inputTokenLimit: this.inputTokenLimit,
      outputTokenCeiling: this.outputTokenCeiling, reservedOutputTokens: this.reservedOutputTokens,
      storageProjectCwd: this.storageProjectCwd,
      subagent: options.subagent, factory: options.subagentFactory,
      promptProfile: options.promptProfile,
    });
    this.registry = assembly.registry;
    this.executor = assembly.executor;
  }

  on(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.emitter.on(type, handler);
  }

  off(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.emitter.off(type, handler);
  }

  /** Effective tool definitions for this LoopAgent instance after any
   *  constructor-time registrations (currently the auto `agent` tool).
   *  Host diagnostics should use this instead of the caller's shared
   *  registry when hashing the actual provider tools array. */
  toolDefinitions(): ToolDefinition[] {
    return this.registry.definitions();
  }

  /** Full system-prompt template after LoopAgent folds in stable runtime
   *  protocol text. The provider receives only the cacheable prefix as a
   *  system message; any dynamic suffix is relocated to transient tail
   *  context by run(). Hosts should use this full view for prompt-cache
   *  diagnostics and devtools. */
  effectiveSystemPrompt(): string | undefined {
    if (!this.systemPrompt && !this.explicitPromptProfile) return undefined;
    return foldProtocolIntoSystemPrompt(this.systemPrompt ?? "", this.protocolPrompt());
  }

  private runtimeTimeBudget(startedAt: number): RuntimeTimeBudget | undefined {
    return this.progressController.timeBudget(startedAt);
  }

  /**
   * Give an in-flight provider/tool step only the run time that remains after
   * reserving final synthesis. This is separate from the user's AbortSignal:
   * when it fires, run() handles it as a soft timeout and can still call the
   * provider once more for a tool-less final answer using the original signal.
   */
  private createStepDeadlineSignal(startedAt: number, signal?: AbortSignal): StepDeadlineSignal {
    const budget = this.runtimeTimeBudget(startedAt);
    if (!budget) {
      return { signal, timedOut: () => false, dispose: () => {} };
    }
    const controller = new AbortController();
    let timedOut = false;
    const delay = Math.max(0, budget.remainingMs - this.progressController.finalizationReserveMs());
    const deadline = { atMs: startedAt + budget.totalMs - this.progressController.finalizationReserveMs(), now: this.now };
    const expire = () => {
      timedOut = true;
      controller.abort(new Error("run time budget reserved for final synthesis"));
    };
    const timer = setTimeout(expire, delay);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.providerDeadlines.set(combined, deadline);
    return {
      signal: combined,
      timedOut: () => {
        if (!timedOut && this.now() >= deadline.atMs) expire();
        return timedOut;
      },
      dispose: () => clearTimeout(timer),
    };
  }

  private resultSchema: "outcome-v1" | "legacy" = "legacy";

  async run(input: string, options?: RunOptions): Promise<LoopAgentResult> {
    this.resultSchema = options?.resultSchema ?? "legacy";
    const signal = options?.signal;
    const allToolResults: ToolResult[] = [];
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    if (this.initialUsage) { accumulateTokenUsage(totalUsage, this.initialUsage); this.initialUsage = undefined; }
    // Tracks the most recent streamResult.finishReason across iterations so
    // run_ended can report it. Used for diagnostics — in particular, when
    // the loop exits on a plain-text iteration we want to know whether the
    // model hit a length limit (so the `isOutputTokenLimit` allowlist can
    // be tuned) or truly finished.
    let lastFinishReason: string | undefined;
    let steps = 0;
    let modelTurnsUsed = 0;
    // A continuation consumes a normal model turn and never resets this cap
    // after a successful request. Provider retries remain separately bounded.
    let streamContinuations = 0;
    const MAX_STREAM_CONTINUATIONS = 2;
    let toolCallsUsed = 0;
    const initialCache = computeCacheUsageStats(totalUsage);
    let freshInputTokens = initialCache.freshInputTokens + initialCache.cacheCreationInputTokens;
    this.requestMeter = new RequestMeter(this.budget, {
      modelCalls: this.adaptiveBudget?.modelTurns,
      tokens: Math.max(0, this.maxTokens - initialCache.totalPromptInputTokens - totalUsage.outputTokens),
    }, (reported, purpose) => {
      const usage = accumulateTokenUsage(totalUsage, reported);
      const cache = computeCacheUsageStats(usage);
      freshInputTokens += cache.freshInputTokens + cache.cacheCreationInputTokens;
      if (purpose === "maintenance") {
        this.emitter.emit({ type: "run_usage", step: steps, ...usage, purpose });
      }
    });
    const progressTracker = new ToolProgressTracker();
    const budgetHints = { stalled: false };
    let consecutiveNoProgress = 0;
    let workspaceChanged = false;
    let stopped: LoopAgentResult["stopped"];
    const startedAt = this.now();
    this.progressController.resetRoundDurations();
    let localMessages: Message[] = [];

    if (options?.signal?.aborted) {
      this.emitter.emit({ type: "run_started", input });
      this.emitter.emit({ type: "run_ended", steps: 0, usage: totalUsage });
      throw new Error("aborted");
    }

    const errorTracker: ErrorTracker = new Map();
    const seenFiles: SeenFiles = new Map();
    const state: LoopState = createInitialLoopState();
    const toolExecutionHooks = createRunToolExecutionHooks(this.executor, (name, args) => {
      this.emitter.emit({
        type: "observation",
        kind: "duplicate_tool_suppressed",
        detail: { tool: name, target: primaryArgSig(name, args) },
      });
    }, this.taskDecomposition, this.registry.has("todo_write"));
    const beforeTool = toolExecutionHooks.beforeExecute;
    toolExecutionHooks.beforeExecute = (name, args) => {
      const suppressed = beforeTool?.(name, args);
      if (suppressed) return suppressed;
      if (!this.requestMeter!.admitTool()) return { success: false, output: "", error: new BudgetLimitError().message };
      return undefined;
    };
    toolExecutionHooks.backgroundTaskOwner = options?.backgroundTaskOwner;
    const inheritedDeadlineAtMs = earliestDeadlineAt(options?.deadlineAtMs);
    toolExecutionHooks.deadlineAtMs = () => {
      const budget = this.runtimeTimeBudget(startedAt);
      const ownDeadline = budget
        // Preserve a past deadline after suspension; clamping remaining time
        // to zero would move it forward to each new tool's dispatch time.
        ? Date.now() + budget.totalMs - budget.elapsedMs - this.progressController.finalizationReserveMs()
        : undefined;
      return earliestDeadlineAt(inheritedDeadlineAtMs, ownDeadline);
    };

    const addMessage: AddMessage = (msg) => {
      if (this.conversation) {
        this.conversation.add(msg);
      } else {
        localMessages.push(msg);
      }
    };

    /** Atomic turn commit — wire-valid by construction. Replaces the prior
     *  pattern of `addMessage(assistant)` followed by `addMessage(tool_result)`
     *  in a loop that could leave history half-written if anything threw
     *  partway through, or that produced orphans when the assistant turn
     *  was later dropped by `pruneOrphanedToolCalls`. See issue #12 +
     *  zapsdk/core/turn.ts. */
    const commitTurn: CommitTurn = (turn) => {
      if (this.conversation) {
        this.conversation.commitTurn(turn);
      } else {
        for (const msg of turnToMessages(turn)) localMessages.push(msg);
      }
    };

    const prefixOption = options?.contextPrefix;
    const backgroundFacts = this.registry.definitions().flatMap((tool) => tool.backgroundTaskStoreId
      ? [`${tool.name}: ${describeBackgroundTaskLifecycle(backgroundTaskLifecycle(options?.backgroundTaskOwner, tool.backgroundTaskStoreId))}`]
      : []);
    const checkpointFacts = describeCheckpointCoverage(this.registry.definitions(), this.executor.onTrackEdit, this.executor.checkpointMode);
    const dynamicSystemContext = [this.buildDynamicSystemContext(), checkpointFacts, backgroundFacts.length
      ? `[Managed background task lifecycle — Host facts]\n${backgroundFacts.join("\n")}` : undefined]
      .filter((part): part is string => !!part).join("\n\n") || undefined;
    const rawStableContext = typeof prefixOption === "function" ? prefixOption() : prefixOption;
    const stableContext = [dynamicSystemContext, rawStableContext?.trim()]
      .filter((part): part is string => !!part)
      .join("\n\n") || undefined;
    const buildContextDiagnostics = (
      prefix: string | undefined,
      messages: Message[],
    ): ContextDiagnostics => {
      let hostDiagnostics: ContextDiagnostics | undefined;
      try {
        hostDiagnostics = options?.contextDiagnostics?.() ?? undefined;
      } catch (err) {
        console.warn(`[context-diagnostics] threw: ${(err as any)?.message ?? err}`);
      }
      const transient = dynamicSystemContext
        ? this.mergeDynamicContextDiagnostics(prefix ?? "", dynamicSystemContext, hostDiagnostics)
        : hostDiagnostics ?? emptyContextDiagnostics();
      return {
        ...transient,
        conversationCache: buildConversationCacheDiagnostics(messages, this.budgetTokenCounter),
      };
    };
    let lastContextDiagnostics: ContextDiagnostics | undefined;
    this.turnContextPrefix = stableContext;
    let turnStartIndex = 0;
    let contextInsertionIndex = 0;

    // getMessagesRaw returns the budgeted provider view of the persistent
    // conversation, excluding transient per-turn context.
    const getMessagesRaw: GetMessages = () => {
      return this.conversation ? this.conversation.getMessages() : localMessages;
    };

    // getMessagesForMaintenance returns the full persisted conversation,
    // excluding transient context and without the provider-view truncation.
    // Auto-compaction writes its result BACK into conversation, so it must
    // summarize the complete backing history instead of a truncated view.
    const getMessagesForMaintenance: GetMessages = () => {
      return this.conversation ? this.conversation.getAllMessages() : localMessages;
    };

    // Stable RepoMap/memory/run-start runtime context is inserted at one fixed
    // point immediately before this run's user turn. The prefix up to that point is
    // append-only across tool steps, so provider prompt caching can reuse it.
    // Only the small, genuinely-live contextDelta remains at the tail.
    let latestRuntimeTimeBudget: RuntimeTimeBudget | undefined;
    // Reuse successful reductions only for identical host-generated content.
    // A changed live todo/memory delta must always be evaluated afresh.
    const transientReplacements = new Map<string, Message>();
    const transientView = (message: Message): Message => transientReplacements.get(contextFingerprint([message])) ?? message;
    this.retainTransientRecovery = (before, after) => {
      const oldTransient = before.filter(m => m.cache?.transient);
      const newTransient = after.filter(m => m.cache?.transient);
      if (oldTransient.length !== newTransient.length) return;
      oldTransient.forEach((message, index) => {
        if (contextFingerprint([message]) !== contextFingerprint([newTransient[index]])) {
          transientReplacements.set(contextFingerprint([message]), newTransient[index]);
        }
      });
    };
    const localImageRetention = new HistoricalImageRetention();
    const getMessages: GetMessages = () => {
      if (this.conversation) {
        const notice = this.conversation.maintainHistoricalImages();
        if (notice) this.emitter.emit({ type: "observation", kind: "historical_images_retired", detail: notice });
      } else {
        const result = localImageRetention.prepare(localMessages);
        if (result?.retiredGroups) {
          localMessages = result.messages;
          const { messages: _messages, ...notice } = result;
          this.emitter.emit({ type: "observation", kind: "historical_images_retired", detail: notice });
        }
      }
      const base = getMessagesRaw();
      latestRuntimeTimeBudget = this.runtimeTimeBudget(startedAt);
      const hostDelta = options?.contextDelta?.()?.trim();
      const timeBudgetDelta = latestRuntimeTimeBudget
        ? buildRuntimeTimeBudgetContext(latestRuntimeTimeBudget)
        : undefined;
      const inheritedDeadlineDelta = inheritedDeadlineAtMs !== undefined
        ? `[Delegated execution deadline — transient]\nAt most ${Math.max(0, Math.floor(inheritedDeadlineAtMs - Date.now()))}ms remain before the known outer execution deadline. Parent cancellation may stop work earlier. Return available findings and unresolved questions within this window.`
        : undefined;
      const delta = [hostDelta, timeBudgetDelta, inheritedDeadlineDelta]
        .filter((part): part is string => !!part)
        .join("\n\n") || undefined;
      const fullContext = [stableContext, delta]
        .filter((part): part is string => !!part)
        .join("\n\n") || undefined;
      this.turnContextPrefix = fullContext;
      lastContextDiagnostics = buildContextDiagnostics(fullContext, base);

      let providerMessages = base;
      if (stableContext) {
        const totalPersisted = this.conversation
          ? this.conversation.getAllMessages().length
          : base.length;
        const omittedHead = Math.max(0, totalPersisted - base.length);
        let insertionIndex = Math.max(0, Math.min(base.length, contextInsertionIndex - omittedHead));
        while (insertionIndex > 0 && base[insertionIndex]?.role === "tool_result") insertionIndex--;
        const contextMessage = createUserMessage(stableContext);
        contextMessage.cache = { transient: true };
        providerMessages = [
          ...base.slice(0, insertionIndex),
          transientView(contextMessage),
          ...base.slice(insertionIndex),
        ];
      }
      if (!delta) return providerMessages;
      const deltaMessage = createUserMessage(delta);
      deltaMessage.cache = { transient: true };
      return [...providerMessages, transientView(deltaMessage)];
    };

    const replaceMessages: ReplaceMessages = (msgs) => {
      contextInsertionIndex = rebaseMessageBoundary(getMessagesForMaintenance(), msgs, contextInsertionIndex);
      if (this.conversation) {
        this.conversation.clear();
        msgs.forEach((m) => this.conversation!.add(m));
      } else {
        localMessages = msgs;
      }
    };
    this.recoveryContext = (requestMessages) => {
      let revision: string | undefined;
      let canonical: Message[] = [];
      return {
        recoveryMessages: () => {
          canonical = getMessagesForMaintenance();
          revision = contextFingerprint(canonical);
          return requestMessages;
        },
        onRecovered: (recovered, notice) => {
          if (contextFingerprint(getMessagesForMaintenance()) !== revision) {
            throw new Error("Context changed during request recovery; refusing to overwrite newer input");
          }
          this.retainTransientRecovery?.(requestMessages, recovered);
          const merged = mergeRecoveredProviderView(canonical, requestMessages, recovered);
          replaceMessages(merged.messages);
          this.conversation?.setProviderViewStart(merged.viewStart);
          if (stableContext) {
            const prefixIndex = recovered.findIndex(m => m.cache?.transient);
            if (prefixIndex >= 0) contextInsertionIndex = merged.canonicalBoundary(
              recovered.slice(0, prefixIndex).filter(m => !m.cache?.transient).length,
            );
          }
          this.emitter.emit({ type: "observation", kind: "request_recovered", detail: { ...notice } });
        },
      };
    };
    const clearRunCacheHints = (): void => {
      const clear = (msgs: Message[]) => {
        for (const msg of msgs) {
          if (!msg.cache?.skipBreakpoint) continue;
          const next = { ...msg.cache };
          delete next.skipBreakpoint;
          msg.cache = Object.keys(next).length > 0 ? next : undefined;
        }
      };
      if (this.conversation) this.conversation.mutateInPlace(clear);
      else clear(localMessages);
    };

    this.ensureSessionSystemPrompt(addMessage);
    // Historical provider-visible messages are immutable across runs. Large
    // tool results are persisted/compressed before their first commit, while
    // AutoCompact/ReactiveCompact establish an explicit new cache epoch only
    // under genuine context pressure. Age-based rewrites here would make the
    // first request of every follow-up turn miss from the changed result.
    turnStartIndex = this.conversation
      ? this.conversation.getAllMessages().length
      : localMessages.length;
    contextInsertionIndex = turnStartIndex;
    try { await this.onRunStart?.({ turnStartIndex, sessionId: this.sessionId, input }); }
    catch (error) { this.emitter.emit({ type: "observation", kind: "checkpoint_error", detail: { message: String(error) } }); }
    this.addTurnMessages(input, addMessage, options?.images);
    this.emitter.emit({ type: "run_started", input });

    const tools = this.registry.definitions();
    let lastText = "";
    const acceptedSteeringIds = new Set<string>();
    // turnEndGuard fires at most once per run. Second natural finish always
    // exits — prevents infinite loops if the model refuses to comply with
    // the guard's continuation prompt (e.g. keeps saying "done" without
    // calling the tool the guard is asking about).
    let turnEndGuardFired = false;
    // Repetition tracker: signature of the previous step's tool calls + how
    // many consecutive steps have used the same signature. Detects models
    // that get stuck repeatedly editing the same file ("继续完善..." → same
    // edit_file → "继续完善..." → same edit_file → ...). Threshold-fires a
    // forced abort with a friendly explanation; safer than letting it eat
    // through maxSteps. The signature is path/command/etc — not full args
    // — so successive edits to the same file with different content still
    // count as duplicates (which is the case we want to catch).
    let lastStepSignature: string | null = null;
    let repeatStreak = 0;
    let lastProgressPoll: string | undefined;
    const REPEAT_LIMIT = 5;
    const observeProgress = (calls: ToolCallRequest[], results: Map<string, ToolResult>) => {
      const observation = progressTracker.observeRound(calls.map((call) => {
        const effects = this.executor.resolveEffects(call.name, call.arguments);
        return {
          ...call,
          readOnly: this.executor.isReadOnly(call.name, call.arguments),
          mayChangeWorkspace: effects.confidence === "unknown"
            || effects.filesystem.some((effect) => effect.operation !== "read")
            || effects.workspace.mode === "root-integration" || effects.workspace.mode === "isolated-write",
          result: results.get(call.id),
        };
      }));
      consecutiveNoProgress = observation.consecutiveNoProgress;
      workspaceChanged = observation.workspaceChanged;
      this.emitter.emit({ type: "observation", kind: "tool_progress", detail: { ...observation } });
    };
    const forceFinishAndCommit = async (reason: ForceFinishReason): Promise<string> => {
      const forcedText = this.cleanOutput(await this.forceFinish(
        getMessages(),
        totalUsage,
        steps,
        reason,
        startedAt,
        signal,
      ));
      if (forcedText) addMessage({ role: "assistant", content: forcedText });
      return forcedText;
    };

    const recordIncompleteUsage = (event: AgentEvent) => {
      if (event.path?.length) return;
      if (event.type === "content_abandoned") {
        totalUsage.usageIncomplete = true;
        this.budget.chargeFresh(0, true);
      }
      if (event.type === "provider_request" && event.request.phase === "failed") {
        // A failed request has no accounted final usage, even when replay is
        // forbidden or final synthesis fails. Zero denotes unknown usage,
        // not a free request; preserve the reported run counters separately.
        this.budget.chargeFresh(0, true);
        const missing = accumulateTokenUsage(totalUsage, {
          inputTokens: 0, outputTokens: 0, providerUsageReported: false, usageIncomplete: true,
        });
        this.emitter.emit({ type: "run_usage", step: event.step, ...missing });
      }
    };
    this.emitter.on("content_abandoned", recordIncompleteUsage);
    this.emitter.on("provider_request", recordIncompleteUsage);
    try {
      options?.onInputAccepted?.();
      while (true) {
        if (options?.signal?.aborted) throw new Error("aborted");

        // A finished response may exactly consume its budget. Only reject
        // subsequent work, including maintenance and final synthesis.
        if (!this.requestMeter!.canRequest()) {
          stopped = "budget";
          lastText = await forceFinishAndCommit("budget");
          if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
          break;
        }

        // Reserve the final-synthesis window before beginning any more model
        // or tool work. The previous guard ran only after a complete step,
        // allowing a model to start another expensive action at the deadline
        // and leave an outer evaluator no time to receive a final result.
        if (this.progressController.shouldReserveFinalization(startedAt)) {
          stopped = "timeout";
          lastText = await forceFinishAndCommit("timeout");
          if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
          break;
        }

        this.injectBudgetDecision({
          modelTurns: modelTurnsUsed,
          steps,
          toolCalls: toolCallsUsed,
          freshInputTokens,
          consecutiveNoProgress,
          workspaceChanged,
          timeBudget: this.runtimeTimeBudget(startedAt),
        }, addMessage, budgetHints);
        await this.tryAutoCompact(state, getMessagesForMaintenance, replaceMessages, { signal, startedAt });

        // Maintenance may await a remote summarizer past cancellation or the
        // finalization deadline. Do not claim pending input after either one.
        if (options?.signal?.aborted) throw new Error("aborted");
        if (this.progressController.shouldReserveFinalization(startedAt)) {
          stopped = "timeout";
          lastText = await forceFinishAndCommit("timeout");
          if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
          break;
        }

        // Only insert after the entire preceding tool group is committed.
        // Splitting tool_calls from their results violates provider protocols.
        if (options?.takeSteering) {
          for (let count = 0; count < 100; count++) {
            const input = options.takeSteering();
            if (!input) break;
            if (!acceptedSteeringIds.has(input.id)) {
              const message = createUserMessage(input.text, input.images);
              message.cache = { skipBreakpoint: true };
              addMessage(message);
              acceptedSteeringIds.add(input.id);
            }
            options.onSteeringAccepted?.(input);
          }
        }

        const messages = getMessages();
        this.emitter.emit({
          type: "run_step",
          step: steps + 1,
          messageCount: messages.length,
          context: lastContextDiagnostics,
          ...(latestRuntimeTimeBudget ? { timeBudget: latestRuntimeTimeBudget } : {}),
        });

        const roundStartedAt = this.now();
        const recordRoundDuration = () => this.progressController.recordRoundDuration(this.now() - roundStartedAt);
        const stepDeadline = this.createStepDeadlineSignal(startedAt, signal);
        const stepSignal = stepDeadline.signal;
        let streamResult: StreamingToolResult;
        let streamInterruption: InterruptedStreamError | undefined;
        try {
          streamResult = await this.streamWithTools(messages, tools, steps, stepSignal, toolExecutionHooks);
        } catch (err) {
          if (err instanceof InterruptedStreamError) {
            streamInterruption = err;
            streamResult = err.partial;
          } else if (isAbortedStreamError(err) && stepDeadline.timedOut() && !signal?.aborted) {
            streamResult = { ...err.partial, usage: { inputTokens: 0, outputTokens: 0,
              providerUsageReported: false, usageIncomplete: true } };
            streamInterruption = new InterruptedStreamError(err, streamResult, false);
          } else if (stepDeadline.timedOut()) {
            stopped = "timeout";
            lastText = await forceFinishAndCommit("timeout");
            if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
            break;
          } else if (this.isContextError(err)) {
            const attemptedCompact = await this.tryAutoCompact(
              state,
              getMessagesForMaintenance,
              replaceMessages,
              { force: true, signal: stepSignal, startedAt },
            );
            if (stepDeadline.timedOut() && !signal?.aborted) {
              stopped = "timeout";
              lastText = await forceFinishAndCommit("timeout");
              if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
              break;
            }
            const retryAfterReactiveCompact = async (sourceErr: unknown): Promise<StreamingToolResult> => {
              try {
                const recovered = await this.tryStreamAfterReactiveCompact(
                  getMessages,
                  getMessagesForMaintenance,
                  replaceMessages,
                  tools,
                  steps,
                  stepSignal,
                  toolExecutionHooks,
                );
                if (!recovered) throw this.makeFriendlyOverflowError(sourceErr);
                return recovered;
              } catch (recoveryErr) {
                if (this.isContextError(recoveryErr)) {
                  throw this.makeFriendlyOverflowError(recoveryErr);
                }
                throw recoveryErr;
              }
            };
            if (!attemptedCompact) {
              streamResult = await retryAfterReactiveCompact(err);
            } else {
              try {
                streamResult = await this.streamWithTools(getMessages(), tools, steps, stepSignal, toolExecutionHooks);
              } catch (retryErr) {
                // Still overflowing after a compact pass — try a final local
                // reactive compact, then surface a friendly overflow if it
                // cannot shrink either the persistent or transient context.
                if (this.isContextError(retryErr)) {
                  streamResult = await retryAfterReactiveCompact(retryErr);
                } else {
                  throw retryErr;
                }
              }
            }
          } else if (this.tryImageStripSelfHeal(err, state, messages)) {
            // Image schema rejection resolves an unknown capability or
            // overrides a positive capability hint. Flip the provider to
            // strip mode and retry once. The original Message[] is left
            // intact so switching to a vision-capable model later still
            // shows the image.
            try {
              streamResult = await this.streamWithTools(getMessages(), tools, steps, stepSignal, toolExecutionHooks);
            } catch (retryErr) {
              if (looksLikeImageContentRejection(retryErr instanceof Error ? retryErr.message : String(retryErr))) {
                // Strip didn't take effect — same error a second time. Fail
                // hard with a friendly message rather than spinning forever.
                throw new Error(
                  "This provider rejected an image even after stripping. " +
                  "Switch to a vision-capable model via /model, or remove the image and start a new turn."
                );
              }
              throw retryErr;
            }
          } else {
            throw err;
          }
        } finally {
          stepDeadline.dispose();
        }

        if (stepDeadline.timedOut() && !streamInterruption) {
          // A delayed timer can fire only after the provider/tools settled.
          // Persist those observations and usage through the interruption path
          // before finalizing; do not execute buffered XML or discard results.
          streamInterruption = new InterruptedStreamError(
            new DOMException("Provider execution deadline exceeded", "AbortError"), streamResult, false);
        }

        const usage = sanitizeTokenUsage(streamResult.usage);
        modelTurnsUsed = this.requestMeter!.calls;
        const cacheUsage = computeCacheUsageStats(usage);
        const promptInputTokens = cacheUsage.totalPromptInputTokens;
        const budgetHasTokens = !this.requestMeter!.blocked && (this.budget.maxTokens === 0 || this.budget.tokensUsed <= this.budget.maxTokens);
        // Emit real per-call token counts so UI can show accurate context usage.
        // inputTokens here is fresh/miss prompt input; cached prompt input is
        // reported separately below. The sum is still far more accurate than
        // local char estimates for context-window occupancy.
        // Cache numbers flow through too: cacheReadInputTokens are bytes served
        // from the prompt cache and cacheCreationInputTokens are bytes written
        // to it. Both count against the context window even though they cost
        // less than fresh input — the UI must sum all three to render an
        // accurate "context used" indicator. Emit the event whenever ANY of
        // the three is non-zero (with caching, fresh inputTokens can be near-
        // zero on subsequent turns and the old `> 0` guard would skip the
        // emit, freezing the indicator at a stale value).
        const cacheReadReported = typeof usage.cacheReadInputTokens === "number";
        const cacheCreateReported = typeof usage.cacheCreationInputTokens === "number";
        const cacheMissReported = typeof usage.cacheMissInputTokens === "number";
        const cacheRead = usage.cacheReadInputTokens ?? 0;
        const cacheCreate = usage.cacheCreationInputTokens ?? 0;
        if (this.shouldEmitUsage(usage, cacheReadReported || cacheCreateReported || cacheMissReported)) {
          this.emitter.emit({
            type: "run_usage",
            step: steps,
            inputTokens: usage.inputTokens,
            ...(totalUsage.usageIncomplete ? { usageIncomplete: true } : {}),
            ...(typeof usage.providerUsageReported === "boolean"
              ? { providerUsageReported: usage.providerUsageReported }
              : {}),
            ...(cacheReadReported ? { cacheReadInputTokens: cacheRead } : {}),
            ...(cacheCreateReported ? { cacheCreationInputTokens: cacheCreate } : {}),
            ...(cacheMissReported ? { cacheMissInputTokens: usage.cacheMissInputTokens } : {}),
            outputTokens: usage.outputTokens,
            finishReason: streamResult.finishReason,
          });
        }
        const { text, textId, toolCalls, results, finishReason } = streamResult;
        lastFinishReason = finishReason;
        if (toolCalls.length > 0) recordRoundDuration();

        if (streamInterruption) {
          // Persist the interrupted turn before deciding whether another
          // request is allowed. No partial text reaches the XML executor.
          steps++;
          if (toolCalls.length > 0) {
            toolCallsUsed += toolCalls.length;
            observeProgress(toolCalls, results);
            this.processNativeToolCalls(toolCalls, textId, results, text, commitTurn,
              allToolResults, errorTracker, seenFiles, streamResult.textFinalEmitted, streamResult.raw);
          } else {
            recordRoundDuration();
            const partialText = this.cleanOutput(text);
            if (partialText) {
              addMessage({ role: "assistant", content: partialText, raw: streamResult.raw });
              if (!streamResult.textFinalEmitted) this.emitter.emit({ type: "content_final", kind: "text",
                id: textId ?? nextContentId("tx"), text: partialText });
            }
          }
          addMessage(createRunLocalUserMessage(
            "[Provider response interrupted. The preceding assistant text is incomplete. " +
            "Tool results record what actually ran; no buffered text or incomplete tool arguments were executed. " +
            "Continue from these observations and check uncertain effects before repeating an operation.]",
          ));
          if (signal?.aborted) throw new Error("aborted");
          const cause = streamInterruption.cause;
          if (!stepDeadline.timedOut() && (!streamInterruption.canContinue || !(cause instanceof Error)
            || !isRetryableProviderError(cause) || streamContinuations >= MAX_STREAM_CONTINUATIONS)) {
            throw streamInterruption;
          }
          const tokens = computeCacheUsageStats(totalUsage).totalPromptInputTokens + totalUsage.outputTokens;
          const stop = stepDeadline.timedOut() || this.progressController.shouldReserveFinalization(startedAt)
            ? "timeout" : !budgetHasTokens || this.budget.stepsRemaining === 0 || this.budget.tokensRemaining === 0 ? "budget"
              : steps >= this.maxSteps || modelTurnsUsed >= this.maxSteps ? "max_steps"
                : tokens >= this.maxTokens ? "max_tokens" : undefined;
          if (stop) {
            stopped = stop;
            if (stop === "budget" || stop === "max_tokens") {
              lastText = "Budget exhausted after an interrupted provider response. Tool results have been saved; work remains incomplete.";
              addMessage({ role: "assistant", content: lastText });
            } else {
              lastText = await forceFinishAndCommit(stop);
            }
            if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
            break;
          }
          streamContinuations++;
          this.emitter.emit({ type: "observation", kind: "provider_stream_continuation",
            detail: { attempt: streamContinuations, maxContinuations: MAX_STREAM_CONTINUATIONS,
              toolCalls: toolCalls.length, usageIncomplete: totalUsage.usageIncomplete === true } });
          continue;
        }

        if (!budgetHasTokens) {
          if (toolCalls.length === 0) recordRoundDuration();
          stopped = "budget";
          if (toolCalls.length > 0) {
            steps++;
            this.processNativeToolCalls(toolCalls, textId, results, text, commitTurn, allToolResults, errorTracker, seenFiles, streamResult.textFinalEmitted, streamResult.raw);
          }
          lastText = toolCalls.length > 0
            ? "Token budget exhausted after this tool step; stopping before another model call."
            : (this.cleanOutput(text).trim() || "Token budget exhausted; stopping before another model call.");
          addMessage({ role: "assistant", content: lastText });
          this.emitter.emit({
            type: "content_final",
            kind: "text",
            id: toolCalls.length > 0 ? nextContentId("tx") : (textId ?? nextContentId("tx")),
            text: lastText,
          });
          break;
        }

        if (toolCalls.length === 0 && this.handleOutputTokenLimit(state, text, finishReason, addMessage)) {
          recordRoundDuration();
          continue;
        }
        state.maxOutputTokensRecoveryCount = 0;

        if (toolCalls.length === 0) {
          const xmlResultStart = allToolResults.length;
          const xmlDeadline = this.createStepDeadlineSignal(startedAt, signal);
          let hadXml: ToolCallRequest[] | undefined;
          try {
            hadXml = await this.processXmlToolCalls(text, textId, steps, commitTurn, allToolResults, errorTracker, seenFiles, xmlDeadline.signal, streamResult.raw, toolExecutionHooks);
          } catch (error) {
            if (!xmlDeadline.timedOut()) throw error;
            stopped = "timeout";
            lastText = await forceFinishAndCommit("timeout");
            if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
            break;
          } finally {
            xmlDeadline.dispose();
          }
          if (!xmlDeadline.timedOut()) recordRoundDuration();
          if (hadXml) {
            steps++;
            const calls = hadXml;
            toolCallsUsed += calls.length;
            observeProgress(calls, new Map(calls.map((call, index) => [call.id, allToolResults[xmlResultStart + index]!])));
          } else {
            lastText = this.cleanOutput(text);
            let finalTextId = textId;
            // If LLM returned empty/whitespace text after doing work, force a summary.
            // forceFinish is a separate LLM call with no streaming, so mint a fresh id.
            if (!lastText.trim() && steps > 0) {
              lastText = this.cleanOutput(await this.forceFinish(
                getMessages(),
                totalUsage,
                steps,
                "empty_output",
                startedAt,
                signal,
              ));
              finalTextId = nextContentId("tx");
            }
            // Attach stream sidecar (reasoning_content etc) even on text-only
            // final turns. DeepSeek V4's thinking mode requires the key to be
            // present on EVERY assistant message once the conversation has seen
            // any tool_calls — absence (not just empty) triggers a 400. Docs
            // say "no tool_calls → reasoning_content ignored", but in practice
            // "ignored" means "tolerated if present", not "optional".
            addMessage({ role: "assistant", content: lastText, raw: streamResult.raw });
            if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: finalTextId ?? nextContentId("tx"), text: lastText });

            // A Steer may arrive while final output streams. Claim it at the
            // next budget-checked boundary, not after the run has ended.
            if (options?.hasSteering?.()) {
              const totalTokens = computeCacheUsageStats(totalUsage).totalPromptInputTokens + totalUsage.outputTokens;
              if (totalTokens >= this.maxTokens) {
                stopped = "max_tokens";
                break;
              }
              continue;
            }

            // One-shot turn-end guard. Call AFTER committing the assistant
            // reply so the subsequent LLM turn sees a proper assistant→user
            // alternation. If the guard returns a non-empty string, inject
            // it as a synthetic user message and keep the loop going.
            //
            // Gate on `lastText` non-empty: if the model produced nothing
            // this iteration (whitespace-only and `steps === 0` so the
            // forceFinish fallback above didn't fire), committing a user
            // continuation after an empty assistant message yields an
            // `assistant("")` → `user(...)` shape some providers reject.
            // Skip the guard in that corner — the empty reply is already
            // pathological; let the turn end cleanly.
            if (lastText && !turnEndGuardFired && options?.turnEndGuard
              && this.budget.canUseStep() && steps < this.maxSteps
              && computeCacheUsageStats(totalUsage).totalPromptInputTokens + totalUsage.outputTokens < this.maxTokens
              && !this.progressController.shouldReserveFinalization(startedAt)) {
              let continuation: string | null | undefined;
              const guardDeadline = this.createStepDeadlineSignal(startedAt, signal);
              let rejectOnAbort: (() => void) | undefined;
              try {
                const abortPromise = new Promise<never>((_, reject) => {
                  rejectOnAbort = () => reject(new Error("turn-end guard aborted"));
                  guardDeadline.signal?.addEventListener("abort", rejectOnAbort, { once: true });
                  if (guardDeadline.signal?.aborted) rejectOnAbort();
                });
                continuation = await Promise.race([options.turnEndGuard({
                  text: lastText, steps, totalUsage, toolResults: [...allToolResults],
                }, guardDeadline.signal), abortPromise]);
              } catch (err) {
                if (signal?.aborted) throw new Error("aborted");
                if (guardDeadline.timedOut()) {
                  stopped = "timeout";
                  break;
                }
                console.warn(`[turn-end-guard] threw: ${(err as any)?.message ?? err}`);
              } finally {
                if (rejectOnAbort) guardDeadline.signal?.removeEventListener("abort", rejectOnAbort);
                guardDeadline.dispose();
              }
              const trimmed = continuation?.trim();
              if (trimmed) {
                turnEndGuardFired = true;
                addMessage(createRunLocalUserMessage(trimmed));
                this.emitter.emit({
                  type: "observation",
                  kind: "turn_end_guard_fired",
                  detail: { step: steps, continuationPreview: trimmed.slice(0, 120) },
                });
                continue;
              }
            }

            break;
          }
        } else {
          steps++;
          toolCallsUsed += toolCalls.length;
          observeProgress(toolCalls, results);
          this.processNativeToolCalls(toolCalls, textId, results, text, commitTurn, allToolResults, errorTracker, seenFiles, streamResult.textFinalEmitted, streamResult.raw);
          // Repetition guard. Compute a stable per-step signature from the
          // tool calls (sorted, with complete argument identities). If the same signature
          // recurs REPEAT_LIMIT times in a row, force-finish the run so the
          // user sees a synthesized summary rather than a red error toast.
          //
          // Steps composed entirely of repeat-friendly tools (edit_file,
          // multi_edit, todo_write) reset the tracker — those tools are
          // progressive by design (iterating edits on one file or syncing
          // the todo list).
          const poll = progressPollSignature(toolCalls, results);
          if (isRepeatFriendlyStep(toolCalls) || isLiveTaskWait(toolCalls, results)) {
            lastStepSignature = null;
            repeatStreak = 0;
            lastProgressPoll = undefined;
          } else if (poll !== undefined && poll !== lastProgressPoll) {
            // The same poll command observed new output (for example a build
            // log advanced). Count that as real progress; do not turn it into
            // a max_repeat abort merely because its command string is stable.
            lastStepSignature = null;
            repeatStreak = 0;
            lastProgressPoll = poll;
          } else {
            if (poll === undefined) lastProgressPoll = undefined;
            const sig = stepSignature(toolCalls);
            if (sig === lastStepSignature) {
              repeatStreak++;
              if (repeatStreak >= REPEAT_LIMIT) {
                stopped = "max_repeat";
                lastText = await forceFinishAndCommit("max_repeat");
                if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
                break;
              }
            } else {
              lastStepSignature = sig;
              repeatStreak = 1;
            }
          }
        }

        // waitForCompression removed — AutoCompact (top of loop) is now
        // the authoritative summarization path, and ConversationManager's
        // own compress() was a no-op without a wired summarizer. Running
        // both created unpredictable ordering and made "why did my history
        // shrink" bug reports hard to trace. The sync truncation in
        // ConversationManager.add still runs as a safety net when over the
        // hard token ceiling.

        if (steps >= this.maxSteps) {
          stopped = "max_steps";
          lastText = await forceFinishAndCommit("max_steps");
          if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
          break;
        }

        const totalTokens = computeCacheUsageStats(totalUsage).totalPromptInputTokens + totalUsage.outputTokens;
        if (totalTokens >= this.maxTokens) {
          stopped = "max_tokens";
          lastText = await forceFinishAndCommit("max_tokens");
          if (lastText) this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
          break;
        }

      }
    } catch (err) {
      // A closed meter is admission state, not the cause of this exception.
      // Cancellation must preserve partial tool results through abort recovery,
      // and unrelated provider failures must not become successful budget stops.
      if (err instanceof BudgetLimitError && !signal?.aborted) {
        stopped = "budget";
        lastText = new BudgetLimitError().message;
        addMessage({ role: "assistant", content: lastText });
        this.emitter.emit({ type: "content_final", kind: "text", id: nextContentId("tx"), text: lastText });
      } else {
      if (signal?.aborted && !isAbortedStreamError(err)) {
        err = new Error("aborted", { cause: err });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message === "aborted") {
        let committedInterruptedToolTurn = false;
        // Preserve what the model managed to emit before Ctrl+C so the next
        // turn can resume. Without this, conversation history contains a user
        // message followed by no assistant reply — the model then re-plans
        // from scratch on every "continue", producing a pile of near-identical
        // thinking blocks. A native stream abort can also carry tool calls
        // that launched before cancellation; commit those first so their real
        // results stay paired. The XML path commits its tool turn before it
        // throws and therefore never reaches this native recovery branch.
        if (isAbortedStreamError(err)) {
          const { text, thinking, toolCalls, results } = err.partial;
          if (toolCalls.length > 0) {
            this.processNativeToolCalls(
              toolCalls,
              err.partial.textId,
              results,
              text,
              commitTurn,
              allToolResults,
              errorTracker,
              seenFiles,
              err.partial.textFinalEmitted,
              err.partial.raw,
            );
            steps++;
            committedInterruptedToolTurn = true;
          }
          const cleaned = this.cleanOutput(text).trim();
          const trimmedThinking = thinking.trim();
          const resumeHint = cleaned
            || (trimmedThinking
              ? `[Interrupted mid-thought — I was planning: ${truncate(trimmedThinking, 400)}]`
              : null);
          if (resumeHint && !committedInterruptedToolTurn) {
            addMessage({ role: "assistant", content: resumeHint });
          }
        }
        // Inject an explicit user-role marker so the NEXT turn's LLM call
        // sees "the user intentionally hit the brakes" instead of having to
        // infer it from a truncated assistant reply or a tool_result that
        // says "aborted before this tool was executed". Without this the
        // model often misreads abort as a network blip / its own completion
        // and either continues the half-finished thought verbatim or
        // re-issues the aborted tool — both ignore the user's "stop" signal.
        // Matches the pattern Claude Code uses ("[Request interrupted by user]")
        // so model output trained on that shape transfers cleanly.
        addMessage(createRunLocalUserMessage("[Request interrupted by user]"));
      } else {
        this.emitter.emit({ type: "error", step: steps, error: message });
      }
      throw err;
      }
    } finally {
      this.requestMeter?.close();
      this.emitter.off("content_abandoned", recordIncompleteUsage);
      this.emitter.off("provider_request", recordIncompleteUsage);
      if (this.onRunEnd) {
        try {
          await this.onRunEnd({ turnStartIndex, sessionId: this.sessionId });
        } catch (err) {
          console.warn(`[checkpoint] onRunEnd failed: ${(err as any)?.message ?? err}`);
        }
      }
      this.emitter.emit({ type: "run_ended", steps, usage: totalUsage, stopped, finishReason: lastFinishReason });
      this.turnContextPrefix = undefined;
      this.recoveryContext = undefined;
      this.retainTransientRecovery = undefined;
      clearRunCacheHints();
    }

    return {
      text: this.cleanOutput(lastText),
      steps,
      toolResults: allToolResults,
      totalUsage,
      stopped,
    };
  }

  // ─── Run helpers ───────────────────────────────────────────────────────────

  /** Runtime-owned protocol, folded into the current system prefix (or the
   * legacy first user turn without a host prompt/profile). Exposed so host
   * diagnostics can hash the actual protocol without reconstructing it. */
  protocolPrompt(): string {
    const toolNames = this.registry.definitions().map((t) => t.name).join(", ");
    if (this.promptProfile === "concise") {
      return conciseAgentProtocol(toolNames, this.maxSteps, this.taskDecomposition === "required");
    }
    return (
      `[AGENT PROTOCOL]\n` +
      `Tools: ${toolNames}\n` +
      `Budget: ${this.maxSteps} steps\n` +
      `Rules:\n` +
      `- Think before acting. For a non-trivial tool task, decompose it with todo_write before implementation: 3-5 ordered, observable items; one in_progress; each has acceptanceCriteria; include an early minimal end-to-end probe and a contingency for a slow/blocked dependency; final item is a concrete verification.\n` +
      `- Search/scan first, then targeted reads. Don't read every file.\n` +
      `- For recovery or forensics tasks, preserve the original input before running a parser, database client, or repair command that could mutate it.\n` +
      `- Reuse prior read/search results while the workspace is unchanged; do not repeat them through bash/grep/sed.\n` +
      `- Manage the available budget from observed progress, remaining work, and verification needs. Follow any transient Harness budget decision and its reason code; do not assume a fixed number of steps fits every task.\n` +
      `- After writing code, run it. Check actual output against explicit expectations; printing output or compiling successfully is not a correctness check. Preserve failed assertions and distinguish confirmed facts from hypotheses. Use structured check steps when available to record self-check results.\n` +
      `- ${DELIVERABLE_SCOPE_GUIDANCE}\n` +
      `- Establish an independently checked end-to-end baseline before optimizing size, speed, or representation. Keep that baseline available so each optimization can be compared against it. Final constraints still apply to the delivered artifact.\n` +
      `- For an unfamiliar format or algorithm, obtain a trustworthy reference or specification when available. Validate intermediate results at the earliest divergence; plausible outputs and matching dimensions do not establish correctness. Keep exploratory dependencies separate from the final deliverable's dependency constraints.\n` +
      `- When a check fails, identify the competing explanations and run a small test that distinguishes them before changing more code. Record which hypothesis changed and whether the result improved; do not cycle through variants without new evidence.\n` +
      `- If a tool fails, read the error carefully. Fix the cause, don't blindly retry.\n` +
      `- For a build or test failure, diagnose the cause and retry after a relevant change to source, command arguments, configuration, or dependencies. The same output target does not make a corrected invocation a duplicate.\n` +
      `- Use web_search results directly when snippets contain enough info. Only http_fetch when you need full page content.`
    );
  }

  /** Ensure session-level system prompt is present (idempotent). Called
   *  before `turnStartIndex` is captured so rewind never drops it.
   *  Folds the AGENT PROTOCOL into the same message — MiniMax (and some
   *  other OpenAI-compat providers) reject two consecutive system messages
   *  with "invalid chat setting (2013)". */
  private ensureSessionSystemPrompt(addMessage: AddMessage): void {
    const combined = this.effectiveSystemPrompt();
    if (!combined) return;
    const [cacheablePrefix] = splitAtBoundary(combined);
    if (!cacheablePrefix) return;
    if (this.conversation) {
      this.conversation.mutateTurnsInPlace((turns) => {
        const systemTurn: Turn = { kind: "system", content: cacheablePrefix };
        let leadingSystemEnd = 0;
        while (turns[leadingSystemEnd]?.kind === "system") leadingSystemEnd++;
        turns.splice(0, turns.length, systemTurn, ...turns.slice(leadingSystemEnd));
      });
    } else {
      addMessage(createSystemMessage(cacheablePrefix));
    }
  }

  /** Move volatile environment data behind the reusable conversation prefix.
   *  Leaving it inside the leading system message only protects Anthropic's
   *  first system breakpoint; OpenAI auto-prefix caching and Anthropic's
   *  later tool/history breakpoints still include those changing bytes. */
  private buildDynamicSystemContext(): string | undefined {
    const prompt = this.effectiveSystemPrompt();
    if (!prompt) return undefined;
    const [, dynamicPart] = splitAtBoundary(prompt);
    const dynamic = stripBoundary(dynamicPart).trim();
    if (!dynamic) return undefined;
    return [
      '<system-context source="runtime_environment">',
      dynamic,
      "</system-context>",
    ].join("\n");
  }

  private mergeDynamicContextDiagnostics(
    fullText: string,
    dynamicText: string,
    host: ContextDiagnostics | undefined,
  ): ContextDiagnostics {
    return {
      totalChars: countCodePoints(fullText),
      estimatedTokens: this.budgetTokenCounter.countText(fullText),
      hash: shortContextHash(fullText),
      segments: [
        {
          name: "runtime_environment",
          chars: countCodePoints(dynamicText),
          estimatedTokens: this.budgetTokenCounter.countText(dynamicText),
          hash: shortContextHash(dynamicText),
          meta: { source: "system_prompt_dynamic_suffix" },
        },
        ...(host?.segments ?? []),
      ],
    };
  }

  /** Append this turn's messages. Called after `turnStartIndex` is captured
   *  so `truncateAfter(turnStartIndex)` cleanly reverts the whole turn.
   *
   *  AGENT PROTOCOL placement, by case:
   *   - systemPrompt configured: ensureSessionSystemPrompt folded the
   *     protocol into the session system message. It rides along on every
   *     API request. No per-turn re-injection — saves tokens and keeps
   *     prompt cache prefix stable.
   *   - systemPrompt empty (rare): no system message exists. Inject the
   *     protocol as a user-role message ONCE on the first turn, so the
   *     model knows about tools/rules. Subsequent turns rely on
   *     conversation history to keep the (now-historical) protocol visible.
   *
   *  Previous behavior re-emitted the protocol every non-first turn —
   *  ~300 tokens per turn waste + cache miss + history clutter. Removed
   *  in favor of trusting the system message; rule following appears
   *  unaffected for Anthropic and OpenAI-compat providers tested so far. */
  private addTurnMessages(input: string, addMessage: AddMessage, images?: import("../core/types.js").ImageContent[]): void {
    const existing = this.conversation?.getAllMessages() ?? [];
    const hasPriorUserTurn = existing.some((m) => m.role === "user");
    const hasSystem = existing.some((m) => m.role === "system");
    if (!hasPriorUserTurn && !hasSystem) {
      addMessage(createUserMessage(this.protocolPrompt()));
    }
    addMessage(createRunLocalUserMessage(input, images));
  }

  /** Inject a cache-tail budget decision without mutating the stable protocol. */
  private injectBudgetDecision(observation: ProgressObservation, addMessage: AddMessage, hints: { stalled: boolean }): BudgetDecision {
    if (observation.consecutiveNoProgress < 3) hints.stalled = false;
    if (!this.adaptiveBudget) {
      const warning = this.progressController.stepWarning(observation.steps);
      if (warning) addMessage(createRunLocalUserMessage(warning));
      return this.progressController.decide(observation);
    }
    const decision = this.progressController.decide(observation);
    if (decision.action === "continue" && decision.reasonCode !== "stalled_progress") return decision;
    this.emitter.emit({
      type: "observation",
      kind: "budget_decision",
      detail: { ...decision },
    });
    if (decision.reasonCode === "stalled_progress") {
      if (hints.stalled) return decision;
      hints.stalled = true;
      addMessage(createRunLocalUserMessage(
        "[Harness observation — repeated tool results]\n" +
        "Recent tool rounds have not produced new recorded observations. This does not establish task failure or require you to finish. " +
        "Use the actual results to decide whether to continue, change a hypothesis, or run a focused diagnostic. " +
        "Separate confirmed facts from untested assumptions. A successful command is not proof that its output is correct.",
      ));
      return decision;
    }
    const action = decision.action === "finalize"
      ? "Finalize with the evidence already observed; do not start new tool work."
      : "Converge: stop broad exploration, finish the smallest remaining user-requested work, and verify any changed workspace before answering.";
    addMessage(createRunLocalUserMessage(
      `[Harness budget decision — ${decision.action}]\n` +
      `Reason code: ${decision.reasonCode}.\n` +
      `Remaining model turns: ${decision.remainingModelTurns}; convergence reserve: ${decision.convergenceReserve}.\n` +
      `${decision.remainingToolCalls === undefined ? "" : `Remaining tool calls: ${decision.remainingToolCalls}.\n`}` +
      `${decision.remainingFreshInputTokens === undefined ? "" : `Remaining fresh input tokens: ${decision.remainingFreshInputTokens}.\n`}` +
      action,
    ));
    return decision;
  }

  /** Run AutoCompact if the context is large enough and has grown meaningfully
   *  since the previous attempt. Returns true when a compact attempt happened. */
  private async tryAutoCompact(
    state: LoopState,
    getMessages: GetMessages,
    replaceMessages: ReplaceMessages,
    options: { force?: boolean; signal?: AbortSignal; startedAt?: number } = {},
  ): Promise<boolean> {
    // Circuit breaker: after N consecutive failures, stop trying. Otherwise
    // a flaky summarizer wedges the agent in an infinite "try to compact,
    // fail, hit ceiling again" loop.
    if (state.consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      return false;
    }

    const msgs = getMessages();

    // Char threshold catches English-heavy / code conversations; the
    // token threshold catches CJK-heavy conversations where 1 token can be
    // <2 chars — without the second check, Chinese conversations hit the
    // model's real token ceiling before the char threshold trips, and the
    // next API call fails with `context length exceeded`.
    const byChars = this.autoCompact.shouldCompact(msgs);
    const tokenEstimate = this.currentAutoCompactTokenEstimate(msgs);
    const byTokens =
      this.autoCompactTokenThreshold !== undefined &&
      tokenEstimate > this.autoCompactTokenThreshold;

    if (!options.force && !byChars && !byTokens) return false;
    if (!this.shouldAttemptAutoCompactAgain(state, tokenEstimate, this.autoCompact.totalChars(msgs))) {
      return false;
    }
    state.hasAttemptedAutoCompact = true;

    const charCount = this.autoCompact.totalChars(msgs);
    const messageCount = msgs.length;
    state.lastAutoCompactAttemptTokens = tokenEstimate;
    state.lastAutoCompactAttemptChars = charCount;
    this.emitter.emit({
      type: "observation",
      kind: "autocompact_start",
      detail: { charCount, tokenEstimate, messageCount, trigger: byTokens ? "tokens" : "chars" },
    });

    const deadline = options.startedAt === undefined ? undefined : this.createStepDeadlineSignal(options.startedAt, options.signal);
    const compactSignal = deadline?.signal ?? options.signal;
    try {
      const { messages: compacted, summary, failureReason } = await this.autoCompact.compact(
        msgs,
        this.meterProvider(this.summarizer ?? this.provider, "maintenance"),
        { signal: compactSignal, deadline: compactSignal ? this.providerDeadlines.get(compactSignal) : undefined },
      );
      if (!summary.trim()) {
        throw new Error(failureReason ?? "autocompact produced no usable summary");
      }

      // Reuse successful historical read results within remaining headroom.
      // Fresh filesystem reads always go through the authorized tool boundary.
      const restored = await restoreRecentFiles(msgs, { counter: this.budgetTokenCounter,
        maxTokens: Math.min(2048, Math.max(0, (this.autoCompactTokenThreshold ?? this.contextWindow ?? 0)
          - this.reservedOutputTokens - this.budgetTokenCounter.countMessages(compacted))) });
      const finalMessages = restored
        ? [...compacted, createRunLocalUserMessage(restored)]
        : compacted;

      replaceMessages(finalMessages);
      state.lastAutoCompactAfterTokens = this.currentAutoCompactTokenEstimate(finalMessages);
      state.lastAutoCompactAfterChars = this.autoCompact.totalChars(finalMessages);
      state.consecutiveAutoCompactFailures = 0; // success — reset breaker
      this.emitter.emit({
        type: "observation",
        kind: "autocompact_done",
        detail: {
          summary,
          messagesBefore: messageCount,
          messagesAfter: finalMessages.length,
          filesRestored: restored ? (restored.match(/^### /gm)?.length ?? 0) : 0,
        },
      });
    } catch (err) {
      state.consecutiveAutoCompactFailures++;
      state.lastAutoCompactAfterTokens = tokenEstimate;
      state.lastAutoCompactAfterChars = charCount;
      this.emitter.emit({
        type: "observation",
        kind: "autocompact_done",
        detail: {
          summary: "",
          messagesBefore: messageCount,
          messagesAfter: messageCount,
          failed: true,
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures: state.consecutiveAutoCompactFailures,
          breakerTripped:
            state.consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        },
      });
      // Don't re-throw — let the next LLM call try, possibly hitting
      // ReactiveCompact as a last resort.
    } finally {
      deadline?.dispose();
    }
    return true;
  }

  private shouldAttemptAutoCompactAgain(state: LoopState, tokenEstimate: number, charCount: number): boolean {
    if (!state.hasAttemptedAutoCompact) return true;

    const tokenBaseline = state.lastAutoCompactAfterTokens ?? state.lastAutoCompactAttemptTokens;
    if (tokenBaseline !== undefined && tokenEstimate > 0) {
      const minTokenGrowth = Math.max(
        4096,
        Math.floor((this.autoCompactTokenThreshold ?? (Number.isFinite(this.maxTokens) ? this.maxTokens : 0)) * 0.1),
      );
      if (tokenEstimate >= tokenBaseline + minTokenGrowth) return true;
    }

    const charBaseline = state.lastAutoCompactAfterChars ?? state.lastAutoCompactAttemptChars;
    if (charBaseline !== undefined) {
      const minCharGrowth = Math.max(16_384, Math.floor(this.autoCompactCharThreshold * 0.1));
      if (charCount >= charBaseline + minCharGrowth) return true;
    }

    return false;
  }

  private tryReactiveCompact(
    getMessagesForMaintenance: GetMessages,
    replaceMessages: ReplaceMessages,
  ): boolean {
    const before = getMessagesForMaintenance();
    const { messages: compacted, compacted: didCompact } = this.reactiveCompact.compactMessages(before, this.budgetTokenCounter);
    if (!didCompact) return false;
    replaceMessages(compacted);
    this.emitter.emit({
      type: "observation",
      kind: "reactive_compact",
      detail: {
        mode: "local",
        messagesBefore: before.length,
        messagesAfter: compacted.length,
        charsBefore: this.autoCompact.totalChars(before),
        charsAfter: this.autoCompact.totalChars(compacted),
      },
    });
    return true;
  }

  private async tryStreamAfterReactiveCompact(
    getMessages: GetMessages,
    getMessagesForMaintenance: GetMessages,
    replaceMessages: ReplaceMessages,
    tools: import("../tools/types.js").ToolDefinition[],
    steps: number,
    signal?: AbortSignal,
    executionHooks?: ToolExecutionHooks,
  ): Promise<StreamingToolResult | null> {
    if (this.tryReactiveCompact(getMessagesForMaintenance, replaceMessages)) {
      return this.streamWithTools(getMessages(), tools, steps, signal, executionHooks);
    }

    const providerView = getMessages();
    const { messages: compacted, compacted: didCompact } = this.reactiveCompact.compactMessages(providerView, this.budgetTokenCounter);
    if (!didCompact) return null;
    this.emitter.emit({
      type: "observation",
      kind: "reactive_compact",
      detail: {
        mode: "provider_view",
        messagesBefore: providerView.length,
        messagesAfter: compacted.length,
        charsBefore: this.autoCompact.totalChars(providerView),
        charsAfter: this.autoCompact.totalChars(compacted),
      },
    });
    const result = await this.streamWithTools(compacted, tools, steps, signal, executionHooks);
    this.retainTransientRecovery?.(providerView, compacted);
    return result;
  }

  private currentAutoCompactTokenEstimate(messages: Message[]): number {
    return this.conversation?.estimatedTokens ?? this.budgetTokenCounter.countMessages(messages);
  }

  /**
   * Handle max_output_tokens recovery (only relevant when there are no tool calls).
   * Returns true if a recovery message was injected and the caller should `continue`.
   */
  private handleOutputTokenLimit(
    state: LoopState,
    text: string,
    finishReason: string | undefined,
    addMessage: AddMessage,
  ): boolean {
    if (!isOutputTokenLimit(finishReason) || state.maxOutputTokensRecoveryCount >= this.maxOutputTokensRecoveries) {
      return false;
    }
    // toolCalls.length === 0 is guaranteed by caller
    state.maxOutputTokensRecoveryCount++;
    const hasVisibleText = text.trim().length > 0;
    // A reasoning-only response has no visible sentence to resume. Do not
    // manufacture an empty assistant prefix for the next provider request.
    if (hasVisibleText) addMessage({ role: "assistant", content: text });
    const continuation = hasVisibleText
      ? "[SYSTEM] Your previous response was cut off by the output token limit. " +
      "Continue exactly where you left off. Do NOT repeat anything already written. " +
      "Resume mid-sentence if needed."
      : "[SYSTEM] The previous request reached its output token limit without producing a usable answer. " +
      "Continue the task using the available observations. Choose a concise next action or answer " +
      "within the remaining budget. Do not repeat completed actions or invent missing output.";
    addMessage(createRunLocalUserMessage(continuation));
    this.emitter.emit({ type: "observation", kind: "max_tokens_recovery", detail: {
      attempt: state.maxOutputTokensRecoveryCount, mode: hasVisibleText ? "partial_text" : "no_visible_output",
    } });
    return true;
  }

  /**
   * Handle XML-embedded tool calls (fallback for models that don't use function calling).
   * Returns true if XML tool calls were found and executed (loop should continue).
   */
  private async processXmlToolCalls(
    text: string,
    textId: string | undefined,
    steps: number,
    commitTurn: CommitTurn,
    allToolResults: ToolResult[],
    errorTracker: ErrorTracker,
    seenFiles: SeenFiles,
    signal?: AbortSignal,
    raw?: Record<string, unknown>,
    executionHooks?: ToolExecutionHooks,
  ): Promise<ToolCallRequest[] | undefined> {
    const xmlParsed = this.parseXmlToolCalls(text);
    if (!xmlParsed || xmlParsed.toolCalls.length === 0) return undefined;

    const cleaned = this.cleanOutput(xmlParsed.cleanText);
    if (cleaned.trim()) {
      this.emitter.emit({ type: "content_final", kind: "text", id: textId ?? nextContentId("tx"), text: cleaned });
    }

    // Execute serially, then commit one atomic Turn. Aborting mid-execution
    // takes the partial work and synthesizes failure results for the
    // unfinished tools — the assistant turn still pairs with N tool_results
    // (the Turn invariant), so Bedrock-strict pairing is preserved even on
    // abort. See issue #12.
    const completed: CompletedCall[] = [];
    const incomplete: IncompleteCall[] = [];
    let aborted = false;
    for (const tc of xmlParsed.toolCalls) {
      if (signal?.aborted) {
        aborted = true;
        for (const remaining of xmlParsed.toolCalls.slice(xmlParsed.toolCalls.indexOf(tc))) {
          incomplete.push({
            id: remaining.id,
            name: remaining.name,
            arguments: remaining.arguments,
            reason: "run aborted before this tool was executed",
          });
        }
        break;
      }
      this.emitter.emit({ type: "content_final", kind: "tool_call", id: tc.id, step: steps, toolName: tc.name, arguments: tc.arguments });
      const suppressed = executionHooks?.beforeExecute?.(tc.name, tc.arguments);
      const result = suppressed ?? await this.executor.execute(tc.name, tc.arguments, signal, {
        backgroundTaskOwner: executionHooks?.backgroundTaskOwner,
        deadlineAtMs: executionHooks?.deadlineAtMs?.(),
        sessionId: this.sessionId,
        toolCallId: tc.id,
        step: steps,
      });
      if (!suppressed) executionHooks?.afterExecute?.(tc.name, tc.arguments, result);
      this.emitter.emit({ type: "content_final", kind: "tool_result", id: tc.id, step: steps, toolName: tc.name, result });
      allToolResults.push(result);
      completed.push({
        id: tc.id, name: tc.name, arguments: tc.arguments,
        result,
        ...this.formatResult(tc, result, errorTracker, seenFiles),
      });
    }
    commitTurn(buildToolTurn({ text: cleaned, raw, completed, incomplete }));
    if (aborted) throw new Error("aborted");
    return xmlParsed.toolCalls;
  }

  /** Process native function-call tool results from StreamingToolExecutor. */
  private processNativeToolCalls(
    toolCalls: ToolCallRequest[],
    textId: string | undefined,
    results: Map<string, ToolResult>,
    text: string,
    commitTurn: CommitTurn,
    allToolResults: ToolResult[],
    errorTracker: ErrorTracker,
    seenFiles: SeenFiles,
    textFinalAlreadyEmitted: boolean | undefined,
    raw?: Record<string, unknown>,
  ): void {
    // Skip emitting if consumeStream already emitted content_final.text on
    // tool_call_start. That ordering (text before tool_call) is what the UI
    // needs to render preamble messages above the tool row. Re-emitting here
    // would double-log.
    if (!textFinalAlreadyEmitted) {
      const cleanedPrefix = this.cleanOutput(text);
      if (cleanedPrefix.trim()) {
        this.emitter.emit({ type: "content_final", kind: "text", id: textId ?? nextContentId("tx"), text: cleanedPrefix });
      }
    }

    // Partition toolCalls by whether the StreamingExecutor produced a
    // result. A missing result means the model emitted a tool_use whose JSON
    // never closed cleanly (mid-stream cut, malformed args, abort) — rather
    // than persist that as a ghost tool_use with no paired tool_result
    // (the orphan-producing pattern issue #12 reports), buildToolTurn
    // synthesizes a failure ToolResult so the Turn pairs by construction.
    const completed: CompletedCall[] = [];
    const incomplete: IncompleteCall[] = [];
    const stepToolCallInfos: Parameters<typeof generateToolUseSummary>[0] = [];
    for (const tc of toolCalls) {
      const result = results.get(tc.id);
      if (result) {
        allToolResults.push(result);
        stepToolCallInfos.push({ name: tc.name, arguments: tc.arguments, result });
        completed.push({
          id: tc.id, name: tc.name, arguments: tc.arguments,
          result,
          ...this.formatResult(tc, result, errorTracker, seenFiles),
        });
      } else {
        incomplete.push({
          id: tc.id, name: tc.name, arguments: tc.arguments,
          reason: "stream truncated before this tool finished — re-issue the call if still needed",
        });
      }
    }
    commitTurn(buildToolTurn({ text, raw, completed, incomplete }));
    generateToolUseSummary(stepToolCallInfos);
  }

  // ─── Streaming ─────────────────────────────────────────────────────────────

  /**
   * Compute the `max_tokens` to send in this LLM call. When `contextWindow`
   * is configured, estimates input size and caps output to fit. Throws
   * `ContextOverflowError` if there's not enough room even for the
   * reserved output floor — the outer catch then triggers autoCompact.
   *
   * Returns `undefined` when budget planning is disabled (no contextWindow),
   * signaling the provider to use its own constructor-bound default.
   */
  private computeCallBudget(messages: Message[], tools: ToolDefinition[]): number | undefined {
    return computeCallBudget(messages, tools, {
      contextWindow: this.contextWindow, inputTokenLimit: this.inputTokenLimit,
      outputTokenCeiling: this.outputTokenCeiling, reservedOutputTokens: this.reservedOutputTokens,
    }, this.budgetTokenCounter);
  }

  private meterProvider(provider: LLMProvider, purpose: "main" | "maintenance" = "main"): LLMProvider {
    return this.requestMeter?.wrap(provider, purpose) ?? provider;
  }

  private providerCallOptions(step: number, maxOutputTokens: number | undefined, signal?: AbortSignal): LLMCallOptions {
    const requestId = nextContentId("request");
    const options: LLMCallOptions = { maxOutputTokens, signal,
      deadline: signal ? this.providerDeadlines.get(signal) : undefined, onRequestEvent: request => {
      this.emitter.emit({ type: "provider_request", step, requestId, request });
    } };
    assertProviderRequestAllowed(options);
    return options;
  }

  /** Stream with concurrent tools. Compaction/fallback is safe only before
   * meaningful output; otherwise a retry could duplicate tool side effects. */
  private async streamWithTools(
    messages: Message[],
    tools: import("../tools/types.js").ToolDefinition[],
    step: number,
    signal?: AbortSignal,
    executionHooks?: ToolExecutionHooks,
  ): Promise<StreamingToolResult> {
    // Budget check runs BEFORE any provider I/O. A throw here bubbles up to
    // run()'s catch, which routes through isContextError → tryAutoCompact →
    // retry. Doing this upfront avoids sending a request we know won't fit.
    const provider = this.meterProvider(this.provider);
    const maxOutputTokens = this.computeCallBudget(messages, tools);

    const streamingExec = new StreamingToolExecutor(this.executor, this.emitter, {
      sessionId: this.sessionId,
    }, executionHooks);

    // ─── Primary provider (streaming) ───
    if (provider.stream) {
      let producedOutput = false;
      const source = provider.stream(messages, tools, {
        ...this.providerCallOptions(step, maxOutputTokens, signal), allowThinkingRetry: true,
      });
      async function* trackedStream() {
        for await (const chunk of source) {
          producedOutput ||= hasMeaningfulOutput(chunk) || chunk.type === "done";
          yield chunk;
        }
      }
      try {
        return await streamingExec.consumeStream(
          trackedStream(),
          step,
          signal,
        );
      } catch (err) {
        streamingExec.discard();
        if (err instanceof BudgetLimitError) throw err;
        // Fallback and compaction must not replay an already delivered turn.
        if (producedOutput || signal?.aborted || isAbortedStreamError(err) || err instanceof InterruptedStreamError) throw err;
        this.providerCallOptions(step, maxOutputTokens, signal);
        const msg = err instanceof Error ? err.message : String(err);

        if (recoveryReason(err)) {
          const retryOpts = this.providerCallOptions(step, maxOutputTokens, signal);
          const { response } = await this.reactiveCompact.callWithCompaction(
            provider, messages, tools, retryOpts,
            { ...this.recoveryContext?.(messages), initialError: err,
              optionsForRetry: candidate => this.providerCallOptions(step, this.computeCallBudget(candidate, tools), signal) },
          );
          return this.llmResponseToStreamingResult(response, step, signal, executionHooks);
        }

        if (this.fallbackProvider) {
          this.emitter.emit({ type: "observation", kind: "provider_fallback", detail: { reason: msg } });
          return this.runWithProvider(this.fallbackProvider, messages, tools, step, maxOutputTokens, signal, executionHooks);
        }

        throw err;
      }
    }

    // ─── Primary provider (non-streaming) ───
    try {
      const { response } = await this.reactiveCompact.callWithCompaction(
        provider, messages, tools, this.providerCallOptions(step, maxOutputTokens, signal),
        { ...this.recoveryContext?.(messages),
          optionsForRetry: candidate => this.providerCallOptions(step, this.computeCallBudget(candidate, tools), signal) },
      );
      return this.llmResponseToStreamingResult(response, step, signal, executionHooks);
    } catch (err) {
      if (err instanceof BudgetLimitError || signal?.aborted || err instanceof RequestRecoveryError) throw err;
      this.providerCallOptions(step, maxOutputTokens, signal);
      if (this.fallbackProvider) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitter.emit({ type: "observation", kind: "provider_fallback", detail: { reason: msg } });
        return this.runWithProvider(this.fallbackProvider, messages, tools, step, maxOutputTokens, signal, executionHooks);
      }
      throw err;
    }
  }

  /** Run with a specific provider (streaming if available, else non-streaming). */
  private async runWithProvider(
    provider: LLMProvider,
    messages: Message[],
    tools: import("../tools/types.js").ToolDefinition[],
    step: number,
    maxOutputTokens: number | undefined,
    signal?: AbortSignal,
    executionHooks?: ToolExecutionHooks,
  ): Promise<StreamingToolResult> {
    provider = this.meterProvider(provider);
    maxOutputTokens = computeCallBudget(messages, tools, {
      contextWindow: this.contextWindow, inputTokenLimit: this.inputTokenLimit,
      outputTokenCeiling: this.outputTokenCeiling, reservedOutputTokens: this.reservedOutputTokens,
    }, new TokenCounter(() => provider.getImageTokenContext?.() ?? {}));
    if (provider.stream) {
      const streamingExec = new StreamingToolExecutor(this.executor, this.emitter, {
        sessionId: this.sessionId,
      }, executionHooks);
      return streamingExec.consumeStream(provider.stream(messages, tools, this.providerCallOptions(step, maxOutputTokens, signal)), step, signal);
    }
    const response = await provider.call(messages, tools, this.providerCallOptions(step, maxOutputTokens, signal));
    return this.llmResponseToStreamingResult(response, step, signal, executionHooks);
  }

  /** Convert a non-streaming response to the same scheduled execution model
   * used by streaming providers. Result Map order remains model-call order. */
  private async llmResponseToStreamingResult(
    response: import("../core/types.js").LLMResponse, step: number,
    signal?: AbortSignal, executionHooks?: ToolExecutionHooks,
  ): Promise<StreamingToolResult> {
    return executeNonStreamingTurn(response, { executor: this.executor, emitter: this.emitter, sessionId: this.sessionId }, step, signal, executionHooks);
  }

  private formatResult(
    toolCall: ToolCallRequest,
    result: ToolResult,
    errorTracker: ErrorTracker,
    seenFiles: SeenFiles,
  ): { formattedOutput: string; formattedOutputSuppression?: "duplicate" } {
    let resultContent = formatToolResultContent(result);

    // Only successful observations can stand in for another successful read.
    // Keep execution-time notices out of the content fingerprint ledger.
    const deduplicated = !result.runtime?.suppression
      ? this.deduplicateFileRead(toolCall, resultContent, seenFiles, result.success)
      : { content: resultContent };
    resultContent = deduplicated.content;
    resultContent = this.classifyError(toolCall, result, errorTracker, resultContent);

    // Persist-to-disk for oversized formatted outputs. Most errors are short,
    // but bash/delegate/external-tool failures can dump huge stderr payloads;
    // keeping those inline would bloat every later provider call just like a
    // large successful output.
    let persistedPath: string | undefined;
    let persistedChars: number | undefined;
    const resultContentChars = countCodePoints(resultContent);
    const contextScaledTokenLimit = this.contextWindow === undefined
      ? undefined
      : Math.max(
          MIN_INLINE_TOOL_RESULT_TOKENS,
          Math.floor(this.contextWindow * MAX_INLINE_TOOL_RESULT_CONTEXT_SHARE),
        );
    const exceedsContextShare = contextScaledTokenLimit !== undefined &&
      this.budgetTokenCounter.countText(resultContent) > contextScaledTokenLimit;
    if (resultContentChars >= PERSIST_THRESHOLD_CHARS || exceedsContextShare) {
      const persisted = maybePersistToolResult(
        toolCall.id,
        this.storageSessionId,
        toolCall.name,
        resultContent,
        {
          projectCwd: this.storageProjectCwd,
          force: exceedsContextShare,
          readerTool: "read_tool_output",
        },
      );
      resultContent = persisted.contentForConversation;
      if (persisted.persisted) {
        persistedPath = persisted.persistedPath;
        persistedChars = resultContentChars;
      } else if (persisted.attempted) {
        this.emitter.emit({
          type: "observation",
          kind: "tool_result_storage_failed",
          detail: {
            tool: toolCall.name,
            fullChars: resultContentChars,
            fallbackChars: countCodePoints(resultContent),
            error: persisted.failureReason ?? "unknown storage error",
          },
        });
      }
    } else if (this.resultCompressor) {
      // Lossy compression is only safe after the result has been classified as
      // small enough not to require recoverable storage.
      resultContent = this.resultCompressor.compress(resultContent);
    }

    // Keep process observations and failure causes outside lossy diagnostic
    // compression and previews, with the same projection as other Agent paths.
    resultContent = formatToolResultForModel(result, resultContent);
    const prefix = result.success ? "✓" : "✗";
    // Report the ACTUAL size that landed in the conversation, not the
    // original tool output size — dedupe / compress / persist can shrink it
    // dramatically, and a misleading breadcrumb like `18000 chars` on a
    // stub that's only 50 chars makes debugging context bloat harder.
    const sizeInfo = persistedPath
      ? `${countCodePoints(resultContent)} chars in-context · ${persistedChars ?? resultContentChars} chars persisted`
      : `${countCodePoints(resultContent)} chars`;
    return {
      formattedOutput: `[${prefix} ${toolCall.name} · ${sizeInfo}]\n${resultContent}`,
      ...(deduplicated.suppression ? { formattedOutputSuppression: deduplicated.suppression } : {}),
    };
  }

  /** Deduplicate repeated reads of the same file. */
  private deduplicateFileRead(
    toolCall: ToolCallRequest,
    resultContent: string,
    seenFiles: SeenFiles,
    success: boolean,
  ): { content: string; suppression?: "duplicate" } {
    if (!toolCall.name.includes("read_file") && toolCall.name !== "pr_file_content") return { content: resultContent };
    if (!(toolCall.arguments as any).path && !(toolCall.arguments as any).ref) return { content: resultContent };

    const filePath = String((toolCall.arguments as any).path ?? (toolCall.arguments as any).ref ?? "");
    // A failure blocks restoration of older reads. A later successful reread
    // must carry its own snapshot even if its contents have not changed.
    if (!success) {
      seenFiles.delete(filePath);
      return { content: resultContent };
    }
    // Keep only a fixed-size fingerprint, but hash the complete provider-visible
    // result. Prefix sampling incorrectly folds a changed file when its edit is
    // located after the sampled bytes.
    const contentHash = createHash("sha256").update(resultContent).digest("hex");
    if (seenFiles.has(filePath) && seenFiles.get(filePath) === contentHash) {
      return { content: `[File already read — see previous result for ${filePath}]`, suppression: "duplicate" };
    }
    seenFiles.set(filePath, contentHash);
    return { content: resultContent };
  }

  /** Append error classification hints or system notices to the result content. */
  private classifyError(
    toolCall: ToolCallRequest,
    result: ToolResult,
    errorTracker: ErrorTracker,
    resultContent: string,
  ): string {
    if (result.success) {
      errorTracker.delete(toolCall.name);
      return resultContent;
    }
    if (!result.error) return resultContent;

    const errorSig = `${toolCall.name}:${result.error.slice(0, 100)}`;
    if (!errorTracker.has(toolCall.name)) errorTracker.set(toolCall.name, new Map());
    const toolErrors = errorTracker.get(toolCall.name)!;
    const count = (toolErrors.get(errorSig) ?? 0) + 1;
    toolErrors.set(errorSig, count);

    const failure = normalizeToolFailure(result).failure!;
    if (count >= this.maxToolRetries) {
      const action = failure.retryable
        ? "Resolve the reported prerequisite before retrying; do not bypass policy boundaries."
        : "Stop repeating this failed operation and report the blocker.";
      return resultContent + `\n\n[SYSTEM] Failed ${count} times. ${action}`;
    }
    return resultContent;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  /** Wrap a context-overflow error in a human-readable form for the UI when
   *  autoCompact has already been tried and the conversation is genuinely
   *  too long to fit. The raw errors mention token counts / context window
   *  sizes, which are developer-oriented. */
  private makeFriendlyOverflowError(err: unknown): Error {
    const hint = "Start a new session with /new or switch to a larger-context model.";
    if (err instanceof ContextOverflowError) {
      return new Error(
        `This conversation is too long for the model (input ~${err.inputTokens} tokens ` +
        `vs context window ${err.contextWindow}) even after compaction. ${hint}`
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Image-content rejection: the provider doesn't support image_url
    // content blocks. Most commonly a non-vision text-only model. Don't
    // muddle this with the "context length" message — surface the real
    // cause + a useful action.
    if (looksLikeImageContentRejection(msg)) {
      return new Error(
        `This provider doesn't accept images (${truncate(msg, 120)}). ` +
        "Switch to a vision-capable model via /model — Anthropic Claude, " +
        "OpenAI gpt-4o, Gemini, etc. — or /new to start a fresh text-only session."
      );
    }
    return new Error(`Context length exceeded after compaction: ${msg}. ${hint}`);
  }

  /** Detect image-rejection 400s that look fixable by stripping image content
   *  from outgoing requests, and trigger the strip if so. Three guard rails
   *  to avoid wrong-firing:
   *
   *    1. The current Message[] must actually contain at least one image
   *       block — otherwise the rejection text is misleading and stripping
   *       won't help.
   *    2. The error must match the schema-level rejection signature
   *       (see `looksLikeImageContentRejection`).
   *    3. Per-turn flag — only one self-heal attempt per run; if the second
   *       call still trips the same rejection the caller propagates instead
   *       of looping.
   *
   *  When all three hold, ask the provider to strip image blocks and emit a
   *  user-visible observation. Returns true if the caller should retry.
   *  Persisting this decision back to config (so future runs skip the round
   *  trip) is the host app's responsibility — wire via `onImageStripSelfHeal`. */
  private tryImageStripSelfHeal(err: unknown, state: LoopState, messages: Message[]): boolean {
    if (state.imageStripAttempted) return false;
    const msg = err instanceof Error ? err.message : String(err);
    if (!looksLikeImageContentRejection(msg)) return false;
    const hasImages = messages.some(m =>
      m.contentBlocks?.some(b => b.type === "image")
    );
    if (!hasImages) return false;
    if (typeof this.provider.setVisionSupported !== "function") return false;
    state.imageStripAttempted = true;
    this.provider.setVisionSupported(false);
    this.conversation?.setTokenCounter(this.budgetTokenCounter);
    this.emitter.emit({
      type: "observation",
      kind: "image_strip_self_heal",
      detail: { errorPreview: truncate(msg, 160) },
    });
    this.onImageStripSelfHeal?.();
    return true;
  }

  /** True for any error that should trigger autoCompact + retry. Covers:
   *   1. LoopAgent's own upfront budget overflow (typed — explicit contract)
   *   2. Real provider errors about context length (string match — best effort)
   *  The typed path wins when both apply (no double-match concerns).
   *  Image-content rejections are explicitly EXCLUDED — they used to match
   *  the (400 + json) heuristic and got mis-labeled as context overflow,
   *  triggering a useless compaction retry that always fails the same way. */
  private isContextError(err: unknown): boolean {
    if (err instanceof RequestRecoveryError) return false;
    if (err instanceof ContextOverflowError) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return isLikelyContextLimitErrorMessage(msg);
  }

  private async forceFinish(
    messages: Message[],
    usage: TokenUsage,
    step: number,
    reason: ForceFinishReason,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const finishMessages = [
      ...messages,
      createRunLocalUserMessage(
        forceFinishInstruction(reason)
      ),
    ];
    const finishBudget = this.runtimeTimeBudget(startedAt);
    const remainingMs = finishBudget?.remainingMs;
    const finishTimeoutMs = Math.min(this.forceFinishTimeoutMs, remainingMs ?? this.forceFinishTimeoutMs);
    if (signal?.aborted) throw new Error("aborted");
    const exhaustedResponse = "Shared agent budget exhausted. Available tool results are retained; task completion remains unverified.";
    // Earlier assistant text can predate subsequent writes or failed checks.
    // Keep it in history, but never promote it to a fresh completion report.
    const unavailableResponse = `The run stopped because ${forceFinishCause(reason)}. A final summary could not be generated. Task completion remains unverified; review the recorded tool results before continuing.`;
    if (!this.requestMeter?.canRequest()) return exhaustedResponse;
    if (finishTimeoutMs <= 0) return unavailableResponse;
    const finishStartedAt = this.now();
    const finishDeadlineAt = Math.min(finishStartedAt + finishTimeoutMs,
      finishBudget ? startedAt + finishBudget.totalMs : Number.POSITIVE_INFINITY);
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimedOut = false;
    try {
      if (signal?.aborted) throw new Error("aborted");
      const maxOutputTokens = this.computeCallBudget(finishMessages, []);
      const timeoutController = new AbortController();
      const finishSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      this.providerDeadlines.set(finishSignal, { atMs: finishDeadlineAt, now: this.now });
      const responsePromise = this.meterProvider(this.provider).call(finishMessages, [], this.providerCallOptions(step, maxOutputTokens, finishSignal));
      const timeoutPromise = new Promise<never>((_, reject) => {
        finishTimer = setTimeout(() => {
          finishTimedOut = true;
          const error = new Error(`force-finish timed out after ${finishTimeoutMs}ms`);
          timeoutController.abort(error);
          reject(error);
        }, Math.max(0, finishDeadlineAt - this.now()));
      });
      const response = await Promise.race([responsePromise, timeoutPromise]);
      this.progressController.recordFinalizationLatency(this.now() - finishStartedAt);
      if (signal?.aborted) throw new Error("aborted");
      const responseUsage = sanitizeTokenUsage(response.usage);
      const promptUsage = computeCacheUsageStats(responseUsage);
      const cacheCreateReported = typeof responseUsage.cacheCreationInputTokens === "number";
      const cacheReadReported = typeof responseUsage.cacheReadInputTokens === "number";
      const cacheMissReported = typeof responseUsage.cacheMissInputTokens === "number";
      const cacheCreate = responseUsage.cacheCreationInputTokens ?? 0;
      const cacheRead = responseUsage.cacheReadInputTokens ?? 0;
      if (this.shouldEmitUsage(responseUsage, cacheReadReported || cacheCreateReported || cacheMissReported)) {
        this.emitter.emit({
          type: "run_usage",
          step,
          inputTokens: responseUsage.inputTokens,
          ...(typeof responseUsage.providerUsageReported === "boolean"
            ? { providerUsageReported: responseUsage.providerUsageReported }
            : {}),
          ...(usage.usageIncomplete ? { usageIncomplete: true } : {}),
          ...(cacheReadReported ? { cacheReadInputTokens: cacheRead } : {}),
          ...(cacheCreateReported ? { cacheCreationInputTokens: cacheCreate } : {}),
          ...(cacheMissReported ? { cacheMissInputTokens: responseUsage.cacheMissInputTokens } : {}),
          outputTokens: responseUsage.outputTokens,
          finishReason: response.finishReason,
        });
      }
      const finalText = this.cleanOutput(response.text);
      return finalText || unavailableResponse;
    } catch {
      if (signal?.aborted) throw new Error("aborted");
      if (finishTimedOut || this.now() >= finishDeadlineAt) {
        this.emitter.emit({
          type: "observation",
          kind: "force_finish_timeout",
          detail: { reason, timeoutMs: finishTimeoutMs },
        });
      }
      return unavailableResponse;
    } finally {
      if (finishTimer) clearTimeout(finishTimer);
    }
  }

  private parseXmlToolCalls(text: string): { toolCalls: ToolCallRequest[]; cleanText: string } | null {
    const xmlToolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    const argRegex = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

    const toolCalls: ToolCallRequest[] = [];
    let match: RegExpExecArray | null;

    while ((match = xmlToolCallRegex.exec(text)) !== null) {
      const body = match[1];
      const nameEnd = body.indexOf("<arg_key>");
      const toolName = (nameEnd >= 0 ? body.slice(0, nameEnd) : body).trim();
      if (!toolName) continue;

      const args: Record<string, unknown> = {};
      let argMatch: RegExpExecArray | null;
      argRegex.lastIndex = 0;
      while ((argMatch = argRegex.exec(body)) !== null) {
        args[argMatch[1].trim()] = argMatch[2].trim();
      }

      toolCalls.push({ id: `xml_${Date.now()}_${toolCalls.length}`, name: toolName, arguments: args });
    }

    if (toolCalls.length === 0) return null;

    const cleanText = text
      .replace(/<\|?tool_calls_section_begin\|?>[\s\S]*?<\|?tool_calls_section_end\|?>/gi, "")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .replace(/<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>/g, "")
      .trim();

    return { toolCalls, cleanText };
  }

  private cleanOutput(text: string): string {
    if (!text) return text;

    let cleaned = text
      .replace(/<\|?tool_call[s_a-z]*\|?>[^]*?<\/?[|]?tool_call[s_a-z]*[|]?>/gi, "")
      .replace(/<\|?tool_calls_section_begin\|?>[^]*?<\|?tool_calls_section_end\|?>/gi, "")
      .replace(/<arg_key>[^<]*<\/arg_key><arg_value>[^<]*<\/arg_value>/gi, "")
      .trim();

    if (cleaned.startsWith("{") && cleaned.includes('"name"') && cleaned.includes('"arguments"')) {
      return "";
    }

    const toolCallStart = cleaned.lastIndexOf("<|tool_call");
    if (toolCallStart !== -1 && !cleaned.includes("<|tool_call", toolCallStart + 1)) {
      cleaned = cleaned.slice(0, toolCallStart).trim();
    }

    return this.guardOutput(cleaned);
  }

  /**
   * Last-line defense against prompt / memory extraction. Scans the final
   * assistant text for fingerprints of the system prompt or injected memory
   * and, if found, replaces the whole response with a brief refusal plus an
   * observation event.
   *
   * Two detectors:
   *   1. Hard markers — distinctive header lines that only exist in the
   *      injected prompt (e.g. "# Persistent Memory", "[AGENT PROTOCOL]").
   *      False-positives are very unlikely for organic coding output.
   *   2. Long verbatim run — any 300+ consecutive characters from the
   *      response also appearing in the system prompt. Catches paraphrase-
   *      proof dumps that sidestep the header markers. 300 chars is large
   *      enough that accidental match on common code/docs is implausible.
   */
  private guardOutput(text: string): string {
    if (!text) return text;
    if (!this.systemPrompt && !this.turnContextPrefix) return text;

    // Scan against system prompt AND the per-turn context attachment.
    // Memory content used to live in systemPrompt; after the Phase 2 split
    // it's in turnContextPrefix. Either can leak verbatim, so both are
    // fair game for the detector.
    const corpus = [this.systemPrompt, this.turnContextPrefix].filter(Boolean).join("\n\n");

    const hardMarkers = [
      "# Persistent Memory",
      "## Memory types",
      "## How to save a memory",
      "# Project Guidelines (from AGENTS.md)",
      "[AGENT PROTOCOL]",
      "<system-context>",
      "<active_plan>",
      "<system-reminder>",
    ];
    for (const marker of hardMarkers) {
      if (corpus.includes(marker) && text.includes(marker)) {
        this.emitter.emit({
          type: "observation",
          kind: "prompt_leak_blocked",
          detail: { marker, replacedLength: text.length },
        });
        return REFUSAL_PROMPT_LEAK;
      }
    }

    const runLen = 300;
    if (text.length >= runLen) {
      for (let i = 0; i + runLen <= text.length; i += 60) {
        const chunk = text.slice(i, i + runLen);
        if (corpus.includes(chunk)) {
          this.emitter.emit({
            type: "observation",
            kind: "prompt_leak_blocked",
            detail: { reason: "long_verbatim_run", replacedLength: text.length },
          });
          return REFUSAL_PROMPT_LEAK;
        }
      }
    }

    return text;
  }

  private shouldEmitUsage(usage: TokenUsage, cacheReported: boolean): boolean {
    // OpenAI-compatible fallback streams synthesize `{0,0}` when the gateway
    // omits the usage-only chunk; keep that invisible. Real provider usage can
    // still have output-only tokens or explicit zero cache accounting, both of
    // which must reach UI/persistence.
    return usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      (usage.cacheReadInputTokens ?? 0) > 0 ||
      (usage.cacheCreationInputTokens ?? 0) > 0 ||
      cacheReported ||
      usage.providerUsageReported === true;
  }
}

function foldProtocolIntoSystemPrompt(systemPrompt: string, protocol: string): string {
  if (!systemPrompt.includes(DYNAMIC_BOUNDARY)) {
    return `${systemPrompt}\n\n${protocol}`;
  }
  const [staticPart, dynamicPart] = splitAtBoundary(systemPrompt);
  return [
    staticPart,
    protocol,
    DYNAMIC_BOUNDARY,
    dynamicPart,
  ].filter((part) => part.length > 0).join("\n\n");
}

function createRunLocalUserMessage(
  content: string,
  images?: Parameters<typeof createUserMessage>[1],
): Message {
  const msg = createUserMessage(content, images);
  msg.cache = { ...msg.cache, skipBreakpoint: true };
  return msg;
}

function shortContextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function emptyContextDiagnostics(): ContextDiagnostics {
  return {
    totalChars: 0,
    estimatedTokens: 0,
    hash: shortContextHash(""),
    segments: [],
  };
}

function truncate(s: string, max: number): string {
  return countCodePoints(s) <= max ? s : sliceHeadCodePoints(s, max - 1) + "…"
}

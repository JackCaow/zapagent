import { AgentBudget } from "../../zapsdk/agent/budget.js"
import { RequestMeter } from "../../zapsdk/agent/request-meter.js"
import { accumulateTokenUsage } from "../../zapsdk/agent/token-usage.js"
import { recordMaintenanceUsage } from "../agent/maintenanceUsage.js"
import { resolveModelImageTokenContext } from "../provider-metadata.js"
import { TokenCounter } from "../../zapsdk/context/token-counter.js"
import type { OutputThroughputSample } from "../agent/outputThroughput.js"
import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore, type MutableRefObject } from "react"
import { SessionHostRuntime, type LoopAgentResult, type Todo, type TodoStore, type ProviderRequestEvent } from "../../zapsdk/index.js"
import { AgentLogger } from "../../zapsdk/debug/agent-logger.js"
import type { CheckpointManager } from "../../zapsdk/checkpoint/index.js"
import { AutoMemory } from "../../zapsdk/memory/auto-memory.js"
import type { ConversationManager } from "../../zapsdk/index.js"
import { extractFilesFromSummary } from "../ui/compact-utils.js"
import { buildCustomSystemPrompt, buildSystemPrompt, deriveCompaction, getActiveProvider } from "../config.js"
import { appendUsage, saveLastOutput, getCurrentSessionId } from "../session.js"
import type { AppConfig } from "../config.js"
import type { LogType, ToolCallInfo, UserImageRef } from "../ui/types.js"
import { appLogger, delegateEventBridge, mdStore, globalMdStore, globalMemoryDir, memorySemanticRetriever, tokenAccounting } from "../singletons.js"
import { createStreamingPreview } from "../agent/streamingPreview.js"
import {
  buildMemoryQueryHistoryFromLogs,
  buildMemoryQueryHistoryFromMessages,
  buildMemoryQueryForRun,
  buildPerTurnAttachments,
  makeContextBuilders,
  makeTurnEndGuard,
  MEMORY_QUERY_HISTORY_LIMIT,
  memoryQueryHistoryText,
  type MemoryQueryHistoryLog,
  type MemoryAttachmentFailureDiagnostic,
} from "../agent/contextAttachments.js"
import { buildRepoMapAttachment } from "../agent/repoMap.js"
import { buildAgentRuntime } from "../agent/buildAgentRuntime.js"
import { watchSession } from "../watch/integration.js"
import { registerHostRuntime } from "../agent/hostProtocol.js"
import { createProjectRuntimeEventStore, recoverProjectRuntimeOutcome } from "../agent/runtimeEventStore.js"
import { contextTokensFromRunUsage, createRunHandlers } from "../agent/wireRunHandlers.js"
import { appendCacheableSystemSection, buildRuntimePromptToolInputs } from "../agent/systemPrompt.js"
import { createPromptSectionDiagnostics, buildPromptCacheDiagnostics, type PromptCacheDiagnostics } from "../agent/promptDiagnostics.js"
import { persistRunUsage } from "../agent/usagePersistence.js"
import { makePromptCacheScope, type PromptCacheScope } from "../agent/cacheScope.js"
import { appendCacheMemoryAudit } from "../agent/cacheMemoryAudit.js"
import { compactFailureReason } from "../agent/compactDiagnostics.js"
import {
  normalizeMemoryFailure,
  persistCompactSummaryBestEffort,
  reportMemoryFailure,
  type MemoryFailureDiagnostic,
  type MemoryDiagnosticsLogger,
} from "../agent/memoryDiagnostics.js"
import { setPromptDiagnosticsLogger } from "../prompts/registry.js"
import type { AgentObjects } from "../agent/types.js"
import type { ContextDiagnostics } from "../../zapsdk/agent/events.js"
import type { TokenUsage } from "../../zapsdk/core/types.js"
import { AgentRunStore } from "../../zapsdk/agent/run-store.js"
import {
  EMPTY_CONTEXT_USAGE,
  buildContextBudgetSnapshot,
  resolveActiveContextLimits,
  updateContextUsage,
  type ContextLimits,
  type ContextUsageSource,
} from "../context-budget.js"

const cwd = process.cwd()
const CONTEXT_DIAGNOSTICS_HISTORY_LIMIT = 12
const USAGE_HISTORY_LIMIT = 12

export {
  buildMemoryQueryHistoryFromLogs,
  buildMemoryQueryHistoryFromMessages,
  type MemoryQueryHistoryLog,
} from "../agent/contextAttachments.js"

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function recordMemoryQueryHistory(
  ref: MutableRefObject<string[]>,
  text: string,
): void {
  const historyText = memoryQueryHistoryText(text)
  if (!historyText) return
  ref.current = [...ref.current, historyText].slice(-MEMORY_QUERY_HISTORY_LIMIT)
}

function normalizeMemoryAttachmentFailure(
  fields: Record<string, unknown> | undefined,
): MemoryAttachmentFailureDiagnostic {
  const stage = fields?.stage === "working_pack" ? "working_pack" : "index"
  return {
    stage,
    memoryDir: typeof fields?.memoryDir === "string" ? fields.memoryDir : "",
    queryPresent: fields?.queryPresent === true,
    error: typeof fields?.error === "string" ? fields.error : "unknown error",
  }
}

export interface PromptSectionFailureDiagnostic {
  section: string
  dynamic: boolean
  error: string
}

function normalizePromptSectionFailure(
  fields: Record<string, unknown> | undefined,
): PromptSectionFailureDiagnostic {
  return {
    section: typeof fields?.section === "string" ? fields.section : "(unknown)",
    dynamic: fields?.dynamic === true,
    error: typeof fields?.error === "string" ? fields.error : "unknown error",
  }
}

export interface CompactFailureDiagnostic {
  phase: "pre_turn" | "in_loop" | "manual"
  error: string
  consecutiveFailures?: number
  breakerTripped?: boolean
}

export interface UsagePersistenceFailureDiagnostic {
  error: string
}

export interface UsageState {
  i: number
  o: number
  providerUsageReported?: boolean
  cacheRead?: number
  cacheWrite?: number
  cacheScope?: PromptCacheScope
  promptCacheDiagnostics?: PromptCacheDiagnostics
}

export function buildResetRunDiagnosticsState(
  usage?: UsageState,
  context?: ContextDiagnostics,
  restoredUsageHistory: UsageState[] = [],
  restoredContextHistory: ContextDiagnostics[] = [],
  promptCache?: PromptCacheDiagnostics,
): {
  tokens: UsageState
  usageHistory: UsageState[]
  contextDiagnostics: ContextDiagnostics | undefined
  contextDiagnosticsHistory: ContextDiagnostics[]
  promptCacheDiagnostics: PromptCacheDiagnostics | undefined
  memoryAttachmentFailure: MemoryAttachmentFailureDiagnostic | undefined
  promptSectionFailure: PromptSectionFailureDiagnostic | undefined
  compactFailure: CompactFailureDiagnostic | undefined
  memoryFailure: MemoryFailureDiagnostic | undefined
  usagePersistenceFailure: UsagePersistenceFailureDiagnostic | undefined
  contextPending: boolean
} {
  const usageHistory = (
    restoredUsageHistory.length > 0
      ? restoredUsageHistory
      : usage ? [usage] : []
  ).map((snapshot) => ({ ...snapshot })).slice(-USAGE_HISTORY_LIMIT)
  const contextDiagnosticsHistory = (
    restoredContextHistory.length > 0
      ? restoredContextHistory
      : context ? [context] : []
  ).slice(-CONTEXT_DIAGNOSTICS_HISTORY_LIMIT)
  const tokens = usage
    ? { ...usage }
    : usageHistory.at(-1) ?? { i: 0, o: 0 }
  const latestPromptCacheDiagnostics =
    promptCache ?? tokens.promptCacheDiagnostics ?? usageHistory.at(-1)?.promptCacheDiagnostics
  return {
    tokens,
    usageHistory,
    contextDiagnostics: context ?? contextDiagnosticsHistory.at(-1),
    contextDiagnosticsHistory,
    promptCacheDiagnostics: latestPromptCacheDiagnostics,
    memoryAttachmentFailure: undefined,
    promptSectionFailure: undefined,
    compactFailure: undefined,
    memoryFailure: undefined,
    usagePersistenceFailure: undefined,
    contextPending: false,
  }
}

export interface PersistFinalRunUsageDeps {
  sawRunUsage: boolean
  usage: TokenUsage
  contextDiagnostics?: ContextDiagnostics
  promptCacheDiagnostics?: PromptCacheDiagnostics
  cacheScope?: PromptCacheScope
  getLocalEstimate: () => number
  appendUsage?: typeof appendUsage
  setPromptOverhead?: (overhead: number) => void
  onUsagePersistenceFailure?: (failure: UsagePersistenceFailureDiagnostic | undefined) => void
}

export function persistFinalRunUsageIfNeeded(deps: PersistFinalRunUsageDeps): boolean {
  if (deps.sawRunUsage) return false
  try {
    persistRunUsage({
      ...deps.usage,
      ...(deps.contextDiagnostics ? { contextDiagnostics: deps.contextDiagnostics } : {}),
      ...(deps.promptCacheDiagnostics ? { promptCacheDiagnostics: deps.promptCacheDiagnostics } : {}),
      ...(deps.cacheScope ? { cacheScope: deps.cacheScope } : {}),
    }, {
      getLocalEstimate: deps.getLocalEstimate,
      appendUsage: deps.appendUsage ?? appendUsage,
      setPromptOverhead: deps.setPromptOverhead,
    })
    deps.onUsagePersistenceFailure?.(undefined)
    return true
  } catch (err) {
    deps.onUsagePersistenceFailure?.({
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

export function estimateProviderInputTokens(
  conversationTokens: number,
  promptOverhead: number,
): number {
  return nonNegativeFinite(conversationTokens) + nonNegativeFinite(promptOverhead)
}

export function shouldPreTurnAutoCompact(
  conversationTokens: number,
  promptOverhead: number,
  triggerAt: number,
): boolean {
  return triggerAt > 0 && estimateProviderInputTokens(conversationTokens, promptOverhead) > triggerAt
}

export function syncConversationCompactionThresholds(
  conversation: Pick<ConversationManager, "setMaxTokens" | "setTriggerAtTokens" | "setTargetTokensAfterCompress">,
  context: number | ContextLimits,
): ReturnType<typeof deriveCompaction> {
  const thresholds = typeof context === "number"
    ? deriveCompaction(context)
    : {
        triggerAt: context.compactAt,
        keepFloorTokens: context.keepFloorTokens,
        reserveForOutput: context.reservedOutputTokens,
      }
  conversation.setMaxTokens(typeof context === "number" ? context : context.effectiveInputLimit)
  conversation.setTriggerAtTokens(thresholds.triggerAt)
  conversation.setTargetTokensAfterCompress(thresholds.keepFloorTokens)
  return thresholds
}

export const preTurnCompactFailureReason = compactFailureReason


type MemoryInstructionSource = Pick<AutoMemory, "buildInstructions">
type MutableStringRef = { current: string }

export async function getMemoryInstructionsForRun(
  autoMemory: MemoryInstructionSource,
  cache: MutableStringRef,
  diagnosticsLogger?: MemoryDiagnosticsLogger,
): Promise<string> {
  if (cache.current.trim()) return cache.current
  try {
    const instructions = await autoMemory.buildInstructions()
    cache.current = instructions
    return instructions
  } catch (err) {
    logMemoryInstructionsFailure(diagnosticsLogger, err)
    return cache.current
  }
}

function logMemoryInstructionsFailure(
  diagnosticsLogger: MemoryDiagnosticsLogger | undefined,
  err: unknown,
): void {
  reportMemoryFailure(
    {
      operation: "instructions",
      error: err instanceof Error ? err.message : String(err),
    },
    { logger: diagnosticsLogger },
  )
}

interface UseAgentRunnerOptions {
  currentSessionId: string
  config: AppConfig
  agentRef: React.MutableRefObject<AgentObjects>
  conversation: ConversationManager
  autoMemory: AutoMemory
  agentLogger: AgentLogger
  addLog: (type: LogType, text: string, tool?: ToolCallInfo, images?: UserImageRef[], agentPath?: string[], extra?: Partial<import("../ui/types.js").LogEntry>) => void
  replaceLog: (id: number, type: LogType, text: string, tool?: ToolCallInfo, agentPath?: string[]) => void
  peekNextLogId: () => number
  compactLogs: (summary: string, before: number, after: number, files: string[]) => void
  /** Ref to current todos — read fresh before each LLM call so the active_plan
   *  reflects mid-run updates from todo_write. Using a ref (not a plain value)
   *  avoids re-running the hook on every todo change. */
  todosRef?: React.MutableRefObject<Todo[]>
  checkpoint: CheckpointManager | null
  todoStore: TodoStore
  /** journalLogIndex captured BEFORE this turn's first log was written.
   *  App.tsx sets this at handleSubmit / command-entry points. Passed
   *  to checkpoint.makeSnapshot so rewind can slice logs back to the
   *  pre-turn position. */
  turnStartLogIndexRef: React.MutableRefObject<number>
  /** Rendered transcript length captured at the same pre-turn boundary. */
  turnStartUiLogIndexRef: React.MutableRefObject<number>
  /** Skills loaded at session start (system + ~/.agents/skills + project).
   *  Passed into the system prompt as an index so the model knows what
   *  `skill` tool names are valid. Stable across the run. */
  availableSkills?: ReadonlyArray<{
    name: string
    description: string
    parameters?: ReadonlyArray<{ name: string; required?: boolean; description?: string }>
  }>
  /** Returns true when Static commits are frozen (palette/dialog visible).
   *  Forwarded to streamingPreview so completed paragraphs stay in the
   *  streaming tail rather than disappearing into an invisible buffer. */
  getIsFrozen?: () => boolean
  /** Registers a callback that fires after the Static freeze buffer flushes.
   *  Used by streamingPreview to clear streaming-text state that was held
   *  pending while frozen (content visible in tail until palette closes). */
  registerStaticFlushCallback?: (cb: (() => void) | null) => void
  /** Persist a config update (state + disk). Used by self-heal paths that
   *  want their decision to survive the next run — e.g. flipping vision off
   *  for the active (provider, model) after an image-rejection 400. */
  onUpdateConfig?: (next: AppConfig) => void
}

export function useAgentRunner({
  currentSessionId,
  config,
  agentRef,
  conversation,
  autoMemory,
  agentLogger,
  addLog,
  replaceLog,
  peekNextLogId,
  todosRef,
  checkpoint,
  compactLogs,
  todoStore,
  turnStartLogIndexRef,
  turnStartUiLogIndexRef,
  availableSkills,
  getIsFrozen,
  registerStaticFlushCallback,
  onUpdateConfig,
}: UseAgentRunnerOptions) {
  const [status, setStatus] = useState("ready")
  const [outputThroughput, setOutputThroughput] = useState<OutputThroughputSample>()
  const [providerRequest, setProviderRequest] = useState<ProviderRequestEvent>()
  const [step, setStep] = useState(0)
  const [activeTool, setActiveTool] = useState("")
  // Bytes accumulated in the in-flight tool-call's JSON arg buffer. Surfaced
  // in LiveActivity so the user can tell a slow generation (bytes climbing)
  // from a silent stall (bytes frozen) — stream-idle watchdog can't make
  // this distinction because OpenAI-compat keep-alive frames count as
  // liveness without carrying token deltas. Cleared on tool_result and on
  // run start.
  const [activeToolBytes, setActiveToolBytes] = useState(0)
  const [tokens, setTokens] = useState<UsageState>({ i: 0, o: 0 })
  const [usageHistory, setUsageHistory] = useState<UsageState[]>([])
  const [contextUsage, setContextUsage] = useState(EMPTY_CONTEXT_USAGE)
  const setContextTokens = useCallback((
    value: number,
    source: ContextUsageSource = "estimated",
    lastMeasuredPromptTokens?: number | null,
  ) => {
    setContextUsage(previous => updateContextUsage(
      previous,
      value,
      source,
      lastMeasuredPromptTokens,
    ))
  }, [])
  const setContextPending = useCallback((pending: boolean) => {
    if (!pending) return
    setContextUsage(previous => updateContextUsage(
      previous,
      previous.currentPromptTokens,
      "pending",
    ))
  }, [])
  const contextTokens = contextUsage.currentPromptTokens ?? 0
  const contextPending = contextUsage.source === "pending"
  const contextBudget = useMemo(
    () => buildContextBudgetSnapshot(config, contextUsage),
    [config, contextUsage],
  )
  const imageTokenContext = resolveModelImageTokenContext(getActiveProvider(config), config.active.model)
  const imageTokenScope = `${config.active.providerId}\0${config.active.model}\0${JSON.stringify(imageTokenContext)}`
  const contextScopeRef = useRef(imageTokenScope)
  useEffect(() => {
    const nextScope = imageTokenScope
    if (contextScopeRef.current === nextScope) return
    contextScopeRef.current = nextScope
    conversation.setTokenCounter(new TokenCounter(imageTokenContext))
    setOutputThroughput(undefined)
    // Provider prompt wrappers and tokenizers differ. A sample calibrated on
    // the previous model must not be presented as truth for the new scope.
    tokenAccounting.promptOverhead = 0
    setContextUsage(previous => updateContextUsage(
      previous,
      conversation.estimatedTokens,
      "estimated",
      null,
    ))
  }, [imageTokenScope, conversation])
  const [contextDiagnostics, setContextDiagnostics] = useState<ContextDiagnostics | undefined>(undefined)
  const [contextDiagnosticsHistory, setContextDiagnosticsHistory] = useState<ContextDiagnostics[]>([])
  const [promptCacheDiagnostics, setPromptCacheDiagnostics] = useState<PromptCacheDiagnostics | undefined>(undefined)
  const [memoryAttachmentFailure, setMemoryAttachmentFailure] = useState<MemoryAttachmentFailureDiagnostic | undefined>(undefined)
  const [promptSectionFailure, setPromptSectionFailure] = useState<PromptSectionFailureDiagnostic | undefined>(undefined)
  const [compactFailure, setCompactFailure] = useState<CompactFailureDiagnostic | undefined>(undefined)
  const [memoryFailure, setMemoryFailure] = useState<MemoryFailureDiagnostic | undefined>(undefined)
  const [usagePersistenceFailure, setUsagePersistenceFailure] = useState<UsagePersistenceFailureDiagnostic | undefined>(undefined)
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [thinkingText, setThinkingText] = useState("")
  const [isThinking, setIsThinking] = useState(false)
  const agentRunStoreRef = useRef<AgentRunStore | null>(null)
  if (!agentRunStoreRef.current) agentRunStoreRef.current = new AgentRunStore()
  const agentRunStore = agentRunStoreRef.current
  const agentRuns = useSyncExternalStore(
    agentRunStore.subscribe,
    agentRunStore.getSnapshot,
    agentRunStore.getSnapshot,
  )

  const running = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const hostSessionRef = useRef<SessionHostRuntime | null>(null)
  const latestContextDiagnosticsRef = useRef<ContextDiagnostics | undefined>(undefined)
  // Memory splits into two halves:
  //   - instructions (taxonomy / how-to-save / when-to-save) lives in the
  //     cacheable system prompt prefix; recomputed rarely
  //   - content (current MEMORY.md index) travels as a per-turn user-context
  //     attachment via RunOptions.contextPrefix; recomputed every turn
  const memoryInstructionsRef = useRef("")
  const memoryQueryHistoryRef = useRef<string[]>([])

  const recordContextDiagnostics = useCallback((context: ContextDiagnostics | undefined) => {
    latestContextDiagnosticsRef.current = context
    setContextDiagnostics(context)
    if (!context) return
    setContextDiagnosticsHistory((prev) => [
      ...prev,
      context,
    ].slice(-CONTEXT_DIAGNOSTICS_HISTORY_LIMIT))
  }, [])

  const recordUsage = useCallback((
    usage: TokenUsage,
    promptCache?: PromptCacheDiagnostics,
    cacheScope?: PromptCacheScope,
  ) => {
    const snapshot: UsageState = {
      i: usage.inputTokens,
      o: usage.outputTokens,
      ...(typeof usage.providerUsageReported === "boolean"
        ? { providerUsageReported: usage.providerUsageReported }
        : {}),
      ...(typeof usage.cacheReadInputTokens === "number"
        ? { cacheRead: usage.cacheReadInputTokens }
        : {}),
      ...(typeof usage.cacheCreationInputTokens === "number"
        ? { cacheWrite: usage.cacheCreationInputTokens }
        : {}),
      ...(cacheScope ? { cacheScope } : {}),
      ...(promptCache ? { promptCacheDiagnostics: promptCache } : {}),
    }
    setTokens(snapshot)
    setUsageHistory((prev) => [...prev, snapshot].slice(-USAGE_HISTORY_LIMIT))
  }, [])

  const resetRunDiagnostics = useCallback((
    usage?: UsageState,
    context?: ContextDiagnostics,
    restoredUsageHistory?: UsageState[],
    restoredContextHistory?: ContextDiagnostics[],
    promptCache?: PromptCacheDiagnostics,
  ) => {
    const next = buildResetRunDiagnosticsState(usage, context, restoredUsageHistory, restoredContextHistory, promptCache)
    setOutputThroughput(undefined)
    setTokens(next.tokens)
    setUsageHistory(next.usageHistory)
    setContextDiagnostics(next.contextDiagnostics)
    setContextDiagnosticsHistory(next.contextDiagnosticsHistory)
    setPromptCacheDiagnostics(next.promptCacheDiagnostics)
    setMemoryAttachmentFailure(next.memoryAttachmentFailure)
    setPromptSectionFailure(next.promptSectionFailure)
    setCompactFailure(next.compactFailure)
    setMemoryFailure(next.memoryFailure)
    setUsagePersistenceFailure(next.usagePersistenceFailure)
    latestContextDiagnosticsRef.current = next.contextDiagnostics
  }, [])

  const restoreMemoryQueryHistoryFromLogs = useCallback((
    logs: readonly MemoryQueryHistoryLog[],
  ) => {
    memoryQueryHistoryRef.current = buildMemoryQueryHistoryFromLogs(logs)
  }, [])

  useEffect(() => {
    setPromptDiagnosticsLogger({
      warn(event, fields) {
        appLogger.warn(event, fields)
        if (event !== "prompt_section_failed") return
        setPromptSectionFailure(normalizePromptSectionFailure(fields))
      },
    })
    return () => { setPromptDiagnosticsLogger(appLogger) }
  }, [])

  useEffect(() => {
    autoMemory.buildInstructions().then((s) => {
      memoryInstructionsRef.current = s
    }).catch((err) => {
      reportMemoryFailure({
        operation: "instructions",
        error: err instanceof Error ? err.message : String(err),
      }, { logger: appLogger, onMemoryFailure: setMemoryFailure })
    })
  }, [])

  const runAgent = useCallback(async (
    task: string,
    systemPrompt?: string,
    images?: import("../../zapsdk/core/types.js").ImageContent[],
    memoryQueryText?: string,
    invocation?: { signal?: AbortSignal; propagateErrors?: boolean; resultSchema?: "outcome-v1" | "legacy" } & Pick<import("../../zapsdk/agent/loop.js").RunOptions,
      "onInputAccepted" | "hasSteering" | "takeSteering" | "onSteeringAccepted">,
  ): Promise<LoopAgentResult | undefined> => {
    running.current = true
    agentRunStore.clear()
    const controller = new AbortController()
    const externalSignal = invocation?.signal
    const forwardExternalAbort = () => controller.abort(externalSignal?.reason)
    if (externalSignal?.aborted) forwardExternalAbort()
    else externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true })
    abortRef.current = controller
    setStatus("preparing")
    setProviderRequest(undefined)
    setStep(0)
    setActiveTool("")
    setActiveToolBytes(0)
    setOutputThroughput(undefined)
    setTokens({ i: 0, o: 0 })
    setContextDiagnostics(undefined)
    latestContextDiagnosticsRef.current = undefined
    setPromptCacheDiagnostics(undefined)
    setMemoryAttachmentFailure(undefined)
    setPromptSectionFailure(undefined)
    setCompactFailure(undefined)
    setMemoryFailure(undefined)
    setUsagePersistenceFailure(undefined)
    setContextTokens(
      conversation.estimatedTokens + tokenAccounting.promptOverhead,
      "estimated",
    )
    // Captured in catch, consumed in finally to label any tool calls left
    // pending when the run ends abnormally (stream timeout, Ctrl+C, …).
    let runError: string | null = null
    let outcomeExecutionError: Error | undefined
    let caughtError: unknown
    let completedResult: LoopAgentResult | undefined
    let preview: ReturnType<typeof createStreamingPreview> | null = null
    let handlers: ReturnType<typeof createRunHandlers> | null = null

    try {
      const { provider, registry, executor, createRegistryForCwd, executionFacts, executionCapacity } = agentRef.current
      const currentConfig = config
      const cacheScope = makePromptCacheScope(
        currentConfig.active.providerId,
        currentConfig.active.model,
      )
      const memoryQuerySource = memoryQueryText ?? task

      let sawRunUsage = false
      const turnBudget = new AgentBudget({ maxSteps: currentConfig.maxSteps * 3, maxSpawns: 10 })
      const maintenanceUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
      const maintenanceMeter = new RequestMeter(turnBudget, {}, usage => {
        accumulateTokenUsage(maintenanceUsage, usage)
        sawRunUsage = true
        try { recordMaintenanceUsage(usage); setUsagePersistenceFailure(undefined) }
        catch (error) { setUsagePersistenceFailure({ error: String(error) }) }
      })
      // ── Auto-compact: prune if approaching context limit ──
      conversation.setTokenCounter(new TokenCounter(() => provider.getImageTokenContext?.() ?? resolveModelImageTokenContext(getActiveProvider(currentConfig), currentConfig.active.model)))
      const contextLimits = resolveActiveContextLimits(currentConfig)
      const ctxWin = contextLimits.contextWindow
      const thresholds = syncConversationCompactionThresholds(conversation, contextLimits)
      // The first Loop step is the pre-turn maintenance boundary as well.
      // It sees the newly assembled system/schema/attachments and user input,
      // so TUI and headless cannot compact different request views here.

    // ── System prompt ──
    // Custom systemPrompt path (skills / /init / /commit): the default
    // buildSystemPrompt is bypassed, so rebuild the cacheable support sections
    // explicitly. This keeps tool guidance, skills index, plan discipline, and
    // the static/dynamic boundary consistent with config.customSystemPrompt.
    const runtimeTools = buildRuntimePromptToolInputs(
      registry.definitions().map((d: { name: string }) => d.name),
      registry.toolPrompts(),
    )
    const promptSections = createPromptSectionDiagnostics()
    const promptCtx = {
      onSection: promptSections.record,
      cwd,
      enabledTools: runtimeTools.enabledToolNames,
      toolPromptsRaw: runtimeTools.toolPrompts,
      model: currentConfig.active.model,
      customSystemPrompt: currentConfig.customSystemPrompt,
      promptProfile: currentConfig.promptProfile ?? "standard",
      availableSkills,
      executionFacts,
      executionCapacity,
    }
    const basePrompt = systemPrompt
      ? buildCustomSystemPrompt(systemPrompt, promptCtx, [
          `Today: ${new Date().toISOString().split("T")[0]}`,
          `CWD: ${cwd}`,
        ])
      : buildSystemPrompt(
          currentConfig,
          cwd,
          runtimeTools.toolPrompts,
          runtimeTools.enabledToolNames,
          availableSkills,
          executionFacts,
          promptSections.record,
          executionCapacity,
        )
    // Memory instructions (taxonomy) live in the system prompt — cacheable.
    const memInstr = await getMemoryInstructionsForRun(autoMemory, memoryInstructionsRef, {
      warn(event, fields) {
        appLogger.warn(event, fields)
        if (event !== "memory_operation_failed") return
        setMemoryFailure(normalizeMemoryFailure(fields))
      },
    })
    const fullSystemPrompt = appendCacheableSystemSection(basePrompt, memInstr)
    if (memInstr) promptSections.record("memory-instructions", "discovery", false, memInstr)
    let promptCacheDiagnosticsForRun: PromptCacheDiagnostics | undefined

    // ── Per-turn attachments (memory index + markdown working pack) ──
    // Travels as a per-turn user-context attachment so it doesn't fragment
    // the cached prefix. The working pack lives alongside MEMORY.md content
    // — putting either in the system prompt fragments the cacheable prefix
    // every time a memory file changes, cratering hit rate on auto-prefix-
    // cache backends.
    const recentUserMessages = [
      ...buildMemoryQueryHistoryFromMessages(conversation.getAllMessages()),
      ...memoryQueryHistoryRef.current,
    ]
    const attachments = await buildPerTurnAttachments(autoMemory, {
      memoryQuery: buildMemoryQueryForRun(memoryQuerySource, recentUserMessages),
      memoryStore: mdStore,
      globalMemoryStore: globalMdStore,
      globalMemoryDir,
      semanticRetriever: memorySemanticRetriever,
      contextWindow: ctxWin,
      diagnosticsLogger: {
        warn(event, fields) {
          appLogger.warn(event, fields)
          if (event !== "memory_attachment_failed") return
          setMemoryAttachmentFailure(normalizeMemoryAttachmentFailure(fields))
        },
      },
    })
    await buildRepoMapAttachment(cwd, memoryQuerySource, ctxWin).then((repoMap) => {
      attachments.repoMapAttachment = repoMap.text
      attachments.repoMapIncluded = repoMap.selectedFiles
      attachments.repoMapRevision = repoMap.revision
      attachments.repoMapTokenBudget = repoMap.tokenBudget
      attachments.repoMapTruncated = repoMap.truncated
    }).catch((error) => {
      appLogger.warn("repo_map_build_failed", {
        message: error instanceof Error ? error.message : String(error),
      })
    })
    recordMemoryQueryHistory(memoryQueryHistoryRef, memoryQuerySource)

    // Refresh memory instructions for next run (non-blocking; rarely changes)
    autoMemory.buildInstructions().then((s) => { memoryInstructionsRef.current = s }).catch((err) => {
      reportMemoryFailure({
        operation: "instructions",
        error: err instanceof Error ? err.message : String(err),
      }, { logger: appLogger, onMemoryFailure: setMemoryFailure })
    })

    // ── Streaming preview (text paragraph commits + thinking timing) ──
      preview = createStreamingPreview({
      addLog,
      setStreamingText,
      setIsStreaming,
      setThinkingText,
      setIsThinking,
      getIsFrozen: getIsFrozen ?? (() => false),
    })
      const runPreview = preview
      registerStaticFlushCallback?.(() => runPreview.onStaticFlushed())
      const currentSessionId = getCurrentSessionId()

      // ── Run handlers (subagent handler must exist BEFORE LoopAgent ctor) ──
      handlers = createRunHandlers({
      currentConfig,
      controller,
      preview: runPreview,
      setStatus, setStep, setActiveTool, setActiveToolBytes,
      setProviderRequest, setOutputThroughput,
      setContextTokens, setContextPending, setContextDiagnostics: recordContextDiagnostics,
      onRunUsage: (usage) => {
        sawRunUsage = true
        if (usage.purpose !== "maintenance") recordUsage(usage, promptCacheDiagnosticsForRun, cacheScope)
      },
      getPromptCacheDiagnostics: () => promptCacheDiagnosticsForRun,
      onCompactFailure: setCompactFailure,
      onMemoryFailure: setMemoryFailure,
      onUsagePersistenceFailure: setUsagePersistenceFailure,
      cacheMemoryAuditSessionId: currentSessionId,
      appendCacheMemoryAudit: (entry) => { appendCacheMemoryAudit(cwd, entry) },
      onCacheMemoryAuditFailure: (failure) => {
        appLogger.warn("cache_memory_audit_failed", failure)
      },
      memoryUtilityCandidates: attachments.memoryUtilityCandidates ?? [],
      memoryUtilityBaseline: attachments.memoryUtilityBaseline,
      memoryUtilityCwd: cwd,
      toolOutputSessionId: currentSessionId,
      toolOutputProjectCwd: cwd,
      onAgentRunState: (run) => { agentRunStore.apply(run) },
      addLog, replaceLog, peekNextLogId, compactLogs,
    })

    // Delegate-agent (external CLI) events flow into the same handler so
    // claude/codex tool calls fold under their parent log, identical to
    // internal subagent events. The bridge is rebound per-run because the
    // handler closure captures per-run pending maps that wouldn't be safe
    // to share across runs.
      delegateEventBridge.handler = handlers.subAgentEventHandler

    // ── AgentRuntime for this turn ──
      const agent = buildAgentRuntime({
      config: currentConfig,
      budget: turnBudget, initialUsage: maintenanceUsage,
      provider, registry, executor,
      createRegistryForCwd,
      cwd,
      conversation,
      fullSystemPrompt,
      publicPromptSections: promptSections.publicPromptSections,
      inheritedInstructions: systemPrompt || currentConfig.customSystemPrompt,
      // Dual thresholds so auto-compact fires on whichever signal hits first.
      // - Char: catches English/code heavy conversations (1 token ≈ 4 chars).
      // - Token: catches CJK heavy conversations (1 token ≈ 1.5 chars) where
      //   the API ceiling is hit long before the char threshold trips.
      autoCompactThreshold: thresholds.triggerAt * 4,
      autoCompactTokenThreshold: thresholds.triggerAt,
      agentLogger,
      currentSessionId,
      checkpoint,
      turnStartLogPosition: () => ({
        journalLogIndex: turnStartLogIndexRef.current,
        uiLogIndex: turnStartUiLogIndexRef.current,
      }),
      todoStore,
      subAgentEventHandler: handlers.subAgentEventHandler,
      onUpdateConfig,
    })
    const protocolPrompt = agent.protocolPrompt()
    if (protocolPrompt) promptSections.record("sdk-protocol", "protocol", false, protocolPrompt)
    promptCacheDiagnosticsForRun = buildPromptCacheDiagnostics(
      agent.effectiveSystemPrompt() ?? fullSystemPrompt,
      agent.toolDefinitions(),
      currentConfig.promptProfile ?? "standard",
      promptSections.sections,
    )
    setPromptCacheDiagnostics(promptCacheDiagnosticsForRun)

      handlers.wire(agent)

    // ── Per-turn context attachments + turn-end guard ──
      const { contextPrefix, contextDelta, contextDiagnostics } = makeContextBuilders({
      attachments,
      getTodos: () => todosRef?.current ?? [],
      modelId: currentConfig.active.model,
    })
      const turnEndGuard = makeTurnEndGuard(() => todosRef?.current ?? [])
      const detachHostRuntime = await hostSessionRef.current?.attach(agent)

      try {
      const runOptions = {
        signal: controller.signal,
        images,
        contextPrefix,
        contextDelta,
        contextDiagnostics,
        turnEndGuard,
        onInputAccepted: invocation?.onInputAccepted,
        hasSteering: invocation?.hasSteering,
        takeSteering: invocation?.takeSteering,
        onSteeringAccepted: invocation?.onSteeringAccepted,
      }
      const execution = invocation?.resultSchema === "legacy" ? undefined : await agent.runWithOutcome(task, runOptions)
      const result = execution?.loopResult ?? await agent.run(task, runOptions)
      if (execution?.outcome.execution.status === "failed" || execution?.outcome.execution.status === "blocked") {
        runError = execution.outcome.execution.error?.message ?? execution.outcome.execution.stopReason
        outcomeExecutionError = new Error(runError)
        caughtError = outcomeExecutionError
      }
      if (execution?.outcome.acceptance.status === "unverified") addLog("system", "本轮执行已结束；结果尚未经过外部验收。")
      completedResult = result
      // Log entries were already committed by content_final handlers; just
      // persist the canonical final text for the /copy command.
      if (result.text) saveLastOutput(result.text)

      if (!sawRunUsage) {
        recordUsage(result.totalUsage, promptCacheDiagnosticsForRun, cacheScope)
        const measuredPromptTokens = contextTokensFromRunUsage(result.totalUsage)
        if (measuredPromptTokens !== null) {
          setContextTokens(measuredPromptTokens, "provider")
        }
        persistFinalRunUsageIfNeeded({
          sawRunUsage,
          usage: result.totalUsage,
          contextDiagnostics: latestContextDiagnosticsRef.current,
          promptCacheDiagnostics: promptCacheDiagnosticsForRun,
          cacheScope,
          getLocalEstimate: () => conversation.estimatedTokens,
          setPromptOverhead: (overhead) => { tokenAccounting.promptOverhead = overhead },
          onUsagePersistenceFailure: setUsagePersistenceFailure,
        })
      }
      // The run_usage sample is exact for the request that just finished, but
      // the newly generated assistant/tool output is already part of the next
      // request. Keep that API sample as lastMeasuredPromptTokens and expose a
      // calibrated next-prompt estimate as the actionable current value.
      setContextTokens(
        conversation.estimatedTokens + tokenAccounting.promptOverhead,
        "estimated",
      )
      } catch (err) {
      // Logging is centralized in the agent.on("error", ...) handler inside
      // wireRunHandlers — LoopAgent emits the event AND rethrows, so adding
      // here produces duplicate entries (the "402 Insufficient Balance shown
      // twice" bug). Aborts are silent by design. We swallow the throw
      // because UI state is already reset in `finally`.
      runError = err instanceof Error ? err.message : String(err)
      caughtError = err
      } finally {
        detachHostRuntime?.()
      }
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err)
      caughtError = err
      appLogger.warn("agent_run_setup_failed", { error: runError })
      if (!controller.signal.aborted) {
        addLog("error", `agent setup failed: ${runError}`)
      }
    } finally {
      // Drain any in-flight content piece whose `content_final` never fired
      // (canonical case: Esc-abort mid-stream). drainOnAbort routes text
      // pieces through flushTextParagraphs(includeTail=true) so visible
      // scrollback lines up perfectly with what's stored — no orphan tail,
      // no consolidated "agent" log overlapping the chunks. Thinking pieces
      // get a single addLog with whatever ms we measured.
      preview?.drainOnAbort()

      // User pressed Esc / Ctrl+C. Drop a marker into the transcript so the
      // turn is identifiable in the session viewer and in any later replay
      // — without it, an Esc-interrupted turn that produced no content at
      // all leaves two consecutive `user` JSONL rows with nothing between
      // them, making it look like the user typed twice.
      if (controller.signal.aborted) {
        setOutputThroughput(undefined)
        addLog("system", "(interrupted)")
      }

      // Settle any tool calls left pending (stream-idle timeout, provider
      // error, Ctrl+C). Without this the App's `pendingTools` useMemo finds
      // dangling "tool" entries with no matching "result" and the
      // LiveActivity spinner row never clears.
      const reason = runError ? `aborted: ${runError}` : "aborted"
      handlers?.settlePending(reason)

      // NOTE: we do NOT clear registerStaticFlushCallback here. The "stale
      // ref after run end" looks like a leak but is load-bearing: when
      // onTextFinal fired while frozen (palette open), pendingClearStreamingState
      // stays true and streamingText is held visible in the tail until the
      // palette closes. The Static flush at palette-close has to fire
      // preview.onStaticFlushed() to clear that state — even though the run
      // has already ended. Nulling the callback in this finally re-introduces
      // the "ghost paragraph in tail" bug that commit 57a4bf2 fixed.

      running.current = false
      abortRef.current = null
      setActiveTool("")
      setStatus("ready")
      setProviderRequest(undefined)
      setStep(0)
      externalSignal?.removeEventListener("abort", forwardExternalAbort)
    }
    // A v2 host receives the persisted failure outcome; interactive queue
    // callers still use rejection to pause failed work. Storage/setup faults
    // always reject, including when a prior outcome exists.
    if (invocation?.propagateErrors && caughtError
      && !(invocation.resultSchema === "outcome-v1" && caughtError === outcomeExecutionError)) throw caughtError
    return completedResult
  }, [
    addLog,
    agentLogger,
    agentRef,
    agentRunStore,
    autoMemory,
    availableSkills,
    checkpoint,
    compactLogs,
    config,
    conversation,
    getIsFrozen,
    onUpdateConfig,
    peekNextLogId,
    recordContextDiagnostics,
    recordUsage,
    registerStaticFlushCallback,
    replaceLog,
    todoStore,
    todosRef,
    turnStartLogIndexRef,
    turnStartUiLogIndexRef,
  ])

  const runAgentRef = useRef(runAgent)
  runAgentRef.current = runAgent
  useEffect(() => {
    const eventStore = createProjectRuntimeEventStore(cwd)
    const hostSession = new SessionHostRuntime({
      threadId: currentSessionId,
      eventStore,
      recover: () => recoverProjectRuntimeOutcome(cwd, currentSessionId, eventStore),
      isBusy: () => running.current,
      runTurn: async (input, options, resultSchema) => {
        const result = await runAgentRef.current(
          input,
          undefined,
          undefined,
          input,
          { signal: options?.signal, propagateErrors: true, resultSchema },
        )
        if (!result) throw new Error(`Thread ${currentSessionId} completed without a result`)
        return result
      },
      cancelTurn: (reason) => {
        const controller = abortRef.current
        if (!controller || controller.signal.aborted) return false
        controller.abort(new Error(reason))
        return true
      },
    })
    hostSessionRef.current = hostSession
    const unregister = registerHostRuntime(hostSession)
    const unregisterWatch = watchSession(currentSessionId)
    return () => {
      unregister()
      unregisterWatch()
      if (hostSessionRef.current === hostSession) hostSessionRef.current = null
      void hostSession.close()
    }
  }, [currentSessionId])

  return {
    runAgent,
    running,
    abortRef,
    status,
    providerRequest,
    outputThroughput,
    setStatus,
    step,
    activeTool,
    activeToolBytes,
    agentRuns,
    tokens,
    usageHistory,
    resetRunDiagnostics,
    restoreMemoryQueryHistoryFromLogs,
    contextTokens,
    setContextTokens,
    contextUsage,
    contextBudget,
    contextDiagnostics,
    contextDiagnosticsHistory,
    promptCacheDiagnostics,
    memoryAttachmentFailure,
    promptSectionFailure,
    compactFailure,
    memoryFailure,
    usagePersistenceFailure,
    setCompactFailure,
    setMemoryFailure,
    contextPending,
    setContextPending,
    streamingText,
    isStreaming,
    thinkingText,
    isThinking,
  }
}

import { recordMaintenanceUsage } from "./maintenanceUsage.js"
import { OutputThroughput, type OutputThroughputSample } from "./outputThroughput.js"
import type { AgentEventSource, AgentEvent, AgentEventHandler, ProviderRequestEvent } from "../../zapsdk/index.js"
import {
  persistCompactSummaryBestEffort,
  type MemoryFailureDiagnostic,
  type PersistCompactSummary,
} from "./memoryDiagnostics.js"
import type { AppConfig } from "../config.js"
import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"
import type { StreamingPreview } from "./streamingPreview.js"
import { extractFilesFromSummary } from "../ui/compact-utils.js"
import { autoMemory, conversation, tokenAccounting } from "../singletons.js"
import { appendUsage } from "../session.js"
import { persistRunUsage } from "./usagePersistence.js"
import { computeCacheUsageStats } from "../../zapsdk/agent/cache-metrics.js"
import type { ContextDiagnostics } from "../../zapsdk/agent/events.js"
import { maybePersistToolResult, PERSIST_THRESHOLD_CHARS } from "../../zapsdk/utils/tool-result-storage.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"
import type { PromptCacheDiagnostics } from "./promptDiagnostics.js"
import {
  buildContextBudgetSnapshot,
  legacyContextUsage,
  type ContextUsageSource,
} from "../context-budget.js"
import { sanitizeContextDiagnostics } from "./diagnosticSanitizers.js"
import { makePromptCacheScope } from "./cacheScope.js"
import { CacheMemoryAuditTracker, type CacheMemoryAuditEntry } from "./cacheMemoryAudit.js"
import type { MemoryUtilityCandidate, MemoryUtilityFingerprint } from "./memoryUtility.js"
import type { AgentRunSnapshot } from "../../zapsdk/agent/run-state.js"

type AddLog = (
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  images?: UserImageRef[],
  agentPath?: string[],
  extra?: Partial<LogEntry>,
) => void
type ReplaceLog = (
  id: number,
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  agentPath?: string[],
  extra?: Pick<LogEntry, "pending">,
) => void

export interface RunHandlersDeps {
  /** Live snapshot of the app config — read once at handler-creation time
   *  for warning thresholds. Doesn't need to be reactive: a handler set up
   *  for run N reads the config that was active when run N started. */
  currentConfig: AppConfig
  controller: AbortController
  preview: StreamingPreview

  setStatus: (s: string) => void
  setOutputThroughput?: (sample: OutputThroughputSample | undefined) => void
  setProviderRequest?: (request: ProviderRequestEvent | undefined) => void
  setStep: (n: number) => void
  setActiveTool: (s: string) => void
  setActiveToolBytes: (n: number) => void
  setContextTokens: (
    n: number,
    source?: ContextUsageSource,
    lastMeasuredPromptTokens?: number | null,
  ) => void
  setContextPending: (b: boolean) => void
  setContextDiagnostics?: (context: ContextDiagnostics | undefined) => void
  onRunUsage?: (usage: {
    purpose?: "main" | "maintenance"
    inputTokens: number
    outputTokens: number
    providerUsageReported?: boolean
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }) => void
  promptCacheDiagnostics?: PromptCacheDiagnostics
  getPromptCacheDiagnostics?: () => PromptCacheDiagnostics | undefined
  onCompactFailure?: (failure: {
    phase: "pre_turn" | "in_loop" | "manual"
    error: string
    consecutiveFailures?: number
    breakerTripped?: boolean
  }) => void
  onMemoryFailure?: (failure: MemoryFailureDiagnostic | undefined) => void
  onUsagePersistenceFailure?: (failure: { error: string } | undefined) => void
  persistCompactSummary?: PersistCompactSummary
  appendUsage?: typeof appendUsage
  cacheMemoryAuditSessionId?: string
  appendCacheMemoryAudit?: (entry: CacheMemoryAuditEntry) => void
  onCacheMemoryAuditFailure?: (failure: { error: string }) => void
  memoryUtilityCandidates?: readonly MemoryUtilityCandidate[]
  memoryUtilityBaseline?: MemoryUtilityFingerprint
  memoryUtilityCwd?: string
  /** Session/project scope used to persist oversized tool-result UI logs.
   *  These logs are written to session JSONL and can become model context
   *  after restore, so they need the same disk-marker treatment as live
   *  LoopAgent tool results. */
  toolOutputSessionId?: string
  toolOutputProjectCwd?: string

  addLog: AddLog
  replaceLog: ReplaceLog
  peekNextLogId: () => number
  compactLogs: (summary: string, before: number, after: number, files: string[]) => void
  /** Receives the authoritative state stream for live subagent runs. */
  onAgentRunState?: (run: AgentRunSnapshot) => void
}

interface PendingTool {
  name: string
  arguments: Record<string, unknown>
  logId: number
}
interface PendingSubagentTool {
  name: string
  arguments: Record<string, unknown> | undefined
  logId: number
  agentPath: string[]
}

export function contextTokensFromRunUsage(usage: {
  inputTokens: number
  providerUsageReported?: boolean
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}): number | null {
  if (usage.providerUsageReported === false) return null
  const used = computeCacheUsageStats(usage).totalPromptInputTokens
  return used > 0 ? used : null
}

function getStringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key]
  return typeof value === "string" ? value : undefined
}

function firstLinePreview(text: string, maxChars: number): string {
  const firstLine = text.slice(0, firstLineEndIndex(text))
  return countCodePoints(firstLine) > maxChars
    ? sliceHeadCodePoints(firstLine, maxChars)
    : firstLine
}

function firstLineEndIndex(text: string): number {
  const lf = text.indexOf("\n")
  const cr = text.indexOf("\r")
  if (lf < 0) return cr < 0 ? text.length : cr
  if (cr < 0) return lf
  return Math.min(lf, cr)
}

function toolResultOutputForLog(
  deps: RunHandlersDeps,
  toolCallId: string | undefined,
  toolName: string,
  output: string,
): string {
  if (!deps.toolOutputSessionId || countCodePoints(output) < PERSIST_THRESHOLD_CHARS) {
    return output
  }
  const persisted = maybePersistToolResult(
    toolCallId,
    deps.toolOutputSessionId,
    toolName,
    output,
    { projectCwd: deps.toolOutputProjectCwd },
  )
  return persisted.contentForConversation
}

export interface RunHandlers {
  /** Event handler to pass to AgentRuntime's subagent adapter. Must be created
   *  BEFORE the runtime is constructed (it goes into the factory). */
  subAgentEventHandler: AgentEventHandler
  /** Bind all `agent.on(...)` listeners. Call after constructing the agent. */
  wire(agent: AgentEventSource): void
  /** In `finally{}`: mark any tool calls that never received a result as
   *  failed with `reason`, so the UI's pendingTools spinner row clears
   *  even when the run ended abnormally (Ctrl+C, stream-idle, error). */
  settlePending(reason: string): void
}

export function createRunHandlers(deps: RunHandlersDeps): RunHandlers {
  const cacheScope = makePromptCacheScope(
    deps.currentConfig.active.providerId,
    deps.currentConfig.active.model,
  )
  const throughput = new OutputThroughput()
  const pendingToolLogById = new Map<string, PendingTool>()
  const pendingSubagentToolLogById = new Map<string, PendingSubagentTool>()
  // tool_use ids of root-level `agent(...)` calls already linked to a
  // spawned subagent via sub_agent_started. Prevents same-task parallel
  // spawns from all stamping the first pending entry — each
  // sub_agent_started claims the first UNclaimed matching pending.
  const claimedAgentToolCallIds = new Set<string>()
  // Track which warning threshold has already been logged this run so we
  // don't spam the transcript with identical "getting full" notices every
  // step. Resets per run via fresh closure.
  let highestWarnedRatio = 0
  let latestContextDiagnostics: ContextDiagnostics | undefined
  const cacheMemoryAudit = deps.appendCacheMemoryAudit
    ? new CacheMemoryAuditTracker({
        sessionId: deps.cacheMemoryAuditSessionId,
        cacheScope,
        getPromptCacheDiagnostics: () =>
          deps.getPromptCacheDiagnostics?.() ?? deps.promptCacheDiagnostics,
        ...(deps.memoryUtilityCandidates
          ? {
              memoryUtility: {
                candidates: deps.memoryUtilityCandidates,
                cwd: deps.memoryUtilityCwd ?? process.cwd(),
                baseline: deps.memoryUtilityBaseline,
              },
            }
          : {}),
        append: deps.appendCacheMemoryAudit,
        onError: (error) => deps.onCacheMemoryAuditFailure?.({ error: error.message }),
      })
    : undefined

  const subAgentEventHandler: AgentEventHandler = (event: AgentEvent) => {
    if (event.type === "agent_run_state") {
      deps.onAgentRunState?.(event.run)
      // Only the parent tool call lives at root. Nested runs are still kept
      // in AgentRunStore but must not claim a root transcript row.
      if (event.path && event.path.length > 0) return
      const toolCallId = event.run.toolCallId
      if (!toolCallId) return
      const pending = pendingToolLogById.get(toolCallId)
      if (!pending || (pending.name !== "agent" && pending.name !== "delegate_agent")) return
      claimedAgentToolCallIds.add(toolCallId)
      const updatedTool: ToolCallInfo = {
        id: toolCallId,
        name: pending.name,
        arguments: pending.arguments,
        meta: {
          subagentId: event.run.runId,
        },
      }
      deps.replaceLog(pending.logId, "tool", pending.name, updatedTool)
      return
    }

    // sub_agent_started (emitted BEFORE the subagent runs) carries the
    // task string + subagentId. Match back to the pending root-level
    // `agent(...)` tool_call by comparing `arguments.task` — that lets
    // groupLogs fold this subagent's children under its parent right
    // away, without waiting for the full tool_result to arrive.
    if (event.type === "sub_agent_started") {
      if (event.path && event.path.length > 0) return
      const task = (event as { task?: string }).task
      if (!task) return
      for (const [tuId, pending] of pendingToolLogById) {
        if (claimedAgentToolCallIds.has(tuId)) continue
        if (pending.name !== "agent" && pending.name !== "delegate_agent") continue
        if (getStringArg(pending.arguments, "task") !== task) continue
        // Claim-first so a second sub_agent_started with the same task
        // advances to the next pending instead of re-stamping this one.
        claimedAgentToolCallIds.add(tuId)
        const updatedTool: ToolCallInfo = {
          id: tuId,
          name: pending.name,
          arguments: pending.arguments,
          meta: { subagentId: event.subagentId },
        }
        deps.replaceLog(pending.logId, "tool", pending.name, updatedTool)
        break
      }
      return
    }

    // Events from subagents carry a non-empty `path`; root events have no path
    if (!event.path || event.path.length === 0) return
    if (event.type !== "content_final") return
    if (event.kind !== "tool_call" && event.kind !== "tool_result") return

    const agentPath = event.path

    if (event.kind === "tool_call") {
      const logId = deps.peekNextLogId()
      const args = event.arguments
      pendingSubagentToolLogById.set(event.id, {
        name: event.toolName,
        arguments: args,
        logId,
        agentPath,
      })
      const toolInfo: ToolCallInfo = { id: event.id, name: event.toolName, arguments: args }
      deps.addLog("tool", event.toolName, toolInfo, undefined, agentPath)
    } else {
      const pending = pendingSubagentToolLogById.get(event.id)
      pendingSubagentToolLogById.delete(event.id)
      const ok = event.result.success
      const rawOutput = ok ? event.result.output : event.result.error ?? ""
      const toolName = pending?.name ?? event.toolName
      const output = toolResultOutputForLog(deps, event.id, toolName, rawOutput)
      const preview = firstLinePreview(output, 80)
      const toolInfo: ToolCallInfo = {
        id: event.id,
        name: toolName,
        arguments: pending?.arguments,
        output,
        success: ok,
        suppression: event.result.runtime?.suppression,
        meta: event.result.runtime
          ? { ...(typeof event.result.meta === "object" && event.result.meta ? event.result.meta : {}), runtime: event.result.runtime }
          : event.result.meta,
      }
      const effectivePath = pending?.agentPath ?? agentPath
      if (pending?.logId !== undefined) {
        deps.replaceLog(pending.logId, "result", preview, toolInfo, effectivePath)
      } else {
        deps.addLog("result", preview, toolInfo, undefined, effectivePath)
      }
    }
  }

  function wire(agent: AgentEventSource): void {
    let recoveryLogId: number | undefined
    if (cacheMemoryAudit) agent.on("*", cacheMemoryAudit.handle)
    agent.on("provider_request", (e: AgentEvent) => {
      if (e.type !== "provider_request" || e.path?.length || deps.controller.signal.aborted) return
      deps.setProviderRequest?.(e.request)
      deps.setOutputThroughput?.(throughput.observe(e.step, e.request, e.requestId))
    })
    // Content events — single source of truth for assistant output
    agent.on("content_abandoned", (e: AgentEvent) => {
      if (e.type !== "content_abandoned") return
      // Remove the unfinished preview so abort draining cannot persist it
      // as part of the next successful response.
      deps.preview.onThinkingFinal(e.id)
    })
    agent.on("content_delta", (e: AgentEvent) => {
      if (e.type !== "content_delta") return
      if (e.kind === "text") {
        deps.setStatus("writing")
        deps.preview.onTextDelta(e.id, e.text)
      } else {
        deps.setStatus("thinking")
        deps.preview.onThinkingDelta(e.id, e.text)
      }
    })

    agent.on("content_final", (e: AgentEvent) => {
      if (e.type !== "content_final") return
      switch (e.kind) {
        case "text": {
          // Flush every paragraph + the trailing in-flight paragraph as a
          // last chunk. We DO NOT add a consolidated `addLog("agent", e.text)`
          // here — paragraph chunks already cover the full message and a
          // consolidated final log would visually duplicate the body.
          deps.preview.onTextFinal(e.id, e.text)
          break
        }
        case "thinking": {
          const { thinkingMs } = deps.preview.onThinkingFinal(e.id)
          deps.addLog("thinking", e.text, undefined, undefined, undefined, { thinkingMs })
          break
        }
        case "tool_call": {
          deps.preview.interruptPreviews()
          deps.setActiveTool(e.toolName)
          deps.setActiveToolBytes(0)
          deps.setStatus(e.toolName)
          if (e.step > 0) deps.setStep(e.step)
          const toolInfo: ToolCallInfo = {
            id: e.id,
            name: e.toolName,
            arguments: e.arguments,
          }
          const existing = pendingToolLogById.get(e.id)
          if (existing !== undefined) {
            pendingToolLogById.set(e.id, {
              name: e.toolName,
              arguments: e.arguments,
              logId: existing.logId,
            })
            deps.replaceLog(existing.logId, "tool", e.toolName, toolInfo)
          } else {
            const logId = deps.peekNextLogId()
            pendingToolLogById.set(e.id, {
              name: e.toolName,
              arguments: e.arguments,
              logId,
            })
            deps.addLog("tool", e.toolName, toolInfo)
          }
          break
        }
        case "tool_result": {
          deps.setActiveTool("")
          deps.setActiveToolBytes(0)
          const ok = e.result.success
          const pending = pendingToolLogById.get(e.id)
          pendingToolLogById.delete(e.id)
          const rawOutput = ok ? e.result.output : e.result.error ?? ""
          const toolName = pending?.name ?? e.toolName
          const output = toolResultOutputForLog(deps, e.id, toolName, rawOutput)
          const preview = firstLinePreview(output, 100)
          // meta: the tool-result's meta is treated as authoritative and
          // fully replaces any meta stamped earlier. Safe because
          // subagent.ts's commonMeta always includes subagentId.
          const toolInfo: ToolCallInfo = {
            id: e.id,
            name: toolName,
            arguments: pending?.arguments,
            output,
            success: ok,
            suppression: e.result.runtime?.suppression,
            meta: e.result.runtime || e.result.failure
              ? { ...(typeof e.result.meta === "object" && e.result.meta ? e.result.meta : {}),
                  ...(e.result.runtime ? { runtime: e.result.runtime } : {}),
                  ...(e.result.failure ? { failure: e.result.failure } : {}) }
              : e.result.meta,
          }
          if (pending?.logId !== undefined) {
            deps.replaceLog(pending.logId, "result", preview, toolInfo)
          } else {
            deps.addLog("result", preview, toolInfo)
          }
          break
        }
      }
    })

    agent.on("run_step", (e: AgentEvent) => {
      if (e.type === "run_step" && !e.path?.length && !deps.controller.signal.aborted) {
        throughput.reset()
        deps.setOutputThroughput?.(undefined)
        deps.setStatus("preparing")
        deps.setProviderRequest?.(undefined)
        deps.setStep(e.step)
        latestContextDiagnostics = sanitizeContextDiagnostics(e.context)
        deps.setContextDiagnostics?.(latestContextDiagnostics)
      }
    })

    agent.on("run_usage", (e: AgentEvent) => {
      if (e.type !== "run_usage") return
      if (e.purpose === "maintenance") {
        deps.onRunUsage?.(e)
        try { recordMaintenanceUsage(e, deps.appendUsage ?? appendUsage); deps.onUsagePersistenceFailure?.(undefined) }
        catch (error) { deps.onUsagePersistenceFailure?.({ error: String(error) }) }
        return
      }
      if (!e.path?.length && !deps.controller.signal.aborted) {
        deps.setOutputThroughput?.(throughput.usage(e.step, e.outputTokens, e.providerUsageReported))
      }
      // Real context occupancy = fresh input + cache reads + cache writes.
      // With Anthropic prompt caching active, fresh `inputTokens` drops to
      // near-zero on cached turns while the actual prompt the model sees
      // can be 100k+. Summing all three matches what the provider counts
      // against the context window, even though cache reads are billed
      // cheaper. Without this sum the Footer / TokenWarning silently
      // under-report usage by an order of magnitude in long sessions.
      const used = contextTokensFromRunUsage(e)
      if (used !== null) deps.setContextTokens(used, "provider")
      deps.setContextPending(false)
      deps.onRunUsage?.({
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        ...(typeof e.providerUsageReported === "boolean"
          ? { providerUsageReported: e.providerUsageReported }
          : {}),
        ...(typeof e.cacheReadInputTokens === "number"
          ? { cacheReadInputTokens: e.cacheReadInputTokens }
          : {}),
        ...(typeof e.cacheCreationInputTokens === "number"
          ? { cacheCreationInputTokens: e.cacheCreationInputTokens }
          : {}),
      })
      // Refine the cached prompt-overhead so subsequent fallback paths
      // (session restore, pre-turn compact, manual /compact) can display
      // a number close to the API truth instead of conversation-only.
      const localAtTime = conversation.estimatedTokens
      // Persist to the session JSONL so a NEW zap process restoring this
      // session can prime its indicators with last-known API truth instead
      // of cold-starting at the conversation-only estimate. The promptOverhead
      // ref above only survives within this process; the JSONL line survives
      // across restarts.
      try {
        const promptCacheDiagnostics =
          deps.getPromptCacheDiagnostics?.() ?? deps.promptCacheDiagnostics
        persistRunUsage({
          ...e,
          ...(cacheScope ? { cacheScope } : {}),
          ...(latestContextDiagnostics ? { contextDiagnostics: latestContextDiagnostics } : {}),
          ...(promptCacheDiagnostics ? { promptCacheDiagnostics } : {}),
        }, {
          getLocalEstimate: () => localAtTime,
          appendUsage: deps.appendUsage ?? appendUsage,
          setPromptOverhead: (overhead) => { tokenAccounting.promptOverhead = overhead },
        })
        deps.onUsagePersistenceFailure?.(undefined)
      } catch (err) {
        deps.onUsagePersistenceFailure?.({
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Use the same operational pressure as Footer and TokenWarning. The
      // notice/warning points correspond to 60%/70% of effective input and
      // auto-compact itself remains 80%.
      const budget = used === null
        ? null
        : buildContextBudgetSnapshot(deps.currentConfig, legacyContextUsage(used))
      const pressure = budget?.pressure ?? 0
      if (budget && (budget.severity === "warning" || budget.severity === "critical") && highestWarnedRatio < 0.875) {
        highestWarnedRatio = 0.875
        deps.addLog(
          "system",
          `⚠ Context at ${Math.round(pressure * 100)}% of auto-compact budget — compaction is close. You can /compact now to control the boundary.`,
        )
      } else if (budget?.severity === "notice" && highestWarnedRatio < 0.75) {
        highestWarnedRatio = 0.75
        deps.addLog(
          "system",
          `ℹ Context at ${Math.round(pressure * 100)}% of auto-compact budget — approaching compaction.`,
        )
      }
    })

    agent.on("error", (e: AgentEvent) => {
      if (e.type !== "error") return
      if (recoveryLogId !== undefined) {
        deps.replaceLog(recoveryLogId, "system", /aborted/i.test(e.error) ? "Request recovery cancelled" : "Request recovery failed — see the error below", undefined, undefined, { pending: false })
        recoveryLogId = undefined
      }
      // User-initiated abort: silent. The run_ended divider already signals
      // the run stopped. Matches Anthropic SDK's "Request was aborted.",
      // Node fetch's "The operation was aborted", and our zapsdk's literal
      // "aborted".
      if (/aborted/i.test(e.error)) return
      if (e.error.includes("stream idle timeout")) {
        deps.addLog(
          "error",
          `❌ ${e.error}\n  ↳ Set ZAPCODE_STREAM_IDLE_MS=300000 (5 min) or higher for slow providers / large write_file payloads.`,
        )
      } else {
        deps.addLog("error", `❌ ${e.error}`)
      }
    })

    // Run boundary marker. Skipped on abort: the `(interrupted)` system
    // marker added in `finally` already signals the boundary AND tells the
    // user *why* the turn ended.
    agent.on("run_ended", (e: AgentEvent) => {
      if (e.type !== "run_ended") return
      if (recoveryLogId !== undefined) {
        deps.replaceLog(recoveryLogId, "system", deps.controller.signal.aborted ? "Request recovery cancelled" : "Request recovery ended without confirmation", undefined, undefined, { pending: false })
        recoveryLogId = undefined
      }
      if (deps.controller.signal.aborted) {
        return
      }
      deps.addLog("divider", "")
    })

    agent.on("observation", (e: AgentEvent) => {
      if (e.type !== "observation") return
      if (e.kind === "prune_done" && !e.path?.length) {
        const d = e.detail
        const before = Number(d?.inputTokens ?? 0), after = Number(d?.outputTokens ?? 0)
        deps.setContextTokens(after, "estimated", null)
        deps.addLog("system", `Pruned ${d?.messagesPruned ?? 0} historical outputs · ~${Math.max(0, before - after)} tokens saved locally; provider cache may rebuild.`,
          undefined, undefined, undefined, { restore: false })
      }
      if (e.kind === "autocompact_start") {
        deps.setStatus("compacting")
        const d = e.detail as
          | { messageCount?: number; tokenEstimate?: number; trigger?: string }
          | undefined
        const msgs = d?.messageCount ?? 0
        const tok = d?.tokenEstimate ?? 0
        const reason = d?.trigger === "force" ? "overflow recovery" : d?.trigger === "tokens" ? "token threshold" : "char threshold"
        deps.addLog(
          "system",
          `🗜 Compacting context — ${msgs} messages / ~${Math.round(tok / 1000)}k tokens (${reason})`,
        )
        // The shared planner already counted schemas and transient context.
        // Do not add the previous provider-calibrated overhead a second time.
        if (tok > 0) {
          deps.setContextTokens(tok, "estimated", null)
        }
      } else if (e.kind === "image_strip_self_heal") {
        deps.addLog(
          "system",
          "⚠ Active model rejected an image. Stripped image content from this turn and persisted vision=off — switch to a vision-capable model via /model to send images.",
        )
      } else if (e.kind === "reactive_compact") {
        const d = e.detail as {
          attempt?: number; maxAttempts?: number; reason?: string;
          before?: { messageBytes: number }; after?: { messageBytes: number };
          mode?: string; messagesBefore?: number; messagesAfter?: number;
        } | undefined
        if (d?.mode) {
          deps.addLog("system", `Context reduced locally: ${d.messagesBefore} → ${d.messagesAfter} messages`)
        } else if (d?.attempt) {
          const cause = d.reason === "request_body" ? "Request body too large — reducing historical images" : "Context token limit — reducing conversation"
          const sizes = d.before && d.after
            ? ` · message data ${(d.before.messageBytes / 1048576).toFixed(2)} → ${(d.after.messageBytes / 1048576).toFixed(2)} MiB` : ""
          const text = `${cause}${sizes} · retry ${d.attempt}/${d.maxAttempts ?? 2}`
          if (recoveryLogId === undefined) {
            recoveryLogId = deps.peekNextLogId()
            deps.addLog("system", text, undefined, undefined, undefined, { pending: true })
          } else deps.replaceLog(recoveryLogId, "system", text)
        }
      } else if (e.kind === "historical_images_retired") {
        const d = e.detail as { retiredGroups: number; beforeImageBytes: number; afterImageBytes: number }
        deps.addLog("system", `Historical images retired in ${d.retiredGroups} tool groups · image data ${(d.beforeImageBytes / 1048576).toFixed(2)} → ${(d.afterImageBytes / 1048576).toFixed(2)} MiB · text and recent images retained`)
      } else if (e.kind === "request_recovered") {
        const d = e.detail as { reason?: string } | undefined
        const text = d?.reason === "request_body"
          ? "Request recovered — historical image payload reduced; text retained for subsequent steps"
          : "Request recovered — reduced context retained for subsequent steps"
        if (recoveryLogId === undefined) deps.addLog("system", text)
        else deps.replaceLog(recoveryLogId, "system", text, undefined, undefined, { pending: false })
        recoveryLogId = undefined
      } else if (e.kind === "autocompact_done") {
        deps.setStatus("thinking")
        const d = e.detail as
          | {
              messagesBefore?: number
              messagesAfter?: number
              summary?: string
              failed?: boolean
              error?: string
              breakerTripped?: boolean
              consecutiveFailures?: number
              outputTokens?: number
              status?: string
              sourceTruncated?: boolean
            }
          | undefined
        if (d?.failed) {
          const fails = d.consecutiveFailures ?? 0
          deps.onCompactFailure?.({
            phase: "in_loop",
            error: d.error ?? "unknown error",
            consecutiveFailures: fails,
            breakerTripped: d.breakerTripped === true,
          })
          if (d.breakerTripped) {
            deps.addLog(
              "error",
              `✗ Context compact failed ${fails}× — circuit breaker tripped. Further autocompact attempts suspended for this run. Error: ${(d.error ?? "").slice(0, 100)}`,
            )
          } else {
            deps.addLog(
              "error",
              `✗ Context compact failed (attempt ${fails}/3): ${(d.error ?? "").slice(0, 120)}`,
            )
          }
        } else {
          if (typeof d?.outputTokens === "number") deps.setContextTokens(d.outputTokens, "estimated", null)
          const before = d?.messagesBefore ?? 0
          const after = d?.messagesAfter ?? 0
          const summary = d?.summary ?? ""
          if (summary && before > 0) {
            deps.compactLogs(summary, before, after, extractFilesFromSummary(summary))
            if (d?.status === "target_not_met") deps.addLog("system", "⚠ Compacted; protected recent input exceeds the soft target but fits the context limit.")
            if (d?.sourceTruncated) deps.addLog("system", "⚠ Compact used bounded history previews; some historical detail was omitted.")
            // Persist durable sections (decisions / errors / files) so they
            // survive compact-of-compact decay. Fire-and-forget — matches the
            // pre-turn and manual /compact paths.
            persistCompactSummaryBestEffort(summary, autoMemory, {
              onMemoryFailure: deps.onMemoryFailure,
              persist: deps.persistCompactSummary,
            })
          } else if (before === after) {
            // No-op compact: every message was either system or "recent
            // enough" to be kept by AutoCompact. Common when a handful of
            // messages each carry a large @file inline — context is full,
            // but nothing's old enough to summarize. Flag it loudly so the
            // user knows /compact will not help and they need to free
            // space manually (/clear, /new, or removing @file refs).
            deps.addLog(
              "system",
              `⚠ Compact had no effect — all ${before} messages are within the keep-recent window. ` +
              `Free space manually: /clear to wipe the transcript, /new for a fresh session, or remove large @file refs.`,
            )
          } else {
            deps.addLog("system", `✓ Context compacted: ${before} → ${after} messages`)
          }
        }
      }
    })

    // Tool call payload is streaming in from the LLM but hasn't finished yet.
    // Fires twice per tool for large payloads:
    //   1. on tool_call_start — toolName known, argsPreview=undefined → show `(…)`
    //   2. on first tool_call_delta that yields a path/command/query hint →
    //      argsPreview set → upgrade the row to `write_file(report.md)`
    // Once content_final.tool_call fires, the row is finalized with real args.
    agent.on("tool_call_pending", (e: AgentEvent) => {
      if (e.type !== "tool_call_pending") return
      deps.preview.interruptPreviews()
      deps.setActiveTool(e.toolName)
      deps.setStatus(`generating ${e.toolName}…`)
      if (e.step > 0) deps.setStep(e.step)
      const preview = e.argsPreview ?? {}
      const bytesHint = e.bytesHint
      if (typeof bytesHint === "number") deps.setActiveToolBytes(bytesHint)
      const toolInfo: ToolCallInfo = {
        id: e.id,
        name: e.toolName,
        arguments: preview,
        // meta.pending tells InlineTool to render `(…)` when args are empty.
        // bytesHint is re-emitted on ~2KB buffer growth so the UI can show
        // "bash(python -c … · 18KB)" while a huge payload streams in.
        meta: {
          ...(Object.keys(preview).length === 0 ? { pending: true } : {}),
          ...(bytesHint !== undefined ? { bytesHint } : {}),
        },
      }
      const existing = pendingToolLogById.get(e.id)
      if (existing !== undefined) {
        pendingToolLogById.set(e.id, { name: e.toolName, arguments: preview, logId: existing.logId })
        deps.replaceLog(existing.logId, "tool", e.toolName, toolInfo)
      } else {
        const logId = deps.peekNextLogId()
        pendingToolLogById.set(e.id, { name: e.toolName, arguments: preview, logId })
        deps.addLog("tool", e.toolName, toolInfo)
      }
    })
  }

  function settlePending(reason: string): void {
    for (const [id, p] of pendingToolLogById) {
      deps.replaceLog(p.logId, "result", reason, {
        id,
        name: p.name,
        arguments: p.arguments,
        output: reason,
        success: false,
      })
    }
    pendingToolLogById.clear()
    for (const [id, p] of pendingSubagentToolLogById) {
      deps.replaceLog(
        p.logId,
        "result",
        reason,
        { id, name: p.name, arguments: p.arguments, output: reason, success: false },
        p.agentPath,
      )
    }
    pendingSubagentToolLogById.clear()
  }

  return { subAgentEventHandler, wire, settlePending }
}

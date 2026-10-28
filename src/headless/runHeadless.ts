import { connectLocalServiceOwner } from "../../zapsdk/services/local-owner.js"
import { createExecutionEnvironment, resolveExecutionBackend } from "../execution-environment.js"
import { executionExitCode, OutcomeProtocolError, type AgentOutcomeV1 } from "../../zapsdk/runtime/outcome.js"
import type { CompletionEvidenceProvider } from "../../zapsdk/harness/completion.js"
import type { LLMProvider } from "../../zapsdk/core/llm.js"
import { requireProcessSealing } from "../../zapsdk/execution/required-process-seal.js"
// Headless run loop. Loads config, builds an AgentRuntime (sharing the TUI's
// provider/registry/executor factory), wires the formatter to AgentEvent
// streams, and exits with a stop-reason-derived code.
//
// What's intentionally NOT here vs the TUI:
//   - no React, no Ink, no streamingPreview (formatter handles deltas directly)
//   - no interactive rewind UI, but file checkpoints remain enabled so every
//     destructive write has the same recoverability boundary as the TUI
//   - no PlanModeCallbacks (plan-mode just denies writes — no UI dialog needed)
//   - no devtools server unless ZAPCODE_DEVTOOLS_PORT was explicitly set
//   - no auto-compact reactive pause (we let it run silently)

import process from "node:process"
import { realpathSync } from "node:fs"
import type { PrivateGitBinding } from "../../zapsdk/workspace/types.js"
import { join } from "node:path"
import { createBoundedRepairSession, type BoundedRepairResult } from "../../zapsdk/runtime/bounded-repair.js"
import type { CreateAgentRuntimeOptions } from "../../zapsdk/runtime/factory.js"
import type { LoopAgentResult } from "../../zapsdk/agent/loop.js"
import { loadResultSourceGuard } from "./resultSourcePolicy.js"
import { loadPublicChecks, type PublicChecksConfiguration } from "./publicChecks.js"
import { AgentLogger } from "../../zapsdk/debug/agent-logger.js"
import { Logger } from "../../zapsdk/index.js"
import { watchObserver } from "../watch/integration.js"
import type { AgentEvent } from "../../zapsdk/index.js"
import type { Message, TokenUsage } from "../../zapsdk/core/types.js"
import {
  loadAppConfig,
  buildSystemPrompt,
  getActiveMaxOutputTokens,
  getActiveProvider,
  setActive,
  hasApiKey,
  type AppConfig,
} from "../config.js"
import { resolveActiveContextLimits } from "../context-budget.js"
import {
  configPath,
  loadLastSession,
  prepareSavedSession,
  SessionLoadError,
  setActiveSession,
  sessionLogsToMessages,
  getCurrentSessionId,
  appendLog,
  appendUsage,
  appendSnapshot,
  readCheckpointJournal,
  peekJournalLogIndex,
} from "../session.js"
import { conversation, autoMemory, taskStore, cronHandle, mdStore, globalMdStore, globalMemoryDir, memorySemanticRetriever, tokenAccounting, delegateProvidersReady } from "../singletons.js"
import { buildAgentObjects } from "../agent-factory.js"
import { CheckpointManager } from "../../zapsdk/checkpoint/index.js"
import {
  buildMemoryQueryHistoryFromLogs,
  buildMemoryQueryHistoryFromMessages,
  buildMemoryQueryForRun,
  buildPerTurnAttachments,
  makeContextBuilders,
  makeTurnEndGuard,
} from "../agent/contextAttachments.js"
import { buildRepoMapAttachment } from "../agent/repoMap.js"
import { appendCacheableSystemSection, buildRuntimePromptToolInputs } from "../agent/systemPrompt.js"
import { createPromptSectionDiagnostics, buildPromptCacheDiagnostics, type PromptCacheDiagnostics } from "../agent/promptDiagnostics.js"
import { summarizeSkillsForPrompt } from "../agent/skillSummary.js"
import { createAgentRuntime, subagentTool, type Todo, type TodoStore } from "../../zapsdk/index.js"
import { loadAllSkills } from "../../zapsdk/skills/loader.js"
import type { HeadlessArgs } from "./args.js"
import { createFormatter, type StopReason, type RunSummary, type HeadlessFormatter } from "./formatter.js"
import type { ApprovalCallback } from "../../zapsdk/tools/executor.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import { loadImageFromFile } from "../../zapsdk/utils/image.js"
import type { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { buildHeadlessApproval } from "./approval.js"
import { getToolAlias } from "../ui/transcript-format.js"
import { persistRunUsage } from "../agent/usagePersistence.js"
import { makePromptCacheScope, type PromptCacheScope } from "../agent/cacheScope.js"
import {
  appendCacheMemoryAudit,
  CacheMemoryAuditTracker,
} from "../agent/cacheMemoryAudit.js"
import {
  persistCompactSummaryBestEffort,
  type PersistCompactSummary,
} from "../agent/memoryDiagnostics.js"
import type { AutoMemory } from "../../zapsdk/memory/auto-memory.js"
import type { HarnessPolicyOverrides } from "../../zapsdk/harness/policy.js"
import type { ContextDiagnostics } from "../../zapsdk/agent/events.js"
import {
  createProjectRuntimeEventStore,
  createProjectRuntimeStateStore,
  projectRuntimeStateDir,
} from "../agent/runtimeEventStore.js"
import {
  registerHostRuntime,
  startHostProtocolServerIfEnabled,
  stopHostProtocolServer,
} from "../agent/hostProtocol.js"

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_BAD_ARGS = 2
export const EXIT_NO_PROVIDER = 3
export const EXIT_PERMISSION_DENIED = 4
export const EXIT_INTERRUPTED = 130

function applyOverrides(config: AppConfig, args: HeadlessArgs): { config: AppConfig; error?: string } {
  if (!args.model) return { config }
  const active = getActiveProvider(config)
  if (!active) return { config }
  // Validate against the active provider's model list. A typo would otherwise
  // silently switch active.model to an invalid value and fail much later at
  // API call time with a 404 the user can't tie back to --model.
  if (active.models.length > 0 && !active.models.includes(args.model)) {
    return {
      config,
      error: `--model '${args.model}' not registered with provider '${active.name || active.id}'. Known: ${active.models.join(", ")}`,
    }
  }
  return { config: setActive(config, active.id, args.model) }
}

export function stopReasonExitCode(reason: StopReason): number {
  switch (reason) {
    case "end_turn": return EXIT_OK
    case "permission_denied": return EXIT_PERMISSION_DENIED
    case "aborted": return EXIT_INTERRUPTED
    case "incomplete":
    case "error": return EXIT_ERROR
    default: return EXIT_OK  // max_steps / max_tokens / budget / timeout / max_repeat are "soft" stops
  }
}

export function resolveRunStopReason(
  stopped: StopReason | undefined,
  anyDenied: boolean,
  continueOnToolDenial = false,
  completionStatus?: "completed" | "incomplete",
): StopReason {
  if (anyDenied && !continueOnToolDenial) return "permission_denied"
  return stopped ?? (completionStatus === "incomplete" ? "incomplete" : "end_turn")
}

export function formatUsagePersistenceWarning(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `warning: failed saving usage history: ${message}\n`
}

export function formatCompactMemoryPersistenceWarning(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `warning: failed saving compact memory: ${message}\n`
}

export function buildHeadlessMemoryQuery(
  prompt: string,
  priorMessages: readonly Pick<Message, "role" | "content">[],
  restoredMemoryQueryHistory: readonly string[] = [],
): string | undefined {
  return buildMemoryQueryForRun(
    prompt,
    [
      ...buildMemoryQueryHistoryFromMessages(priorMessages),
      ...restoredMemoryQueryHistory,
    ],
  )
}

export function persistHeadlessRunUsage(
  event: AgentEvent,
  deps: {
    getLocalEstimate: () => number
    appendUsage: typeof appendUsage
    setPromptOverhead: (overhead: number) => void
    contextDiagnostics?: ContextDiagnostics
    promptCacheDiagnostics?: PromptCacheDiagnostics
    cacheScope?: PromptCacheScope
    writeWarning?: (text: string) => void
  },
): void {
  if (event.type !== "run_usage") return
  try {
    persistRunUsage({
      ...event,
      ...(deps.contextDiagnostics ? { contextDiagnostics: deps.contextDiagnostics } : {}),
      ...(deps.promptCacheDiagnostics ? { promptCacheDiagnostics: deps.promptCacheDiagnostics } : {}),
      ...(deps.cacheScope ? { cacheScope: deps.cacheScope } : {}),
    }, {
      getLocalEstimate: deps.getLocalEstimate,
      appendUsage: deps.appendUsage,
      setPromptOverhead: deps.setPromptOverhead,
    })
  } catch (err) {
    const writeWarning = deps.writeWarning ?? ((text: string) => { process.stderr.write(text) })
    writeWarning(formatUsagePersistenceWarning(err))
  }
}

export function persistHeadlessFinalRunUsageIfNeeded(
  deps: {
    sawRunUsage: boolean
    usage: TokenUsage
    getLocalEstimate: () => number
    appendUsage: typeof appendUsage
    setPromptOverhead: (overhead: number) => void
    contextDiagnostics?: ContextDiagnostics
    promptCacheDiagnostics?: PromptCacheDiagnostics
    cacheScope?: PromptCacheScope
    writeWarning?: (text: string) => void
  },
): boolean {
  if (deps.sawRunUsage) return false
  try {
    persistRunUsage({
      ...deps.usage,
      ...(deps.contextDiagnostics ? { contextDiagnostics: deps.contextDiagnostics } : {}),
      ...(deps.promptCacheDiagnostics ? { promptCacheDiagnostics: deps.promptCacheDiagnostics } : {}),
      ...(deps.cacheScope ? { cacheScope: deps.cacheScope } : {}),
    }, {
      getLocalEstimate: deps.getLocalEstimate,
      appendUsage: deps.appendUsage,
      setPromptOverhead: deps.setPromptOverhead,
    })
    return true
  } catch (err) {
    const writeWarning = deps.writeWarning ?? ((text: string) => { process.stderr.write(text) })
    writeWarning(formatUsagePersistenceWarning(err))
    return false
  }
}

export function persistHeadlessCompactSummary(
  event: AgentEvent,
  deps: {
    autoMemory: AutoMemory
    persistCompactSummary?: PersistCompactSummary
    writeWarning?: (text: string) => void
  },
): void {
  if (event.type !== "observation" || event.kind !== "autocompact_done") return
  const detail = event.detail as
    | {
        messagesBefore?: number
        summary?: string
        failed?: boolean
      }
    | undefined
  if (detail?.failed) return
  const before = detail?.messagesBefore ?? 0
  const summary = detail?.summary ?? ""
  if (!summary || before <= 0) return
  const writeWarning = deps.writeWarning ?? ((text: string) => { process.stderr.write(text) })
  persistCompactSummaryBestEffort(summary, deps.autoMemory, {
    persist: deps.persistCompactSummary,
    onMemoryFailure: (failure) => {
      if (!failure) return
      writeWarning(formatCompactMemoryPersistenceWarning(failure.error))
    },
  })
}

/** Host hooks for non-TUI integrations. Policy and Runtime
 * assembly stay shared with the ordinary CLI; hosts cannot bypass hard denies. */
export interface HeadlessHost {
  harnessPolicy?: HarnessPolicyOverrides
  /** Host-authored task acceptance, separate from model text and tool success. */
  completionEvidence?: CompletionEvidenceProvider
  config?: AppConfig
  formatter?: HeadlessFormatter
  onAsk?: ApprovalCallback
  onEvent?: (event: AgentEvent) => void
  onSealing?: () => void
  sealingTimeoutMs?: number
  getPermissionMode?: () => HeadlessArgs["permissionMode"]
  /** Host workflows must not mistake a denied operation for successful work. */
  onPermissionDenied?: (toolName: string, reason: string) => void
  images?: ImageContent[]
  strictResume?: boolean
  prepareRegistry?: (registry: ToolRegistry) => Promise<void>
  /** Trusted Host instrumentation, applied inside RetryProvider. */
  providerAdapter?: (provider: LLMProvider) => LLMProvider
  admitToolExecution?: (toolName: string) => void
  /** Host-controlled admission may require prohibiting unmetered child agents. */
  disableSubagent?: boolean
  /** Host-owned isolation root for workflows requiring fenced child workspaces. */
  subagentIsolationRoot?: string
  /** Enforce the workspace boundary even in permissive approval modes. */
  isolateWorkspace?: boolean
  privateGit?: PrivateGitBinding
  privateGitOwnerDirectory?: string
  serializeSubagent?: boolean
  prepareSubagentWorkspace?: (cwd: string, signal?: AbortSignal) => Promise<void>
  validateSubagentWorkspace?: (cwd: string, signal?: AbortSignal) => Promise<void>
  /** Require an OS sandbox with no network grant and workspace-only shell paths. */
  disableShellNetwork?: boolean
  requireProcessSeal?: boolean
  onProcessSealUnconfirmed?: () => void
  disableRepoMap?: boolean
}

export async function runHeadless(args: HeadlessArgs, host: HeadlessHost = {}): Promise<number> {
  const outcomeMode = (args.resultSchema ?? "outcome-v1") === "outcome-v1"
  if (outcomeMode && (host.completionEvidence || host.harnessPolicy?.completion || host.harnessPolicy?.task?.completion)) {
    process.stderr.write("error: UNSUPPORTED_ACCEPTANCE_MODE: explicit legacy completion requires --result-schema legacy\n")
    return EXIT_BAD_ARGS
  }
  // ── Load + override config ───────────────────────────────────────────
  let config = host.config ?? loadAppConfig(configPath)
  const ov = applyOverrides(config, args)
  if (ov.error) {
    process.stderr.write(`error: ${ov.error}\n`)
    return EXIT_BAD_ARGS
  }
  config = ov.config
  const cacheScope = makePromptCacheScope(config.active.providerId, config.active.model)

  if (!hasApiKey(config)) {
    process.stderr.write(
      "no provider configured. Run `zap` interactively once to set one up with /connect.\n",
    )
    return EXIT_NO_PROVIDER
  }

  // ── Determine working directory ──────────────────────────────────────
  // NOTE: actual `process.chdir(args.cwd)` happens earlier in index.tsx,
  // *before* singletons.ts loads, so autoMemory / mdStore / permissionManager
  // all get constructed with the user-requested cwd. By the time we get
  // here, process.cwd() already reflects --cwd. We just use it.
  const cwd = process.cwd()
  let resultGuard: Awaited<ReturnType<typeof loadResultSourceGuard>> | undefined
  if (args.resultSourcePolicy) {
    try { resultGuard = await loadResultSourceGuard(args.resultSourcePolicy, cwd) }
    catch { process.stderr.write("Invalid or unreadable Host source policy.\n"); return EXIT_BAD_ARGS }
  }
  let publicChecks: PublicChecksConfiguration | undefined
  if (args.publicChecks) {
    if (!outcomeMode || args.continueLast || args.sessionId || host.completionEvidence
      || host.harnessPolicy?.completion || host.harnessPolicy?.task?.completion) {
      process.stderr.write("error: --public-checks requires a fresh outcome-v1 run without legacy completion\n")
      return EXIT_BAD_ARGS
    }
    try {
      publicChecks = await loadPublicChecks(args.publicChecks, cwd, join(projectRuntimeStateDir(cwd), "..", "acceptance"))
      if (args.timeoutMs !== undefined) publicChecks.budget.timeoutMs = Math.min(publicChecks.budget.timeoutMs, args.timeoutMs)
    } catch (error) {
      process.stderr.write(`error: public checks preflight: ${error instanceof Error ? error.message : String(error)}\n`)
      return EXIT_BAD_ARGS
    }
  }
  // Headless previously omitted todo_write entirely, so constrained runs had
  // no structured way to decompose work before operating on a repository.
  // Keep this store local to one process: the transcript records the plan,
  // while a fresh invocation must not inherit stale work from an older run.
  let headlessTodos: Todo[] = []
  const headlessTodoStore: TodoStore = {
    get: () => headlessTodos,
    set: (_key, _oldTodos, nextTodos) => { headlessTodos = nextTodos },
  }

  // ── Session restore (--continue / --session-id) ──────────────────────
  // Caveat: `setActiveSession` finalizes the auto-created writer and starts
  // a NEW one with a NEW UUID, then replays the loaded logs into it. So the
  // returned sessionId in formatter.init below is the *new* fork id, not the
  // source id. This matches the TUI's /sessions dialog (and Claude Code's
  // --continue) — historical conversation is loaded into ConversationManager,
  // but new writes go to a fresh file. The source id is surfaced in JSONL
  // / progress output as `resumedFrom` for traceability.
  let resumedFrom: string | undefined
  let restoredMemoryQueryHistory: string[] = []
  if (args.continueLast) {
    const restored = loadLastSession()
    if (restored) {
      const msgs = hydrateHeadlessTranscriptImages(sessionLogsToMessages(restored.logs))
      resumedFrom = restored.id
      restoredMemoryQueryHistory = buildMemoryQueryHistoryFromLogs(restored.logs)
      const previous = conversation.getAllMessages()
      conversation.mutateInPlace(current => current.splice(0, current.length, ...msgs))
      try {
        setActiveSession(restored.logs, { sourceSessionId: restored.id })
      } catch (error) {
        conversation.mutateInPlace(current => current.splice(0, current.length, ...previous))
        throw error
      }
    }
  } else if (args.sessionId) {
    try {
      const restored = await prepareSavedSession(args.sessionId)
      const msgs = hydrateHeadlessTranscriptImages(sessionLogsToMessages(restored.sessionLogs))
      resumedFrom = args.sessionId
      restoredMemoryQueryHistory = buildMemoryQueryHistoryFromLogs(restored.sessionLogs)
      const previous = conversation.getAllMessages()
      conversation.mutateInPlace(current => current.splice(0, current.length, ...msgs))
      try {
        setActiveSession(restored.sessionLogs, {
          sourceSessionId: restored.sourceSessionId,
          metadata: restored.metadata,
        })
      } catch (error) {
        conversation.mutateInPlace(current => current.splice(0, current.length, ...previous))
        throw error
      }
    } catch (error) {
      if (host.strictResume) throw error
      if (!(error instanceof SessionLoadError)) throw error
      process.stderr.write(`warning: ${error.message} — starting a fresh conversation\n`)
    }
  }

  // ── Formatter + approval gate ────────────────────────────────────────
  const formatter = host.formatter ?? createFormatter(args.outputFormat, args.quiet, args.resultSchema ?? "outcome-v1")
  const provider = getActiveProvider(config)!
  formatter.init({
    sessionId: getCurrentSessionId(),
    model: config.active.model,
    provider: provider.name ?? provider.id,
    resumedFrom,
  })

  const approval = buildHeadlessApproval({
    cwd,
    get permissionMode() { return host.getPermissionMode?.() ?? args.permissionMode },
    onAsk: host.onAsk,
    allowedTools: args.allowedTools,
    disallowedTools: args.disallowedTools,
    onDeny: (tool, reason) => {
      formatter.progress(`✗ denied ${getToolAlias(tool)}: ${reason}`)
      host.onPermissionDenied?.(tool, reason)
    },
    onDecision: (tool, decision, reason) => {
      if (args.outputFormat === "stream-json" && !host.formatter) {
        // Surface decisions as observations so downstream tooling can see
        // the gate without parsing stderr.
        process.stdout.write(JSON.stringify({
          type: "permission",
          tool,
          alias: getToolAlias(tool),
          decision,
          reason,
        }) + "\n")
      }
    },
  })

  // Headless previously disabled the checkpoint manager entirely. That made
  // it impossible to enforce the same destructive-write contract used by the
  // TUI, and hid write evidence from resumable sessions. Persist snapshots in
  // the normal session JSONL even though headless does not expose /rewind.
  const checkpoint = new CheckpointManager({
    sessionId: getCurrentSessionId(),
    cwd,
    writeJsonlEntry: (entry) => appendSnapshot(entry.snapshot, true),
    onError: (error) => {
      if (error.reason.startsWith("track-edit")) return
      formatter.progress(`checkpoint: ${error.reason}${error.path ? ` ${error.path}` : ""}${error.message ? ` — ${error.message}` : ""}`)
    },
    config: {
      managedStorage: true,
      enabled: config.fileCheckpointingEnabled ?? true,
      maxFileBytes: config.maxSnapshotFileBytes ?? 10 * 1024 * 1024,
      maxSnapshots: config.maxSnapshots ?? 100,
      blobDir: config.checkpointBlobDir,
    },
  })

  checkpoint.hydrateFromJsonl(readCheckpointJournal(getCurrentSessionId()))

  // ── Build agent objects (cwd-aware) ──────────────────────────────────
  const skills = loadAllSkills(cwd)
  // Detection is asynchronous; a cold worker must not build an empty registry.
  await delegateProvidersReady
  let executionEnvironment: ReturnType<typeof createExecutionEnvironment> | undefined
  if (args.serviceOwner) {
    try {
      if (args.dangerouslyDisableOsSandbox || config.allowUnsandboxedCommands !== false || resolveExecutionBackend(config.executionBackend) !== "local") throw new Error("Unsupported owner execution profile")
      const owner = await connectLocalServiceOwner(args.serviceOwner)
      if (owner.workspace.root !== cwd) throw new Error("Owner workspace mismatch")
      executionEnvironment = createExecutionEnvironment(cwd, "required", "local", false, config.sandboxNetwork, config.sandboxExcludedCommands, owner)
    } catch { process.stderr.write("Invalid, unavailable or incompatible Host service owner.\n"); return EXIT_BAD_ARGS }
  }
  if (host.disableShellNetwork) {
    if (args.serviceOwner || args.dangerouslyDisableOsSandbox || process.env.ZAPCODE_RESIDENT_AGENT === "1") {
      throw new Error("Goal offline shell requires the local OS sandbox")
    }
    executionEnvironment = createExecutionEnvironment(cwd, "required", resolveExecutionBackend(config.executionBackend), false, config.sandboxNetwork, [])
    executionEnvironment.commandOptions.sandboxNetwork = false
    executionEnvironment.commandOptions.restrictedNetwork = false
    executionEnvironment.commandOptions.workspaceOnly = true
    executionEnvironment.commandOptions.disableBackgroundTasks = true
    if (host.requireProcessSeal) executionEnvironment.broker = requireProcessSealing(executionEnvironment.broker, host.onProcessSealUnconfirmed)
  }
  const { provider: llmProvider, registry, executor: baseExecutor, createRegistryForCwd, executionFacts, executionCapacity, sandboxConfined } = buildAgentObjects(
    config,
    approval.onApproval,
    /* todoStore   */ headlessTodoStore,
    /* planCb      */ undefined,
    /* checkpoint  */ checkpoint,
    /* skills      */ skills,
    /* cwdOverride */ cwd,
    /* sandboxMode */ args.dangerouslyDisableOsSandbox ? "disabled" : "required",
    /* environment */ executionEnvironment,
    /* delegateEvents */ event => {
      formatter.onEvent(event)
      host.onEvent?.(event)
    },
    /* askUserCallbacks */ undefined,
    /* providerAdapter */ host.providerAdapter,
  )
  const deniedTools = new Set(args.disallowedTools ?? [])
  const scopedExecutor = deniedTools.size ? baseExecutor.withRuntimePolicy({
    evaluate: request => deniedTools.has(request.call.name)
      ? approval.onApproval(request.call.name, request.call.arguments).then(() => ({ decision: "deny" as const, reason: "disallowed by --disallowed-tools" }))
      : baseExecutor.policyEngine.evaluate(request),
  }, baseExecutor.checkpointMode) : baseExecutor
  const guardedExecutor = resultGuard ? scopedExecutor.withResultGuard(resultGuard) : scopedExecutor
  const isolatedExecutor = host.isolateWorkspace ? guardedExecutor.withWorkspace({ root: realpathSync(cwd), mode: "isolated-write", sandbox: sandboxConfined ? "enforced" : "none", ...(host.privateGit ? { privateGitDirectory: host.privateGit.directory, privateGitIdentity: { device: host.privateGit.device, inode: host.privateGit.inode } } : {}) }) : guardedExecutor
  const executor = host.admitToolExecution ? isolatedExecutor.withExecutionAdmission(host.admitToolExecution) : isolatedExecutor
  approval.setSandboxConfined(sandboxConfined, config.autoAllowSandboxedCommands !== false)
  approval.setSandboxExcludedCommands(config.allowUnsandboxedCommands !== false ? config.sandboxExcludedCommands : undefined)
  await host.prepareRegistry?.(registry)
  if (publicChecks) {
    // These tools start work outside the root provider admission budget.
    for (const name of ["agent", "delegate_agent", "cron_create"]) registry.unregister(name)
  }

  // ── System prompt + per-turn attachments (mirror useAgentRunner) ─────
  const contextLimits = resolveActiveContextLimits(config)
  const ctxWin = contextLimits.contextWindow
  const thresholds = {
    triggerAt: contextLimits.compactAt,
    keepFloorTokens: contextLimits.keepFloorTokens,
    reserveForOutput: contextLimits.reservedOutputTokens,
  }
  const runtimeTools = buildRuntimePromptToolInputs(
    registry.definitions().map((d: { name: string }) => d.name),
    registry.toolPrompts(),
  )
  const appLogger = new Logger()
  const agentLogger = new AgentLogger(appLogger)
  const availableSkills = summarizeSkillsForPrompt(skills.values())
  const promptSections = createPromptSectionDiagnostics()
  let systemPrompt = buildSystemPrompt(
    config,
    cwd,
    runtimeTools.toolPrompts,
    runtimeTools.enabledToolNames,
    availableSkills,
    executionFacts,
    promptSections.record,
    executionCapacity,
  )
  if (args.systemPromptPrepend) systemPrompt = `${args.systemPromptPrepend}\n\n${systemPrompt}`
  if (args.systemPromptAppend) systemPrompt = appendCacheableSystemSection(systemPrompt, args.systemPromptAppend)
  const memInstr = await autoMemory.buildInstructions().catch(() => "")
  systemPrompt = appendCacheableSystemSection(systemPrompt, memInstr)

  if (args.systemPromptPrepend) promptSections.record("prepend", "user", false, args.systemPromptPrepend)
  if (args.systemPromptAppend) promptSections.record("append", "user", false, args.systemPromptAppend)
  if (memInstr) promptSections.record("memory-instructions", "discovery", false, memInstr)

  const attachments = await buildPerTurnAttachments(autoMemory, {
    memoryQuery: buildHeadlessMemoryQuery(args.prompt, conversation.getAllMessages(), restoredMemoryQueryHistory),
    memoryStore: mdStore,
    globalMemoryStore: globalMdStore,
    globalMemoryDir,
    semanticRetriever: memorySemanticRetriever,
    contextWindow: ctxWin,
    diagnosticsLogger: appLogger,
  })
  if (!host.disableRepoMap) await buildRepoMapAttachment(cwd, args.prompt, ctxWin).then((repoMap) => {
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
  const { contextPrefix, contextDelta, contextDiagnostics } = makeContextBuilders({
    attachments,
    getTodos: () => headlessTodos,
    modelId: config.active.model,
  })
  const turnEndGuard = makeTurnEndGuard(() => headlessTodos)

  // The value is reset immediately before the user transcript entry below.
  // Keep it in outer scope so RuntimeFactory's onRunEnd can bind the snapshot.
  let turnStartLogIndex = peekJournalLogIndex()

  // ── AgentRuntime ─────────────────────────────────────────────────────
  const observeLifecycle = (stage: string) => formatter.onEvent({
    type: "observation", kind: "runtime_lifecycle", detail: { stage, at: Date.now() },
  })
  const controller = new AbortController()
  const runtimeOptions: CreateAgentRuntimeOptions = {
    observer: watchObserver(),
    backgroundTasks: { store: taskStore, disposition: "stop" },
    onSealing: () => { host.onSealing?.(); observeLifecycle("sealing") },
    sealingTimeoutMs: host.sealingTimeoutMs,
    onSealingProgress: (progress) => formatter.onEvent({
      type: "observation", kind: "runtime_sealing", detail: { ...progress },
    }),
    harnessPolicy: { ...host.harnessPolicy, execution: { ...host.harnessPolicy?.execution,
      checkpoint: host.harnessPolicy?.execution?.checkpoint ?? (config.fileCheckpointingEnabled === false ? "never" : "best-effort") } },
    threadId: getCurrentSessionId(),
    completionEvidence: host.completionEvidence,
    eventStore: createProjectRuntimeEventStore(cwd),
    stateStore: createProjectRuntimeStateStore(cwd),
    onEventStoreError: (error) => {
      appLogger.error("runtime_event_store_failed", { message: error.message })
    },
    onRecovery: (reports) => {
      agentLogger.runtimeRecovery(reports)
      const actions = reports.reduce((total, report) => total + report.actions.length, 0)
      formatter.progress(`Recovered interrupted runtime state (${actions} action${actions === 1 ? "" : "s"})`)
    },
    workspace: {
      root: cwd,
      ...(host.subagentIsolationRoot ? { tempRoot: host.subagentIsolationRoot, forbidGit: true, retention: false as const } : {}),
      ...(host.privateGit && host.privateGitOwnerDirectory ? { capturePrivateGitFromRoot: { ownerDirectory: host.privateGitOwnerDirectory, sourceBinding: host.privateGit } } : {}),
      onTrackEdit: (paths) => checkpoint.trackEdits(paths),
    },
    loopAgent: {
      onRunStart: async context => { await checkpoint.beginTurn(context.turnStartIndex, { journalLogIndex: turnStartLogIndex, uiLogIndex: turnStartLogIndex }, context.input) },
      provider: llmProvider,
      registry,
      executor,
      conversation: publicChecks ? undefined : conversation,
      systemPrompt,
      promptProfile: config.promptProfile ?? "standard",
      maxSteps: args.maxTurns ?? config.maxSteps,
      timeoutMs: args.timeoutMs,
      maxToolRetries: 2,
      autoCompactThreshold: thresholds.triggerAt * 4,
      autoCompactTokenThreshold: thresholds.triggerAt,
      autoCompactEnabled: config.compaction.auto,
      pruneEnabled: config.compaction.prune,
      requestCacheScope: getActiveProvider(config)?.id,
      contextWindow: ctxWin,
      inputTokenLimit: contextLimits.inputLimit,
      outputTokenCeiling: getActiveMaxOutputTokens(config),
      reservedOutputTokens: contextLimits.reservedOutputTokens,
      storageSessionId: getCurrentSessionId(),
      storageProjectCwd: cwd,
      sessionId: getCurrentSessionId(),
      subagentFactory: publicChecks || host.disableSubagent ? undefined : host.serializeSubagent ? options => {
        const tool = subagentTool(options)
        const resolveEffects = tool.definition.resolveEffects
        return { ...tool, definition: { ...tool.definition, resolveEffects: (args, context) => {
          const effects = resolveEffects!(args, context)
          return { ...effects, workspace: { mode: "root-integration" as const } }
        } } }
      } : subagentTool,
    },
    subagent: publicChecks || host.disableSubagent ? false : {
      inheritedInstructions: [args.systemPromptPrepend, config.customSystemPrompt, args.systemPromptAppend]
        .filter(text => text?.trim()).join("\n\n"),
      onEvent: (event) => { formatter.onEvent(event); host.onEvent?.(event) },
      createRegistryForCwd,
      requireWriteIsolation: true,
      prepareWorkspace: host.prepareSubagentWorkspace,
      validateWorkspace: host.validateSubagentWorkspace,
    },
    onRunEnd: async () => {
      observeLifecycle("checkpoint_started")
      try {
        await checkpoint.makeSnapshot(turnStartLogIndex, {
          journalLogIndex: peekJournalLogIndex(),
          uiLogIndex: peekJournalLogIndex(),
        })
      } finally { observeLifecycle("checkpoint_finished") }
    },
  }
  const repairSession = publicChecks ? createBoundedRepairSession({ ...publicChecks,
    runtime: { ...runtimeOptions, subagent: false }, signal: controller.signal,
  }) : undefined
  const agent = repairSession?.runtime ?? createAgentRuntime(runtimeOptions)
  const protocolPrompt = agent.protocolPrompt()
  if (protocolPrompt) promptSections.record("sdk-protocol", "protocol", false, protocolPrompt)
  const promptCacheDiagnostics = buildPromptCacheDiagnostics(
    agent.effectiveSystemPrompt() ?? systemPrompt,
    agent.toolDefinitions(),
    config.promptProfile ?? "standard",
    promptSections.sections,
  )
  const cacheMemoryAudit = new CacheMemoryAuditTracker({
    sessionId: getCurrentSessionId(),
    cacheScope,
    getPromptCacheDiagnostics: () => promptCacheDiagnostics,
    memoryUtility: {
      candidates: attachments.memoryUtilityCandidates ?? [],
      cwd,
      baseline: attachments.memoryUtilityBaseline,
    },
    append: (entry) => { appendCacheMemoryAudit(cwd, entry) },
    onError: (error) => {
      appLogger.warn("cache_memory_audit_failed", { error: error.message })
    },
  })
  agentLogger.attach(agent)
  agent.on("*", cacheMemoryAudit.handle)

  // ── Wire events to formatter ─────────────────────────────────────────
  let latestContextDiagnostics: ContextDiagnostics | undefined
  let repairSteps = 0
  const repairUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  agent.on("run_ended", e => {
    if (!repairSession || e.type !== "run_ended" || e.path?.length) return
    repairSteps += e.steps
    repairUsage.inputTokens += e.usage.inputTokens
    repairUsage.outputTokens += e.usage.outputTokens
  })
  let sawRunUsage = false
  agent.on("*", (e: AgentEvent) => formatter.onEvent(e))
  if (host.onEvent) agent.on("*", host.onEvent)
  agent.on("run_step", (e: AgentEvent) => {
    if (e.type !== "run_step") return
    latestContextDiagnostics = e.context
  })
  agent.on("observation", (e: AgentEvent) => {
    persistHeadlessCompactSummary(e, { autoMemory })
  })
  agent.on("run_usage", (e: AgentEvent) => {
    sawRunUsage = true
    persistHeadlessRunUsage(e, {
      getLocalEstimate: () => repairSession?.estimatedTokens() ?? conversation.estimatedTokens,
      appendUsage,
      setPromptOverhead: (overhead) => { tokenAccounting.promptOverhead = overhead },
      contextDiagnostics: latestContextDiagnostics,
      promptCacheDiagnostics,
      cacheScope,
    })
  })

  // Tool-call progress lines for `text` mode (skipped when --quiet).
  agent.on("content_final", (e: AgentEvent) => {
    if (e.type !== "content_final") return
    if (e.kind === "tool_call") {
      formatter.progress(`→ ${getToolAlias(e.toolName)}(${formatArgsShort(e.arguments, cwd)})`)
    } else if (e.kind === "tool_result") {
      const ok = e.result.success !== false
      if (!ok) formatter.progress(`✗ ${getToolAlias(e.toolName)}: ${truncOneLine(e.result.error ?? "")}`)
    }
  })

  // ── Abort handling: SIGINT / SIGTERM mid-run ─────────────────────────
  // singletons.ts registers `process.on("SIGINT", () => process.exit(130))`
  // at module load. Node fires listeners in registration order, so without
  // intervention the singleton's exit-immediate handler beats ours →
  // `controller.abort()` never lands, `agent.run` is killed mid-promise,
  // and `formatter.finalize()` never runs. For json / stream-json that
  // leaves the consumer hanging with no terminator.
  //
  // Fix: strip the singleton signal handlers for the duration of the run.
  // The `process.on("exit", _shutdown)` hook in singletons still fires on
  // natural exit, so taskStore / cronHandle cleanup is preserved.
  const previousSigintListeners = process.listeners("SIGINT")
  const previousSigtermListeners = process.listeners("SIGTERM")
  process.removeAllListeners("SIGINT")
  process.removeAllListeners("SIGTERM")
  const onSigint = () => controller.abort()
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigint)

  let outcome: AgentOutcomeV1 | undefined
  let repairResult: BoundedRepairResult | undefined
  let outcomeFailure: { code: string; message: string } | undefined
  let stopReason: StopReason = "end_turn"
  let runErr: string | null = null
  let finalText = ""
  let totalSteps = 0
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  const unregisterHostRuntime = registerHostRuntime(agent)
  const hostProtocolEndpoint = await startHostProtocolServerIfEnabled().catch((error) => {
    process.stderr.write(`[zapcode] host protocol unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  })
  if (hostProtocolEndpoint) {
    process.stderr.write(`host protocol: ${hostProtocolEndpoint.origin} token=${hostProtocolEndpoint.token}\n`)
  }

  try {
    turnStartLogIndex = peekJournalLogIndex()
    persistHeadlessTranscriptEntry("user", args.prompt, (type, text) => appendLog(type, text, undefined,
      host.images?.map(image => ({ filePath: image.filePath, mediaType: image.mediaType, source: image.source }))), host.images)
    const runOptions = {
      signal: controller.signal,
      images: host.images,
      contextPrefix,
      contextDelta,
      contextDiagnostics,
      turnEndGuard,
    }
    repairResult = repairSession ? await repairSession.run(args.prompt, { images: host.images, contextPrefix, contextDelta, contextDiagnostics }) : undefined
    const execution = repairResult ? repairResult.attempts.at(-1)
      : outcomeMode ? await agent.runWithOutcome(args.prompt, runOptions) : undefined
    if (repairResult && !repairResult.lastOutcome) throw new OutcomeProtocolError(repairResult.code, "Public checks workflow stopped before a terminal outcome; recover any pending runtime outcome")
    outcome = repairResult?.lastOutcome ?? execution?.outcome
    const result: LoopAgentResult = repairResult ? { text: outcome!.execution.finalResponse, steps: repairSteps, totalUsage: repairUsage, toolResults: [] }
      : execution?.loopResult ?? await agent.run(args.prompt, runOptions)
    observeLifecycle("runtime_returned")
    finalText = result.text
    persistHeadlessTranscriptEntry("agent", finalText)
    totalSteps = result.steps
    totalUsage = result.totalUsage
    persistHeadlessFinalRunUsageIfNeeded({
      sawRunUsage,
      usage: result.totalUsage,
      getLocalEstimate: () => repairSession?.estimatedTokens() ?? conversation.estimatedTokens,
      appendUsage,
      setPromptOverhead: (overhead) => { tokenAccounting.promptOverhead = overhead },
      contextDiagnostics: latestContextDiagnostics,
      promptCacheDiagnostics,
      cacheScope,
    })
    const completion = agent.lastCompletionAssessment()
    if (completion?.status === "incomplete" && !result.stopped) runErr = completion.reason ?? "Delivery evidence is incomplete"
    stopReason = outcome?.execution.stopReason ?? resolveRunStopReason(
      result.stopped as StopReason | undefined,
      approval.anyDenied(),
      args.continueOnToolDenial,
      completion?.status,
    )
  } catch (err) {
    if (outcomeMode) outcomeFailure = { code: err instanceof OutcomeProtocolError ? err.code : "EXECUTION_SETUP_FAILED", message: err instanceof Error ? err.message : String(err) }
    if (controller.signal.aborted) {
      stopReason = "aborted"
    } else {
      stopReason = "error"
      runErr = err instanceof Error ? err.message : String(err)
    }
  } finally {
    repairSession?.dispose()
    observeLifecycle("host_cleanup_started")
    unregisterHostRuntime()
    await stopHostProtocolServer()
    observeLifecycle("host_cleanup_finished")
    restoreSignalListeners("SIGINT", onSigint, previousSigintListeners)
    restoreSignalListeners("SIGTERM", onSigint, previousSigtermListeners)
  }

  const summary: RunSummary = {
    outcome,
    ...(repairResult ? { publicChecks: { status: repairResult.status, code: repairResult.code, usage: repairResult.usage,
      attempts: repairResult.attempts.map(item => ({ attemptId: item.outcome.attemptId, recordId: item.acceptance.id,
        snapshotId: item.acceptance.snapshot?.id, report: item.acceptance.report })) } } : {}),
    ok: (outcome ? outcome.execution.status === "finished" : stopReason === "end_turn") && (!repairResult || repairResult.status === "passed"),
    text: finalText,
    sessionId: getCurrentSessionId(),
    turns: totalSteps,
    usage: totalUsage,
    toolCalls: [],  // filled by formatter
    stopReason,
    error: outcome?.execution.error?.message ?? runErr,
    completion: agent.lastCompletionAssessment(),
  }
  if (outcomeFailure) {
    if (formatter.failure) formatter.failure(outcomeFailure)
    else process.stderr.write(`error: ${outcomeFailure.code}: ${outcomeFailure.message}\n`)
  } else formatter.finalize(summary)

  // Clean up session-scoped singletons that registered process listeners.
  // (singletons.ts already wires process.on("exit") cleanup; calling here
  // ensures cleanup before exit code is set when running embedded.)
  try { taskStore.stopAll("SIGTERM") } catch {}
  try { cronHandle.stop() } catch {}

  if (outcomeFailure) return outcomeFailure.code === "REPAIR_CANCELLED" ? 130
    : outcomeFailure.code === "REPAIR_DEADLINE_EXCEEDED" ? 124 : EXIT_ERROR
  return repairResult ? repairResult.status === "passed" ? 0
    : repairResult.code === "REPAIR_CANCELLED" ? 130 : repairResult.code === "REPAIR_DEADLINE_EXCEEDED" ? 124 : 5
    : outcome ? executionExitCode(outcome.execution) : stopReasonExitCode(stopReason)
}

export function persistHeadlessTranscriptEntry(
  type: "user" | "agent",
  text: string,
  writer: (type: string, text: string) => unknown = appendLog,
  images: readonly ImageContent[] = [],
): boolean {
  if (text.trim() === "" && !(type === "user" && images.length > 0)) return false
  writer(type, text)
  return true
}

function hydrateHeadlessTranscriptImages(messages: Message[]): Message[] {
  return messages.map(message => {
    let unavailable = false
    const contentBlocks = message.contentBlocks?.map(block => {
      if (block.type !== "image" || block.base64) return block
      try { return { ...loadImageFromFile(block.filePath), source: block.source } }
      catch {
        unavailable = true
        process.stderr.write("warning: a saved conversation image could not be loaded\n")
        return { type: "text" as const, text: "[Saved conversation image unavailable]" }
      }
    })
    // Text-only normalization can discard contentBlocks; retain the notice in
    // content as well when no usable image remains.
    return { ...message, contentBlocks, content: unavailable
      ? `${message.content ?? ""}\n[Saved conversation image unavailable]` : message.content }
  })
}

function restoreSignalListeners<S extends NodeJS.Signals>(
  signal: S,
  temporaryListener: NodeJS.SignalsListener,
  previousListeners: Array<(signal: S) => void>,
): void {
  process.off(signal, temporaryListener)
  const current = process.listeners(signal) as unknown as Array<(signal: S) => void>
  for (const listener of previousListeners) {
    if (!current.includes(listener)) process.on(signal, listener)
  }
}

export function formatArgsShort(args: Record<string, unknown>, cwd?: string): string {
  const a = args ?? {}
  const v = a.path ?? a.command ?? a.cmd ?? a.pattern ?? a.query ?? a.url ?? a.task
  if (v === undefined) return ""
  let s = String(v)
  // Strip cwd-prefix BEFORE truncating. Otherwise a long absolute path
  // eats the 80-char budget and the actually-useful flags / sub-paths
  // get cut off. Example before: `find /Users/foo/proj/app/src -name "*.ts"`
  //   → truncated to `find /Users/foo/proj/app/src -…` (loses `-name "*.ts"`)
  // After strip: `find app/src -name "*.ts"` (32 chars, no truncation needed).
  if (cwd) {
    const cwdSlash = cwd.endsWith("/") ? cwd : cwd + "/"
    // Escape regex metachars in the path before building the strip regex.
    const escaped = cwdSlash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    s = s.replace(new RegExp(escaped, "g"), "")
  }
  return truncOneLine(s)
}

function truncOneLine(s: string): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > 80 ? one.slice(0, 79) + "…" : one
}

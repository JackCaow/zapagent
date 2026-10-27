/** @jsxImportSource react */
import { restoreAfterUpdate } from "./update-lifecycle.js"
import { UpdateDialog } from "./ui/dialog-update.js"
import { requestUpdateRestart } from "./self-update.js"
// Ink-based App, orchestrator only — every non-trivial subsystem lives in
// src/hooks/* or src/commands/*. The monolithic ~2200-line predecessor was
// broken up in the App→hooks refactor (commit 30f1544).
//
// What gets wired here (and nowhere else):
//   - state hooks (logs / input / dialogs / images / queue)
//   - the dispatchCommand wrapper that binds dispatchSlashCommand to its
//     local deps (it can't be a hook because it's also called from the
//     turn dispatcher's queue loop)
//   - render JSX

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Box, Text, useApp } from "ink"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { resolveProjectDataSegment } from "../zapsdk/utils/project-paths.js"
import { c } from "./ui/theme.js"
import { initHighlighter } from "./ui/highlight.js"
initHighlighter() // fire-and-forget; harmless when shiki isn't used yet

import {
  loadAppConfig,
  saveAppConfig,
  hasApiKey as configHasApiKey,
  getActiveContextWindow,
  getEffort,
  getProviderDisplayName,
  type AppConfig,
} from "./config.js"
import { cwdShort, configPath, getCurrentSessionId, getSessionPersistenceStatus, peekJournalLogIndex, appendSnapshot, appendTodoUpdate, readCurrentSessionLogs, readTodoUpdates, resolveRestoredUsageContext, resolveUnmeasuredUsageContext, sessionLogsToMessages, type PersistedUsage } from "./session.js"
import { useLogs } from "./hooks/useLogs.js"
import { useAgentRunner } from "./hooks/useAgentRunner.js"
import { useToasts } from "./hooks/useToasts.js"
import { useUpdateCheck } from "./hooks/useUpdateCheck.js"
import { UpdateNotice } from "./ui/UpdateNotice.js"
import { autoMemory, appLogger, agentLogger, conversation, tokenAccounting } from "./singletons.js"
import { CheckpointManager } from "../zapsdk/checkpoint/index.js"
import { type Todo, type TodoStore } from "../zapsdk/index.js"
import { loadAllSkills } from "../zapsdk/skills/loader.js"
import type { SkillDefinition } from "../zapsdk/skills/types.js"
import { inferInvocationRules } from "./permissions.js"
import {
  subscribeToQueue,
  getQueueSnapshot,
  getQueueActiveRunId,
  configureQueue,
  getMessageQueue,
  prepareQueuedCommandsForEditing,
  clearQueue,
  type PendingImage,
} from "./queue/inputQueue.js"
import type { QueueEntry } from "./queue/messageQueue.js"
import { buildDispatchText } from "./hooks/useTurnDispatcher.js"
import { QueuePanel, QueueDialog } from "./ui/message-queue.js"
import { resolveTurnActivity } from "./queue/turnActivity.js"
import {
  subscribeToSystemInbox,
  getSystemInboxLength,
  clearSystemInbox,
} from "./queue/systemInbox.js"
import { pruneImageStorage } from "./imageStore.js"
import { applyMetadataRefresh, refreshModelsDevMetadata } from "./provider-metadata.js"

// ── New extracted modules (refactored out of this file) ──
import { usePermissionApproval } from "./hooks/usePermissionApproval.js"
import { usePlanMode } from "./hooks/usePlanMode.js"
import { useAskUser } from "./hooks/useAskUser.js"
import { usePalettes } from "./hooks/usePalettes.js"
import { useAgentObjects } from "./hooks/useAgentObjects.js"
import { useMCPSubsystem } from "./hooks/useMCPSubsystem.js"
import { useSamplingHandler } from "./hooks/useSamplingHandler.js"
import { setMCPManager } from "./singletons.js"
import { usePasteHandler } from "./hooks/usePasteHandler.js"
import { useTurnDispatcher } from "./hooks/useTurnDispatcher.js"
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js"
import { summarizeSkillsForPrompt } from "./agent/skillSummary.js"
import { buildToolSchemaDiagnostics } from "./agent/toolDiagnostics.js"
import {
  dispatchSlashCommand,
  isProviderReady,
  type DialogId,
} from "./commands/dispatcher.js"

// ── UI components ──
import { Welcome } from "./ui/Welcome.js"
import { Transcript } from "./ui/Transcript.js"
import { PendingUserMessage } from "./ui/pending-user-message.js"
import { Prompt, isShellMode, pushHistory } from "./ui/prompt.js"
import { Footer } from "./ui/footer.js"

// Compact MCP status summariser. Inline because it's only used by App's
// Footer wiring; doesn't deserve a dedicated module.
import type { MCPServerConfig, MCPServerSnapshot as MCPSnap } from "../zapsdk/index.js"
const EMPTY_MCP_SERVERS: MCPServerConfig[] = []

function summariseMCPStatuses(snapshots: MCPSnap[]): {
  ready: number; total: number; degraded: number; needsAuth: number; error: number
} {
  let ready = 0, degraded = 0, needsAuth = 0, error = 0
  for (const s of snapshots) {
    if (s.status === "ready") ready++
    else if (s.status === "degraded" || s.status === "connecting") degraded++
    else if (s.status === "needs_auth") needsAuth++
    else if (s.status === "error") error++
  }
  return { ready, total: snapshots.length, degraded, needsAuth, error }
}
import { ConversationSurface } from "./ui/conversation-surface.js"
import { SlashPalette } from "./ui/slash-palette.js"
import { FilePalette } from "./ui/file-palette.js"
import { ConnectDialog } from "./ui/dialog-connect.js"
import { ModeDialog, EffortDialog } from "./ui/dialog-config.js"
import { ModelDialog } from "./ui/dialog-model.js"
import { StatusDialog } from "./ui/dialog-status.js"
import { loadSessionForDialog, type DialogSessionRestore, commitSessionForDialog, replaceConversationMessages, SessionsDialog } from "./ui/dialog-sessions.js"
import { MemDialog } from "./ui/dialog-mem.js"
import { PermissionsDialog } from "./ui/dialog-permissions.js"
import { RewindDialog, rewindDraft } from "./ui/dialog-rewind.js"
import { RecoveryDialog } from "./ui/dialog-recovery.js"
import { SupertaskWatchDialog } from "./ui/dialog-supertask-watch.js"
import { approvalFacts } from "./approval-facts.js"
import { ApprovalBar } from "./ui/dialog-approval.js"
import { PlanApprovalBar } from "./ui/dialog-plan-approval.js"
import { AskUserBar } from "./ui/dialog-ask-user.js"
import { collectPendingTools, LiveActivity } from "./ui/live-activity.js"
import { TokenWarning } from "./ui/token-warning.js"
import { ToastContainer } from "./ui/toast.js"
import { TodosPanel } from "./ui/todos-panel.js"
import { TermWidthContext } from "./ui/term-width.js"
import type { AgentObjects } from "./agent/types.js"
import { ProjectRecoveryCenter } from "../zapsdk/index.js"
import { createProjectRuntimeStateStore } from "./agent/runtimeEventStore.js"
import type { StatusUsageDetail } from "./commands/status.js"
import {
  makePromptCacheScope,
  samePromptCacheScope,
  type PromptCacheScope,
} from "./agent/cacheScope.js"

void appLogger // explicit reference; live calls happen later via ZAPCODE_DIAG=1 paths

type RunnerUsageState = {
  i: number
  o: number
  providerUsageReported?: boolean
  cacheRead?: number
  cacheWrite?: number
  cacheScope?: PromptCacheScope
  promptCacheDiagnostics?: StatusUsageDetail["promptCacheDiagnostics"]
}

function toStatusUsage(tokens: RunnerUsageState): StatusUsageDetail | undefined {
  if (
    tokens.i <= 0 &&
    tokens.o <= 0 &&
    typeof tokens.providerUsageReported !== "boolean" &&
    typeof tokens.cacheRead !== "number" &&
    typeof tokens.cacheWrite !== "number" &&
    !tokens.cacheScope &&
    !tokens.promptCacheDiagnostics
  ) {
    return undefined
  }
  return {
    inputTokens: tokens.i,
    outputTokens: tokens.o,
    ...(typeof tokens.providerUsageReported === "boolean"
      ? { providerUsageReported: tokens.providerUsageReported }
      : {}),
    ...(typeof tokens.cacheRead === "number"
      ? { cacheReadInputTokens: tokens.cacheRead }
      : {}),
    ...(typeof tokens.cacheWrite === "number"
      ? { cacheCreationInputTokens: tokens.cacheWrite }
      : {}),
    ...(tokens.cacheScope ? { cacheScope: tokens.cacheScope } : {}),
    ...(tokens.promptCacheDiagnostics
      ? { promptCacheDiagnostics: tokens.promptCacheDiagnostics }
      : {}),
  }
}

function persistedUsageToRunnerUsage(persisted: PersistedUsage): RunnerUsageState {
  return {
    i: persisted.inputTokens ?? 0,
    o: persisted.output ?? 0,
    ...(typeof persisted.providerUsageReported === "boolean"
      ? { providerUsageReported: persisted.providerUsageReported }
      : {}),
    ...(typeof persisted.cacheReadInputTokens === "number"
      ? { cacheRead: persisted.cacheReadInputTokens }
      : {}),
    ...(typeof persisted.cacheCreationInputTokens === "number"
      ? { cacheWrite: persisted.cacheCreationInputTokens }
      : {}),
    ...(persisted.cacheScope ? { cacheScope: persisted.cacheScope } : {}),
    ...(persisted.promptCacheDiagnostics
      ? { promptCacheDiagnostics: persisted.promptCacheDiagnostics }
      : {}),
  }
}

export function App() {
  // Ink-clean exit — let Ink restore the terminal state before the process
  // dies. Hoisted here (not buried in useKeyboardShortcuts) so the slash
  // command dispatcher's `/exit` branch shares the same callable.
  const { exit } = useApp()

  // Live terminal width. Ink relayouts Yoga on stdout 'resize' but doesn't
  // trigger a React render, so memoized Transcript rows and Boxes with
  // explicit `width=` props would otherwise keep their pre-resize widths
  // when a split-pane border is dragged wider. We mirror the width into
  // React state and broadcast via TermWidthContext (see ui/term-width.tsx)
  // so consumers re-render through memo barriers.
  const [termWidth, setTermWidth] = useState(() => process.stdout.columns || 80)
  useEffect(() => {
    const onResize = () => setTermWidth(process.stdout.columns || 80)
    process.stdout.on("resize", onResize)
    return () => { process.stdout.off("resize", onResize) }
  }, [])

  // Render-storm sentinel (issue #20). If renders/sec breaches the threshold
  // the freeze is imminent and we want a stack/state snapshot before stdout
  // is wedged. Gate behind ZAPCODE_RENDER_SENTINEL=1 to keep prod logs clean.
  const renderTimesRef = useRef<number[]>([])
  // ZAPCODE_DIAG=1: 1Hz render-rate counter into appLogger so we can read CPU
  // hotspots from latest.log without scraping stderr. Cheap — one Date.now
  // per render plus one timestamped log entry per second.
  const diagRenderRef = useRef({ count: 0, windowStart: Date.now() })
  useEffect(() => {
    if (process.env.ZAPCODE_RENDER_SENTINEL !== "1") return
    const now = Date.now()
    const arr = renderTimesRef.current
    arr.push(now)
    while (arr.length > 0 && now - arr[0]! > 1000) arr.shift()
    if (arr.length > 30) {
      // stderr only — stdout is owned by Ink. One line per offender frame is
      // enough; the next frames will also trip and produce a histogram.
      process.stderr.write(
        `[render-storm] ${arr.length} renders/sec at ${new Date(now).toISOString()}\n`,
      )
    }
  })
  if (process.env.ZAPCODE_DIAG === "1") {
    const s = diagRenderRef.current
    s.count++
    const now = Date.now()
    if (now - s.windowStart >= 1000) {
      appLogger.debug("app_render_rate", { rendersPerSec: s.count })
      s.count = 0
      s.windowStart = now
    }
  }

  // ── Config ──
  const [config, setConfig] = useState<AppConfig>(() => loadAppConfig(configPath))
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  const updateConfig = useCallback((next: AppConfig) => {
    configRef.current = next
    setConfig(next)
    saveAppConfig(configPath, next)
  }, [])

  // Best-effort catalog hydration for providers created before model metadata
  // persistence existed. It never blocks first render; if /connect changes the
  // config while the request is in flight, commit only metadata for unchanged
  // connections against the latest snapshot; never replace user selection.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const initial = configRef.current
      const result = await refreshModelsDevMetadata(initial)
      if (cancelled) return
      const current = configRef.current
      const refreshed = applyMetadataRefresh(current, initial, result)
      if (refreshed === current) return
      updateConfig(refreshed)
      appLogger.info("provider_metadata_refreshed", {
        providers: refreshed.providers.filter(provider => provider.modelMetadata).length,
      })
    })()
    return () => { cancelled = true }
  }, [updateConfig])

  // ── Conversation state ──
  const { logs, addLog, replaceLog, peekNextLogId, getUiLogCount, compactLogs: replaceWithCompactLog, setLogs, setStaticCommitFrozen, getIsFrozen, registerStaticFlushCallback } = useLogs()
  const logsRef = useRef(logs)
  logsRef.current = logs

  // Bumped whenever we want Static to remount and re-emit its items from
  // scratch — session restore / rewind / /clear / /new all need this.
  const [transcriptEpoch, setTranscriptEpoch] = useState(0)
  const bumpTranscript = useCallback(() => setTranscriptEpoch((e) => e + 1), [])
  const compactLogs = useCallback((...args: Parameters<typeof replaceWithCompactLog>) => {
    replaceWithCompactLog(...args)
    // Ink Static remembers its emitted item count. Replacing a long history
    // with one compact marker must reset that cursor before subsequent logs.
    bumpTranscript()
  }, [replaceWithCompactLog, bumpTranscript])

  // ── Input ──
  const [inputValue, setInputValue] = useState("")
  // Bumped on every external input update (paste, history nav, placeholder
  // atomic-delete) so the TextInput's internal cursor re-initializes at
  // value.length — otherwise it'd stay stuck at the pre-update position.
  const [inputEpoch, setInputEpoch] = useState(0)
  const bumpInputEpoch = useCallback(() => setInputEpoch((e) => e + 1), [])

  // ── Loaded skills ──
  // Picked up from /etc/codex/skills, ~/.codex/skills, ~/.agents/skills,
  // and any project-local .agents/skills. Passed both into the agent's
  // `skill` tool registry AND into the system prompt (via
  // useAgentRunner.availableSkills) so the model knows what to call.
  const skillsRef = useRef<Map<string, SkillDefinition>>(loadAllSkills(process.cwd()))
  const availableSkills = useMemo(
    () => summarizeSkillsForPrompt(skillsRef.current.values()),
    [],
  )

  // ── Permission approval callback (executor → UI Promise → user choice) ──
  // Lifted up here (above MCP + palettes) so the sampling handler can use
  // it as the approval gate.
  const { onApproval, pendingApproval } = usePermissionApproval({ configRef, addLog })

  // ── MCP subsystem (manager + bridged tools + per-server snapshots) ──
  // Sits above palettes so MCP prompts/resources can flow into the slash +
  // @-reference completers. The sampling handler needs read-access to the
  // current agent provider, which useAgentObjects populates BELOW. We
  // pre-allocate a shared ref so the handler is bound here (and captured
  // by the manager at construction time) while the provider it reads is
  // updated later in the same render.
  const sharedAgentRef = useRef<AgentObjects | null>(null)
  const samplingHandler = useSamplingHandler({ agentRef: sharedAgentRef, onApproval })
  const mcp = useMCPSubsystem(config.mcpServers ?? EMPTY_MCP_SERVERS, { samplingHandler })
  // Expose the manager via the singleton handle for submit-time helpers
  // (resolveMCPReferences / dispatchMCPPrompt) that don't take it as a prop.
  useEffect(() => {
    setMCPManager(mcp.manager)
    return () => { setMCPManager(null) }
  }, [mcp.manager])
  // ── Palettes (slash + @ file) ──
  const palettes = usePalettes({
    inputValue,
    skillsRef,
    mcpPrompts: mcp.prompts,
    mcpResources: mcp.resources,
  })

  // ── Modal dialog state ──
  // Only one modal can be open at a time; the prompt is hidden behind it
  // (Ink keyboard input routes to the dialog because it mounts a useInput
  // hook of its own).
  const [dialog, setDialog] = useState<DialogId>(() => process.env.ZAPAGENT_RESTORE_SESSION ? "restoring" : null)
  // ZAPCODE_DIAG=1: log dialog open/close transitions so latest.log shows
  // exactly when /model entered + how long before the user dismissed.
  useEffect(() => {
    if (process.env.ZAPCODE_DIAG === "1") {
      appLogger.debug("dialog_state", { dialog })
    }
  }, [dialog])

  // ── Todo store (in-memory; agent's todo_write tool reads/writes here) ──
  const [todos, setTodos] = useState<Todo[]>([])
  const todosRef = useRef<Todo[]>([])
  useEffect(() => { todosRef.current = todos }, [todos])
  const subagentTodosRef = useRef<Map<string, Todo[]>>(new Map())
  const todoStoreRef = useRef<TodoStore>({
    getKey: () => "main",
    get: (key) =>
      key === "main" ? todosRef.current : (subagentTodosRef.current.get(key) ?? []),
    set: (key, _oldTodos, newTodos) => {
      if (key === "main") {
        todosRef.current = newTodos
        setTodos(newTodos)
      } else {
        subagentTodosRef.current.set(key, newTodos)
      }
      // Persist to the session JSONL so resume rebuilds the same todo
      // state. Without this the in-memory store is the only source of
      // truth — every restart starts from an empty list even though the
      // session's user messages and tool calls have already been written.
      try { appendTodoUpdate(key, newTodos) }
      catch { /* JSONL write failures are non-fatal — the agent run continues with in-memory state. */ }
    },
  })

  // ── Checkpoint manager ──
  // Lives across the whole process; `setSessionId` keeps its label aligned
  // with the current session writer on /new + /sessions resume so newly
  // committed snapshots land under whatever session id the JSONL writer is
  // currently using. `writeJsonlEntry` persists each commit into the active
  // writer's JSONL so /rewind survives a restart and resume can recover the
  // historical chain via hydrateFromJsonl. `onError` routes recoverable
  // failures (large file skips, JSONL write fails) into the transcript so
  // the user actually sees them — Ink swallows stderr so a console.warn
  // would just disappear.
  const checkpointRef = useRef<CheckpointManager | null>(null)
  if (checkpointRef.current === null) {
    checkpointRef.current = new CheckpointManager({
      sessionId: getCurrentSessionId(),
      cwd: process.cwd(),
      writeJsonlEntry: (entry) => appendSnapshot(entry.snapshot, true),
      onError: (e) => {
        if (e.reason.startsWith("track-edit")) { appLogger.warn("checkpoint_coverage", { reason: e.reason, path: e.path }); return }
        if (e.reason === "snapshot-jsonl-failed") {
          addLog("error", `Recovery metadata could not be persisted: ${e.message}`)
        } else if (e.reason === "snapshot-jsonl-skipped-path") {
          addLog("error", `checkpoint JSONL skipped unsafe path ${e.path}: ${e.message}`)
        }
      },
      config: {
        managedStorage: true,
        enabled: config.fileCheckpointingEnabled ?? true,
        maxFileBytes: config.maxSnapshotFileBytes ?? 10 * 1024 * 1024,
        maxSnapshots: config.maxSnapshots ?? 100,
        blobDir: config.checkpointBlobDir,
      },
    })
  }
  const checkpoint = checkpointRef.current
  const checkpointHandle = checkpointRef as React.MutableRefObject<CheckpointManager>
  const recoveryCenterRef = useRef<ProjectRecoveryCenter | null>(null)
  if (recoveryCenterRef.current === null) {
    recoveryCenterRef.current = new ProjectRecoveryCenter({
      workspaceRoot: process.cwd(),
      store: createProjectRuntimeStateStore(process.cwd()),
      onTrackEdit: (paths) => checkpoint.trackEdits(paths),
    })
  }
  const recoveryCenter = recoveryCenterRef.current
  useEffect(() => {
    checkpoint.updateConfig({
      enabled: config.fileCheckpointingEnabled ?? true,
      maxFileBytes: config.maxSnapshotFileBytes ?? 10 * 1024 * 1024,
      maxSnapshots: config.maxSnapshots ?? 100,
      blobDir: config.checkpointBlobDir,
    })
  }, [
    checkpoint,
    config.fileCheckpointingEnabled,
    config.maxSnapshotFileBytes,
    config.maxSnapshots,
    config.checkpointBlobDir,
  ])

  // ── Toasts ──
  const { toasts, addToast } = useToasts()
  const availableUpdate = useUpdateCheck()

  // ── Pending images attached to next user turn ──
  const [pendingImages, setPendingImages] = useState<import("./queue/inputQueue.js").PendingImage[]>([])

  // ── Message queue subscription ──
  const [queueError, setQueueError] = useState(() => {
    try {
      configureQueue(join(getAppDataDir(), "projects", resolveProjectDataSegment(process.cwd()), "follow-ups"), getCurrentSessionId())
      return ""
    } catch (error) { return `Queue storage unavailable: ${error instanceof Error ? error.message : String(error)}` }
  })
  const inputQueue = useSyncExternalStore(subscribeToQueue, getQueueSnapshot, getQueueSnapshot)
  const queueActiveRunId = useSyncExternalStore(subscribeToQueue, getQueueActiveRunId, getQueueActiveRunId)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const draftBackup = useRef<{ text: string; images: PendingImage[]; pastes: Map<number, string> } | null>(null)
  const inputValueRef = useRef(inputValue)
  inputValueRef.current = inputValue
  const getInputValue = useCallback(() => inputValueRef.current, [])
  const openQueue = useCallback(() => setDialog("queue"), [])
  const bindQueue = useCallback((resumeFrom?: string) => {
    try { getMessageQueue().bind(getCurrentSessionId(), resumeFrom); setQueueError("") }
    catch (error) { setQueueError(`Queue storage unavailable: ${error instanceof Error ? error.message : String(error)}`) }
  }, [])
  useEffect(() => { if (queueError) addLog("error", queueError) }, [queueError, addLog])
  const systemInboxSize = useSyncExternalStore(subscribeToSystemInbox, getSystemInboxLength, getSystemInboxLength)

  // ── Plan-mode state machine ──
  const { planCallbacks, pendingPlan } = usePlanMode({ configRef, setConfig })
  const { askUserCallbacks, pendingQuestions } = useAskUser()

  // ── Agent objects (rebuilt on config change + MCP tool surface) ──
  const { agentRef } = useAgentObjects({
    config,
    onApproval,
    todoStore: todoStoreRef.current,
    planCallbacks,
    askUserCallbacks,
    checkpoint,
    skillsRef,
    mcpTools: mcp.tools,
    externalRef: sharedAgentRef,
  })

  // Freeze Static commits only for INLINE overlays — those that share the
  // dynamic frame with a streaming agent reply. Two cases:
  //   - approval bar / plan-approval bar — agent is running, addLog can fire
  //     mid-frame; without freeze, eraseLines(H_old) misses the dialog height
  //     and burns into scrollback.
  //   - slash / file palette — same hazard: palette grows the dynamic frame
  //     while streaming commits keep landing.
  //
  // Modal dialogs (connect / model / mode / effort / sessions / mem /
  // permissions / rewind) are NOT in this list. They open via slash command,
  // which means the agent is idle, no streaming pressure exists; freezing
  // their lifetime adds an extra effect/setState round-trip on every open
  // and close for no benefit.
  useEffect(() => {
    setStaticCommitFrozen(
      pendingApproval !== null ||
      pendingPlan !== null ||
      pendingQuestions !== null ||
      palettes.slashOpen ||
      palettes.fileOpen ||
      dialog === "queue",
    )
  }, [pendingApproval, pendingPlan, pendingQuestions, palettes.slashOpen, palettes.fileOpen, dialog, setStaticCommitFrozen])

  // ── One-shot disk hygiene ──
  // Prune ~/.zapcode/image-paste/ (clipboard pastes not referenced by
  // any history entry) and ~/.zapcode/image-cache/ (SVG/URL caches older
  // than CACHE_TTL). Runs once after first render so it doesn't block
  // startup.
  useEffect(() => { void pruneImageStorage() }, [])

  // ── Track journal index at the start of each turn (for checkpoint slicing) ──
  const turnStartLogIndexRef = useRef(0)
  const turnStartUiLogIndexRef = useRef(0)

  // ── Agent runner ──
  const {
    runAgent,
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
    contextBudget,
    contextDiagnostics,
    contextDiagnosticsHistory,
    promptCacheDiagnostics,
    memoryAttachmentFailure,
    memoryFailure,
    promptSectionFailure,
    compactFailure,
    setCompactFailure,
    setMemoryFailure,
    usagePersistenceFailure,
    isStreaming,
    isThinking,
    streamingText,
    thinkingText,
  } = useAgentRunner({
    currentSessionId: getCurrentSessionId(),
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
    todoStore: todoStoreRef.current,
    turnStartLogIndexRef,
    turnStartUiLogIndexRef,
    compactLogs,
    availableSkills,
    getIsFrozen,
    registerStaticFlushCallback,
    onUpdateConfig: updateConfig,
  })

  const isAgentRunning = status !== "ready" && status !== "cancelled"
  const turnActivity = resolveTurnActivity(status, inputQueue, queueActiveRunId, queueError)
  const isRunning = turnActivity.busy

  // Mirror the actionable next-prompt estimate into a ref so non-React
  // callers (notably /compact) read the same value as the UI without
  // triggering callback rebinding after every turn.
  const contextTokensRef = useRef(contextTokens)
  useEffect(() => { contextTokensRef.current = contextTokens }, [contextTokens])

  // Pending tool calls that haven't yet had a matching result. The complete
  // set feeds LiveActivity so its aggregate counts stay aligned with the
  // transcript's multi-agent panel.
  //
  // todo_write is excluded: it doesn't render in the transcript either
  // (Transcript.tsx returns null for `tool.name === "todo_write"` — the live
  // list lives in TodosPanel), so surfacing it as `⚙ TodoWrite (+N) · Esc to
  // interrupt` in LiveActivity produces a "stuck" bar with no counterpart
  // anywhere on screen — confusing whenever a todo_write tool/result pair
  // briefly straddles a render (or stays pending under a frozen Static
  // buffer during a dialog).
  const pendingTools = useMemo(() => collectPendingTools(logs), [logs])

  // Most recent completed root-agent tool in the current user turn. Keeping
  // this visible while the next model step is thinking makes forward progress
  // explicit without adding another dynamic-frame row.
  const lastCompletedTool = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i]
      if (!log || log.type === "user") break
      if (
        log.type === "result"
        && log.tool?.name !== "todo_write"
        && (!log.agentPath || log.agentPath.length === 0)
      ) return log
    }
    return undefined
  }, [logs])

  // ── Paste / image handler ──
  const paste = usePasteHandler({
    inputValue,
    setInputValue,
    setPendingImages,
    bumpInputEpoch,
  })

  const restoreQueueDraft = useCallback(() => {
    const backup = draftBackup.current
    if (!backup) return
    paste.pasteStoreRef.current = new Map(backup.pastes)
    setInputValue(backup.text)
    setPendingImages(backup.images)
    draftBackup.current = null
    setEditingMessageId(null)
    bumpInputEpoch()
  }, [paste.pasteStoreRef, bumpInputEpoch])
  const editQueueMessage = useCallback((id: string) => {
    if (draftBackup.current) { addToast("Save or cancel the current edit first.", { variant: "warning" }); return }
    try {
      const entry = getMessageQueue().edit(id)
      if (!entry) { addToast("Only pending messages can be edited.", { variant: "warning" }); return }
      const prepared = prepareQueuedCommandsForEditing([entry], {
        nextPasteId: paste.pasteCounterRef.current + 1,
        nextImageId: paste.imageCounterRef.current + 1,
      })
      draftBackup.current = { text: inputValueRef.current, images: pendingImages, pastes: new Map(paste.pasteStoreRef.current) }
      paste.pasteStoreRef.current = new Map(Object.entries(prepared.pastedContents).map(([key, value]) => [Number(key), value]))
      for (const id of paste.pasteStoreRef.current.keys()) paste.pasteCounterRef.current = Math.max(paste.pasteCounterRef.current, id)
      for (const image of prepared.images) paste.imageCounterRef.current = Math.max(paste.imageCounterRef.current, image.id)
      setInputValue(prepared.text)
      setPendingImages(prepared.images)
      setEditingMessageId(id)
      setDialog(null)
      bumpInputEpoch()
    } catch (error) { addToast(String(error), { variant: "error" }) }
  }, [addToast, pendingImages, paste.pasteStoreRef, paste.pasteCounterRef, paste.imageCounterRef, bumpInputEpoch])
  const cancelQueueEdit = useCallback(() => {
    try { if (editingMessageId) getMessageQueue().cancelEdit(editingMessageId); restoreQueueDraft() }
    catch (error) { addToast(String(error), { variant: "error" }) }
  }, [editingMessageId, restoreQueueDraft, addToast])

  // ── dispatchUserTurn ──
  // Wraps addLog + runAgent. Defined in App.tsx (not buried in
  // useTurnDispatcher) so both the turn dispatcher AND the slash-command
  // dispatcher (/review, /commit, /run_skill, /init_project) can share the
  // same callable without going through a ref + late-bind dance.
  const dispatchUserTurn = useCallback(
    async (
      text: string,
      systemPrompt?: string,
      images?: import("../zapsdk/core/types.js").ImageContent[],
      /** What to show in the transcript. Defaults to `text` for plain turns.
       *  Pass the placeholder-bearing form (`[Image #1] ...`) when text was
       *  stripped of UI markers before dispatch. */
      displayText?: string,
      /** Skip the `addLog("user", ...)` call. Used for system-synthesized
       *  user turns — background task completion notifications, etc. */
      silent?: boolean,
      /** Optional full user-visible text for compact paste restoration.
       *  Must exclude model-only context blocks such as @file/MCP payloads. */
      restoreText?: string,
      /** Optional compact text used only for memory recall/query ranking. */
      memoryQueryText?: string,
      onAccepted?: () => void,
    ): Promise<unknown> => {
      turnStartLogIndexRef.current = peekJournalLogIndex()
      turnStartUiLogIndexRef.current = getUiLogCount()
      const queue = getMessageQueue()
      const runId = randomUUID()
      const steering = new Map<string, QueueEntry>()
      queue.beginRun(runId)
      const logUser = (display: string, full?: string, attachments?: import("../zapsdk/core/types.js").ImageContent[]) => {
        addLog("user", display, undefined, attachments?.map(img => ({ filePath: img.filePath, source: img.source, mediaType: img.mediaType })),
          undefined, full !== undefined ? { restoreText: full } : undefined)
      }
      try {
        return await runAgent(text, systemPrompt, images, memoryQueryText ?? displayText ?? text, {
          propagateErrors: true,
          onInputAccepted: () => {
            onAccepted?.()
            if (silent) addLog("task-notification", text)
            else logUser(displayText ?? text, restoreText, images)
          },
          hasSteering: () => queue.hasSteering(runId),
          takeSteering: () => {
            const entry = queue.claimSteering(runId)
            if (!entry) return
            steering.set(entry.id, entry)
            const attachments = entry.images?.map(image => image.content)
            return { id: entry.id, text: buildDispatchText(entry.text, !!attachments?.length), images: attachments }
          },
          onSteeringAccepted: input => {
            const entry = steering.get(input.id)
            if (!entry) return
            const warning = queue.acknowledge(entry.id, entry.sessionId)
            if (warning) addLog("error", warning)
            logUser(entry.displayForm, entry.restoreText, entry.images?.map(image => image.content))
            steering.delete(input.id)
          },
        })
      } finally {
        try { queue.endRun(runId) }
        catch (error) { addLog("error", `Queue run cleanup failed: ${String(error)}`) }
      }
    },
    [addLog, getUiLogCount, runAgent],
  )

  const precheckProvider = useCallback(
    () => isProviderReady(configRef, addLog),
    [addLog],
  )

  // ── Bound slash-command dispatcher ──
  // dispatchSlashCommand is a pure function; bind it to App-local deps via
  // useCallback. Closes over dispatchUserTurn directly — no ref needed.
  const dispatchCommand = useCallback(
    async (
      input: string,
      meta?: import("./commands/dispatcher.js").SlashCommandDispatchMeta & { onAccepted?: () => void },
    ): Promise<boolean> => {
      const result = await dispatchSlashCommand(input, {
        exit,
        bumpTranscript,
        setLogs,
        setTodos,
        todosRef,
        subagentTodosRef,
        checkpointRef: checkpointHandle,
        turnStartLogIndexRef,
        setDialog,
        addLog,
        configRef,
        updateConfig,
        addToast,
        getLogs: () => logsRef.current,
        compactLogs,
        agentRef,
        skillsRef,
        dispatchUserTurn: (text, systemPrompt, images, displayText, silent, restoreText, memoryQueryText) =>
          dispatchUserTurn(text, systemPrompt, images, displayText, silent, restoreText, memoryQueryText, meta?.onAccepted),
        getContextTokens: () => contextTokensRef.current,
        onResetRuntimeState: () => {
          tokenAccounting.promptOverhead = 0
          setContextTokens(0, "estimated", null)
          resetRunDiagnostics()
          restoreMemoryQueryHistoryFromLogs([])
        },
        setStatus,
        beginManualCompact: () => {
          const controller = new AbortController()
          abortRef.current = controller
          return controller
        },
        endManualCompact: (controller) => {
          if (abortRef.current === controller) abortRef.current = null
        },
        onCompactFailure: setCompactFailure,
        onMemoryFailure: setMemoryFailure,
        onContextChanged: (requestTokens) => {
          setContextTokens(
            requestTokens ?? conversation.estimatedTokens + tokenAccounting.promptOverhead,
            "estimated",
            null,
          )
        },
      }, meta)
      if (getMessageQueue().getSessionId() !== getCurrentSessionId()) bindQueue()
      return result
    },
    // bumpTranscript / setLogs / setTodos / updateConfig / setDialog are
    // stable; refs aren't deps. Only addLog/addToast/compactLogs/dispatchUserTurn
    // could realistically change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addLog, addToast, compactLogs, dispatchUserTurn, exit, updateConfig, setContextTokens, resetRunDiagnostics, restoreMemoryQueryHistoryFromLogs, setCompactFailure, setMemoryFailure, bindQueue],
  )

  // ── Turn dispatcher (unified handleSubmit + drain) ──
  const { handleSubmit } = useTurnDispatcher({
    getTodos: () => todosRef.current,
    // Pending delivery is busy for UI/controls, but must not block the
    // dispatcher effect that starts that very delivery.
    isRunning: isAgentRunning,
    paused: dialog === "rewind" || dialog === "update" || dialog === "restoring",
    inputQueue,
    systemInboxSize,
    followUpMode: config.followUpMode ?? "queue",
    editingMessageId,
    onEditCommitted: restoreQueueDraft,
    openQueue,
    getInputValue,
    queueError,
    getSessionId: getCurrentSessionId,
    addLog,
    addToast,
    dispatchUserTurn,
    dispatchCommand,
    precheckProvider,
    slashOpen: palettes.slashOpen,
    slashEntries: palettes.slashEntries,
    slashIdx: palettes.slashIdx,
    expandPastes: paste.expandPastes,
    pasteStoreRef: paste.pasteStoreRef,
    pasteCounterRef: paste.pasteCounterRef,
    imageCounterRef: paste.imageCounterRef,
    attachImageWithPlaceholder: paste.attachImageWithPlaceholder,
    setInputValue,
    pendingImages,
    setPendingImages,
  })

  // Ink emits every parsed key from one stdin.read() batch synchronously. Some
  // terminal automation sends text + CR in one chunk; if submit dispatch mutates
  // app state immediately, React can still be rendering while Ink continues to
  // emit the rest of that batch, which React 19 rejects for useEffectEvent-based
  // useInput handlers. Defer the actual submit to the next macrotask so input
  // emission and any current render finish first.
  const submitInputDeferred = useCallback((value: string) => {
    setTimeout(() => { void handleSubmit(value) }, 0)
  }, [handleSubmit])

  // ── /clear-style reset (also bound to Ctrl+L) ──
  const onClearScreen = useCallback(() => {
    if (isRunning) { addToast("Stop the current task before clearing its conversation.", { variant: "warning" }); return }
    try { clearQueue() } catch (error) { addToast(String(error), { variant: "error" }); return }
    clearSystemInbox()
    restoreQueueDraft()
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[H\x1b[2J\x1b[3J")
    }
    conversation.clear()
    restoreMemoryQueryHistoryFromLogs([])
    setLogs([])
    todosRef.current = []
    setTodos([])
    subagentTodosRef.current.clear()
    turnStartLogIndexRef.current = 0
    turnStartUiLogIndexRef.current = 0
    bumpTranscript()
  }, [isRunning, addToast, restoreQueueDraft, bumpTranscript, restoreMemoryQueryHistoryFromLogs, setLogs])

  // ── Keyboard shortcuts (palette nav / Esc / Ctrl+C/L/V) ──
  useKeyboardShortcuts({
    fileOpen: palettes.fileOpen,
    fileEntries: palettes.fileEntries,
    fileIdx: palettes.fileIdx,
    setFileIdx: palettes.setFileIdx,
    slashOpen: palettes.slashOpen,
    slashEntries: palettes.slashEntries,
    slashIdx: palettes.slashIdx,
    setSlashIdx: palettes.setSlashIdx,
    dialog,
    pendingApproval,
    pendingPlan,
    questionOpen: pendingQuestions !== null,
    inputQueue,
    openQueue,
    openRewind: () => { if (!isRunning) setDialog("rewind") },
    saveDraftToHistory: value => pushHistory(value, Object.fromEntries(paste.pasteStoreRef.current), {}),
    editingMessageId,
    cancelQueueEdit,
    pendingImages,
    setPendingImages,
    restorePastedContents: (pastedContents) => paste.handleHistoryNav(pastedContents, {}),
    isRunning,
    abortRef,
    setStatus,
    inputValue,
    setInputValue,
    bumpInputEpoch,
    submitInput: submitInputDeferred,
    addToast,
    onClearScreen,
    exit,
    lastAttachAtRef: paste.lastAttachAtRef,
    absorbVUntilRef: paste.absorbVUntilRef,
    ATTACH_DEDUP_MS: paste.ATTACH_DEDUP_MS,
    attachImageWithPlaceholder: paste.attachImageWithPlaceholder,
  })

  // ── Render ──
  const providerDisplayName = getProviderDisplayName(config)
  const hasKey = configHasApiKey(config)
  const welcomeHeader = useMemo(() => <Welcome hasApiKey={hasKey} />, [hasKey])
  const mcpFooterSummary = useMemo(
    () => summariseMCPStatuses(mcp.snapshots),
    [mcp.snapshots],
  )

  // Stable callbacks — dialogs/pickers depend on `closeDialog`/`commitConfig`
  // identity inside their useInput closures and useMemo'd option lists.
  // Without useCallback, every App re-render (logs streaming, spinner tick,
  // toast countdown) churns those identities and forces the whole picker
  // subtree to reconcile on every keystroke.
  const closeDialog = useCallback(() => setDialog(null), [])
  const commitConfig = useCallback((next: AppConfig) => {
    updateConfig(next)
    setDialog(null)
  }, [updateConfig])

  // Render order: ambient stuff → active input slot (Prompt/dialog/bar) →
  // Footer last. Footer below the input matches the conventional terminal
  // status-bar layout. Prompt declares its IME cursor position via Ink's
  // useCursor; layout below it doesn't matter for cursor parking.
  //
  // Modal screen takeover — DISABLED BY DEFAULT (2026-05-20).
  //
  // Earlier behavior unmounted TodosPanel / LiveActivity / ToastContainer /
  // queued-message preview / Prompt / palettes / Footer when a dialog was
  // open. The unmount + later remount cascade emits a big batch of erase
  // and cursor-positioning escape bytes through Ink each time. Apple
  // Terminal accumulates state per batch and transitions into a 10x slower
  // render path (138ms → 1.4s mount commit), which persists for the entire
  // Terminal.app session — only Cmd+Q clears it. The slash palette never
  // triggers takeover and never causes that slowdown — that A/B is what
  // located the cause. See memory project_apple_terminal_slow_render.md.
  //
  // New behavior: keep everything mounted, exactly like the slash palette
  // does. The original "long-session arrow-key sluggishness" that takeover
  // was guarding against has not been observed to return — Ink's memo
  // barrier + Transcript's <Static> commit keep per-render cost flat.
  //
  // ZAPCODE_MODAL_TAKEOVER=1 re-enables the legacy unmount path for power
  // users who hit the old issue in a non-Apple-Terminal setup. Inline
  // overlays (approval / plan / palette) stay rendered through dialog open
  // regardless of this flag — they fire while the agent is RUNNING and the
  // surrounding context must stay visible.
  const inModal = dialog !== null && process.env.ZAPCODE_MODAL_TAKEOVER === "1"

  const restoreSession = (loaded: DialogSessionRestore) => {
    const { logs: restored, messages, loadedSessionId, metadata } = loaded
    appLogger.info("session_restore_begin", {
      sessionId: loadedSessionId,
      restoredLogs: restored.length,
      messagesToAdd: messages.length,
    })
    // All fallible file reads and transcript conversion completed in
    // the dialog's prepare phase. Commit conversation + durable writer
    // together; a writer failure restores the previous conversation.
    const restoredActiveSessionId = commitSessionForDialog(loaded, conversation)
    restoreQueueDraft()
    bindQueue(loadedSessionId)
    // Recalibrate the current next-prompt estimate from the LAST API
    // truth persisted with this session. Recovering provider overhead
    // via `total - localEstimateAtTime` avoids a fresh process showing
    // a number 10-30k below what the API would receive next.
    const persistedHistory = metadata.usages
    const persisted = persistedHistory.at(-1) ?? null
    const activeCacheScope = makePromptCacheScope(
      config.active.providerId,
      config.active.model,
    )
    const persistedMatchesActiveModel = !!persisted && (
      !persisted.cacheScope || samePromptCacheScope(persisted.cacheScope, activeCacheScope)
    )
    if (persisted && persistedMatchesActiveModel) {
      const restoredUsage = resolveRestoredUsageContext(
        persisted,
        conversation.estimatedTokens,
        tokenAccounting.promptOverhead,
      )
      tokenAccounting.promptOverhead = restoredUsage.promptOverhead
      setContextTokens(
        restoredUsage.contextTokens,
        "restored",
        persisted.total > 0 ? persisted.total : null,
      )
      resetRunDiagnostics(
        persistedUsageToRunnerUsage(persisted),
        persisted.contextDiagnostics,
        persistedHistory.map(persistedUsageToRunnerUsage),
        persistedHistory.flatMap((usage) => usage.contextDiagnostics ? [usage.contextDiagnostics] : []),
        persisted.promptCacheDiagnostics,
      )
    } else {
      const restoredUsage = resolveUnmeasuredUsageContext(conversation.estimatedTokens)
      tokenAccounting.promptOverhead = restoredUsage.promptOverhead
      setContextTokens(restoredUsage.contextTokens, "pending", null)
      if (persisted) {
        resetRunDiagnostics(
          persistedUsageToRunnerUsage(persisted),
          persisted.contextDiagnostics,
          persistedHistory.map(persistedUsageToRunnerUsage),
          persistedHistory.flatMap((usage) => usage.contextDiagnostics ? [usage.contextDiagnostics] : []),
          persisted.promptCacheDiagnostics,
        )
      } else {
        resetRunDiagnostics()
      }
    }
    setLogs(restored)
    restoreMemoryQueryHistoryFromLogs(restored)
    appLogger.info("session_restore_state_set", {
      convEstimatedTokens: conversation.estimatedTokens,
      convMessageCount: conversation.getMessages().length,
      persistedUsage: persisted,
      promptOverhead: tokenAccounting.promptOverhead,
      firstMsgRole: messages[0]?.role,
      firstMsgPreview: messages[0]?.content?.slice(0, 60),
      lastMsgRole: messages[messages.length - 1]?.role,
      lastMsgPreview: messages[messages.length - 1]?.content?.slice(0, 60),
    })
    // Rebind checkpoint to the durable fork and hydrate from the same
    // validated source bundle that was copied into the fork.
    try {
      checkpoint.setSessionId(restoredActiveSessionId)
      checkpoint.hydrateFromJsonl(metadata.checkpointJournal, { remapToCurrentSession: true })
    } catch (err) {
      addLog("error", `checkpoint hydrate failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // `parseTodoUpdates` is tail-wins per key. The exact validated map
    // was also persisted into the durable fork during commit.
    try {
      const todoMap = metadata.todos
      const main = todoMap.get("main") as Todo[] | undefined
      todosRef.current = main ?? []
      setTodos(main ?? [])
      subagentTodosRef.current.clear()
      for (const [key, list] of todoMap) {
        if (key === "main") continue
        subagentTodosRef.current.set(key, list as Todo[])
      }
    } catch (err) {
      addLog("error", `todo restore failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    bumpTranscript()
    appLogger.info("session_restore_end", { sessionId: loadedSessionId })
    closeDialog()

  }
  useEffect(() => {
    const id = process.env.ZAPAGENT_RESTORE_SESSION
    delete process.env.ZAPAGENT_RESTORE_SESSION
    if (id) void restoreAfterUpdate({
      load: () => loadSessionForDialog(id), commit: restoreSession,
      failed: () => addToast("Could not restore the previous session. Open /sessions to recover it.", { variant: "error" }),
      finished: () => setDialog(null),
    })
  }, [])

  return (
    <TermWidthContext.Provider value={termWidth}>
    <ConversationSurface>
      <Transcript
        key={transcriptEpoch}
        logs={logs}
        header={welcomeHeader}
        streamingTail={streamingText}
        agentRuns={agentRuns}
      />
      <PendingUserMessage entry={inputQueue.find(entry => entry.id === turnActivity.foregroundId)} />

      {!inModal && (
        <>
          {dialog !== "queue" && <TodosPanel todos={todos} />}

          <LiveActivity
            isRunning={isRunning}
            isStreaming={isStreaming}
            isThinking={isThinking}
            thinkingChars={thinkingText.length}
            status={turnActivity.status}
            providerRequest={providerRequest}
            activeTool={activeTool}
            activeToolBytes={activeToolBytes}
            termWidth={termWidth}
            pendingTools={pendingTools}
            lastCompletedTool={lastCompletedTool}
            stopHint={inputQueue.length || editingMessageId || pendingImages.length || dialog || palettes.slashOpen || palettes.fileOpen ? "Ctrl+C to stop" : undefined}
          />

          <ToastContainer toasts={toasts} />
          <UpdateNotice version={availableUpdate} />

          <TokenWarning contextBudget={contextBudget} />

          {dialog !== "queue" && <QueuePanel entries={inputQueue} mode={config.followUpMode ?? "queue"} active={isAgentRunning} foregroundId={turnActivity.foregroundId} />}
          {editingMessageId && <Text color={c.accent}>Editing queued message · Enter saves · Esc cancels · original draft is kept</Text>}
        </>
      )}

      {!inModal && pendingApproval && (
        <ApprovalBar
          key={pendingApproval.id}
          toolName={pendingApproval.name}
          args={pendingApproval.args}
          onChoose={pendingApproval.resolve}
          allowScope={pendingApproval.allowScope}
          onGrant={pendingApproval.grant}
          availableTools={agentRef.current.registry.definitions().filter(tool => tool.permission === "confirm").map(tool => tool.name)}
          unsandboxed={approvalFacts(pendingApproval.name, pendingApproval.args, pendingApproval.context).sandboxEscape}
          rulePreview={inferInvocationRules(pendingApproval.name, pendingApproval.args, process.cwd(), pendingApproval.context).map(rule => rule.pattern).join(", ") || null}
        />
      )}
      {!inModal && pendingPlan && <PlanApprovalBar plan={pendingPlan.plan} onChoose={pendingPlan.resolve} />}
      {!inModal && pendingQuestions && <AskUserBar questions={pendingQuestions.questions} onDone={pendingQuestions.resolve} />}

      {!inModal && !pendingApproval && !pendingPlan && !pendingQuestions && (
        <Prompt
          config={config}
          providerLabel={`${providerDisplayName}/${config.active.model}`}
          hasActiveKey={hasKey}
          inputValue={inputValue}
          onInput={paste.handleInput}
          onSubmit={submitInputDeferred}
          onPaste={paste.handlePaste}
          onHistoryNav={paste.handleHistoryNav}
          inputEpoch={inputEpoch}
          // Defocus Prompt while a modal dialog is open so its useInput
          // (history nav on ↑/↓) and TextInput don't compete with the
          // dialog's own keyboard handler. Prompt stays mounted (no
          // unmount-cascade byte storm — see the takeover comment above)
          // but goes inert.
          focused={dialog === null}
          isRunning={isRunning}
          inputTokens={0}
          outputTokens={0}
          contextTokens={contextTokens}
          maxContextTokens={getActiveContextWindow(config)}
          disableHistoryNav={palettes.slashOpen || palettes.fileOpen}
          // Suppress Prompt's own submit while a palette is open. File palette
          // Enter inserts a path; slash palette Enter submits via
          // useKeyboardShortcuts so Ink's multi-listener fan-out can't double
          // dispatch the same command.
          blockSubmit={palettes.fileOpen || palettes.slashOpen}
          // LiveActivity above provides its own marginTop=1; doubling it
          // on the prompt creates the "live indicator floats too far from
          // the prompt" gap.
          noTopMargin={isRunning || isStreaming || isThinking || pendingTools.length > 0}
        />
      )}

      {!inModal && !pendingApproval && !pendingPlan && !pendingQuestions && palettes.slashOpen && (
        <SlashPalette entries={palettes.slashEntries} selected={palettes.slashIdx} />
      )}

      {!inModal && !pendingApproval && !pendingPlan && !pendingQuestions && palettes.fileOpen && (
        <FilePalette entries={palettes.fileEntries} selected={palettes.fileIdx} />
      )}

      {/* ── Dialog slot ────────────────────────────────────────────────
       *  Rendered BELOW Prompt so the dialog reads as a panel that pops
       *  out from under the input box (matching how SlashPalette /
       *  FilePalette already work). Prompt above stays visible but
       *  defocused while the dialog owns the keyboard (see focused= prop
       *  above). */}
      {dialog === "restoring" && <Text>Restoring saved session…</Text>}
      {dialog === "update" && <UpdateDialog version={availableUpdate} busy={isRunning} sessionId={getCurrentSessionId()} beforeInstall={() => {
        readCurrentSessionLogs()
        const persistence = getSessionPersistenceStatus()
        if (persistence.pendingWrites || persistence.lastFailure) throw new Error("Save the current session successfully before updating.")
      }} onCancel={closeDialog} onRestart={request => { readCurrentSessionLogs(); requestUpdateRestart(request); exit() }} />}
      {dialog === "connect"     && <ConnectDialog     config={config} onSave={updateConfig} onCommit={commitConfig} onCancel={closeDialog} />}
      {dialog === "model"       && <ModelDialog       config={config} onSave={updateConfig} onCommit={commitConfig} onCancel={closeDialog} />}
      {dialog === "mode"        && <ModeDialog        config={config} onCommit={commitConfig} onCancel={closeDialog} />}
      {dialog === "effort"      && <EffortDialog      config={config} onCommit={commitConfig} onCancel={closeDialog} />}
      {dialog === "status"      && (
        <StatusDialog
          config={config}
          contextBudget={contextBudget}
          contextDiagnostics={contextDiagnostics}
          contextDiagnosticsHistory={contextDiagnosticsHistory}
          usage={toStatusUsage(tokens)}
          usageHistory={usageHistory.flatMap((snapshot) => {
            const usage = toStatusUsage(snapshot)
            return usage ? [usage] : []
          })}
          diagnostics={{
            memoryAttachmentFailure,
            memoryFailure,
            promptSectionFailure,
            compactFailure,
            usagePersistenceFailure,
            sessionPersistence: getSessionPersistenceStatus(),
            promptCache: promptCacheDiagnostics,
            toolSchema: buildToolSchemaDiagnostics(agentRef.current.registry.definitions()),
          }}
          cwd={process.cwd()}
          onCancel={closeDialog}
        />
      )}
      {dialog === "sessions"    && (
        <SessionsDialog
          onLoad={restoreSession}
          onCancel={closeDialog}
        />
      )}
      {dialog === "mem"         && <MemDialog         onCancel={closeDialog} />}
      {dialog === "queue" && <QueueDialog queue={getMessageQueue()} entries={inputQueue} mode={config.followUpMode ?? "queue"}
        onModeChange={mode => updateConfig({ ...configRef.current, followUpMode: mode })}
        onEdit={editQueueMessage} onError={error => addToast(error, { variant: "error" })} onCancel={closeDialog} />}
      {dialog === "permissions" && <PermissionsDialog availableTools={agentRef.current.registry.definitions().filter(tool => tool.permission === "confirm").map(tool => tool.name)} onCancel={closeDialog} />}
      {dialog === "supertask_watch" && <SupertaskWatchDialog cwd={process.cwd()} onCancel={closeDialog} />}
      {dialog === "rewind"      && (
        <RewindDialog
          isRunning={isRunning}
          checkpoint={checkpoint}
          logs={logs}
          onApply={(truncated, snap, mode, result) => {
            if (mode === "code") {
              addToast(`Restored ${result.succeeded.length} tracked files${result.skipped?.length ? `; skipped ${result.skipped.length}` : ""}`);
              closeDialog(); return;
            }
            const draft = rewindDraft(snap, logs);
            setInputValue(draft.text);
            setPendingImages([]);
            paste.handleHistoryNav({}, draft.imageRefs);
            bumpInputEpoch();
            // Rebuild from the durable, marker-aware journal rather than using
            // snap.turnStartIndex. Message indexes are invalidated whenever
            // compact replaces an old prefix with one summary turn; replaying
            // JSONL guarantees the model cannot retain the abandoned branch.
            try {
              replaceConversationMessages(
                conversation,
                sessionLogsToMessages(readCurrentSessionLogs()),
              )
            } catch (err) {
              // The files and rewind marker are already committed here. Fail
              // closed by dropping the in-memory branch; restart/session load
              // can rebuild it from the durable marker-aware journal.
              conversation.clear()
              appLogger.warn("rewind_conversation_restore_failed", {
                error: err instanceof Error ? err.message : String(err),
              })
            }
            setContextTokens(
              conversation.estimatedTokens + tokenAccounting.promptOverhead,
              "estimated",
              null,
            )
            resetRunDiagnostics()
            if (process.stdout.isTTY) process.stdout.write("\x1b[H\x1b[2J\x1b[3J")
            setLogs(truncated)
            restoreMemoryQueryHistoryFromLogs(truncated)
            // Todo state is model-facing dynamic context. Restore the same
            // marker-filtered branch immediately instead of waiting for a
            // restart to repair stale plans from the abandoned future.
            const todoMap = readTodoUpdates(getCurrentSessionId())
            const mainTodos = (todoMap.get("main") as Todo[] | undefined) ?? []
            todosRef.current = mainTodos
            setTodos(mainTodos)
            subagentTodosRef.current.clear()
            for (const [key, list] of todoMap) {
              if (key !== "main") subagentTodosRef.current.set(key, list as Todo[])
            }
            bumpTranscript()
            closeDialog()
          }}
          onCancel={closeDialog}
        />
      )}
      {dialog === "recovery" && (
        <RecoveryDialog
          center={recoveryCenter}
          onMutation={async (event) => {
            if (event.type === "merge") {
              await checkpoint.makeSnapshot(conversation.getMessages().length, {
                journalLogIndex: peekJournalLogIndex(),
                uiLogIndex: logs.length,
              })
              bumpTranscript()
            }
            addToast(event.message, { variant: "success" })
          }}
          onCancel={closeDialog}
        />
      )}

      {/* Hide the Footer while slash/file palette OR any dialog is open.
       *  The dropdown panels expand UNDER the prompt and the Footer below
       *  would otherwise get pushed off the bottom of the visible
       *  viewport. /status in particular shows much of the same info the
       *  Footer carries (model + token usage), so having both visible at
       *  once is redundant. The palette/dialog's own keyboard hints
       *  replace what Footer was conveying during this momentary state. */}
      {!inModal && dialog === null && !palettes.slashOpen && !palettes.fileOpen && (
        <Footer
          outputThroughput={outputThroughput}
          cwd={cwdShort}
          provider={providerDisplayName}
          model={config.active.model}
          effort={config.active.providerId ? getEffort(config, config.active.providerId) : undefined}
          isRunning={isRunning}
          step={step}
          maxSteps={config.maxSteps}
          contextBudget={contextBudget}
          hasApiKey={hasKey}
          showWelcome={logs.length === 0 && !isRunning && !isStreaming}
          shellMode={isShellMode()}
          permissionMode={config.permissionMode}
          termWidth={termWidth}
          mcp={mcpFooterSummary}
        />
      )}
    </ConversationSurface>
    </TermWidthContext.Provider>
  )
}

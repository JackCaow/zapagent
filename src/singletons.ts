import { resolveModelImageTokenContext } from "./provider-metadata.js"
import { TokenCounter } from "../zapsdk/context/token-counter.js"
// Module-level singletons shared across App + hooks.
// Initialized once at module load. Side effects (skill auto-install,
// conversation.clear for fresh session) live here too.

import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import {
  ConversationManager,
  AutoMemory,
  LocalSparseMemoryRetriever,
  Logger,
  AgentLogger,
} from "../zapsdk/index.js"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { cronTools, monitorTool, detectProviders, type DetectedProvider } from "../zapsdk/builtin-tools/index.js"
import { TaskStore } from "../zapsdk/tasks/store.js"
import { buildTaskNotificationXml, classifyTaskExit } from "../zapsdk/tasks/notification.js"
import { pushSystemEvent } from "./queue/systemInbox.js"
import type { AgentEventHandler } from "../zapsdk/agent/events.js"
import { installSkillIfMissing } from "../zapsdk/skills/loader.js"
import { PermissionManager } from "./permissions.js"
import { SKILLS } from "./skills.js"
import { configPath, setSessionDiagnostics } from "./session.js"
import { loadAppConfig, getActiveProvider } from "./config.js"
import { resolveActiveContextLimits } from "./context-budget.js"
import { openMdStore } from "../zapsdk/memory/md-store.js"
import { setPromptDiagnosticsLogger } from "./prompts/registry.js"

// ─── Auto-install built-in skills to ~/.agents/skills ───
const _agentSkillsDir = join(homedir(), ".agents", "skills")
try { mkdirSync(_agentSkillsDir, { recursive: true }) } catch {}
for (const skill of SKILLS) {
  installSkillIfMissing(_agentSkillsDir, skill)
}

// ─── Singletons ───
const _initialConfig = loadAppConfig(configPath)
export const autoMemory = new AutoMemory(process.cwd())
export const appLogger = new Logger()
setPromptDiagnosticsLogger(appLogger)
setSessionDiagnostics({
  warn: (event, fields) => appLogger.warn(event, fields),
  error: (event, fields) => appLogger.error(event, fields),
})
export const agentLogger = new AgentLogger(appLogger)
export const permissionManager = new PermissionManager(process.cwd(), appLogger)

const _initialContextLimits = resolveActiveContextLimits(_initialConfig)
export const conversation = new ConversationManager({
  tokenCounter: new TokenCounter(resolveModelImageTokenContext(getActiveProvider(_initialConfig), _initialConfig.active.model)),
  // Token-aware compaction is the production history boundary. A rolling
  // message-count window rewrites the provider prefix after every new turn
  // once the session crosses the cap, destroying prompt-cache locality and
  // silently discarding otherwise affordable history.
  maxMessages: Number.POSITIVE_INFINITY,
  maxTokens: _initialContextLimits.effectiveInputLimit,
  triggerAtTokens: _initialContextLimits.compactAt,
  targetTokensAfterCompress: _initialContextLimits.keepFloorTokens,
  autoCompress: true,
})

// Fresh session on every startup — previous sessions available via /sessions
conversation.clear()

// ─── Markdown memory layer ───
// Single source of truth for /mem dialog, working-pack injection, and the
// memory_save tool. Shares autoMemory.memoryDir so memory_save (writer),
// buildMdPack (reader), and the instructions string injected into the
// system prompt all agree on the same per-project location
// (~/.zapcode/projects/<project-id>/memory/) — without this, mdStore pointed
// at the global ~/.zapcode/memory/ and bled cross-project records into every
// new workspace.
try { autoMemory.ensureSync() }
catch (err) { appLogger.warn("memory_ensure_failed", { error: err instanceof Error ? err.message : String(err) }) }
export const mdStore = openMdStore(autoMemory.memoryDir)
export const globalMemoryDir = join(getAppDataDir(), "memory")
export const globalMdStore = openMdStore(globalMemoryDir)
// Offline sparse vectors improve topical recall without sending memory bodies
// to an embedding service. The retriever caches one fingerprinted index per
// scope and can be replaced by any MemorySemanticRetriever implementation.
export const memorySemanticRetriever = process.env.ZAPCODE_DISABLE_LOCAL_MEMORY_SEMANTIC === "1"
  ? undefined
  : new LocalSparseMemoryRetriever()

// ─── Token-accounting state ───
// `conversation.estimatedTokens` only counts the messages currently held in
// the ConversationManager — system prompt, tool-definition JSON, memory
// attachments, and per-turn context attachments are constructed at the agent
// call site and never enter `turns`, so the local estimate under-reports
// what the provider actually sees by 10-30k tokens.
//
// After each successful turn we have ground truth: the API tells us how many
// input tokens it processed (input + cache_read + cache_creation). The
// difference between that and `conversation.estimatedTokens` at the same
// moment IS the system-prompt + tools + memory overhead for this session.
// Cache it here so the next "no API result yet" fallback (session restore,
// pre-turn compact, post-manual-compact) can add it back instead of showing
// an estimate that's 10-30k too low.
export const tokenAccounting = {
  /** Last observed (API input tokens) - (conversation.estimatedTokens).
   *  Starts at 0; refined each turn. Never drops below 0 (cache reads can
   *  make API truth temporarily smaller than the local count). */
  promptOverhead: 0,
}

// ─── Cron + Monitor session-scoped handles ───
// Singletons (not per-config-reload): session-only jobs should survive
// config changes but die with the process. No `agentId` → main agent has
// team-lead semantics (sees and deletes all jobs). `onFire` is left
// undefined until the CLI prompt-queue integration is wired — fires are
// recorded on the job (lastFiredAt) but do not inject into agent turns yet.
export const cronHandle = cronTools({})
// Single shared TaskStore — monitor, bash bg, and future task_* tools all
// register and look up tasks here so the UI gets a unified view.
export const taskStore = new TaskStore({ projectCwd: process.cwd() })
export const monitorHandle = monitorTool({ store: taskStore })

// ─── Task-completion → systemInbox bridge ───
// When a background task exits, build a `<task-notification>` XML payload
// and drop it on the systemInbox. The dispatcher (`useTurnDispatcher`)
// drains the inbox at every turn boundary and delivers each event to the
// model as a silent user-role message — the model reacts (e.g. surfaces a
// summary of the completed task) and that reaction is what the user sees.
// Separate from the input queue by design: a system event must never
// surface in the UI input area where the user could edit or dismiss it.
taskStore.on("exited", (e) => {
  const snap = taskStore.get(e.taskId)
  if (!snap) return
  const status = classifyTaskExit(e.exitCode, e.signal)
  const xml = buildTaskNotificationXml({ task: snap, status, outputBytes: e.outputBytes })
  // Sub-agent results are delivered by their owning agent, not a new main-agent turn.
  if (snap.ownerAgentId) return
  pushSystemEvent({
    kind: "task-notification", payload: xml, ts: Date.now(),
    id: `${taskStore.instanceId}:${snap.taskId}:exit`, taskId: snap.taskId, sessionId: snap.sessionId,
    isObsolete: () => taskStore.hasObservedExit(snap.taskId),
    onDelivered: () => taskStore.observeExit(snap.taskId),
  })
})

// ─── Process shutdown cleanup ───
// Kill every still-running monitor child so Ctrl-C doesn't leave background
// processes orphaned. Cron scheduler is setInterval(unref'd), dies with the
// process; calling stop() is belt-and-suspenders.
let _shutdownRan = false
function _shutdown(): void {
  if (_shutdownRan) return
  _shutdownRan = true
  try { taskStore.stopAll("SIGTERM") } catch {}
  try { cronHandle.stop() } catch {}
}
process.on("exit", _shutdown)
process.on("SIGINT", () => { _shutdown(); process.exit(130) })
process.on("SIGTERM", () => { _shutdown(); process.exit(143) })

// ─── Delegate-agent provider probe + event bridge ───
// Probe PATH for `claude` / `codex` once at startup so per-turn agent factory
// stays sync. Empty list → delegate_agent tool is not registered.
//
// `delegateEventBridge.handler` is the indirection that lets useAgentRunner
// rebind the per-run sub-agent event handler each turn while the registry's
// delegate_agent tool — built once at config-rebuild time — keeps the same
// onEvent closure. The closure forwards to whatever bridge.handler points at.
//
// `delegateProvidersReady` is the promise consumers (App.tsx) await so they
// can rebuild agentRef once detection finishes — without it, the initial
// agentRef built at App mount races detectProviders and almost always loses
// (cold-start App mount completes in single-digit ms, PATH `which` takes
// 30–200ms), leaving `delegate_agent` unregistered until the user
// independently changes config and triggers a rebuild.
export let delegateProviders: DetectedProvider[] = []
export const delegateProvidersReady: Promise<DetectedProvider[]> = detectProviders(2000)
  .then((found) => { delegateProviders = found; return found })
  .catch(() => [] as DetectedProvider[])

export const delegateEventBridge: { handler: AgentEventHandler | null } = { handler: null }

// ─── MCP manager handle ───
// Populated by App.tsx via setMCPManager() once useMCPSubsystem has built
// the singleton. submit-time helpers (resolveMCPReferences /
// dispatchMCPPrompt) read through getMCPManager() so they don't need
// React state plumbed all the way through useTurnDispatcher options.
import type { MCPManager } from "../zapsdk/index.js"
let _mcpManager: MCPManager | null = null
export function setMCPManager(m: MCPManager | null): void { _mcpManager = m }
export function getMCPManager(): MCPManager | null { return _mcpManager }

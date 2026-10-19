import { AgentBudget } from "../../zapsdk/agent/budget.js"
import { RequestMeter } from "../../zapsdk/agent/request-meter.js"
import { recordMaintenanceUsage } from "../agent/maintenanceUsage.js"
import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import type { AppConfig, PermissionMode } from "../config.js"
import {
  cycleEffort,
  getActiveProvider,
  resolveEffortInput,
  setEffort,
  validateConfig,
} from "../config.js"
import { resolveActiveContextLimits } from "../context-budget.js"
import type { CheckpointManager } from "../../zapsdk/checkpoint/index.js"
import { conversation, autoMemory } from "../singletons.js"
import { dispatchMCPCommand } from "./mcp.js"
import {
  getCurrentSessionId,
  lastOutputPath,
  readCurrentSessionLogs,
  startNewSession,
} from "../session.js"
import { restoreRecentFiles } from "../../zapsdk/index.js"
import { extractFilesFromSummary } from "../ui/compact-utils.js"
import { manualCompactFailureReason } from "../agent/compactDiagnostics.js"
import {
  persistCompactSummaryBestEffort,
  type MemoryFailureDiagnostic,
  type PersistCompactSummary,
} from "../agent/memoryDiagnostics.js"
import { buildStatusText } from "./status.js"
import type { Todo } from "../../zapsdk/index.js"
import type { LogEntry, LogType, ToolCallInfo, UserImageRef } from "../ui/types.js"
import type { SkillDefinition } from "../../zapsdk/skills/types.js"
import type { AgentObjects } from "../agent/types.js"
import { parseCommand } from "../commands.js"
import { clearQueue } from "../queue/inputQueue.js"
import { clearSystemInbox } from "../queue/systemInbox.js"
import {
  REVIEW_PROMPT,
  COMMIT_PROMPT,
  INIT_PROJECT_PROMPT,
} from "../prompts/builtin-commands.js"
import {
  createSupertask,
  findResumable,
  listSupertasks,
  abort as abortSupertask,
  readMeta,
  readPrd,
  prdSummary,
  readIter,
  isRunnerAlive,
  readRunnerPid,
  clearRunnerPid,
  setMetaStatus,
  generateRalphArtifacts,
  spawnRunnerDetached,
  RALPH_DEFAULT_MAX_ITER,
} from "../../zapsdk/supertask/index.js"

const SUPERTASK_RUNNER_TERM_TIMEOUT_MS = 1000
const SUPERTASK_RUNNER_TERM_POLL_MS = 50

type AddLog = (
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  images?: UserImageRef[],
  agentPath?: string[],
  extra?: Partial<LogEntry>,
) => void

type RestorableUserEntry = {
  type: string
  text: string
  restore?: boolean
  restoreText?: string
}

export type DialogId =
  | "connect"
  | "model"
  | "mode"
  | "effort"
  | "sessions"
  | "queue"
  | "mem"
  | "permissions"
  | "rewind"
  | "recovery"
  | "status"
  | "supertask_watch"
  | null

export interface ToastOptions {
  variant?: "success" | "warning" | "error"
  duration?: number
}

export interface DispatchSlashCommandDeps {
  exit: () => void
  bumpTranscript: () => void
  setLogs: (logs: LogEntry[]) => void
  setTodos: (todos: Todo[]) => void
  todosRef: React.MutableRefObject<Todo[]>
  subagentTodosRef: React.MutableRefObject<Map<string, Todo[]>>
  checkpointRef: React.MutableRefObject<CheckpointManager>
  turnStartLogIndexRef: React.MutableRefObject<number>
  setDialog: (id: DialogId) => void
  addLog: AddLog
  configRef: React.MutableRefObject<AppConfig>
  updateConfig: (next: AppConfig) => void
  addToast: (text: string, options?: ToastOptions) => void
  /** Current in-memory transcript. Used by /copy-input to copy the latest
   *  restorable user turn, including long-paste restoreText. */
  getLogs?: () => readonly RestorableUserEntry[]
  /** Fallback persisted transcript for /copy-input after compaction replaces
   *  the in-memory transcript with a compact marker. */
  getSessionLogs?: () => readonly RestorableUserEntry[]
  /** Test seam for clipboard writes. Defaults to the platform clipboard command. */
  copyToClipboard?: (text: string) => boolean
  compactLogs: (summary: string, before: number, after: number, files: string[]) => void
  agentRef: React.MutableRefObject<AgentObjects>
  skillsRef: React.MutableRefObject<Map<string, SkillDefinition>>
  dispatchUserTurn: (
    text: string,
    systemPrompt?: string,
    images?: import("../../zapsdk/core/types.js").ImageContent[],
    displayText?: string,
    silent?: boolean,
    restoreText?: string,
    memoryQueryText?: string,
  ) => Promise<unknown>
  /** Returns the current next-prompt estimate used by the shared context
   * meter. Provider usage calibrates it after every successful request. */
  getContextTokens: () => number
  /** Clears App-owned runtime diagnostics (context token counters, cache
   *  usage history, memory/compact failures). Reset commands clear the
   *  conversation/logs here, but those diagnostics live in useAgentRunner. */
  onResetRuntimeState?: () => void
  /** Direct setter for the App-level agent status so non-agent commands
   *  (currently /compact) can drive the LiveActivity spinner during long
   *  synchronous LLM calls. Pre-turn auto-compact already does this from
   *  useAgentRunner.ts; in-loop compact gets it via the autocompact_start
   *  event handler. Manual /compact was the missing third path. */
  setStatus: (s: string) => void
  /** Records or clears the latest compact failure for /status diagnostics. */
  onCompactFailure?: (failure: {
    phase: "pre_turn" | "in_loop" | "manual"
    error: string
    consecutiveFailures?: number
    breakerTripped?: boolean
  } | undefined) => void
  /** Records latest memory operation failure for /status diagnostics. */
  onMemoryFailure?: (failure: MemoryFailureDiagnostic | undefined) => void
  /** Refreshes the shared context meter after commands mutate conversation
   * history outside the normal agent event stream (currently /compact). */
  onContextChanged?: () => void
  /** Bind manual compaction to the AbortController used by Esc/Ctrl+C. */
  beginManualCompact?: () => AbortController
  /** Release the controller only when this operation still owns it. */
  endManualCompact?: (controller: AbortController) => void
  /** Test override for compact-summary memory persistence. Defaults to the SDK implementation. */
  persistCompactSummary?: PersistCompactSummary
}

export interface SlashCommandDispatchMeta {
  /** Compact placeholder-bearing command text as typed/displayed. */
  displayText?: string
  /** Expanded command text for replay/copy when displayText contains paste placeholders. */
  restoreText?: string
  /** Queue delivery must require a canonical receipt for agent-backed commands. */
  onInputRequired?: () => void
  onRunResult?: (result: unknown) => void
}

export interface GracefulTerminateOptions {
  timeoutMs?: number
  pollMs?: number
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean
  sleep?: (ms: number) => Promise<void>
}

export async function terminateProcessGracefully(
  pid: number,
  options: GracefulTerminateOptions = {},
): Promise<void> {
  const kill = options.kill ?? process.kill
  try { kill(pid, "SIGTERM") } catch { return }
  await waitForProcessExit(pid, options)
}

async function waitForProcessExit(
  pid: number,
  options: GracefulTerminateOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SUPERTASK_RUNNER_TERM_TIMEOUT_MS
  const pollMs = options.pollMs ?? SUPERTASK_RUNNER_TERM_POLL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const kill = options.kill ?? process.kill
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { kill(pid, 0) } catch { return }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  }
}

/** /connect not run yet → block agent dispatch with a friendly message
 *  instead of letting AnthropicProvider/OpenAI throw on empty creds. */
function precheckProvider(deps: Pick<DispatchSlashCommandDeps, "addLog" | "configRef">): boolean {
  const err = validateConfig(deps.configRef.current)
  if (err) {
    deps.addLog("system", err)
    return false
  }
  return true
}

export function latestUserInputText(logs: readonly RestorableUserEntry[]): string {
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i]
    if (log.type !== "user") continue
    if (isCopyInputCommand(log.text) && log.restoreText === undefined) continue
    // Display-only command rows are skipped unless they carry restoreText.
    // Slash/MCP turns with long-paste placeholders are intentionally marked
    // restore:false so session replay will not re-run the command, but
    // /copy-input still needs their full user-authored text.
    if (log.restore === false && log.restoreText === undefined) continue
    return log.restoreText ?? log.text
  }
  return ""
}

function isCopyInputCommand(text: string): boolean {
  const trimmed = text.trim()
  return /^\/(?:copy-input|copyinput)(?:\s|$)/.test(trimmed)
}

function writeClipboard(text: string, deps: Pick<DispatchSlashCommandDeps, "copyToClipboard">): boolean {
  if (deps.copyToClipboard) return deps.copyToClipboard(text)
  const clipCmd =
    process.platform === "darwin" ? "pbcopy"
    : process.platform === "win32" ? "clip"
    : "xclip"
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : []
  const r = spawnSync(clipCmd, args, { input: text })
  return r.status === 0
}

function wipeTerminalScrollback(): void {
  if (process.stdout.isTTY) {
    // \x1b[H = move cursor home; [2J = clear visible viewport; [3J = clear
    // scrollback buffer. The three together emulate a fresh terminal boot
    // before React state changes flow through Ink's renderer.
    process.stdout.write("\x1b[H\x1b[2J\x1b[3J")
  }
}

function resumeSupertaskRunner(
  cwd: string,
  ref: NonNullable<ReturnType<typeof findResumable>>,
  deps: Pick<DispatchSlashCommandDeps, "addLog">,
): void {
  const priorStatus = ref.meta.status
  // Stale pid file is normal after a crash / reboot — wipe it before
  // respawning so the new process gets a clean slot.
  clearRunnerPid(ref.dir)
  // Flip status back to "running" before the spawn so /supertask status,
  // watch, and findResumable all see the correct in-flight state. The
  // runner only sets terminal statuses (done/aborted/blocked/max_iter);
  // without this flip a resume of a blocked task would keep meta.status
  // showing "blocked" while the runner is actively iterating.
  try { setMetaStatus(ref.dir, "running") } catch { /* meta gone — let spawn fail loudly */ }
  try {
    // Regenerate artifacts — the zap binary path may have moved since
    // last run (different terminal, different install), and the briefings
    // are cheap to rewrite.
    const artifacts = generateRalphArtifacts({
      stateDir: ref.dir,
      projectDir: cwd,
      desc: ref.meta.desc,
    })
    const spawned = spawnRunnerDetached(artifacts)
    const iter = readIter(ref.dir)
    deps.addLog(
      "system",
      [
        `🧭 Supertask resumed: ${ref.id}`,
        `   desc:      ${ref.meta.desc}`,
        `   from:      iter ${iter} · prior status "${priorStatus}"`,
        `   runner:    pid ${spawned.pid}`,
        `   log:       tail -f ${artifacts.logPath}`,
      ].join("\n"),
    )
  } catch (err) {
    deps.addLog("error", `Failed to respawn supertask runner: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Dispatch a typed-in slash command. Built-in commands (clear/exit/copy/etc.)
 * run synchronously; agent-backed ones (review/commit/init/skills) dispatch
 * through the agent loop with a custom system prompt.
 *
 * Returns true (or a Promise resolving true for awaited local operations)
 * when the input was recognized as a command, even if it had no effect.
 * Returns false when parseCommand couldn't make sense of the input — caller
 * should treat that as plain user text.
 */
export function dispatchSlashCommand(
  input: string,
  deps: DispatchSlashCommandDeps,
  meta: SlashCommandDispatchMeta = {},
): boolean | Promise<boolean> {
  const cmd = parseCommand(input)
  if (!cmd) return false
  const displayCommand = meta.displayText ? parseCommand(meta.displayText) : null

  const dispatchAgentTurn = (...args: Parameters<DispatchSlashCommandDeps["dispatchUserTurn"]>): boolean | Promise<boolean> => {
    meta.onInputRequired?.()
    if (!precheckProvider(deps)) return true
    return deps.dispatchUserTurn(...args).then(result => {
      meta.onRunResult?.(result)
      return true
    })
  }

  const resetConversationState = () => {
    conversation.clear()
    deps.setLogs([])
    deps.todosRef.current = []
    deps.setTodos([])
    deps.subagentTodosRef.current.clear()
    deps.turnStartLogIndexRef.current = 0
    clearQueue()
    clearSystemInbox()
    deps.onResetRuntimeState?.()
  }

  switch (cmd.type) {
    case "exit":
      deps.exit()
      return true

    case "clear": {
      // Wipe everything to a fresh-boot state. Sequence matters: write the
      // ANSI wipe BEFORE the React state changes so it lands before Ink's
      // next render. Ink's log-update will issue eraseLines(N) for the
      // previous dynamic frame on its next render, but with the cursor at
      // top-left those erases just no-op against blank rows.
      wipeTerminalScrollback()
      resetConversationState()
      deps.bumpTranscript()
      return true
    }

    case "new_session": {
      // Same visual + logical reset as /clear, plus a brand-new session:
      // new JSONL writer + sessionId. The existing CheckpointManager
      // rebinds to the new sessionId so its writeJsonlEntry + config
      // wiring from App.tsx stays in effect. Snapshots from the prior
      // session linger in memory under the old id (harmless — listSnapshots
      // filters by the current id and won't surface them), but newly
      // committed snapshots all label + persist under the new id.
      wipeTerminalScrollback()
      startNewSession()
      resetConversationState()
      deps.checkpointRef.current.setSessionId(getCurrentSessionId())
      deps.bumpTranscript()
      return true
    }

    case "open_connect":     deps.setDialog("connect");     return true
    case "open_model_picker":deps.setDialog("model");       return true
    case "open_mode_picker": deps.setDialog("mode");        return true
    case "open_sessions":    deps.setDialog("sessions");    return true
    case "open_queue":       deps.setDialog("queue");       return true
    case "open_mem":         deps.setDialog("mem");         return true
    case "show_permissions": deps.setDialog("permissions"); return true
    case "open_rewind":      deps.setDialog("rewind");      return true
    case "open_recovery":    deps.setDialog("recovery");    return true

    case "open_mcp": {
      // Async dispatch — fire-and-forget. The handler writes its own
      // addLog output for every code path.
      const arg = cmd.value ?? ""
      void dispatchMCPCommand(arg, { addLog: deps.addLog as never })
      return true
    }

    case "open_serper":
      deps.addLog(
        "system",
        "Set Serper key by editing serperKey in ~/.zapcode/config.json.",
      )
      return true

    case "set_model": {
      const next = {
        ...deps.configRef.current,
        active: { ...deps.configRef.current.active, model: cmd.value ?? "" },
      }
      deps.updateConfig(next)
      deps.addToast(`model → ${cmd.value}`)
      return true
    }

    case "set_permission_mode": {
      const v = (cmd.value ?? "default") as PermissionMode
      deps.updateConfig({ ...deps.configRef.current, permissionMode: v })
      deps.addToast(`mode → ${v}`)
      return true
    }

    case "set_effort": {
      const provider = getActiveProvider(deps.configRef.current)
      if (!provider) {
        deps.addLog("error", "No active provider")
        return true
      }
      const value = cmd.value ?? ""
      if (!value) {
        deps.setDialog("effort")
        return true
      }
      if (value === "cycle") {
        const nextValue = cycleEffort(deps.configRef.current, provider.id)
        deps.updateConfig(setEffort(deps.configRef.current, provider.id, nextValue))
        deps.addToast(`effort → ${nextValue ?? "off"}`)
        return true
      }
      if (value === "off") {
        deps.updateConfig(setEffort(deps.configRef.current, provider.id, null))
        deps.addToast("effort off")
        return true
      }
      const resolved = resolveEffortInput(deps.configRef.current, provider.id, value)
      if (!resolved.ok) {
        deps.addToast(resolved.message, { variant: "warning" })
        return true
      }
      deps.updateConfig(setEffort(deps.configRef.current, provider.id, resolved.value))
      deps.addToast(`effort → ${resolved.value}`)
      return true
    }

    case "copy": {
      try {
        const text = existsSync(lastOutputPath) ? readFileSync(lastOutputPath, "utf-8") : ""
        if (!text) {
          deps.addToast("Nothing to copy", { variant: "warning" })
          return true
        }
        if (writeClipboard(text, deps)) deps.addToast("Copied to clipboard", { variant: "success" })
        else deps.addToast("Copy failed (clipboard tool not available?)", { variant: "error" })
      } catch (e) {
        deps.addToast(`Copy failed: ${e instanceof Error ? e.message : e}`, { variant: "error" })
      }
      return true
    }

    case "copy_input": {
      try {
        const memoryText = latestUserInputText(deps.getLogs?.() ?? [])
        const text = memoryText || latestUserInputText(
          deps.getSessionLogs?.() ?? readCurrentSessionLogs(),
        )
        if (!text) {
          deps.addToast("No user input to copy", { variant: "warning" })
          return true
        }
        if (writeClipboard(text, deps)) deps.addToast("Copied last input to clipboard", { variant: "success" })
        else deps.addToast("Copy failed (clipboard tool not available?)", { variant: "error" })
      } catch (e) {
        deps.addToast(`Copy failed: ${e instanceof Error ? e.message : e}`, { variant: "error" })
      }
      return true
    }

    case "show_status": {
      // Open the dropdown-style status popup. Earlier behaviour dumped the
      // status text into the transcript as a system log; now it lives in
      // a dismissable Esc-to-close panel that doesn't litter scrollback.
      deps.setDialog("status")
      return true
    }

    case "compact_session": {
      // Force-compact the conversation. Uses the current agent's provider as
      // summarizer (agent.run not needed — this is a one-shot LLM call via
      // conversation.compress).
      return (async () => {
        const controller = deps.beginManualCompact?.() ?? new AbortController()
        // Mirror the in-loop autocompact_start log so manual /compact also
        // signals "this is going to take a few seconds" up front. compactLogs
        // below will replace the log array post-success anyway; the row's
        // job is to bridge the 3-10s wait.
        const ctxTokens = conversation.estimatedTokens
        deps.addLog("system", `🗜 Compacting context — ~${Math.round(ctxTokens / 1000)}k tokens (manual)`)
        // Flip the App-level status so LiveActivity renders its spinner +
        // "Compacting" label during the 3-10s LLM summary call. Without
        // this, the manual path had a start log but no live indicator,
        // making the UI look frozen. Reset to "ready" in finally so we
        // never leave the bar spinning if compress throws.
        deps.setStatus("compacting")
        try {
          // Capture pre-compact messages BEFORE compress so the post-compact
          // file-restoration walk has access to the original read_file tool
          // calls. Same pattern as the pre-turn and in-loop paths — keeps the
          // three compact entry points behaviourally consistent. Use the full
          // backing view because getMessages() may already be truncated when
          // manual compaction is invoked.
          const preMessages = conversation.getAllMessages()
          const preTurnCount = conversation.getTurns().filter(turn => turn.kind !== "system").length
          const meter = new RequestMeter(new AgentBudget({ maxSteps: 2 }), {}, usage => {
            try { recordMaintenanceUsage(usage) }
            catch (error) { deps.addToast(`Usage history could not be saved: ${String(error)}`, { variant: "error" }) }
          })
          const result = await conversation.compress(meter.wrap(deps.agentRef.current.provider, "maintenance"), {
            force: true,
            signal: controller.signal,
          })
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("Compact cancelled")
          }
          const limits = resolveActiveContextLimits(deps.configRef.current)
          const thresholds = {
            triggerAt: limits.compactAt,
            keepFloorTokens: limits.keepFloorTokens,
            reserveForOutput: limits.reservedOutputTokens,
          }
          const failureReason = manualCompactFailureReason(result, {
            messageCountBefore: preMessages.length,
            turnCountBefore: preTurnCount,
            contextTokensBefore: deps.getContextTokens(),
            triggerAtTokens: thresholds.triggerAt,
            failureReason: conversation.lastCompressionFailureReason,
          })
          if (failureReason) {
            deps.onCompactFailure?.({ phase: "manual", error: failureReason })
            deps.addToast(`Compact failed: ${failureReason}`, { variant: "error" })
          } else if (result) {
            const restored = await restoreRecentFiles(preMessages, { maxTokens: Math.min(2048, Math.max(0, thresholds.keepFloorTokens - conversation.estimatedTokens)) })
            if (restored) {
              conversation.commitTurn({ kind: "user", content: restored })
            }
            // Persist durable sections (decisions / errors / files) so they
            // survive compact-of-compact decay. Fire-and-forget.
            persistCompactSummaryBestEffort(result.summary, autoMemory, {
              onMemoryFailure: deps.onMemoryFailure,
              persist: deps.persistCompactSummary,
            })
            deps.compactLogs(result.summary, result.before, result.after, extractFilesFromSummary(result.summary))
            deps.onContextChanged?.()
            deps.onCompactFailure?.(undefined)
            deps.addToast(`Compacted ${result.before}→${result.after} msgs`, { variant: "success" })
          } else {
            deps.onCompactFailure?.(undefined)
            deps.addToast("Nothing to compact", { variant: "warning" })
          }
        } catch (e) {
          if (controller.signal.aborted) {
            deps.onCompactFailure?.(undefined)
            deps.addToast("Compact cancelled", { variant: "warning" })
            return true
          }
          const error = e instanceof Error ? e.message : String(e)
          deps.onCompactFailure?.({ phase: "manual", error })
          deps.addToast(
            `Compact failed: ${error}`,
            { variant: "error" },
          )
        } finally {
          deps.endManualCompact?.(controller)
          // Always restore status so the spinner clears whether compress
          // succeeded, returned null ("nothing to compact"), or threw.
          deps.setStatus("ready")
        }
        return true
      })()
    }

    case "clear_todos": {
      deps.todosRef.current = []
      deps.setTodos([])
      deps.addToast("Todos cleared")
      return true
    }

    case "review": {
      return dispatchAgentTurn(`Review the code at: ${cmd.value ?? "."}`, REVIEW_PROMPT)
    }

    case "commit": {
      return dispatchAgentTurn("Stage changes and create a conventional commit.", COMMIT_PROMPT)
    }

    case "init_project": {
      return dispatchAgentTurn("Analyze this project and write AGENTS.md.", INIT_PROJECT_PROMPT)
    }

    case "supertask": {
      if (!precheckProvider(deps)) return true
      const cwd = process.cwd()
      const existing = findResumable(cwd)
      if (existing) {
        // Don't silently overwrite — surface the conflict and let the user
        // pick. "Existing" here includes blocked / max_iter / failed runs;
        // those carry real work on disk that the user almost certainly
        // wants to either resume or explicitly abort, not silently orphan.
        const alive = isRunnerAlive(existing.dir)
        const iter = readIter(existing.dir)
        const pid = readRunnerPid(existing.dir)
        const status = existing.meta.status
        const hint = alive
          ? `Loop is still running. Use /supertask watch to peek, or /supertask abort to stop it before starting a new one.`
          : (status === "blocked" || status === "max_iter" || status === "failed")
            ? `Loop stopped with status "${status}". /supertask resume picks up where it left off; /supertask abort discards the state.`
            : `Loop is not running. Either /supertask resume to continue it, or /supertask abort to discard it.`
        deps.addLog(
          "system",
          [
            `Existing supertask in this dir: ${existing.id}`,
            `  desc:   ${existing.meta.desc}`,
            `  status: ${status}${alive ? "" : " · runner not running"}`,
            `  iter:   ${iter}/${RALPH_DEFAULT_MAX_ITER}`,
            `  runner: ${alive ? `alive (pid ${pid})` : "not running"}`,
            `  state:  ${existing.dir}`,
            ``,
            hint,
          ].join("\n"),
        )
        return true
      }
      const ref = createSupertask(cwd, cmd.value ?? "")
      try {
        const artifacts = generateRalphArtifacts({
          stateDir: ref.dir,
          projectDir: cwd,
          desc: ref.meta.desc,
          maxIter: cmd.maxIter,
          maxTurnsPerIter: cmd.maxTurns,
        })
        const spawned = spawnRunnerDetached(artifacts)
        const limitsLine = (cmd.maxIter || cmd.maxTurns)
          ? `   limits:  max-iter ${artifacts.maxIter} · max-turns ${artifacts.maxTurnsPerIter}`
          : null
        deps.addLog(
          "system",
          [
            `🧭 Supertask started: ${ref.id}`,
            `   desc:    ${ref.meta.desc}`,
            ...(limitsLine ? [limitsLine] : []),
            `   runner:  pid ${spawned.pid} (detached, survives /exit)`,
            `   log:     tail -f ${artifacts.logPath}`,
            `   status:  /supertask status`,
            `   abort:   /supertask abort`,
          ].join("\n"),
        )
      } catch (err) {
        // Cleanup partial state if we couldn't even spawn — avoids a
        // ghost "unfinished" supertask that blocks future /supertask calls.
        abortSupertask(cwd, ref.id)
        deps.addLog("error", `Failed to spawn supertask runner: ${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    }

    case "supertask_resume": {
      if (!precheckProvider(deps)) return true
      const cwd = process.cwd()
      const force = cmd.value === "force"
      const ref = findResumable(cwd)
      if (!ref) {
        deps.addLog("system", "No resumable supertask in this working directory.")
        return true
      }
      const alivePid = readRunnerPid(ref.dir)
      const alive = isRunnerAlive(ref.dir)
      if (alive && !force) {
        // Detached runner survived your terminal close — by design. Tell
        // the user concretely what they CAN do instead of just refusing.
        // (Previously the message only mentioned watch, leading to "I
        // exited the terminal, why can't I resume?" confusion.)
        const iter = readIter(ref.dir)
        deps.addLog(
          "system",
          [
            `Runner is already alive (pid ${alivePid}) — iter ${iter}/${RALPH_DEFAULT_MAX_ITER}.`,
            `Detached runners survive terminal exit on purpose; you don't need to resume.`,
            ``,
            `  /supertask watch         — live view of progress`,
            `  /supertask abort         — stop the runner and discard state`,
            `  /supertask resume force  — kill the current runner and respawn fresh`,
          ].join("\n"),
        )
        return true
      }
      if (alive && force && alivePid !== null) {
        void (async () => {
          await terminateProcessGracefully(alivePid)
          deps.addLog("system", `Killed runner pid ${alivePid} (force resume). Respawning…`)
          resumeSupertaskRunner(cwd, ref, deps)
        })()
        return true
      }
      resumeSupertaskRunner(cwd, ref, deps)
      return true
    }

    case "supertask_abort": {
      const cwd = process.cwd()
      const ref = findResumable(cwd)
      if (!ref) {
        deps.addLog("system", "No supertask to abort in this working directory.")
        return true
      }
      const pid = readRunnerPid(ref.dir)
      const alive = isRunnerAlive(ref.dir)
      if (cmd.value !== "confirm") {
        const iter = readIter(ref.dir)
        deps.addLog(
          "system",
          [
            `About to abort supertask ${ref.id}:`,
            `  desc:   ${ref.meta.desc}`,
            `  iter:   ${iter}/${RALPH_DEFAULT_MAX_ITER}`,
            `  runner: ${alive ? `alive (pid ${pid}) — will be killed` : "not running"}`,
            `  state:  ${ref.dir}`,
            ``,
            `Type "/supertask abort confirm" to kill the runner (if alive) and delete the state directory.`,
          ].join("\n"),
        )
        return true
      }
      if (alive && pid !== null) {
        void (async () => {
          await terminateProcessGracefully(pid)
          abortSupertask(cwd, ref.id)
          deps.todosRef.current = []
          deps.setTodos([])
          deps.addToast(`Supertask ${ref.id} aborted`, { variant: "warning" })
        })()
        return true
      }
      abortSupertask(cwd, ref.id)
      deps.todosRef.current = []
      deps.setTodos([])
      deps.addToast(`Supertask ${ref.id} aborted`, { variant: "warning" })
      return true
    }

    case "supertask_watch": {
      // Watch shows the MOST RECENT supertask regardless of status — a
      // blocked / done / max_iter run is often exactly what the user
      // wants to inspect (Why did it stop? What got committed?). Only
      // bail if there's literally no supertask history in this cwd.
      const cwd = process.cwd()
      const refs = listSupertasks(cwd)
      if (refs.length === 0) {
        deps.addLog("system", "No supertask history in this working directory.")
        return true
      }
      deps.setDialog("supertask_watch")
      return true
    }

    case "supertask_status": {
      const cwd = process.cwd()
      const ref = findResumable(cwd)
      if (!ref) {
        deps.addLog("system", "No active supertask in this working directory.")
        return true
      }
      const meta = readMeta(ref.dir)
      const prd = readPrd(ref.dir)
      const iter = readIter(ref.dir)
      const alive = isRunnerAlive(ref.dir)
      const pid = readRunnerPid(ref.dir)
      const lines: string[] = [
        `Supertask ${ref.id}`,
        `  desc:    ${meta.desc}`,
        `  status:  ${meta.status} · iter ${iter}/${RALPH_DEFAULT_MAX_ITER}`,
        `  runner:  ${alive ? `alive (pid ${pid})` : pid ? `dead (stale pid ${pid})` : "not running"}`,
      ]
      if (prd) {
        const s = prdSummary(prd)
        lines.push(`  stories: ${s.passed}/${s.total} passed (${s.remaining} remaining)`)
        if (s.next) lines.push(`  next:    ${s.next.id} — ${s.next.title}`)
      } else {
        lines.push(`  stories: (prd.json not written yet — planner still running)`)
      }
      lines.push(`  state:   ${ref.dir}`)
      lines.push(`  log:     ${ref.dir}/runner.log`)
      deps.addLog("system", lines.join("\n"))
      return true
    }

    case "run_skill": {
      const skillName = cmd.skill ?? ""
      const skill = deps.skillsRef.current.get(skillName)
      if (!skill) {
        deps.addLog("system", `Unknown command: /${skillName}`)
        return true
      }
      // Substitute {{param}} placeholders in the skill's systemPrompt with
      // whatever the user typed after the skill name. Single-arg skills get
      // the whole tail bound to the first parameter.
      const rawTail = runSkillTailFromRawCommand(input, skillName)
      const tail = rawTail !== undefined && rawTail.trim().length > 0
        ? rawTail
        : (cmd.skillInput ?? "").trim()
      const params = skill.parameters ?? []
      let prompt = skill.systemPrompt
      if (params.length === 1 && params[0])
        prompt = prompt.replaceAll(`{{${params[0].name}}}`, tail)
      const displayTail = displayCommand?.type === "run_skill" && displayCommand.skill === skillName
        ? runSkillTailFromRawCommand(meta.displayText ?? "", skillName) ?? (displayCommand.skillInput ?? "").trim()
        : undefined
      const restoreTail = typeof meta.restoreText === "string"
        ? runSkillTailFromRawCommand(meta.restoreText, skillName) ?? (parseCommand(meta.restoreText)?.skillInput ?? "").trim()
        : undefined
      const displayText = displayTail && displayTail !== tail ? displayTail : undefined
      const restoreText = displayText && restoreTail ? restoreTail : undefined
      return dispatchAgentTurn(
        tail || `Run skill: ${skillName}`,
        prompt,
        undefined,
        displayText,
        false,
        restoreText,
        displayText,
      )
    }

    case "output":
      if (cmd.text) deps.addLog("system", cmd.text)
      return true
  }

  return false
}

function runSkillTailFromRawCommand(input: string, skillName: string): string | undefined {
  const parsed = parseCommand(input)
  if (parsed?.type !== "run_skill" || parsed.skill !== skillName) return undefined
  const match = /^\/\S+([\s\S]*)$/u.exec(input)
  if (!match) return undefined
  const suffix = match[1] ?? ""
  if (!suffix) return ""
  return /^\s/u.test(suffix) ? suffix.slice(1) : suffix
}

/** Re-exported for callers that want to gate a dispatch on provider readiness
 *  without going through the full dispatcher (e.g. handleSubmit pre-check). */
export function isProviderReady(
  configRef: React.MutableRefObject<AppConfig>,
  addLog: AddLog,
): boolean {
  return precheckProvider({ configRef, addLog })
}

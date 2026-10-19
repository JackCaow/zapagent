import { useState, useCallback, useRef } from "react"
import type { LogEntry, LogType, ToolCallInfo, UserImageRef } from "../ui/types.js"
import { appendLog as journalAppend, replaceLog as journalReplace } from "../session.js"

let logId = 0

function replaceEntry(
  log: LogEntry,
  id: number,
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  agentPath?: string[],
  extra?: Pick<LogEntry, "pending">,
): LogEntry {
  return log.id === id ? { ...log, ...extra, type, text, tool, agentPath } : log
}

export function useLogs() {
  const [logs, setLogsState] = useState<LogEntry[]>([])
  // Synchronous mirror used for pre-turn checkpoint boundaries. React state
  // may batch many streaming appends before rendering; reading `logs.length`
  // from the last render would therefore under-count the transcript.
  const logsRef = useRef<LogEntry[]>([])
  const logIdRef = useRef(logId)
  // Map UI logId → JSONL logIndex for replaceLog
  const logIndexMap = useRef(new Map<number, number>())
  // Static-commit freeze. While `frozenRef.current === true`, addLog buffers
  // entries here instead of calling setLogs. Releasing the freeze (via
  // setFrozen(false)) drains the buffer in one setLogs call.
  //
  // Why: ApprovalBar / PlanApprovalBar live in the dynamic frame. Every
  // Static commit while they are up triggers Ink's incremental
  // log.clear() → static write → re-draw path, which pushes overlay
  // content into terminal scrollback permanently — Ink's eraseLines can
  // never reclaim scrollback. Freezing log appends until the user
  // dismisses the overlay removes that pressure entirely; the post-dismiss
  // flush is a single big commit on a clean viewport.
  //
  // JSONL journal writes still happen synchronously so a crash mid-dialog
  // doesn't lose the in-flight tool output — only the UI commit is held.
  const frozenRef = useRef(false)
  const pendingBufferRef = useRef<LogEntry[]>([])
  const onFlushCallbackRef = useRef<(() => void) | null>(null)

  const addLog = useCallback((
    type: LogType,
    text: string,
    tool?: ToolCallInfo,
    images?: UserImageRef[],
    agentPath?: string[],
    // Mostly UI-only metadata (e.g. thinkingMs). Restore hints are persisted:
    // restore:false skips display-only rows; restoreText replays compact rows
    // with their full model-facing content.
    extra?: Partial<LogEntry>,
  ) => {
    const id = logId++
    logIdRef.current = logId
    // Append to JSONL journal and track the index
    const journalIdx = journalAppend(type, text, tool, images, agentPath, {
      restore: extra?.restore,
      restoreText: extra?.restoreText,
    })
    if (journalIdx !== null) logIndexMap.current.set(id, journalIdx)
    const entry: LogEntry = { type, text, id, tool, images, agentPath, ...extra }
    if (frozenRef.current) {
      pendingBufferRef.current.push(entry)
      return
    }
    logsRef.current = [...logsRef.current, entry]
    setLogsState(logsRef.current)
  }, [])

  /** Pause / resume Static commits. Pass true before mounting a tall
   *  dynamic-frame dialog (ApprovalBar, PlanApprovalBar). Pass false on
   *  dismiss — buffered entries flush in one setLogs call. */
  const setStaticCommitFrozen = useCallback((frozen: boolean) => {
    if (frozenRef.current === frozen) return
    frozenRef.current = frozen
    if (!frozen && pendingBufferRef.current.length > 0) {
      // Order matters: the flush callback (used by streamingPreview to clear
      // its held streamingText state) fires *before* setLogs commits the
      // buffered entries. Both calls land in the same React 18 auto-batch,
      // so the streamingText clear and the new log rows render in a single
      // frame — without batching, the user would see a brief flash where
      // the streaming tail is gone but the buffered rows haven't yet
      // appeared in Static. Don't break this ordering without also moving
      // streamingText clearing into a different lifecycle hook.
      onFlushCallbackRef.current?.()
      const buffered = pendingBufferRef.current
      pendingBufferRef.current = []
      logsRef.current = [...logsRef.current, ...buffered]
      setLogsState(logsRef.current)
    }
  }, [])

  const registerStaticFlushCallback = useCallback((cb: (() => void) | null) => {
    onFlushCallbackRef.current = cb
  }, [])

  const replaceLog = useCallback((id: number, type: LogType, text: string, tool?: ToolCallInfo, agentPath?: string[], extra?: Pick<LogEntry, "pending">) => {
    // JSONL and in-memory state both treat the `agentPath` argument as
    // authoritative (no silent fallback to the prior value). Callers must
    // pass the full path every time they want it preserved — undefined
    // wipes it on both sides. Keeps the two write paths in lockstep so a
    // reloaded session matches what the live UI renders.
    const journalIdx = logIndexMap.current.get(id)
    if (journalIdx !== undefined) {
      journalReplace(journalIdx, type, text, tool, agentPath)
    }
    // A tool can start or finish while an approval dialog has frozen Static
    // commits. In that state its freshly-added parent row lives in the buffer,
    // not React state, so updating only `logs` loses subagent metadata and
    // leaves a genuinely running agent displayed as queued after the flush.
    pendingBufferRef.current = pendingBufferRef.current.map(log => (
      replaceEntry(log, id, type, text, tool, agentPath, extra)
    ))
    logsRef.current = logsRef.current.map(log => replaceEntry(log, id, type, text, tool, agentPath, extra))
    setLogsState(logsRef.current)
  }, [])

  /** Returns the id that the next addLog call will assign (does not increment). */
  const peekNextLogId = () => logId

  const getUiLogCount = useCallback(
    () => logsRef.current.length + pendingBufferRef.current.length,
    [],
  )

  const setLogs = useCallback((next: LogEntry[]) => {
    logsRef.current = next
    pendingBufferRef.current = []
    setLogsState(next)
  }, [])

  /** Allocates n sequential ids and returns the starting id. Keeps logId in sync. */
  const allocateLogIds = (n: number): number => {
    const start = logId
    logId += n
    logIdRef.current = logId
    return start
  }

  /** Replace the entire log list with a single "compacted" entry.
   *  JSONL is intentionally NOT touched — full history remains on disk,
   *  so /load can still replay. Old in-memory log ids are abandoned. */
  const compactLogs = useCallback((
    summary: string,
    before: number,
    after: number,
    files: string[],
  ): void => {
    const id = logId++
    logIdRef.current = logId
    const next = [{
      type: "compacted",
      text: "",
      id,
      compacted: { summary, before, after, files },
    } satisfies LogEntry]
    logsRef.current = next
    pendingBufferRef.current = []
    setLogsState(next)
    logIndexMap.current.clear()
  }, [])

  const getIsFrozen = useCallback(() => frozenRef.current, [])

  return { logs, setLogs, addLog, replaceLog, peekNextLogId, getUiLogCount, allocateLogIds, compactLogs, setStaticCommitFrozen, getIsFrozen, registerStaticFlushCallback }
}

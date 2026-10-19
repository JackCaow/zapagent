/** @jsxImportSource react */
// /sessions — pick a saved session and load it into the current UI.
// Loading replaces in-memory logs AND repopulates the agent's
// ConversationManager (via `sessionLogsToMessages`), so the next turn
// the model sees the prior transcript as context — no more "what app?"
// amnesia after restoring a session. The Turn-based rebuild guarantees
// tool_use ↔ tool_result pairing even if some tool_results are missing
// in the JSONL (synthesized as failure ToolResults).
import { useEffect, useRef, useState } from "react"
import {
  getCurrentSessionId,
  listSavedSessionsPage,
  prepareSavedSession,
  sessionLogConsumesJournalIndex,
  sessionLogsToMessages,
  setActiveSession,
} from "../session.js"
import type { PreparedSessionRestore, SessionInfo, SessionLog } from "../session.js"
import type { Message } from "../../zapsdk/core/types.js"
import { PickerDialog, type PickerOption } from "./dialog-picker.js"
import type { LogEntry, LogType } from "./types.js"

interface Props {
  onLoad: (loaded: DialogSessionRestore) => void
  onCancel: () => void
}

export interface DialogSessionRestore extends PreparedSessionRestore {
  logs: LogEntry[]
  messages: Message[]
  loadedSessionId: string
}

export async function loadSessionForDialog(id: string): Promise<DialogSessionRestore> {
  const prepared = await prepareSavedSession(id)
  return {
    ...prepared,
    logs: toLogEntries(prepared.sessionLogs),
    messages: sessionLogsToMessages(prepared.sessionLogs),
    loadedSessionId: id,
  }
}

interface ConversationRestoreTarget {
  getAllMessages(): Message[]
  mutateInPlace<T>(fn: (messages: Message[]) => T): T
}

export function replaceConversationMessages(target: ConversationRestoreTarget, messages: Message[]): void {
  target.mutateInPlace(current => {
    current.splice(0, current.length, ...messages)
  })
}

/**
 * Commit the two canonical restore states together. Conversation is replaced
 * first because it is cheaply reversible; if the durable writer swap fails,
 * the previous conversation is restored before the error reaches the dialog.
 */
export function commitSessionForDialog(
  loaded: DialogSessionRestore,
  conversation: ConversationRestoreTarget,
  activate: typeof setActiveSession = setActiveSession,
): string {
  const previousMessages = conversation.getAllMessages()
  replaceConversationMessages(conversation, loaded.messages)
  try {
    activate(loaded.sessionLogs, {
      sourceSessionId: loaded.sourceSessionId,
      metadata: loaded.metadata,
    })
  } catch (error) {
    replaceConversationMessages(conversation, previousMessages)
    throw error
  }
  return getCurrentSessionId()
}

const SESSION_PAGE_SIZE = 50

export function SessionsDialog({ onLoad, onCancel }: Props) {
  const mountedRef = useRef(true)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [nextOffset, setNextOffset] = useState<number | null | undefined>(undefined)
  const [listError, setListError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    void listSavedSessionsPage({ limit: SESSION_PAGE_SIZE }).then(page => {
      if (cancelled) return
      setSessions(page.sessions)
      setNextOffset(page.nextOffset)
    }).catch(error => {
      if (cancelled) return
      setListError(error instanceof Error ? error.message : String(error))
      setNextOffset(null)
    })
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [])

  const busy = loadingSessionId !== null || loadingMore
  const sessionOptions: PickerOption[] = sessions.map(s => ({
    id: s.id,
    label: s.preview.slice(0, 60) || s.id,
    meta: loadingSessionId === s.id ? "loading…" : `${s.date} · ~${s.messageCount} msg`,
    disabled: busy,
  }))
  const options: PickerOption[] = []
  if (loadError) options.push({ id: "__load_error", label: loadError, disabled: true })
  if (listError) options.push({ id: "__list_error", label: listError, disabled: true })
  options.push(...sessionOptions)
  if (nextOffset === undefined) {
    options.push({ id: "__loading", label: "Loading sessions…", disabled: true })
  } else if (nextOffset !== null) {
    options.push({
      id: "__load_more",
      label: loadingMore ? "Loading older sessions…" : "Load older sessions…",
      disabled: busy,
    })
  } else if (sessions.length === 0 && !listError) {
    options.push({ id: "__none", label: "No saved sessions", disabled: true })
  }

  return (
    <PickerDialog
      title="Saved sessions"
      options={options}
      onCancel={onCancel}
      hint={busy ? "loading…  esc cancel" : "↑/↓ select  ⏎ load  esc cancel"}
      onSelect={(id) => {
        if (id === "__none") { onCancel(); return }
        if (id.startsWith("__") && id !== "__load_more") return
        if (busy) return
        if (id === "__load_more" && typeof nextOffset === "number") {
          setLoadingMore(true)
          setListError(null)
          void listSavedSessionsPage({ offset: nextOffset, limit: SESSION_PAGE_SIZE }).then(page => {
            if (!mountedRef.current) return
            setSessions(previous => {
              const seen = new Set(previous.map(session => session.id))
              return [...previous, ...page.sessions.filter(session => !seen.has(session.id))]
            })
            setNextOffset(page.nextOffset)
          }).catch(error => {
            if (!mountedRef.current) return
            setListError(error instanceof Error ? error.message : String(error))
          }).finally(() => {
            if (mountedRef.current) setLoadingMore(false)
          })
          return
        }

        setLoadingSessionId(id)
        setLoadError(null)
        void loadSessionForDialog(id).then(loaded => {
          if (mountedRef.current) onLoad(loaded)
        }).catch(err => {
          if (!mountedRef.current) return
          setLoadError(err instanceof Error ? err.message : String(err))
          setLoadingSessionId(null)
        })
      }}
    />
  )
}

let _restoreId = 0

function agentPathEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Merge consecutive `agent` entries from streaming chunks back into one
// LogEntry per assistant message. Live streaming writes one JSONL row per
// source-line chunk (text="line\n", "next\n", ..., "tail") with no
// `liveStreamed` flag persisted (UI-only). Without merging, a restored
// session would render N tiny AgentMessage rows with marginTop=1 each,
// stacking giant gaps between every line. With merging, the restored view
// looks identical to a non-streamed reply: one AgentMessage with full
// markdown reflow on the concatenated text.
//
// Conditions to merge into the previous entry:
//   - both type === "agent"
//   - neither has a `tool` (defensive — shouldn't happen for plain text)
//   - same agentPath (root agents have undefined; nested subagents must
//     match exactly so chunks from different subagents don't fuse)
function toLogEntries(logs: SessionLog[]): LogEntry[] {
  const out: LogEntry[] = []
  let journalIndex = 0
  for (const l of logs) {
    const journalStartIndex = journalIndex
    if (sessionLogConsumesJournalIndex(l.type)) journalIndex++
    const journalEndIndex = journalIndex
    const last = out[out.length - 1]
    if (
      l.type === "agent" &&
      !l.tool &&
      last?.type === "agent" &&
      !last.tool &&
      agentPathEqual(last.agentPath, l.agentPath)
    ) {
      last.text += l.text
      last.journalEndIndex = journalEndIndex
      continue
    }
    out.push({
      id: --_restoreId, // negative ids stay out of the way of the live counter
      type: l.type as LogType,
      text: l.text,
      tool: l.tool,
      images: l.images,
      restore: l.restore,
      restoreText: l.restoreText,
      agentPath: l.agentPath,
      journalStartIndex,
      journalEndIndex,
    })
  }
  return out
}

export interface UserImageRef {
  filePath: string
  source: string
  mediaType: string
}

export type LogType = "user" | "agent" | "tool" | "result" | "error" | "system" | "progress" | "thinking" | "divider" | "compacted" | "approval" | "task-notification"

export interface ToolCallInfo {
  /** LLM-provided tool_use id. Persisted so session restore can rebuild
   *  valid Message pairs (assistant.toolCalls[].id ↔ tool_result.toolCallId). */
  id?: string
  name: string
  arguments?: Record<string, unknown>
  output?: string
  success?: boolean
  /** Host provenance: this result is a duplicate notice, not a fresh tool read. */
  suppression?: "duplicate"
  /** Tool-specific metadata for UI rendering only — e.g. write_file/edit_file
   *  place a pre-computed DiffMeta here. Shape is per-tool; consumers cast. */
  meta?: unknown
}

export interface LogEntry {
  type: LogType
  text: string
  id: number
  /** UI-only: keep an in-flight status outside Ink Static until it settles. */
  pending?: boolean
  tool?: ToolCallInfo
  images?: UserImageRef[]
  /** Present only when type === "compacted". */
  compacted?: {
    summary: string
    before: number
    after: number
    files: string[]
  }
  /** Nesting path of subagent IDs. Empty/undefined for root-agent events;
   *  ["sa_xxx"] for a first-level subagent; deeper for nested subagents.
   *  Used by the UI to collapse each subagent's child tool calls under a
   *  single foldable parent block. */
  agentPath?: string[]
  /** false means the row is transcript display only and should not be replayed
   *  into restored model context. Used for slash command echoes whose
   *  agent-facing synthetic task is logged separately. */
  restore?: boolean
  /** Model-facing text to use when restoring this row into conversation
   *  context. Lets the transcript show compact paste placeholders while
   *  replay still sees the full expanded content. */
  restoreText?: string
  /** Elapsed milliseconds the model spent in its thinking pass. Set only on
   *  type==="thinking" entries; the transcript renderer uses it to show a
   *  one-line "thought for Xs" summary. UI-only — not persisted to JSONL. */
  thinkingMs?: number
  /** True when this entry is one source-line chunk emitted live during a
   *  streaming agent reply (one LogEntry per `\n`-terminated source line, or
   *  one final partial-tail entry without `\n`). Multiple consecutive chunks
   *  reconstruct the full agent message. AgentMessage renders them tightly
   *  stacked (no marginTop unless `firstOfStream`) and without a separate
   *  consolidated parent log — saves a Static-render cycle and prevents the
   *  visual "single tall message" from collapsing into a giant per-render
   *  diff target. UI-only flag — not persisted to JSONL (see useLogs.ts:
   *  addLog passes only named fields to journalAppend; `extra` lives only
   *  on the in-memory LogEntry). On session restore the flag is absent;
   *  toLogEntries merges consecutive agent chunks back into one entry so
   *  the restored view renders as one normal AgentMessage. */
  liveStreamed?: boolean
  /** Set on the FIRST chunk of each streaming reply piece (the leading line)
   *  so AgentMessage can apply `marginTop=1` once at the top while leaving
   *  subsequent chunks tight. Resets at the start of every new content piece
   *  (text → tool_call → text emits two streams, each gets its own first
   *  chunk). UI-only — paired with `liveStreamed`. */
  firstOfStream?: boolean
  /** Half-open persisted-journal range represented by this restored UI row.
   *  UI-only. A merged streaming row may cover many journal rows; a divider
   *  covers an empty range at a turn boundary. */
  journalStartIndex?: number
  journalEndIndex?: number
}

export type Route = "home" | "session"

export interface Toast {
  id: number
  text: string
  fg?: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

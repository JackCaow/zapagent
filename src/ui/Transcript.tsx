/** @jsxImportSource react */
// Transcript: renders chat history as Ink Box/Text. Markdown / shiki / diff
// rendering hand-rolled in src/ui/{markdown,code-block,diff}.tsx.
//
// Layout convention: every rendered block uses an explicit two-column flex
// (sibling indent column + content column) so wrap inside the row stays in
// the content column instead of falling back to col 0. Plain `marginLeft`
// on the outer Box visually applies on the first row but wrapped
// continuation rows leak back to col 0. <IndentedRow> bakes the right
// pattern in once and every renderer reuses it.

import { Fragment, memo, useMemo, useRef } from "react"
import { Box, Static, Text } from "ink"
import type { LogEntry } from "./types.js"
import { c } from "./theme.js"
import { useTermWidth } from "./term-width.js"
import { appLogger } from "../singletons.js"

const DIAG = process.env.ZAPCODE_DIAG === "1"
import {
  formatResultLabel,
  getToolIcon,
  getToolAlias,
  truncateOutput,
  formatThinkingDuration,
  readThinkingMode,
  THINKING_SUMMARY_FLOOR_MS,
} from "./transcript-format.js"
import { Markdown } from "./markdown.js"
import { Diff, looksLikeDiff } from "./diff.js"
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints } from "../utils/logicalLines.js"
import {
  batchAgentGroups,
  groupLogs,
  partitionRenderItems,
  summarizeAgentGroup,
  type AgentBatch,
  type BatchedRenderItem,
} from "./group-logs.js"
import type { AgentRunSnapshot } from "../../zapsdk/agent/run-state.js"

const INDENT_COLS = 2   // body indent — aligns with user-message body col so
                        // agent reply text starts at the same x as the user's
                        // typed text (right of the submitted-prompt marker)
const NESTED_COLS = 5   // tool-output indent (replaces "     " NESTED_INDENT)
const MAX_USER_MESSAGE_DISPLAY_LINES = 120
const USER_MESSAGE_DISPLAY_HEAD_LINES = 80
const USER_MESSAGE_DISPLAY_TAIL_LINES = 30
const MAX_USER_MESSAGE_DISPLAY_CHARS = 24_000
const USER_MESSAGE_DISPLAY_HEAD_CHARS = 12_000
const USER_MESSAGE_DISPLAY_TAIL_CHARS = 6_000

// Short, human-readable agent identifier for the transcript. Strips the
// timestamp + random suffix off delegate IDs ("da_claude_moo14b6f_c55l"
// → "claude") so multi-segment subagent paths don't blow out the narrow
// gutter column. Returns "" when the log isn't from a subagent.
function agentLabel(log: LogEntry): string {
  const path = log.agentPath
  if (!path?.length) return ""
  const short = path.map(seg => {
    const m = seg.match(/^da_([^_]+)/)
    return m ? m[1] : seg
  }).join("/")
  return `[${short}]`
}

/**
 * Two-column flex row: a fixed-width gutter on the left and a width-
 * constrained content column on the right. Children render inside the
 * content column; their text wrap stays inside the content bound rather
 * than falling back to col 0 on continuation rows. The gutter accepts a
 * ReactNode so callers can put a marker (` ┃ `, `· `, `✓ `, etc.) there
 * instead of a blank column.
 *
 * IMPORTANT: the content column uses an EXPLICIT width (termWidth -
 * indent - 1) rather than flexGrow={1}. flexGrow children let their Text
 * auto-wrap based on whatever width Ink propagates, which used to fall
 * back to terminal width minus 0 in some contexts and put continuation
 * rows at col 0. An explicit width forces wrap at the right edge of the
 * content column and continuations land underneath.
 */
function IndentedRow({
  width,
  gutter,
  marginTop,
  children,
}: {
  width: number
  gutter?: React.ReactNode
  marginTop?: number
  children: React.ReactNode
}) {
  // Live width via context — Ink's resize handler doesn't trigger a React
  // re-render, so reading process.stdout.columns here would lock the column
  // at the value present when this row was first mounted.
  const termWidth = useTermWidth()
  const contentWidth = Math.max(20, termWidth - width - 1)
  return (
    <Box flexDirection="row" {...(marginTop ? { marginTop } : {})}>
      <Box flexShrink={0} width={width}>
        {gutter ?? <Text> </Text>}
      </Box>
      <Box width={contentWidth} flexDirection="column">
        {children}
      </Box>
    </Box>
  )
}

// Renders the short agent label as a dim header row (`[claude]`) above
// the actual log row. Returns null when the log isn't from a subagent.
// Surfacing the agent ONLY in the body column (never the narrow gutter)
// keeps long IDs from per-character-wrapping the spinner column.
function AgentHeader({ log }: { log: LogEntry }) {
  const label = agentLabel(log)
  if (!label) return null
  return (
    <IndentedRow width={INDENT_COLS}>
      <Text color={c.text.faint}>{label}</Text>
    </IndentedRow>
  )
}

// All row components below are memoized so unchanged log entries render to
// byte-identical output across frames. Combined with the Ink pure-append
// patch in node_modules/ink/build/log-update.js, this lets the diff path
// emit zero terminal bytes for committed rows during streaming, so user
// scroll-up isn't yanked back to tail. log objects are immutable (addLog
// creates new ones, replaceLog returns new ones for changed entries) so
// React's default shallow prop compare is sufficient — same log === same
// reference === memo skips the render.
type UserMessageDeliveryState = "pending" | "accepted"

export function userMessageDisplayText(log: Pick<LogEntry, "text" | "restoreText">, deliveryState: UserMessageDeliveryState = "accepted"): string {
  const shellText = log.text.trimStart()
  let display: string
  if (shellText.startsWith("!")) {
    display = log.restoreText ?? log.text
    const trimmed = display.trimStart()
    display = trimmed.startsWith("!") ? trimmed.trimEnd().slice(1) : display
  } else {
    display = log.restoreText ?? log.text
  }
  return foldLongUserMessageForDisplay(display, deliveryState)
}

export function foldLongUserMessageForDisplay(text: string, deliveryState: UserMessageDeliveryState = "accepted"): string {
  const displayText = normalizeDisplayNewlines(text)
  const lines = displayText.split("\n")
  if (lines.length > MAX_USER_MESSAGE_DISPLAY_LINES) {
    const head = lines.slice(0, USER_MESSAGE_DISPLAY_HEAD_LINES)
    const tail = lines.slice(-USER_MESSAGE_DISPLAY_TAIL_LINES)
    const omitted = lines.length - head.length - tail.length
    const folded = [
      renderUserMessageFoldNotice(`${omitted} lines`, `${lines.length} lines`, `${countCodePoints(displayText)} chars`, deliveryState),
      ...head,
      renderUserMessageFoldGap(`${omitted} lines`),
      ...tail,
    ].join("\n")
    return countCodePoints(folded) <= MAX_USER_MESSAGE_DISPLAY_CHARS
      ? folded
      : foldLongUserMessageByChars(displayText, deliveryState)
  }
  if (countCodePoints(displayText) > MAX_USER_MESSAGE_DISPLAY_CHARS) {
    return foldLongUserMessageByChars(displayText, deliveryState)
  }
  return displayText
}

function normalizeDisplayNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

function foldLongUserMessageByChars(text: string, deliveryState: UserMessageDeliveryState): string {
  const head = sliceHeadCodePoints(text, USER_MESSAGE_DISPLAY_HEAD_CHARS)
  const tail = sliceTailCodePoints(text, USER_MESSAGE_DISPLAY_TAIL_CHARS)
  const omitted = Math.max(0, countCodePoints(text) - countCodePoints(head) - countCodePoints(tail))
  return [
    renderUserMessageFoldNotice(`${omitted} chars`, null, `${countCodePoints(text)} chars`, deliveryState),
    head,
    renderUserMessageFoldGap(`${omitted} chars`),
    tail,
  ].join("\n")
}

function renderUserMessageFoldNotice(omitted: string, totalLines: string | null, totalChars: string, deliveryState: UserMessageDeliveryState): string {
  const total = totalLines ? `${totalLines}, ${totalChars}` : totalChars
  if (deliveryState === "pending") return `[... display folded only: ${omitted} omitted; full ${total} retained in queue; awaiting acceptance ...]`
  return `[... display folded only: ${omitted} omitted; full ${total} was sent and preserved in session/model context; use /copy-input to copy exact input ...]`
}

function renderUserMessageFoldGap(omitted: string): string {
  return `[... ${omitted} omitted from display here ...]`
}

export const UserMessage = memo(function UserMessage({ log, deliveryState = "accepted" }: { log: LogEntry; deliveryState?: UserMessageDeliveryState }) {
  const display = userMessageDisplayText(log, deliveryState)
  const isShell = log.text.trimStart().startsWith("!")
  const markerColor = isShell ? c.warning : c.accent
  const marker = isShell ? "$ " : "› "
  return (
    <Box flexDirection="column" marginTop={1}>
      <AgentHeader log={log} />
      <IndentedRow
        width={2}
        gutter={<Text color={markerColor}>{marker}</Text>}
      >
        <UserMessageBody text={display} />
      </IndentedRow>
      {log.images && log.images.length > 0 && (
        <IndentedRow width={INDENT_COLS}>
          <Text color={c.accent}>
            {`[${log.images.length} image${log.images.length === 1 ? "" : "s"} attached]`}
          </Text>
        </IndentedRow>
      )}
    </Box>
  )
})

// Keep submitted prompts visually tied to the input prompt without painting a
// terminal-wide background band. The fixed-width gutter owns the marker and
// Ink wraps continuation lines inside IndentedRow's content column, aligned
// beneath the first character of the message.
function UserMessageBody({ text }: { text: string }) {
  return <Text color={c.text.primary}>{text}</Text>
}

const AgentMessage = memo(function AgentMessage({ log }: { log: LogEntry }) {
  // Live-streamed chunks: each is one paragraph (`...\n\n`) of an in-flight
  // reply, committed to <Static> as it completes. Render with the same
  // <Markdown> as a regular agent message so the post-commit visual matches
  // what the user just saw in the dynamic-frame's `streamingTail` preview.
  // `firstOfStream` adds `marginTop=1` once at the leading edge; later
  // chunks render tight (the prior chunk's trailing blank from `\n\n`
  // separates paragraphs). On session restore toLogEntries merges adjacent
  // agent rows so this branch is only hit during the live run.
  if (log.liveStreamed) {
    if (!log.text) return null
    if (log.firstOfStream) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <AgentHeader log={log} />
          <IndentedRow width={INDENT_COLS}>
            <Markdown source={log.text} />
          </IndentedRow>
        </Box>
      )
    }
    return (
      <IndentedRow width={INDENT_COLS}>
        <Markdown source={log.text} />
      </IndentedRow>
    )
  }
  if (!log.text.trim()) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <AgentHeader log={log} />
      <IndentedRow width={INDENT_COLS}>
        <Markdown source={log.text} />
      </IndentedRow>
    </Box>
  )
})

const SystemMessage = memo(function SystemMessage({ log }: { log: LogEntry }) {
  if (!log.text.trim()) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <AgentHeader log={log} />
      <IndentedRow width={INDENT_COLS}>
        <Text color={c.text.ghost}>{log.text}</Text>
      </IndentedRow>
    </Box>
  )
})

const ErrorMessage = memo(function ErrorMessage({ log }: { log: LogEntry }) {
  if (!log.text.trim()) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <AgentHeader log={log} />
      <IndentedRow width={INDENT_COLS}>
        <Text color={c.error}>{`✗ ${log.text}`}</Text>
      </IndentedRow>
    </Box>
  )
})

const ProgressMessage = memo(function ProgressMessage({ log }: { log: LogEntry }) {
  return (
    <Box flexDirection="column">
      <AgentHeader log={log} />
      <IndentedRow width={INDENT_COLS}>
        <Text color={c.text.faint}>{`… ${log.text}`}</Text>
      </IndentedRow>
    </Box>
  )
})

const ThinkingMessage = memo(function ThinkingMessage({ log }: { log: LogEntry }) {
  const mode = readThinkingMode()
  if (mode === "off") return null
  const text = log.text.trim()
  if (!text) return null
  const ms = log.thinkingMs ?? 0
  // Header shows duration only when we trust it (>= floor). Below floor —
  // includes ms === 0 from providers that emit a single content_final without
  // a prior delta — fall back to a plain "thinking" label so the block still
  // renders content instead of vanishing.
  const header = ms >= THINKING_SUMMARY_FLOOR_MS
    ? `◆ thought for ${formatThinkingDuration(ms)}`
    : "◆ thinking"
  if (mode === "full") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <AgentHeader log={log} />
        <IndentedRow width={INDENT_COLS}>
          <Text color={c.text.faint}>{header}</Text>
        </IndentedRow>
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.text.ghost}>{text}</Text>
        </IndentedRow>
      </Box>
    )
  }
  // summary (default): up to 3 preview lines + "+N more lines" tail.
  const { lines, truncated, total } = truncateOutput(text)
  return (
    <Box flexDirection="column">
      <AgentHeader log={log} />
      <IndentedRow width={INDENT_COLS}>
        <Text color={c.text.faint}>{header}</Text>
      </IndentedRow>
      {lines.length > 0 && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.text.ghost}>{lines.join("\n")}</Text>
        </IndentedRow>
      )}
      {truncated && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.text.faint}>{`… ${total - lines.length} more lines`}</Text>
        </IndentedRow>
      )}
    </Box>
  )
})

const DividerLine = memo(function DividerLine() {
  return null
})

const ToolCall = memo(function ToolCall({ log }: { log: LogEntry }) {
  const tool = log.tool
  if (!tool || tool.name === "todo_write") return null
  // While a tool's args are still streaming in (tool_call_pending fired with
  // empty preview, before the first delta carries a usable hint), formatArgs
  // would produce `name()` — visually identical to a no-args call. Render
  // `name(…)` instead when the runner stamped meta.pending so the user can
  // tell streaming-in-progress apart from genuinely-no-args.
  const meta = tool.meta as { pending?: boolean } | undefined
  const argsEmpty = !tool.arguments || Object.keys(tool.arguments).length === 0
  const label = meta?.pending && argsEmpty
    ? `${getToolIcon(tool.name)} ${getToolAlias(tool.name)}(…)`
    : formatResultLabel(tool.name, tool.arguments)
  return (
    <Box flexDirection="column">
      <AgentHeader log={log} />
      <IndentedRow
        width={INDENT_COLS + 2}
        gutter={<Text color={c.text.faint}>{"· "}</Text>}
      >
        <Text color={c.text.muted}>{label}</Text>
      </IndentedRow>
    </Box>
  )
})

interface DiffMetaShape {
  diff: string
  filetype: string
  oldBytes?: number
  newBytes?: number
  skipped?: string
}

export const ToolResult = memo(function ToolResult({ log }: { log: LogEntry }) {
  const tool = log.tool
  if (!tool || tool.name === "todo_write") return null
  const ok = tool.success !== false && !log.text.startsWith("ERR")
  const runtime = (tool.meta as { runtime?: { command?: { exitCode?: number; stderrPresent?: boolean }; networkDenials?: unknown[] } } | undefined)?.runtime
  const command = runtime?.command
  const networkWarning = (runtime?.networkDenials?.length ?? 0) > 0
  const shellWarning = ok && tool.name === "bash" && command?.exitCode === 0 && (command.stderrPresent === true || networkWarning)
  const status = !ok ? "✗" : shellWarning ? "⚠" : "✓"
  const statusFg = !ok ? c.error : shellWarning ? c.warning : c.text.ghost
  const output = tool.output ?? ""
  const checkpoint = (tool.meta as {
    runtime?: { checkpoint?: { covered?: boolean; error?: string } }
  } | undefined)?.runtime?.checkpoint
  const checkpointWarning = ok && checkpoint && !checkpoint.covered
    ? `rewind coverage unavailable${checkpoint.error ? `: ${checkpoint.error}` : ""}`
    : ""

  // exit_plan_mode special case: the plan markdown the model presented to
  // the user lives in tool.arguments.plan and otherwise never appears in
  // the transcript — the PlanApprovalBar that displayed it during approval
  // is a dynamic-frame component, gone the moment the user decides. Render
  // the full plan body under the result label so the transcript remains a
  // complete record of what was approved (and so the user can scroll back
  // to it after implementation starts).
  if (tool.name === "exit_plan_mode" && tool.arguments && typeof (tool.arguments as { plan?: unknown }).plan === "string") {
    const plan = (tool.arguments as { plan: string }).plan
    return (
      <Box flexDirection="column">
        <AgentHeader log={log} />
        <IndentedRow
          width={INDENT_COLS + 2}
          gutter={<Text color={statusFg}>{`${status} `}</Text>}
        >
          <Text color={c.text.muted}>{formatResultLabel(tool.name, tool.arguments)}</Text>
        </IndentedRow>
        <IndentedRow width={NESTED_COLS}>
          <Markdown source={plan} />
        </IndentedRow>
        {output && (
          <IndentedRow width={NESTED_COLS}>
            <Text color={c.text.faint}>{output}</Text>
          </IndentedRow>
        )}
      </Box>
    )
  }

  const meta = tool.meta as DiffMetaShape | undefined
  const metaDiff = meta && typeof meta.diff === "string" && meta.diff.length > 0 ? meta : null
  const looksLike = looksLikeDiff(output)
  const renderAsDiff = !shellWarning && (metaDiff !== null || looksLike)

  if (renderAsDiff) {
    const source = metaDiff ? metaDiff.diff : output
    const lang   = metaDiff ? metaDiff.filetype : undefined
    return (
      <Box flexDirection="column">
        <AgentHeader log={log} />
        <IndentedRow
          width={INDENT_COLS + 2}
          gutter={<Text color={statusFg}>{`${status} `}</Text>}
        >
          <Text color={c.text.muted}>{formatResultLabel(tool.name, tool.arguments)}</Text>
        </IndentedRow>
        <IndentedRow width={NESTED_COLS}>
          {metaDiff?.skipped === "too_large" ? (
            <Text color={c.text.faint}>(diff suppressed — file too large)</Text>
          ) : (
            <Diff source={source} lang={lang} />
          )}
        </IndentedRow>
        {checkpointWarning && (
          <IndentedRow width={NESTED_COLS}>
            <Text color={c.warning}>{`⚠ ${checkpointWarning}`}</Text>
          </IndentedRow>
        )}
      </Box>
    )
  }

  const { lines, truncated, total } = truncateOutput(output)
  return (
    <Box flexDirection="column">
      <AgentHeader log={log} />
      <IndentedRow
        width={INDENT_COLS + 2}
        gutter={<Text color={statusFg}>{`${status} `}</Text>}
      >
        <Text color={c.text.muted}>{formatResultLabel(tool.name, tool.arguments)}</Text>
      </IndentedRow>
      {shellWarning && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.warning}>{networkWarning
            ? "exit 0 with network refusals — inspect diagnostics; some requests were blocked"
            : "exit 0 with stderr — inspect diagnostics; earlier commands may have failed"}</Text>
        </IndentedRow>
      )}
      {lines.length > 0 && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.text.muted}>{lines.join("\n")}</Text>
        </IndentedRow>
      )}
      {checkpointWarning && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.warning}>{`⚠ ${checkpointWarning}`}</Text>
        </IndentedRow>
      )}
      {truncated && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.text.faint}>{`… ${total - lines.length} more lines`}</Text>
        </IndentedRow>
      )}
    </Box>
  )
})

// Permission-prompt entry that shows the proposed edit/create with full
// diff while the live ApprovalBar is asking the user to decide. Finalized
// at addLog time — the approve/deny outcome is rendered as a SEPARATE
// follow-up system log, not as a mutation on this entry, so memo is safe.
const ToolApproval = memo(function ToolApproval({ log }: { log: LogEntry }) {
  const tool = log.tool
  if (!tool) return null
  const meta = tool.meta as DiffMetaShape | undefined
  const hasDiff = meta && typeof meta.diff === "string" && meta.diff.length > 0
  const skipped = meta?.skipped

  return (
    <Box flexDirection="column" marginTop={1}>
      <AgentHeader log={log} />
      <IndentedRow
        width={INDENT_COLS + 2}
        gutter={<Text color={c.warning}>{"⋯ "}</Text>}
      >
        <Text color={c.text.muted}>
          {formatResultLabel(tool.name, tool.arguments)}
          <Text color={c.warning}>  [proposed change]</Text>
        </Text>
      </IndentedRow>
      {hasDiff && (
        <IndentedRow width={NESTED_COLS}>
          <Diff source={meta!.diff} lang={meta!.filetype} />
        </IndentedRow>
      )}
      {!hasDiff && skipped && (
        <IndentedRow width={NESTED_COLS}>
          <Text color={c.text.faint}>(preview unavailable: {skipped})</Text>
        </IndentedRow>
      )}
    </Box>
  )
})

// Compact boundary — one-line marker in the dimmed style of Claude Code's
// `✻ Conversation compacted` row. Deliberately ultra-brief: the full
// summary is preserved in `meta.summary` for diagnostic use and in the
// session JSONL for replay, but the in-transcript footprint stays small
// so the boundary reads as a divider, not a wall of text. Files touched
// + restoration count fit on the same row when present.
const CompactedMessage = memo(function CompactedMessage({ log }: { log: LogEntry }) {
  const meta = log.compacted
  if (!meta) return null
  const fileSuffix = meta.files.length > 0
    ? ` · ${meta.files.length} file${meta.files.length === 1 ? "" : "s"} touched`
    : ""
  return (
    <Box flexDirection="column" marginTop={1}>
      <IndentedRow width={INDENT_COLS}>
        <Text color={c.text.faint}>
          {`✻ Conversation compacted — ${meta.before}→${meta.after} msgs${fileSuffix}`}
        </Text>
      </IndentedRow>
    </Box>
  )
})

// Compact one-line render for the silent <task-notification> turn — the
// raw XML body is what the LLM saw; we just pull the highlights (task id,
// status, optional exit code) into a single faint row so the user can see
// what triggered the assistant's automatic continuation without staring at
// markup.
const TaskNotificationMessage = memo(function TaskNotificationMessage({ log }: { log: LogEntry }) {
  const text = log.text
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1] ?? "?"
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1] ?? "exited"
  const exit = /<exit-code>([^<]+)<\/exit-code>/.exec(text)?.[1]
  const bytes = /<output-bytes>([^<]+)<\/output-bytes>/.exec(text)?.[1]
  const icon = status === "completed" ? "·" : status === "killed" || status === "unknown" ? "⚠" : "✗"
  const suffix = [
    exit !== undefined ? `code ${exit}` : null,
    bytes !== undefined ? `${bytes}B` : null,
  ].filter(Boolean).join(", ")
  const tail = suffix ? ` (${suffix})` : ""
  return (
    <IndentedRow width={INDENT_COLS}>
      <Text color={c.text.faint}>{`${icon} process ${id} ${status === "completed" ? "exited" : status}${tail} · result unverified`}</Text>
    </IndentedRow>
  )
})

const AgentBatchMessage = memo(function AgentBatchMessage({
  batch,
  agentRunsByToolCallId,
}: {
  batch: AgentBatch
  agentRunsByToolCallId?: ReadonlyMap<string, AgentRunSnapshot>
}) {
  const summaries = batch.groups.map((group) => summarizeAgentGroup(
    group,
    group.parent?.tool?.id
      ? agentRunsByToolCallId?.get(group.parent.tool.id)
      : undefined,
  ))
  const statusCounts = new Map<string, number>()
  for (const summary of summaries) {
    statusCounts.set(summary.status, (statusCounts.get(summary.status) ?? 0) + 1)
  }
  const active = summaries.filter(summary => ![
    "completed", "succeeded", "failed", "cancelled", "blocked",
  ].includes(summary.status)).length
  const failed = summaries.filter(summary => summary.status === "failed" || summary.status === "blocked").length
  const total = summaries.length
  const headerIcon = active > 0 ? "◇" : failed > 0 ? "✗" : "✓"
  const headerColor = active > 0 ? c.accent : failed > 0 ? c.error : c.success
  const countLabel = total === 1 ? "Agent" : `${total} agents`
  const statusOrder = [
    "starting", "running", "waiting_approval", "waiting_input", "validating",
    "ready_to_merge", "merging", "cancelling", "waiting_dependency",
    "waiting_capacity", "scheduled", "queued", "completed", "succeeded",
    "blocked", "failed", "cancelled",
  ]
  const statusLabel: Record<string, string> = {
    waiting_approval: "approval",
    waiting_input: "input",
    waiting_dependency: "dependencies",
    waiting_capacity: "capacity",
    cancelling: "cancelling",
    ready_to_merge: "ready to merge",
    scheduled: "queued",
    completed: "done",
    succeeded: "done",
  }
  const statusParts = statusOrder.flatMap((status) => {
    const count = statusCounts.get(status) ?? 0
    return count > 0 ? [`${count} ${statusLabel[status] ?? status}`] : []
  })

  return (
    <Box flexDirection="column" marginTop={1}>
      <IndentedRow width={INDENT_COLS}>
        <Text color={headerColor}>
          {`${headerIcon} ${countLabel}`}
          <Text color={c.text.faint}>{` · ${statusParts.join(" · ")}`}</Text>
        </Text>
      </IndentedRow>
      {summaries.map((summary, index) => {
        const isLast = index === summaries.length - 1
        const branch = isLast ? "└─" : "├─"
        const waiting = ["queued", "scheduled", "waiting_dependency", "waiting_capacity"]
          .includes(summary.status)
        const activeStatus = [
          "starting", "running", "waiting_approval", "waiting_input", "cancelling",
          "validating", "ready_to_merge", "merging",
        ].includes(summary.status)
        const icon = waiting
          ? "○"
          : activeStatus
            ? "◐"
            : summary.status === "failed" || summary.status === "blocked"
              ? "✗"
              : "✓"
        const color = waiting
          ? c.text.faint
          : activeStatus
            ? c.accent
            : summary.status === "failed" || summary.status === "blocked"
              ? c.error
              : c.success
        const duration = summary.durationMs !== undefined
          ? formatThinkingDuration(summary.durationMs)
          : ""
        const completedDetail = [
          `${summary.actionCount} action${summary.actionCount === 1 ? "" : "s"}`,
          duration,
        ].filter(Boolean).join(" · ")
        const runningDetail = summary.latestTool
          ? formatResultLabel(summary.latestTool.name, summary.latestTool.arguments)
          : "starting"
        const detail = summary.status === "running"
          ? runningDetail
          : ["completed", "succeeded", "failed", "cancelled"].includes(summary.status)
            ? completedDetail
            : statusLabel[summary.status] ?? summary.status.replaceAll("_", " ")

        return (
          <Box key={batch.groups[index]?.subagentId ?? index} flexDirection="column">
            <IndentedRow width={INDENT_COLS + 2} gutter={<Text color={c.text.ghost}>{`${branch} `}</Text>}>
              <Text wrap="truncate-end">
                <Text color={color}>{`${icon} `}</Text>
                <Text color={c.text.secondary}>{summary.label}</Text>
                {detail && <Text color={c.text.faint}>{` · ${detail}`}</Text>}
              </Text>
            </IndentedRow>
            {summary.outputPreview && (
              <IndentedRow width={NESTED_COLS + 2}>
                <Text color={c.text.ghost} wrap="truncate-end">{`↳ ${summary.outputPreview}`}</Text>
              </IndentedRow>
            )}
          </Box>
        )
      })}
    </Box>
  )
})

function renderLog(log: LogEntry) {
  switch (log.type) {
    case "user":              return <UserMessage      key={log.id} log={log} />
    case "agent":             return <AgentMessage     key={log.id} log={log} />
    case "system":            return <SystemMessage    key={log.id} log={log} />
    case "error":             return <ErrorMessage     key={log.id} log={log} />
    case "progress":          return <ProgressMessage  key={log.id} log={log} />
    case "thinking":          return <ThinkingMessage  key={log.id} log={log} />
    case "divider":           return <DividerLine      key={log.id} />
    case "tool":              return <ToolCall         key={log.id} log={log} />
    case "result":            return <ToolResult       key={log.id} log={log} />
    case "approval":          return <ToolApproval     key={log.id} log={log} />
    case "compacted":         return <CompactedMessage key={log.id} log={log} />
    case "task-notification": return <TaskNotificationMessage key={log.id} log={log} />
    default:                  return null
  }
}

function renderTranscriptItem(
  item: BatchedRenderItem,
  agentRunsByToolCallId?: ReadonlyMap<string, AgentRunSnapshot>,
) {
  return item.kind === "log"
    ? renderLog(item.log)
    : <AgentBatchMessage key={`agent-batch-${item.batch.id}`} batch={item.batch} agentRunsByToolCallId={agentRunsByToolCallId} />
}

function transcriptItemKey(item: BatchedRenderItem): string | number {
  return item.kind === "log" ? item.log.id : `agent-batch-${item.batch.id}`
}

// Layout:
//   <Static items={[header, ...committedItems]}>  ← scrollback band
//   {dynamicSuffix inline}                        ← dynamic frame
//
// Static commits each item to scrollback once, via direct stdout.write
// that bypasses log-update entirely. Items in Static don't participate in
// per-render diffs. That's CRITICAL for tall transcripts: log-update's
// incremental diff path emits cursorUp(prevLines.length - 1), which on
// frames taller than the viewport jumps cursor past the viewport's upper
// boundary, triggering terminal scroll-on-output that yanks the user's
// scroll position back to the tail. Pinning committed logs in Static
// keeps the dynamic frame small. From the earliest mutable tool onward, the
// suffix stays dynamic; parallel subagents are summarized as one bounded
// batch instead of rendering every child event as another row.
//
// Streaming agent text is committed to Static one source-line at a time
// during the stream (each line a separate `agent` log entry with
// `liveStreamed: true` — see useAgentRunner's flushTextChunks). That keeps
// the dynamic frame's height bounded regardless of reply length, so Ink
// can never cursor-up past the viewport top to yank scroll. AgentMessage
// renders chunks tightly stacked; toLogEntries on session restore merges
// adjacent agent entries back into a single LogEntry so the restored view
// looks identical to a non-streamed reply.
//
// Only "tool" entries mutate after creation (placeholder → updated args →
// "result"). partitionRenderItems keeps the suffix from the earliest such
// item dynamic, then commits the finalized batch atomically.
//
// Welcome (header) lives INSIDE Static as item 0 so it gets committed at
// the very top of scrollback. /clear and /new pair an ANSI screen+
// scrollback wipe with a transcript epoch bump that remounts this whole
// subtree, so the header re-emits at the top of the now-empty scrollback.
type StaticItem =
  | { kind: "header"; node: React.ReactNode }
  | { kind: "render"; item: BatchedRenderItem }

export const Transcript = memo(function Transcript({
  logs,
  header,
  streamingTail,
  agentRuns = [],
}: {
  logs: LogEntry[]
  header?: React.ReactNode
  /** The in-flight assistant suffix after the most recent committed
   *  paragraph. Rendered as plain `<Text>` for cheap token-level animation
   *  and capped by streamingPreview to 12 logical lines / 1600 chars. The
   *  complete paragraph is retained off-screen and receives normal Markdown
   *  rendering once committed to <Static>. */
  streamingTail?: string
  /** Authoritative live AgentRun snapshots. Old/restored logs without these
   *  continue to use the legacy transcript inference path. */
  agentRuns?: readonly AgentRunSnapshot[]
}) {
  const agentRunsByToolCallId = useMemo(() => new Map(
    agentRuns.flatMap((run) => run.toolCallId ? [[run.toolCallId, run] as const] : []),
  ), [agentRuns])
  // Input and spinner updates must not regroup the full transcript. Even when
  // streamingTail changes, logs normally retain their identity, so keep the
  // O(log count) grouping and Static item allocation behind memo boundaries.
  const groupedItems = useMemo(() => batchAgentGroups(groupLogs(logs)), [logs])
  const { committed, dynamic } = useMemo(
    () => partitionRenderItems(groupedItems),
    [groupedItems],
  )
  const items = useMemo<StaticItem[]>(() => [
    ...(header ? [{ kind: "header" as const, node: header }] : []),
    ...committed.map(item => ({ kind: "render" as const, item })),
  ], [committed, header])
  // Track first render after (re)mount so we can capture the items
  // count the Static was seeded with — useful for the session-restore
  // "transcript blank after load" diagnosis. Always-on info-level so we
  // don't need ZAPCODE_DIAG=1 to debug a restore issue in the field.
  const renderSeqRef = useRef(0)
  renderSeqRef.current++
  if (renderSeqRef.current === 1) {
    const types: Record<string, number> = {}
    for (const i of items) {
      const k = i.kind === "header"
        ? "header"
        : i.item.kind === "log"
          ? i.item.log.type
          : "agent-batch"
      types[k] = (types[k] ?? 0) + 1
    }
    appLogger.info("transcript_mount", {
      itemCount: items.length,
      logsLen: logs.length,
      hasActive: dynamic.length > 0,
      hasStreamingTail: !!(streamingTail && streamingTail.length > 0),
      types,
    })
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={items}>
        {(item) => (
          <Fragment key={item.kind === "header" ? "__header__" : transcriptItemKey(item.item)}>
            {item.kind === "header" ? item.node : renderTranscriptItem(item.item, agentRunsByToolCallId)}
          </Fragment>
        )}
      </Static>
      {dynamic.map(item => (
        <Fragment key={transcriptItemKey(item)}>{renderTranscriptItem(item, agentRunsByToolCallId)}</Fragment>
      ))}
      {streamingTail && streamingTail.length > 0 && (() => {
        // In-flight paragraph: chars after the last `\n\n` of the running
        // assistant reply. Keep the in-flight tail as plain Text: reparsing
        // Markdown on every provider frame competes directly with keyboard
        // and palette updates on Ink's single JS thread. Once a paragraph is
        // complete it commits to <Static> and receives the normal full
        // Markdown rendering there, so final transcript fidelity is unchanged.
        //
        // Margin matches the chunk's: leading paragraph (no prior chunk in
        // this reply) gets `marginTop=1` to separate from previous content.
        // Continuation paragraph (some chunk already committed) renders
        // tight; the trailing-blank from the previous chunk's `\n\n`
        // already provides separation between paragraphs.
        const lastLog = logs[logs.length - 1]
        const tailIsContinuation =
          lastLog?.type === "agent" && lastLog.liveStreamed === true
        const inner = (
          <IndentedRow width={INDENT_COLS}>
            <Text color={c.text.primary}>{streamingTail}</Text>
          </IndentedRow>
        )
        return tailIsContinuation
          ? inner
          : <Box flexDirection="column" marginTop={1}>{inner}</Box>
      })()}
    </Box>
  )
})

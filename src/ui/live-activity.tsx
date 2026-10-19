/** @jsxImportSource react */
import { shellCommandDisplay } from "../../zapsdk/utils/shell.js";
import { memo, useEffect, useRef } from "react"
import { Box, Text } from "ink"
import type { LogEntry } from "./types.js"
import type { ProviderRequestEvent } from "../../zapsdk/core/llm.js"
import { c } from "./theme.js"
import { shortAgentLabel } from "./group-logs.js"
import { displayWidth, truncateToWidth } from "./truncate.js"
import { getToolAlias, getToolIcon } from "./transcript-format.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"
import { useSpinner } from "../hooks/useSpinner.js"
import {
  activityProgress,
  buildLiveActivityCopy,
  type ActivityProgressKind,
} from "./activity-status.js"

const SPINNER_FRAMES = [
  "≋(°o°)≋", "≋(°-°)≋", "≈(°o°)≈", "≋(^o^)≋", "≈(°-°)≈", "≋(°ω°)≋",
]

function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  const cwd = process.cwd().replace(/\\/g, "/")
  if (normalized.startsWith(cwd + "/")) return normalized.slice(cwd.length + 1)
  const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/")
  if (home && normalized.startsWith(home)) return "~" + normalized.slice(home.length)
  return normalized
}

function oneLine(value: unknown, max = 60): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return countCodePoints(text) > max ? `${sliceHeadCodePoints(text, Math.max(1, max - 1))}…` : text
}

function formatToolLabel(name: string, args: Record<string, unknown> | undefined): string {
  const icon = getToolIcon(name)
  const alias = getToolAlias(name)
  if (!args) return `${icon} ${alias}`
  if (name === "agent") return `${icon} ${alias}(${shortAgentLabel(args.task as string | undefined)})`
  if (name === "skill") return `${icon} ${alias}(${oneLine(args.name)})`
  let arg = ""
  const patternFirst = (name === "search_files" || name === "glob_files") && args.pattern
  if (patternFirst) arg = String(args.pattern)
  else if (args.path) arg = normalizePath(String(args.path))
  else if (args.command ?? args.cmd) arg = String(args.command ?? args.cmd).replace(/\s*\n\s*/g, " ")
  else if (name === "bash" && args.check_steps) arg = shellCommandDisplay(args)
  else if (args.pattern) arg = String(args.pattern)
  else if (args.query) arg = String(args.query)
  else if (args.url) arg = String(args.url)
  else if (args.task ?? args.description) arg = String(args.task ?? args.description)
  return arg ? `${icon} ${alias}(${oneLine(arg)})` : `${icon} ${alias}`
}

export function formatPendingToolsLabel(pendingTools: LogEntry[]): string {
  const agentTools = pendingTools.filter(log => (
    log.tool?.name === "agent" || log.tool?.name === "delegate_agent"
  ))
  if (agentTools.length > 1) {
    const otherCount = pendingTools.length - agentTools.length
    const running = agentTools.filter(log => (
      !!(log.tool?.meta as { subagentId?: string } | undefined)?.subagentId
    )).length
    const queued = agentTools.length - running
    const states = [
      running > 0 ? `${running} running` : "",
      queued > 0 ? `${queued} queued` : "",
    ].filter(Boolean).join(" · ")
    return `◇ ${agentTools.length} agents · ${states}${otherCount > 0 ? ` (+${otherCount})` : ""}`
  }
  const labels = pendingTools
    .map(log => log.tool ? formatToolLabel(log.tool.name, log.tool.arguments) : log.text)
    .filter(Boolean)
  if (labels.length === 1) return labels[0]!
  return labels.length > 1 ? `${labels[0]} (+${labels.length - 1})` : ""
}

/** Return every root tool call that has not received a matching result yet.
 * Keep this collection complete: the renderer is responsible for presenting a
 * compact summary, and agent counts must not depend on an arbitrary row cap. */
export function collectPendingTools(logs: LogEntry[]): LogEntry[] {
  const matched = new Set<string>()
  const pending: LogEntry[] = []
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i]
    if (!log) continue
    // Child activity is already summarized inside the corresponding agent
    // row. Including it here creates noisy `(+20)` counters and makes the
    // footer describe implementation details rather than root work.
    if (log.agentPath?.length) continue
    const toolId = log.tool?.id
    if (!toolId) continue
    if (log.tool?.name === "todo_write") continue
    if (log.type === "result") matched.add(toolId)
    else if (log.type === "tool" && !matched.has(toolId)) pending.unshift(log)
  }
  return pending
}

export interface LiveActivityProps {
  isRunning: boolean
  isStreaming: boolean
  isThinking: boolean
  thinkingChars: number
  status: string
  providerRequest?: ProviderRequestEvent
  activeTool: string
  /** Bytes accumulated in the in-flight tool-call's JSON arg buffer (set
   *  while the model is still streaming tool args, cleared once the tool
   *  starts executing). When >0, surface a `12.4k` counter so a slow
   *  generation looks distinct from a silent stall. */
  activeToolBytes?: number
  termWidth: number
  pendingTools: LogEntry[]
  lastCompletedTool?: LogEntry
  /** Esc may be occupied by a queue editor, palette, or attachment. */
  stopHint?: string
}

const STATUS_LABELS: Record<string, string> = {
  ready: "", cancelled: "", thinking: "Thinking", writing: "Replying", compacting: "Compacting",
  sending: "Sending", working: "Working", preparing: "Preparing request",
}

function statusLabel(status: string, activeTool: string): string {
  if (activeTool) return getToolAlias(activeTool)
  return STATUS_LABELS[status] ?? status ?? "Working"
}

export const LiveActivity = memo(function LiveActivity({
  isRunning, isStreaming, isThinking, thinkingChars,
  status, activeTool, activeToolBytes = 0, termWidth, pendingTools,
  lastCompletedTool, providerRequest, stopHint = "Esc twice to stop",
}: LiveActivityProps) {
  // Keep the 150ms animation state inside this small row. Hosting it in App
  // made every spinner tick reconcile the transcript, prompt and palettes.
  const { spinIdx, elapsed } = useSpinner(status)
  const progress = activityProgress(isThinking, thinkingChars, activeToolBytes)
  const progressRef = useRef<{
    kind: ActivityProgressKind
    value: number
    changedAt: number
  }>({ kind: progress.kind, value: progress.value, changedAt: Date.now() })
  const progressChanged = progress.kind !== progressRef.current.kind
    || progress.value !== progressRef.current.value
  const progressIdleSeconds = progressChanged
    ? 0
    : Math.max(0, Math.floor((Date.now() - progressRef.current.changedAt) / 1000))

  useEffect(() => {
    if (!isRunning || progress.kind === "none") {
      progressRef.current = { kind: progress.kind, value: progress.value, changedAt: Date.now() }
      return
    }
    if (progress.kind !== progressRef.current.kind || progress.value !== progressRef.current.value) {
      progressRef.current = { kind: progress.kind, value: progress.value, changedAt: Date.now() }
    }
  }, [isRunning, progress.kind, progress.value])

  // Always render a single-row Box (even when idle) so the frame
  // height stays stable across the running→idle transition. Without
  // this, log-update under-erases by 1 row when LiveActivity
  // dismounts and leaves a stray horizontal artifact above the
  // prompt after the first agent response. Cheap: just one blank
  // row of vertical space.
  if (!isRunning && !isStreaming && !isThinking && pendingTools.length === 0) {
    return <Box height={1} marginTop={1} />
  }
  // Spinner ticks freely and elapsed updates every 150ms. This is safe
  // because completed paragraphs of a streaming reply commit to <Static>
  // via useAgentRunner's flushTextParagraphs, so the dynamic frame stays
  // bounded (one in-flight paragraph + LiveActivity + Prompt + Footer ≈
  // <20 rows). Even when log-update falls back to its slow path on a
  // byte-changed row inside the dynamic frame, the cursorUp stays well
  // inside the viewport and never re-engages the terminal's scroll-on-
  // output policy. (The earlier "freeze spinner during streaming" patch
  // was a defensive no-op against a tall-frame yank that no longer
  // exists in this architecture.)
  const spinner = SPINNER_FRAMES[spinIdx % SPINNER_FRAMES.length]
  const toolsSegment = formatPendingToolsLabel(pendingTools)
  const primaryLabel = toolsSegment || statusLabel(status, activeTool)
  const copy = buildLiveActivityCopy({
    primaryLabel,
    elapsedSeconds: elapsed,
    isThinking,
    thinkingChars,
    activeToolBytes,
    progressIdleSeconds,
    providerRequest: pendingTools.length === 0 && status !== "compacting" ? providerRequest : undefined,
  })
  const lastActionSegment = pendingTools.length === 0 && lastCompletedTool?.tool
    ? `after ${formatToolLabel(lastCompletedTool.tool.name, lastCompletedTool.tool.arguments)}`
    : ""
  const segments = [copy.primaryLabel, copy.elapsed, copy.progress, lastActionSegment]
    .filter(Boolean)
    .join("  ·  ")
  const interruptHint = `  ⏎ ${stopHint}`
  const spinnerWidth = displayWidth(spinner) + 1
  const hintWidth = displayWidth(interruptHint)
  const segmentBudget = Math.max(20, termWidth - spinnerWidth - hintWidth - 4)
  const truncated = truncateToWidth(segments, segmentBudget)
  // Compact uses a distinct spinner color (warning) so the user can tell at
  // a glance "this isn't the agent thinking, it's the context being
  // compressed". Matches the Claude Code pattern of swapping to a system-
  // colored spinner during compact_start → compact_end.
  const spinnerColor = status === "compacting" || copy.mayBeStalled ? c.warning : c.accent
  return (
    <Box flexDirection="row" paddingLeft={2} marginTop={1}>
      <Text color={spinnerColor} wrap="truncate-end">{spinner} </Text>
      <Text color={c.text.muted} wrap="truncate-end">{truncated}</Text>
      <Text color={c.text.faint} wrap="truncate-end">{interruptHint}</Text>
    </Box>
  )
})

export function liveActivityHeight(active: boolean): number {
  return active ? 2 : 0
}

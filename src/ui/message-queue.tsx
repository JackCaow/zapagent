/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import { DialogFrame } from "./dialog-frame.js"
import { commandInput } from "./controlled-input.js"
import { useTermWidth } from "./term-width.js"
import { truncateToWidth } from "./truncate.js"
import { c } from "./theme.js"
import { queuedCommandPreview } from "../queue/inputQueue.js"
import { isQueuePaused, type FollowUpMode, type MessageQueue, type QueueEntry } from "../queue/messageQueue.js"

export function queuePanelHeading(entries: readonly QueueEntry[], mode: FollowUpMode, active = false): string {
  if (isQueuePaused(entries)) {
    return `Follow-ups · ${entries.length} · PAUSED by a failed message: nothing behind it runs · Ctrl+Q: r retry · x delete · c clear failed`
  }
  // Ordinary sends use the same durable queue as follow-ups. Until a run
  // accepts its input, that receipt is a send in progress, not a follow-up.
  if ((!active && entries.every(entry => entry.state === "queued" || entry.state === "dispatching")) || (entries.length === 1 && entries[0]?.state === "dispatching" && entries[0]?.mode === "queue")) {
    return `Sending · ${entries.length}`
  }
  return `Follow-ups · ${entries.length} · default: ${mode === "queue" ? "Queue" : "Steer"} · /queue or Ctrl+Q manage`
}

export function QueuePanel({ entries: allEntries, mode, active, foregroundId }: { entries: readonly QueueEntry[]; mode: FollowUpMode; active?: boolean; foregroundId?: string }) {
  const width = Math.max(10, useTermWidth() - 2)
  const entries = allEntries.filter(entry => entry.id !== foregroundId)
  if (!entries.length) return mode === "steer" && active
    ? <Text color={c.text.faint}>{truncateToWidth("Queuing off · new messages Steer the active task · /queue to manage", width)}</Text>
    : null
  return <Box paddingX={1} flexDirection="column">
    <Text color={isQueuePaused(entries) ? c.warning : c.text.faint}>{truncateToWidth(queuePanelHeading(entries, mode, active), width)}</Text>
    {entries.slice(0, 3).map(entry => <Text key={entry.id} color={entry.state === "failed" || entry.state === "accepted" ? c.warning : c.text.faint}>
      {truncateToWidth(`${entry.mode === "steer" ? "↪" : "↳"} ${entry.state} · ${queuedCommandPreview(entry)}`, width)}
    </Text>)}
    {entries.length > 3 && <Text color={c.text.faint}>… {entries.length - 3} more</Text>}
  </Box>
}

interface QueueDialogProps {
  queue: MessageQueue
  entries: readonly QueueEntry[]
  mode: FollowUpMode
  onModeChange: (mode: FollowUpMode) => void
  onEdit: (id: string) => void
  onError: (error: string) => void
  onCancel: () => void
}

export function QueueDialog(props: QueueDialogProps) {
  const width = Math.max(10, useTermWidth() - 2)
  const [height, setHeight] = useState(process.stdout.rows ?? 24)
  useEffect(() => {
    const resize = () => setHeight(process.stdout.rows ?? 24)
    process.stdout.on("resize", resize)
    return () => { process.stdout.off("resize", resize) }
  }, [])
  const [selectedId, setSelectedId] = useState(props.entries[0]?.id)
  const live = useRef({ ...props, selectedId })
  live.current = { ...props, selectedId }
  const selectedIndex = Math.max(0, props.entries.findIndex(entry => entry.id === selectedId))
  const selected = props.entries[selectedIndex]
  useInput((input, key) => {
    const state = live.current
    const entries = state.queue.getSnapshot()
    const index = Math.max(0, entries.findIndex(entry => entry.id === state.selectedId))
    const entry = entries[index]
    const command = commandInput(input, key)
    if (key.escape) { state.onCancel(); return }
    const select = (next: number) => {
      const id = entries[Math.max(0, Math.min(entries.length - 1, next))]?.id
      live.current.selectedId = id
      setSelectedId(id)
    }
    try {
      if (command === "q") {
        state.mode = state.mode === "queue" ? "steer" : "queue"
        state.onModeChange(state.mode)
        return
      }
      if (key.upArrow && !key.shift) { select(index - 1); return }
      if (key.downArrow && !key.shift) { select(index + 1); return }
      if (!entry) return
      if (command === "e") { state.onEdit(entry.id); return }
      if (command === "s") {
        if (!state.queue.steer(entry.id)) state.onError("Steer needs an active task and a pending non-command message.")
        return
      }
      if (command === "r") {
        if (!state.queue.retry(entry.id)) state.onError("Only failed messages can be retried.")
        return
      }
      if (command === "c") {
        const removed = state.queue.discardFailed()
        if (!removed) state.onError("No failed messages to clear.")
        return
      }
      if (command === "x" || key.delete || key.backspace) {
        if (!state.queue.remove(entry.id)) state.onError("A sending or editing message cannot be deleted.")
        return
      }
      if (command === "[" || (key.shift && key.upArrow)) state.queue.move(entry.id, -1)
      if (command === "]" || (key.shift && key.downArrow)) state.queue.move(entry.id, 1)
    } catch (error) { state.onError(error instanceof Error ? error.message : String(error)) }
  })

  // Leave space for the existing composer, live row, mode copy and shortcuts.
  // Observe height-only resizes too; Ink relayout alone does not rerender React.
  const count = Math.max(1, Math.min(5, Math.floor((height - 20) / 2)))
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(count / 2), props.entries.length - count))
  return <DialogFrame title="Follow-up messages · /queue" hint="↑↓ select · e edit · x delete · c clear failed · [/] move · s Steer · r retry · q toggle queuing · esc close">
    <Text color={c.text.faint}>{truncateToWidth(props.mode === "queue"
      ? "Queuing on · new messages wait for the current task to finish. Press q to turn off queuing."
      : "Queuing off · new messages Steer the active task at its next safe boundary. Press q to turn on queuing.", width)}</Text>
    {isQueuePaused(props.entries)
      ? <Text color={c.warning}>{truncateToWidth("Paused: a failed message blocks the ones behind it. Retry (r) or delete (x) it, or press c to clear every failed message and continue.", width)}</Text>
      : <Text color={c.text.faint}>{truncateToWidth("Changing the default does not send or discard existing messages.", width)}</Text>}
    <Box marginTop={1} flexDirection="column">
      {props.entries.slice(start, start + count).map((entry, i) => <Box key={entry.id} flexDirection="column">
        <Text color={entry.id === selected?.id ? c.accent : c.text.primary} bold={entry.id === selected?.id}>
          {truncateToWidth(`${entry.id === selected?.id ? "›" : " "} ${start + i + 1}. ${queuedCommandPreview(entry)}`, width)}
        </Text>
        <Text color={entry.state === "failed" || entry.state === "accepted" ? c.warning : c.text.faint}>
          {truncateToWidth(`  ${entry.mode === "steer" ? "Steer · waiting for a safe boundary" : "Queue · separate next turn"} · ${entry.state}`, width)}
        </Text>
      </Box>)}
      {!props.entries.length && <Text color={c.text.faint}>No pending messages. You can still change the default above.</Text>}
      {props.entries.length > count && <Text color={c.text.faint}>{start + 1}–{Math.min(start + count, props.entries.length)} of {props.entries.length}</Text>}
      {selected?.error && <Text color={c.warning}>{truncateToWidth(selected.error, width)}</Text>}
    </Box>
  </DialogFrame>
}

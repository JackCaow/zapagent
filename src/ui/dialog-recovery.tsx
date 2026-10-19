/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Text, useInput } from "ink"
import type {
  ProjectRecoveryCenter,
  RecoveryCenterEntry,
  RecoveryCenterSnapshot,
} from "../../zapsdk/index.js"
import { commandInput, isReturnInput } from "./controlled-input.js"
import { DialogFrame } from "./dialog-frame.js"
import { c } from "./theme.js"
import { truncateToWidth } from "./truncate.js"

type Phase = "loading" | "ready" | "merging" | "cleaning" | "pruning" | "error"
type PendingAction =
  | { kind: "merge"; entry: RecoveryCenterEntry }
  | { kind: "cleanup"; entry: RecoveryCenterEntry }
  | { kind: "prune" }

interface Props {
  center: ProjectRecoveryCenter
  onMutation?: (event: {
    type: "merge" | "cleanup" | "prune"
    message: string
  }) => void | Promise<void>
  onCancel: () => void
}

export function RecoveryDialog({ center, onMutation, onCancel }: Props) {
  const [snapshot, setSnapshot] = useState<RecoveryCenterSnapshot | null>(null)
  const [phase, setPhase] = useState<Phase>("loading")
  const [idx, setIdx] = useState(0)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setPhase("loading")
    setError(null)
    try {
      const next = await center.refresh()
      setSnapshot(next)
      setIdx((current) => Math.min(current, Math.max(0, next.entries.length - 1)))
      setPhase("ready")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPhase("error")
    }
  }, [center])

  useEffect(() => {
    let active = true
    setPhase("loading")
    center.refresh().then(
      (next) => {
        if (!active) return
        setSnapshot(next)
        setIdx((current) => Math.min(current, Math.max(0, next.entries.length - 1)))
        setPhase("ready")
      },
      (cause) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase("error")
      },
    )
    return () => { active = false }
  }, [center])

  const entries = snapshot?.entries ?? []
  const selected = entries[idx]
  const busy = phase === "loading" || phase === "merging" || phase === "cleaning" || phase === "pruning"

  useInput((input, key) => {
    const cmd = commandInput(input, key).toLowerCase()
    if (busy) return
    if (key.escape) {
      if (pending) { setPending(null); return }
      onCancel()
      return
    }
    if (pending) {
      if (cmd === "y") void executePending(pending)
      if (cmd === "n") setPending(null)
      return
    }
    if (key.upArrow && entries.length > 0) {
      setIdx((current) => (current - 1 + entries.length) % entries.length)
      setMessage(null)
      return
    }
    if (key.downArrow && entries.length > 0) {
      setIdx((current) => (current + 1) % entries.length)
      setMessage(null)
      return
    }
    if (cmd === "r") { void refresh(); return }
    if (cmd === "p") { setPending({ kind: "prune" }); return }
    if (!selected) return
    if ((cmd === "m" || isReturnInput(input, key)) && selected.action === "merge") {
      setPending({ kind: "merge", entry: selected })
      return
    }
    if ((cmd === "d" || isReturnInput(input, key)) && selected.action === "cleanup") {
      setPending({ kind: "cleanup", entry: selected })
    }
  })

  async function executePending(action: PendingAction): Promise<void> {
    setPending(null)
    setError(null)
    setMessage(null)
    try {
      if (action.kind === "merge") {
        setPhase("merging")
        const result = await center.resumeMerge(
          action.entry.threadId,
          action.entry.artifactIds ?? [],
        )
        if (!result.success) throw new Error(result.error ?? "Recovered artifact merge was blocked")
        const text = `Merged ${result.artifactIds.length} recovered artifact${result.artifactIds.length === 1 ? "" : "s"}`
        await onMutation?.({ type: "merge", message: text })
        setMessage(text)
      } else if (action.kind === "cleanup") {
        setPhase("cleaning")
        await center.cleanupBatch(
          action.entry.threadId,
          action.entry.batchPath ?? "",
          true,
        )
        const text = "Recovered workspace batch removed"
        await onMutation?.({ type: "cleanup", message: text })
        setMessage(text)
      } else {
        setPhase("pruning")
        const report = await center.sweepRetention(true)
        const text = report.removed.length === 0
          ? "Retention sweep complete; no eligible batches"
          : `Retention removed ${report.removed.length} batch${report.removed.length === 1 ? "" : "es"} (${formatBytes(report.beforeBytes - report.afterBytes)})`
        await onMutation?.({ type: "prune", message: text })
        setMessage(text)
      }
      const next = await center.refresh()
      setSnapshot(next)
      setIdx((current) => Math.min(current, Math.max(0, next.entries.length - 1)))
      setPhase("ready")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPhase("error")
    }
  }

  const hint = pending
    ? confirmationHint(pending)
    : busy
      ? `${phase}…`
      : "↑/↓ select  ⏎ action  m merge  d discard  p prune  r refresh  esc close"
  const retention = snapshot?.retention
  const visible = useMemo(() => visibleEntries(entries, idx, 9), [entries, idx])
  const rowWidth = Math.max(32, (process.stdout.columns ?? 100) - 8)

  return (
    <DialogFrame
      title="Runtime Recovery Center"
      hint={hint}
      accentColor={pending || phase === "error" ? c.warning : undefined}
    >
      <Box flexDirection="column">
        {retention && (
          <Text color={retention.overQuota ? c.warning : c.text.faint}>
            {`${retention.afterBatches}/${retention.policy.maxBatches} batches · ${formatBytes(retention.afterBytes)}/${formatBytes(retention.policy.maxBytes)} · TTL ${formatTtl(retention.policy.ttlMs)}`}
          </Text>
        )}
        {phase === "loading" && !snapshot && <Text color={c.text.muted}>Scanning runtime state and workspace markers…</Text>}
        {snapshot && entries.length === 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color={c.success}>No interrupted artifacts or workspaces need attention.</Text>
            <Text color={c.text.faint}>Retention still runs automatically before the next isolated Agent workspace.</Text>
          </Box>
        )}
        {visible.map(({ entry, index }) => {
          const active = index === idx
          return (
            <Box key={entry.id} marginTop={1} flexDirection="column">
              <Text color={active ? c.text.primary : statusColor(entry.status)} bold={active}>
                {`${active ? "◆" : "◇"} ${actionLabel(entry.action)} ${entry.title} · ${entry.status}`}
              </Text>
              <Text color={c.text.faint}>
                {`  ${truncateToWidth(entry.detail, rowWidth)}`}
              </Text>
            </Box>
          )
        })}
        {entries.length > 9 && <Text color={c.text.faint}>{`  ${idx + 1}/${entries.length}`}</Text>}
        {pending && (
          <Box marginTop={1}>
            <Text color={c.warning}>{pendingWarning(pending)}</Text>
          </Box>
        )}
        {message && <Text color={c.success}>{`✓ ${message}`}</Text>}
        {error && <Text color={c.error}>{`✗ ${error}`}</Text>}
        {retention && retention.skipped.length > 0 && (
          <Text color={c.warning}>{`${retention.skipped.length} unsafe/unreadable batch entr${retention.skipped.length === 1 ? "y" : "ies"} skipped`}</Text>
        )}
      </Box>
    </DialogFrame>
  )
}

function visibleEntries(entries: RecoveryCenterEntry[], idx: number, max: number) {
  const start = Math.max(0, Math.min(idx - Math.floor(max / 2), entries.length - max))
  return entries.slice(start, start + max).map((entry, offset) => ({ entry, index: start + offset }))
}

function actionLabel(action: RecoveryCenterEntry["action"]): string {
  if (action === "merge") return "[merge]"
  if (action === "cleanup") return "[discard]"
  return "[inspect]"
}

function statusColor(status: string): string {
  if (status.includes("ready") || status.includes("preserved")) return c.accent
  if (status.includes("blocked") || status.includes("missing") || status.includes("failed")) return c.error
  return c.text.muted
}

function confirmationHint(action: PendingAction): string {
  if (action.kind === "merge") return "Apply recovered artifact changes to the root workspace? y / n"
  if (action.kind === "cleanup") return "Permanently discard this recovered workspace batch? y / n"
  return "Enforce TTL/quota and remove eligible ownerless batches? y / n"
}

function pendingWarning(action: PendingAction): string {
  if (action.kind === "merge") return "Merge is transactional and will stop on root drift or file conflicts."
  if (action.kind === "cleanup") return "This deletes preserved Agent files and cannot be undone."
  return "Protected artifacts and live owners will not be removed."
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function formatTtl(ttlMs: number): string {
  const days = ttlMs / (24 * 60 * 60_000)
  return days >= 1 ? `${days.toFixed(days % 1 === 0 ? 0 : 1)}d` : `${Math.round(ttlMs / 3_600_000)}h`
}

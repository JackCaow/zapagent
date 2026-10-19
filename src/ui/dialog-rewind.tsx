/** @jsxImportSource react */
// /rewind — select code, conversation, or both. Conversation restoration
// commits a durable marker so /load cannot replay the abandoned branch;
// code-only restoration keeps that branch and its recovery points.
import { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput } from "ink"
import type { CheckpointManager } from "../../zapsdk/checkpoint/index.js"
import type { Snapshot, DiffStats, RewindMode, RewindResult } from "../../zapsdk/checkpoint/types.js"
import { appendRewindMarkerDurable } from "../session.js"
import type { LogEntry } from "./types.js"
import { DialogFrame } from "./dialog-frame.js"
import { c } from "./theme.js"
import { truncateToWidth } from "./truncate.js"
import { commandInput, isReturnInput } from "./controlled-input.js"

interface Props {
  isRunning?: boolean
  checkpoint: CheckpointManager
  logs: LogEntry[]
  /** Caller receives both the UI-truncated logs AND the snapshot that was
   *  applied — needed so the App can also truncate the in-memory
   *  ConversationManager via `snap.turnStartIndex`. Without that the next
   *  turn's `agent.run()` would serialize the rewound-away history back
   *  to the model and the model's context would diverge from the file state. */
  onApply: (truncatedLogs: LogEntry[], snap: Snapshot, mode: RewindMode, result: RewindResult) => void
  onCancel: () => void
}

/** Resolve the rendered transcript boundary independently from the persisted
 *  JSONL boundary. New snapshots carry an exact UI count. Restored legacy
 *  snapshots are translated through the per-row journal ranges attached by
 *  dialog-sessions; live legacy snapshots conservatively keep the UI intact. */
export function resolveRewindUiCutoff(logs: readonly LogEntry[], snap: Snapshot): number {
  if (typeof snap.uiLogIndex === "number" && Number.isFinite(snap.uiLogIndex)) {
    return Math.min(logs.length, Math.max(0, Math.floor(snap.uiLogIndex)))
  }
  const journalCutoff = snap.journalLogIndex ?? snap.logIndex
  if (typeof journalCutoff !== "number" || !Number.isFinite(journalCutoff)) return logs.length

  let mapped = false
  let cutoff = 0
  for (const log of logs) {
    const start = log.journalStartIndex
    const end = log.journalEndIndex
    if (typeof start !== "number" || typeof end !== "number") break
    mapped = true
    const belongsBeforeBoundary = log.type === "divider"
      ? start <= journalCutoff
      : end <= journalCutoff
    if (!belongsBeforeBoundary) break
    cutoff++
  }
  return mapped ? cutoff : logs.length
}

export function RewindDialog({ checkpoint, logs, onApply, onCancel, isRunning }: Props) {
  const snapshots = useMemo(() => checkpoint.listSnapshots(), [checkpoint])
  const diag = useMemo(() => checkpoint.getDiagnostics(), [checkpoint])
  const [idx, setIdx] = useState(snapshots.length - 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [mode, setMode] = useState<RewindMode>("both")
  // Lazy-loaded diff preview: populated when the user enters the confirm
  // state. Resets to null on selection change so the preview always reflects
  // the currently-highlighted snapshot.
  const [dryRun, setDryRun] = useState<DiffStats | null>(null)
  const [dryRunErr, setDryRunErr] = useState<string | null>(null)

  // Compute the dry-run when entering the confirm step. Async + effect (not
  // inline in the key handler) so a slow rewindDryRun doesn't block input.
  useEffect(() => {
    if (!confirming) return
    const snap = snapshots[idx]
    if (!snap) return
    let cancelled = false
    setDryRun(null); setDryRunErr(null)
    checkpoint.rewindDryRun(snap.id).then(
      (stats) => { if (!cancelled) { setDryRun(stats); setMode(stats.filesChanged.length ? "both" : "conversation") } },
      (e) => { if (!cancelled) setDryRunErr(e instanceof Error ? e.message : String(e)) },
    )
    return () => { cancelled = true }
  }, [confirming, idx, checkpoint, snapshots])

  useInput((input, key) => {
    const cmd = commandInput(input, key)
    if (busy) return
    if (key.escape) {
      if (confirming) { setConfirming(false); setDryRun(null); setDryRunErr(null); return }
      onCancel()
      return
    }
    if (snapshots.length === 0) return
    if (key.upArrow)   { setIdx(i => (i - 1 + snapshots.length) % snapshots.length); setConfirming(false); return }
    if (key.downArrow) { setIdx(i => (i + 1) % snapshots.length);                    setConfirming(false); return }
    if (isReturnInput(input, key) && !confirming) { setConfirming(true); return }
    if (cmd === "n" && confirming) { setConfirming(false); setDryRun(null); setDryRunErr(null); return }
    if (confirming && ["1", "2", "3"].includes(cmd)) {
      const next = cmd === "1" ? "both" : cmd === "2" ? "conversation" : "code";
      if (availableRewindModes(dryRun).includes(next)) setMode(next);
      return;
    }
    if (cmd === "y" && confirming && availableRewindModes(dryRun).includes(mode)) { void apply(); return }
  })

  async function apply() {
    const snap = snapshots[idx]
    if (!snap) return
    if (isRunning) { setError("Stop the current task before restoring a recovery point."); return }
    setBusy(true)
    try {
      const journalCutoff = snap.journalLogIndex ?? snap.logIndex
      const result = await checkpoint.rewind(snap.id, {
        mode,
        ...(mode !== "code" ? { finalize: () => appendRewindMarkerDurable(snap.turnStartIndex, journalCutoff, snap.id) } : {}),
      })
      if (result.failed.length > 0) {
        setError(`Failed: ${result.failed.map(f => `${f.path}: ${f.error}`).join("; ")}`)
        setBusy(false)
        return
      }
      // UI and JSONL have different row cardinalities: dividers are UI-only,
      // while restored streaming chunks collapse into one rendered row.
      const cutoff = resolveRewindUiCutoff(logs, snap)
      const next = mode === "code" ? logs : logs.slice(0, cutoff)
      onApply(next, snap, mode, result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (snapshots.length === 0) {
    // Distinguish the three "no snapshots" cases so the user actually knows
    // why /rewind is empty:
    //   1. Checkpointing disabled in config
    //   2. Edits pending — turn is still running, snapshot will commit
    //      when it finishes
    //   3. Nothing edited yet — no write-class tool has fired in this
    //      session (also explains bash's untracked status so users with
    //      `sed -i` workflows aren't surprised)
    const headline = diag.maxSnapshots === 0
      ? "Recovery points are disabled (maxSnapshots is zero)."
      : !diag.enabled
      ? "File tracking is disabled; conversation recovery remains available for new turns."
      : diag.pendingCount > 0
        ? `${diag.pendingCount} file${diag.pendingCount === 1 ? "" : "s"} pending — snapshot commits when this turn ends.`
        : "No recovery points yet."
    return (
      <DialogFrame title="Rewind" hint="esc close">
        <Box flexDirection="column">
          <Text color={c.text.muted}>{headline}</Text>
          {diag.enabled && diag.pendingCount === 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color={c.text.faint}>Recovery points are created before each turn. File undo covers:</Text>
              <Text color={c.text.faint}>  write_file · edit_file · multi_edit · delete_file · move_file</Text>
              <Text color={c.text.faint}>File edits via bash (sed -i, cat &gt; …) are not tracked.</Text>
            </Box>
          )}
          <Text color={c.text.faint}>{`\nsession=${diag.sessionId.slice(0, 8)} · snapshots=${diag.snapshotCount} · pending=${diag.pendingCount}`}</Text>
        </Box>
      </DialogFrame>
    )
  }

  const VISIBLE = 8
  const start = Math.max(0, Math.min(idx - Math.floor(VISIBLE / 2), snapshots.length - VISIBLE))
  const visible = snapshots.slice(start, start + VISIBLE)

  const hint = busy
    ? "applying…"
    : confirming
      ? "1 both · 2 conversation · 3 code · y apply · n back"
      : "↑/↓ select  ⏎ rewind  esc cancel"

  return (
    <DialogFrame title="Rewind" hint={hint} accentColor={confirming || busy ? c.warning : undefined}>
      <Box flexDirection="column">
        {visible.map((snap, i) => {
          const real = start + i
          const active = real === idx
          const fileCount = Object.keys(snap.trackedFiles).length
          return (
            <Box key={snap.id}>
              <Text color={active ? c.text.primary : c.text.muted}>
                {summarizeSnapshot(snap, fileCount, logs)}
              </Text>
            </Box>
          )
        })}
        {snapshots.length > VISIBLE && (
          <Text color={c.text.faint}>{`  ${idx + 1}/${snapshots.length}`}</Text>
        )}
        <Text color={c.text.faint}>Bash, external processes and untracked changes are not restored.</Text>
        {confirming && <>
          <Text color={c.accent}>{`Restore: ${mode === "both" ? "code and conversation" : mode === "code" ? "code only (keep conversation)" : "conversation only (keep current code)"}`}</Text>
          {dryRun && dryRun.filesChanged.length === 0 && <Text color={c.text.faint}>No tracked code changes at this point; conversation restore is available.</Text>}
          {(snapshots.slice(idx).flatMap(s => s.skippedFiles ?? []).length > 0) && <Text color={c.warning}>Some file changes were not captured; only tracked files can be restored.</Text>}
          <DryRunPreview stats={dryRun} error={dryRunErr} />
        </>}
        {error && <Text color={c.error}>{`✗ ${error}`}</Text>}
      </Box>
    </DialogFrame>
  )
}

/** Renders the file-by-file diff summary the user is about to apply. Top 6
 *  files shown verbatim; the rest collapse into "+N more". Binary files
 *  render with `bin` instead of insertion/deletion counts. Loading + error
 *  states are handled here so the parent can stay a flat render. */
function DryRunPreview({ stats, error }: { stats: DiffStats | null; error: string | null }) {
  if (error) {
    return (
      <Box marginTop={1}>
        <Text color={c.error}>{`Could not compute preview: ${error}`}</Text>
      </Box>
    )
  }
  if (!stats) {
    return (
      <Box marginTop={1}>
        <Text color={c.text.faint}>Computing diff…</Text>
      </Box>
    )
  }
  const files = stats.filesChanged
  if (files.length === 0) {
    return (
      <Box marginTop={1}>
        <Box flexDirection="column">
          <Text color={c.text.faint}>No tracked files will change.</Text>
          {stats.skippedFiles?.slice(0, 6).map(file => <Text key={file.path} color={c.warning}>{`Skipped: ${file.path} (${file.reason})`}</Text>)}
        </Box>
      </Box>
    )
  }
  const MAX = 6
  const visible = files.slice(0, MAX)
  const extra = files.length - visible.length
  return (
    <Box marginTop={1} flexDirection="column">
      {stats.skippedFiles?.map(file => <Text key={file.path} color={c.warning}>{`Skipped: ${file.path} (${file.reason})`}</Text>)}
      <Text color={c.accent}>
        {`Will revert ${files.length} file${files.length === 1 ? "" : "s"}`}
        {(stats.totalInsertions > 0 || stats.totalDeletions > 0) &&
          ` (+${stats.totalInsertions} −${stats.totalDeletions})`}
        :
      </Text>
      {visible.map((f) => (
        <Box key={f.path}>
          <Text color={c.text.faint}>  </Text>
          <Text color={c.text.muted}>
            {f.binary
              ? `${f.path}  (binary)`
              : `${f.path}  +${f.insertions} −${f.deletions}`}
          </Text>
        </Box>
      ))}
      {extra > 0 && (
        <Text color={c.text.faint}>{`  …+${extra} more`}</Text>
      )}
    </Box>
  )
}

/** Snapshot row label. Format: `HH:MM:SS  N files  · "user prompt that
 *  started this turn"`. The prompt preview starts at the exact rendered UI
 *  boundary when available, or at the journal-to-UI mapped cutoff for restored
 *  snapshots. Truncation is display-width aware (CJK glyphs count as 2 cells)
 *  so the row doesn't blow out the dialog width on Chinese prompts.
 *
 *  Falls back to `turn N` when no user log can be found at that position —
 *  happens for legacy snapshots without `logIndex` and for the edge case
 *  where the first turn's snapshot indexes past the live `logs` slice
 *  (e.g. partial restore). */
function summarizeSnapshot(snap: Snapshot, fileCount: number, logs: LogEntry[]): string {
  const t = snap.timestamp.includes("T")
    ? snap.timestamp.slice(11, 19)
    : snap.timestamp
  const fileLabel = `${fileCount} file${fileCount === 1 ? "" : "s"}`
  const prompt = findOriginatingUserPrompt(snap, logs)
  // Budget: dialog inner width minus chrome (≈12 chars: `▸ HH:MM:SS  N files  · `).
  const termWidth = process.stdout.columns ?? 80
  const promptBudget = Math.max(20, termWidth - 4 /* dialog border */ - 24 /* row chrome */)
  if (prompt) {
    return `${t}  ${fileLabel}  · ${truncateToWidth(prompt, promptBudget)}`
  }
  return `${t}  ${fileLabel}  · turn ${snap.turnStartIndex}`
}

/** Walk forward from the rendered pre-turn boundary looking for the user-typed message
 *  that started this turn. Skips `task-notification` synthesized turns
 *  (those are background-task completion XML, not human input — not
 *  what the user would recognise). */
export function findOriginatingUserPrompt(snap: Snapshot, logs: LogEntry[]): string | null {
  const hasExactUiBoundary = typeof snap.uiLogIndex === "number" && Number.isFinite(snap.uiLogIndex)
  const hasMappedJournalBoundary = typeof (snap.journalLogIndex ?? snap.logIndex) === "number"
  if (!hasExactUiBoundary && !hasMappedJournalBoundary) return snap.prompt ?? null
  const start = resolveRewindUiCutoff(logs, snap)
  // Cheap bounded forward scan — turn-starter is almost always exactly at
  // snap.logIndex; the loop is a safety net for the rare case where a
  // system-injected entry slipped in between.
  for (let i = start; i < Math.min(logs.length, start + 4); i++) {
    const log = logs[i]
    if (log?.type !== "user" || !log.text) continue
    // Strip [Image #N] markers + collapse whitespace + take first non-blank line.
    const cleaned = log.text.replace(/\[Image #\d+\]/g, "").replace(/\s+/g, " ").trim()
    if (cleaned) return cleaned
  }
  return snap.prompt ?? null
}


export function availableRewindModes(stats: DiffStats | null): RewindMode[] {
  return stats && stats.filesChanged.length > 0 ? ["both", "conversation", "code"] : ["conversation"];
}

export function rewindDraft(snap: Snapshot, logs: readonly LogEntry[]): { text: string; imageRefs: Record<string, string> } {
  const start = resolveRewindUiCutoff(logs, snap);
  const original = logs.slice(start, start + 4).find(log => log.type === "user" && log.text);
  const text = original?.restoreText ?? original?.text ?? snap.prompt ?? "";
  const ids = [...text.matchAll(/\[Image #(\d+)\]/g)].map(match => match[1]!);
  const imageRefs: Record<string, string> = {};
  original?.images?.forEach((image, index) => { if (ids[index]) imageRefs[ids[index]!] = image.filePath; });
  return { text, imageRefs };
}

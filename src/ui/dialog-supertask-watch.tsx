/** @jsxImportSource react */
// /supertask watch — live TUI showing supertask runner progress.
//
// Polls state files (meta.json / prd.json / iter.txt / runner.pid /
// iter_NN.out) every 1.5s and re-renders. Reads git log from the project
// directory for the "recent commits" pane. Esc / q / Enter dismisses.
//
// This dialog is read-only — it never writes to state files and never
// signals the runner. Closing it has no effect on the supertask itself.

import { useEffect, useState, type ReactNode } from "react"
import { Box, Text, useInput } from "ink"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  findResumable,
  listSupertasks,
  readMeta,
  readPrd,
  readIter,
  readRunnerPid,
  isRunnerAlive,
  type SupertaskRef,
  progressSummary,
  estimateEta,
  formatDuration,
  tailNonEmpty,
  truncateLine,
  cleanActivityLine,
  cleanCommitLine,
} from "../../zapsdk/supertask/index.js"
import { RALPH_DEFAULT_MAX_ITER } from "../../zapsdk/supertask/index.js"
import { c } from "./theme.js"
import { commandInput, isReturnInput } from "./controlled-input.js"

interface Props {
  cwd: string
  onCancel: () => void
}

interface Snapshot {
  ref: SupertaskRef | null
  status: string
  desc: string
  iter: number
  passed: number
  total: number
  remaining: number
  current?: { id: string; title: string }
  alive: boolean
  pid: number | null
  elapsedSec: number
  etaSec: number | null
  commits: string[]
  recentActivity: string[]
  prdMissing: boolean
}

const POLL_MS = 1500
const ACTIVITY_LINES = 4
const COMMIT_LINES = 5
/** Visual width of the dialog's framed area — header bar + dividers + row
 *  content all live inside this column budget. Previously the header used
 *  flexGrow without a width cap, which on wide terminals shoved the status
 *  label hundreds of columns from the title and left a giant dead zone
 *  between them. 76 fits comfortably on 80-col terminals and leaves room
 *  for inline truncation on longer goal/title text. */
const PANEL_WIDTH = 76

function loadSnapshot(cwd: string): Snapshot {
  // Prefer a still-resumable task (running / blocked / max_iter / failed);
  // otherwise fall back to the most recent of any status (done / aborted)
  // so watch can still serve as a post-mortem viewer, not just a live one.
  const ref = findResumable(cwd) ?? listSupertasks(cwd)[0] ?? null
  if (!ref) {
    return {
      ref: null,
      status: "(none)",
      desc: "no supertask history in this directory",
      iter: 0,
      passed: 0,
      total: 0,
      remaining: 0,
      alive: false,
      pid: null,
      elapsedSec: 0,
      etaSec: null,
      commits: [],
      recentActivity: [],
      prdMissing: true,
    }
  }
  // Re-read meta fresh — desc never changes, but status flips when the
  // runner exits (done / max_iter / aborted / blocked). findUnfinished
  // already gave us the in-memory copy; reading again is cheap and picks
  // up the runner's status flips.
  let status = ref.meta.status
  let desc = ref.meta.desc
  let createdAt = ref.meta.created_at
  try {
    const meta = readMeta(ref.dir)
    status = meta.status
    desc = meta.desc
    createdAt = meta.created_at
  } catch { /* meta.json gone — leave fields at last known. */ }

  const iter = readIter(ref.dir)
  const pid = readRunnerPid(ref.dir)
  const alive = isRunnerAlive(ref.dir)

  const prd = readPrd(ref.dir)
  const summary = prd ? progressSummary(prd) : { passed: 0, total: 0, remaining: 0, next: undefined }
  const eta = estimateEta({
    createdAt,
    iter,
    passed: summary.passed,
    total: summary.total,
  })

  return {
    ref,
    status,
    desc,
    iter,
    passed: summary.passed,
    total: summary.total,
    remaining: summary.remaining,
    current: summary.next,
    alive,
    pid,
    elapsedSec: eta.elapsedSec,
    etaSec: eta.etaSec,
    commits: loadRecentCommits(cwd),
    recentActivity: loadRecentActivity(ref.dir, iter),
    prdMissing: prd === null,
  }
}

function loadRecentActivity(stateDir: string, iter: number): string[] {
  // Look at the current iter's captured output first; fall back to the
  // previous iter if the current one hasn't been written yet (the runner
  // creates iter_NN.out only after the bun child writes its first byte).
  for (let i = iter; i >= Math.max(1, iter - 1); i--) {
    const p = join(stateDir, `iter_${String(i).padStart(2, "0")}.out`)
    if (!existsSync(p)) continue
    let content = ""
    try {
      // Cap the read to the last ~16KB — iter_NN.out can grow large and
      // we only ever surface the last few lines.
      const st = statSync(p)
      const start = Math.max(0, st.size - 16_384)
      const fd = readFileSync(p, "utf-8")
      content = start === 0 ? fd : fd.slice(start)
    } catch { continue }
    const lines = tailNonEmpty(content, ACTIVITY_LINES)
    if (lines.length > 0) return lines
  }
  return []
}

function loadRecentCommits(projectDir: string): string[] {
  // git log can fail in many ways: not a repo, no commits yet, git missing.
  // Treat every error as "no commits to show" — never crash the dialog.
  try {
    const out = execFileSync(
      "git",
      ["-C", projectDir, "log", "--oneline", "--no-color", `-n`, String(COMMIT_LINES)],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 },
    )
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  } catch {
    return []
  }
}

function statusColor(status: string, alive: boolean): string {
  if (status === "done") return c.success
  if (status === "failed" || status === "blocked" || status === "aborted") return c.error
  if (status === "max_iter") return c.warning
  if (status === "running" && !alive) return c.warning
  return c.success
}

/** ms between shimmer-cell advances on the progress bar. ~150ms is the
 *  sweet spot — fast enough to read as motion, slow enough not to thrash
 *  the terminal or distract the eye. */
const SHIMMER_MS = 150

export function SupertaskWatchDialog({ cwd, onCancel }: Props) {
  const [snap, setSnap] = useState<Snapshot>(() => loadSnapshot(cwd))
  /** Monotonically increasing tick driving the progress-bar shimmer.
   *  Modded by passed-count to pick which filled cell glows this frame.
   *  Only ticks while runner is alive — terminal states (done/blocked/
   *  aborted/max_iter/failed) render a static bar so nothing distracts
   *  from "this run is finished" semantics. */
  const [shimmerTick, setShimmerTick] = useState(0)

  useInput((input, key) => {
    const cmd = commandInput(input, key)
    if (key.escape || isReturnInput(input, key) || cmd === "q") onCancel()
  })

  useEffect(() => {
    // Hide native cursor for the duration of the panel — matches StatusDialog.
    process.stderr.write("\x1b[?25l")
    const tick = () => setSnap(loadSnapshot(cwd))
    const id = setInterval(tick, POLL_MS)
    return () => clearInterval(id)
  }, [cwd])

  useEffect(() => {
    // Shimmer only when the runner is actually iterating — otherwise the
    // moving glow falsely implies progress is being made. The condition
    // is re-evaluated whenever `snap.alive` flips (e.g. runner crashed
    // mid-view → shimmer freezes).
    if (!snap.alive) return
    const id = setInterval(() => setShimmerTick((t) => (t + 1) >>> 0), SHIMMER_MS)
    return () => clearInterval(id)
  }, [snap.alive])

  // `bar` is no longer needed here — ProgressRow builds its own colored
  // segments. Kept progressBar() in the SDK for static callers and tests.
  const statusText = snap.alive ? snap.status : (snap.status === "running" ? `${snap.status} · runner gone` : snap.status)
  const sColor = statusColor(snap.status, snap.alive)

  const etaText = snap.etaSec === null
    ? (snap.prdMissing ? "(planner running)" : "—")
    : (snap.etaSec === 0 ? "done" : `~${formatDuration(snap.etaSec)}`)

  if (!snap.ref) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={c.accent} bold>🧭 Supertask watch</Text>
        <Text color={c.text.muted}>No supertask history in this directory.</Text>
        <Box marginTop={1}>
          <Text color={c.text.faint}>esc / ⏎ / q  close</Text>
        </Box>
      </Box>
    )
  }

  return (
    // Single, consistent left margin for every line inside the dialog.
    // Earlier revisions had three competing indents (paddingLeft={1},
    // per-Row "  " prefix, divider "" prefix, body "    " prefix) which
    // produced visible left-edge stair-stepping. Everything now sits at
    // paddingLeft={2}; body lines under a section header get a single
    // extra "  " (2-space) prefix to nest under their header.
    <Box flexDirection="column" paddingLeft={2}>
      {/* Header: title left, status right — pinned to a fixed PANEL_WIDTH
          so the status sits at the right edge of the divider, not the right
          edge of the terminal. Without the width cap, wide terminals open
          a huge dead zone between the title and the status word, which
          reads as "two disconnected UIs" instead of "one panel". */}
      <Box width={PANEL_WIDTH}>
        <Text color={c.accent} bold>🧭 Supertask </Text>
        <Box flexGrow={1}>
          <Text color={c.text.muted}>· {snap.ref.id}</Text>
        </Box>
        <Text color={sColor}>{statusText}</Text>
      </Box>

      <Row label="goal:    " value={truncateLine(snap.desc, 80)} />
      {snap.total > 0 ? (
        <ProgressRow
          passed={snap.passed}
          total={snap.total}
          iter={snap.iter}
          maxIter={RALPH_DEFAULT_MAX_ITER}
          shimmer={snap.alive ? shimmerTick : null}
        />
      ) : (
        <Row label="progress:" value={snap.prdMissing ? "planner still drafting prd.json" : "no stories planned"} />
      )}
      {snap.current && (
        <Row label="current: " value={`${snap.current.id} — ${truncateLine(snap.current.title, 60)}`} />
      )}
      <Row
        label="elapsed: "
        value={`${formatDuration(snap.elapsedSec)} · ETA ${etaText}`}
      />
      <Row
        label="runner:  "
        value={snap.alive ? `alive (pid ${snap.pid})` : snap.pid ? `dead (stale pid ${snap.pid})` : "not running"}
      />

      <Text color={c.text.faint}> </Text>
      <Text color={c.text.primary}>recent commits (project):</Text>
      {snap.commits.length === 0 ? (
        <Text color={c.text.ghost}>{"  "}(none yet)</Text>
      ) : (
        snap.commits.map((line, i) => (
          <Text key={i} color={c.text.muted}>{`  ${truncateLine(cleanCommitLine(line), 72)}`}</Text>
        ))
      )}

      <Text color={c.text.faint}> </Text>
      <Text color={c.text.primary}>recent activity (iter {snap.iter}):</Text>
      {snap.recentActivity.length === 0 ? (
        <Text color={c.text.ghost}>{"  "}(no streaming output captured yet)</Text>
      ) : (
        snap.recentActivity.map((line, i) => (
          <Text key={i} color={c.text.muted}>{`  ${truncateLine(cleanActivityLine(line, cwd), 72)}`}</Text>
        ))
      )}

      <Box marginTop={1}>
        <Text color={c.text.faint}>esc / ⏎ / q  close  ·  refreshes every {POLL_MS / 1000}s</Text>
      </Box>
    </Box>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  // 2-space prefix so the stats block reads as "body of the header bar",
  // matching the indent of commit / activity body lines. Without it the
  // stats hug the same column as the section headers (recent commits:,
  // recent activity:) and the panel loses its two-tier visual hierarchy.
  return (
    <Box>
      <Text color={c.text.faint}>{`  ${label}`}</Text>
      <Text color={c.text.muted}>{` ${value}`}</Text>
    </Box>
  )
}

const BAR_CELLS = 16
const FILLED_CHAR = "▰"
const EMPTY_CHAR = "░"

/** Progress row with a "scan-light" shimmer on the filled segment of the
 *  bar. When `shimmer` is a number, the cell at index `shimmer %
 *  passedCells` is rendered in `c.accent` (bright); siblings in the filled
 *  region stay in `c.success`. When `shimmer` is null (runner not alive),
 *  the whole filled region is static `c.success` — terminal states should
 *  not animate. Unfilled cells are always `c.text.faint`. */
function ProgressRow({
  passed,
  total,
  iter,
  maxIter,
  shimmer,
}: {
  passed: number
  total: number
  iter: number
  maxIter: number
  shimmer: number | null
}) {
  // Mirror progressBar()'s rounding so visual cell count matches what
  // tests / the SDK helper compute.
  const clamped = Math.max(0, Math.min(passed, total))
  const filled = total > 0 ? Math.round((clamped / total) * BAR_CELLS) : 0
  const empty = BAR_CELLS - filled
  // When shimmer is active AND we have at least one filled cell, pick the
  // glow position. Modulo by `filled` so it rotates only across painted
  // cells (a glow on an empty cell would look like the bar is shrinking).
  const glowIdx = (shimmer !== null && filled > 0) ? shimmer % filled : -1

  const filledCells: ReactNode[] = []
  for (let i = 0; i < filled; i++) {
    // Glow cell: white + bold against the olive-green filled cells. The
    // earlier pass used c.accent (a slightly-different green), which the
    // user reported as "color changed but no animation" — the two greens
    // were too close in luminance for the eye to track motion. White is
    // ~3× the luma contrast vs olive, so the scan reads as motion now.
    const isGlow = i === glowIdx
    filledCells.push(
      <Text
        key={`f${i}`}
        color={isGlow ? c.text.primary : c.success}
        bold={isGlow}
      >{FILLED_CHAR}</Text>,
    )
  }
  const emptySpan = empty > 0 ? EMPTY_CHAR.repeat(empty) : ""

  return (
    <Box>
      <Text color={c.text.faint}>  progress:</Text>
      <Text> </Text>
      {filledCells}
      <Text color={c.text.faint}>{emptySpan}</Text>
      <Text color={c.text.muted}>{`  ${passed}/${total} stories  (iter ${iter}/${maxIter})`}</Text>
    </Box>
  )
}

// View-state helpers for /supertask watch.
//
// All functions here are pure (no fs, no shell). They translate the on-disk
// state shapes from state.ts into the strings the TUI renders. Keeping them
// pure makes them unit-testable and keeps the React component focused on
// layout + polling, not arithmetic.

import type { Prd } from "./state.js";

/** Render a horizontal progress bar of `cells` columns. */
export function progressBar(passed: number, total: number, cells = 16): string {
  if (cells <= 0) return "";
  if (total <= 0) return "░".repeat(cells);
  const clamped = Math.max(0, Math.min(passed, total));
  const filled = Math.round((clamped / total) * cells);
  return "▰".repeat(filled) + "░".repeat(cells - filled);
}

/** Human-readable duration: "18m", "1h 12m", "47s". Always rounded down. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

export interface EtaInputs {
  /** ISO timestamp the supertask was created. */
  createdAt: string;
  /** Reference "now" — defaults to Date.now(). Injectable for tests. */
  nowMs?: number;
  /** Current iteration number from iter.txt (0 means planner phase). */
  iter: number;
  /** Stories that already have passes:true. */
  passed: number;
  /** Total stories in prd.json. */
  total: number;
}

export interface EtaResult {
  elapsedSec: number;
  /** Estimated seconds remaining, or null if there isn't enough signal yet
   *  (no iters elapsed, no stories planned, or 100% already passed). */
  etaSec: number | null;
  /** Avg seconds per completed iter — null if iter ≤ 0. */
  avgSecPerIter: number | null;
}

/** Estimate remaining time from elapsed/iter and remaining stories.
 *
 * Assumption: one story per iter (the runner's design target). Real iters
 * sometimes burn on failed checks and re-attempt, so this is a lower bound,
 * not a guarantee. We round generously and the UI labels it as an estimate. */
export function estimateEta(inp: EtaInputs): EtaResult {
  const now = inp.nowMs ?? Date.now();
  const startMs = Date.parse(inp.createdAt);
  const elapsedSec = Number.isFinite(startMs) ? Math.max(0, Math.floor((now - startMs) / 1000)) : 0;

  if (inp.iter <= 0 || inp.total <= 0) {
    return { elapsedSec, etaSec: null, avgSecPerIter: null };
  }
  const avgSecPerIter = elapsedSec / inp.iter;
  const remaining = Math.max(0, inp.total - inp.passed);
  if (remaining === 0) {
    return { elapsedSec, etaSec: 0, avgSecPerIter };
  }
  return { elapsedSec, etaSec: Math.floor(avgSecPerIter * remaining), avgSecPerIter };
}

/** Extract the last `n` non-empty lines from a captured iter output stream,
 *  trimming trailing whitespace. Empty input → empty array. */
export function tailNonEmpty(content: string, n: number): string[] {
  if (!content) return [];
  const lines = content.split("\n").map((l) => l.replace(/\s+$/, ""));
  const nonEmpty = lines.filter((l) => l.length > 0);
  return nonEmpty.slice(-Math.max(0, n));
}

/** Truncate a single line to `width` columns, replacing the overflow with
 *  an ellipsis. Naive byte-length truncation — fine for log lines, which
 *  are overwhelmingly ASCII tool-call summaries. */
export function truncateLine(line: string, width: number): string {
  if (width <= 1) return line.length > 0 ? "…" : "";
  if (line.length <= width) return line;
  return line.slice(0, width - 1) + "…";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compact a raw tool-call line from iter_NN.out so the watch dialog shows
 *  the useful part instead of repeated noise. The raw format is
 *  `→ ToolName(args)` (emitted by zap's headless text-mode formatter — see
 *  runHeadless.ts:223). The noise we strip:
 *    - `→ Bash(cd <projectDir> && <cmd>)` → `$ <cmd>` (agents commonly cd
 *      into project root before running anything; that prefix is identical
 *      every line and shoves the actual command past the right edge)
 *    - `→ Read(/abs/path/under/projectDir/foo.ts)` → `read foo.ts`
 *    - other tools: lowercase the tool name, drop the wrapping parens
 *  Lines that don't match the arrow format pass through unchanged. */
export function cleanActivityLine(raw: string, projectDir: string): string {
  const arrow = raw.match(/^→\s+(\w+)\((.*)\)\s*$/);
  if (!arrow) return raw;
  const tool = arrow[1]!;
  let arg = arrow[2]!;
  const pathRe = new RegExp(escapeRegex(projectDir + "/"), "g");
  if (tool === "Bash") {
    // Step 1: strip a `cd <projectDir>[/subpath] && ` prefix — agents
    // often prefix every command with cd into the project root. Path may
    // be bare or quoted; the subpath (if any) is captured up to whitespace
    // or the next quote.
    const cdRe = new RegExp(
      `^cd\\s+["']?${escapeRegex(projectDir)}(?:/[^\\s"']*)?["']?\\s*&&\\s*`,
    );
    arg = arg.replace(cdRe, "");
    // Step 2: strip any remaining absolute paths to the project from
    // mid-command (e.g., `cat /<projectDir>/app/foo` → `cat app/foo`,
    // `grep -n X /<projectDir>/src/y` → `grep -n X src/y`). This is the
    // pattern the screenshot exposed — agents pass full paths as args
    // instead of cd-ing first.
    arg = arg.replace(pathRe, "");
    return `$ ${arg}`;
  }
  // Other tools: same path-stripping; absolute paths are the only noise.
  arg = arg.replace(pathRe, "");
  return `${tool.toLowerCase()} ${arg}`;
}

/** Drop the `[supertask]` prefix from a commit subject line. The watch
 *  dialog is supertask-scoped; the prefix is true on every row and just
 *  pushes the story id + title past the right edge. Lines without the
 *  prefix pass through unchanged. */
export function cleanCommitLine(raw: string): string {
  // Match patterns like "<sha> [supertask] [US-001] title" or
  // "<sha> [supertask] mark passes" (no story tag) and yank the marker.
  return raw.replace(/^(\S+)\s+\[supertask\]\s+/, "$1 ");
}

export interface ProgressSummary {
  passed: number;
  total: number;
  remaining: number;
  next?: { id: string; title: string };
}

/** Wrap state.prdSummary into the shape the view consumes (next collapsed
 *  to just id+title; the full PrdStory has fields the panel doesn't need). */
export function progressSummary(prd: Prd): ProgressSummary {
  const passed = prd.userStories.filter((s) => s.passes).length;
  const total = prd.userStories.length;
  // Lowest-priority-number, stable. Mirrors what the iter agent picks.
  const next = prd.userStories
    .filter((s) => !s.passes)
    .reduce<{ id: string; title: string; priority: number } | undefined>(
      (acc, s) => (acc && acc.priority <= s.priority ? acc : { id: s.id, title: s.title, priority: s.priority }),
      undefined,
    );
  return {
    passed,
    total,
    remaining: total - passed,
    next: next ? { id: next.id, title: next.title } : undefined,
  };
}

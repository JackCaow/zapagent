// Helpers shared by edit_file and multi_edit. Currently: fuzzy line matching
// for "string not found" failures — when the model gives an `old_string` that
// doesn't match (whitespace drift, off-by-one newline, transcription typo),
// returning the closest candidates lets it self-correct in one round instead
// of going dark.

/**
 * Levenshtein distance with a cheap early-exit ceiling. Returns Infinity once
 * the running cost exceeds `ceiling`, which lets callers skip lines that
 * obviously can't make the cutoff.
 */
function levenshtein(a: string, b: string, ceiling: number): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > ceiling) return Infinity;
  if (m === 0) return n;
  if (n === 0) return m;

  // Single-row DP, swap so the inner loop is over the shorter string.
  const [s, t] = m < n ? [a, b] : [b, a];
  const sLen = s.length, tLen = t.length;
  let prev = new Array<number>(sLen + 1);
  let curr = new Array<number>(sLen + 1);
  for (let i = 0; i <= sLen; i++) prev[i] = i;

  for (let j = 1; j <= tLen; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    const tj = t.charCodeAt(j - 1);
    for (let i = 1; i <= sLen; i++) {
      const cost = s.charCodeAt(i - 1) === tj ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // deletion
        curr[i - 1] + 1,    // insertion
        prev[i - 1] + cost, // substitution
      );
      if (curr[i] < rowMin) rowMin = curr[i];
    }
    if (rowMin > ceiling) return Infinity;
    [prev, curr] = [curr, prev];
  }
  return prev[sLen];
}

export interface NearestLine {
  /** 1-based line number in the original buffer. */
  line: number;
  /** Trimmed line content (kept reasonable length for display). */
  content: string;
  /** Edit distance from the trimmed needle to the trimmed line. */
  distance: number;
}

/**
 * Find the n lines in `haystack` closest to `needle` by Levenshtein distance.
 *
 * Strategy:
 *  - Compare the needle's first non-empty trimmed line against each haystack
 *    line trimmed. Multi-line needles use just their first line — full needles
 *    against full lines would mostly return "1.0 distance, no match" noise.
 *  - Cheap pre-filter: keep only lines whose length is within ±2x the needle
 *    (avoids running DP on hundreds of obviously-different lines).
 *  - Then sort by distance and take top n. Drop candidates whose normalized
 *    distance > 0.5 — at that point they aren't really "close".
 */
export function nearestLines(needle: string, haystack: string, n = 3): NearestLine[] {
  const needleFirst = needle.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (needleFirst.length === 0) return [];

  const lines = haystack.split("\n");
  const needleLen = needleFirst.length;

  // Length-band pre-filter — discards trivially-different lines without the
  // DP cost. Keeps anything between half and double the needle's trimmed length.
  const candidates: Array<{ line: number; trimmed: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length < Math.max(1, Math.floor(needleLen / 2))) continue;
    if (trimmed.length > needleLen * 2 + 2) continue;
    candidates.push({ line: i + 1, trimmed });
  }

  // Distance ceiling: half the needle length. Anything past that isn't worth
  // surfacing and lets levenshtein early-exit aggressively.
  const ceiling = Math.max(2, Math.floor(needleLen / 2));
  const scored: NearestLine[] = [];
  for (const c of candidates) {
    const d = levenshtein(needleFirst, c.trimmed, ceiling);
    if (d === Infinity) continue;
    scored.push({
      line: c.line,
      content: c.trimmed.length > 100 ? c.trimmed.slice(0, 100) + "…" : c.trimmed,
      distance: d,
    });
  }

  scored.sort((a, b) => a.distance - b.distance || a.line - b.line);
  return scored.slice(0, n);
}

/** Render the nearest-lines list as a multi-line tail for an error message. */
export function renderNearestLines(matches: NearestLine[]): string {
  if (matches.length === 0) return "";
  const rows = matches.map(
    (m) => `  line ${m.line} (${m.distance} char${m.distance === 1 ? "" : "s"} off): ${JSON.stringify(m.content)}`,
  );
  return `\nClosest candidates in file:\n${rows.join("\n")}`;
}

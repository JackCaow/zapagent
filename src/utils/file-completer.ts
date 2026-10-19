import { readdirSync } from "node:fs"
import { join, relative } from "node:path"

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", ".next",
  ".cache", ".turbo", "__pycache__", ".venv", "venv", ".tox",
  "coverage", ".nyc_output", ".parcel-cache",
])

const MAX_ENTRIES = 2000
const CACHE_TTL = 30_000 // 30s

let cachedRoot = ""
let cachedFiles: string[] = []
let cachedAt = 0

function walk(root: string, dir: string, out: string[], depth: number): void {
  if (out.length >= MAX_ENTRIES || depth > 8) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(relative(root, full) + "/")
      walk(root, full, out, depth + 1)
    } else if (e.isFile()) {
      out.push(relative(root, full))
    }
  }
}

function getFileIndex(root: string): string[] {
  const now = Date.now()
  if (root === cachedRoot && cachedFiles.length > 0 && now - cachedAt < CACHE_TTL) {
    return cachedFiles
  }
  const files: string[] = []
  walk(root, root, files, 0)
  files.sort()
  cachedRoot = root
  cachedFiles = files
  cachedAt = now
  return files
}

/** Word-boundary character — chars after these get a match-bonus during
 *  scoring, matching the way VS Code / fzf treat `/`, `_`, `-`, `.`, ` ` as
 *  segment starts. Lowercase letters after an uppercase letter are also
 *  treated as boundaries (camelCase), checked separately during scoring. */
function isSeparator(ch: string): boolean {
  return ch === "/" || ch === "_" || ch === "-" || ch === "." || ch === " "
}

/** Lower-cased fuzzy-match scorer. Returns null when not all query chars
 *  fit in order; otherwise a non-negative score where higher = better.
 *  Bonuses:
 *    +30 first query char matches first target char
 *    +20 query char matches a word-boundary position (after / _ - . space)
 *    +20 query char matches a camelCase boundary (lower→Upper)
 *    +10 query char immediately follows the previous match (consecutive run)
 *     +5 every other matching char
 *  Penalties:
 *    −1 per skipped (unmatched) target char
 *
 *  Result: short, dense, boundary-aligned matches outscore long, scattered
 *  ones. Same shape as fzy's bonus table, tuned smaller. */
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  let qi = 0
  let score = 0
  let lastMatch = -1
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    const qc = query.charCodeAt(qi)
    const tc = target.charCodeAt(ti)
    const tcLower = tc >= 65 && tc <= 90 ? tc + 32 : tc
    if (qc === tcLower) {
      let bonus = 5
      if (qi === 0 && ti === 0) bonus += 30
      const prev = ti > 0 ? target.charAt(ti - 1) : ""
      if (ti === 0 || isSeparator(prev)) bonus += 20
      // CamelCase boundary: previous char lowercase, current uppercase.
      const tcRaw = target.charCodeAt(ti)
      const prevCode = ti > 0 ? target.charCodeAt(ti - 1) : 0
      if (tcRaw >= 65 && tcRaw <= 90 && prevCode >= 97 && prevCode <= 122) bonus += 20
      if (lastMatch === ti - 1) bonus += 10
      score += bonus
      lastMatch = ti
      qi++
    } else if (lastMatch >= 0) {
      score -= 1
    }
  }
  if (qi < query.length) return null
  return score
}

/** basename(path) — last segment, with the trailing slash stripped for
 *  directories so the scorer treats `src/` and `src` equivalently. */
function basename(path: string): string {
  const stripped = path.endsWith("/") ? path.slice(0, -1) : path
  const slash = stripped.lastIndexOf("/")
  return slash >= 0 ? stripped.slice(slash + 1) : stripped
}

/** Filter project files by a partial path query, ranked by fuzzy score.
 *  Behaviour aligns with VS Code's @-quick-open: basename matches
 *  outscore full-path matches, dense / boundary-aligned matches outscore
 *  scattered ones. Returns up to `limit` matches. Empty query falls back
 *  to alphabetical (the file index is pre-sorted) so the picker opens
 *  to a deterministic view. */
export function completeFiles(root: string, query: string, limit = 20): string[] {
  const files = getFileIndex(root)
  if (!query) return files.slice(0, limit)
  const q = query.toLowerCase()
  const scored: Array<{ path: string; score: number }> = []
  for (const f of files) {
    // Score basename and path separately, take whichever wins after a
    // +200 basename-bonus. That makes `@main` rank `src/main.ts` above
    // `node_modules-but-not-skipped/zmain.ts` even when the path scorer
    // would slightly prefer the latter due to position bonuses.
    const baseScore = fuzzyScore(q, basename(f))
    const pathScore = fuzzyScore(q, f)
    let best: number | null = null
    if (baseScore !== null) best = baseScore + 200
    if (pathScore !== null && (best === null || pathScore > best)) best = pathScore
    if (best !== null) scored.push({ path: f, score: best })
  }
  // Sort by score desc; tie-break by alphabetical path so the order is
  // stable across renders (the file index is already sorted, so equal
  // scores naturally fall back to that — but make it explicit).
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(s => s.path)
}

/** Extract the @token being typed at end of input. Returns the query part after @ or null. */
export function extractAtQuery(input: string): string | null {
  // Match @ preceded by whitespace or at start, followed by non-whitespace chars, at end of input
  const m = input.match(/(?:^|\s)@(?:"((?:\\.|[^"\\])*)|(\S*))$/)
  return m ? unescapeQuotedAtPath(m[1] ?? m[2] ?? "") : null
}

/** Replace the @partial at end of input with the selected file path.
 * For directory selections (path ending in "/"), do NOT append a trailing
 * space — leaving the @ token open lets the user keep typing to drill
 * deeper (e.g. Tab on `src/` produces `@src/`, then typing `App` filters
 * to files inside `src/`). Files always get a trailing space so the
 * palette closes and the user can keep composing the message. */
export function replaceAtToken(input: string, selectedPath: string): string {
  return input.replace(/(?:^|\s)@(?:"(?:\\.|[^"\\])*"?|\S*)$/, (match) => {
    const leadingSpace = match.startsWith("@") ? "" : match[0]
    const directory = selectedPath.endsWith("/")
    const trailing = directory ? "" : " "
    return `${leadingSpace}@${formatAtPath(selectedPath, { keepOpen: directory })}${trailing}`
  })
}

function formatAtPath(path: string, options: { keepOpen?: boolean } = {}): string {
  const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return /\s|"/.test(path)
    ? `"${escaped}${options.keepOpen ? "" : "\""}`
    : path
}

function unescapeQuotedAtPath(path: string): string {
  return path.replace(/\\(["\\])/g, "$1")
}

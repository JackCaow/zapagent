import { normalizeCompactHeadingTitle } from "../../zapsdk/context/autocompact.js"

/**
 * Parse the structured summary's "# Files read / modified" section and
 * return the bullet-list paths. Returns [] when the section is missing,
 * empty, or contains no recognizable bullets.
 *
 * Bullets matched: `- <path>`, `* <path>`, optionally with surrounding
 * backticks and trailing " — description". Stops at the next heading of
 * equal or shallower depth.
 */
export function extractFilesFromSummary(summary: string): string[] {
  const lines = summary.split("\n")
  const headingRe = /^(#{1,3})\s+(.+?)\s*$/
  let headerIdx = -1
  let headerDepth = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(headingRe)
    if (m && normalizeCompactHeadingTitle(m[2]!) === "files read / modified") {
      headerIdx = i
      headerDepth = m[1]!.length
      break
    }
  }
  if (headerIdx === -1) return []

  const files: string[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const heading = line.match(headingRe)
    if (heading && heading[1]!.length <= headerDepth) break
    const path = extractBulletPath(line)
    if (path) files.push(path)
  }
  return files
}

function extractBulletPath(line: string): string | null {
  const m = line.match(/^\s*[-*]\s+(.+?)\s*$/)
  if (!m) return null
  const body = m[1]!.trim()
  if (!body) return null
  if (body.startsWith("`")) {
    const end = body.indexOf("`", 1)
    if (end > 1) return stripLineSuffix(body.slice(1, end))
  }
  const first = body.split(/\s+—\s+|\s+-\s+|\s+/)[0]
  if (!first) return null
  return stripLineSuffix(first)
}

function stripLineSuffix(path: string): string {
  return path.replace(/:(\d+)(?::\d+)?$/, "")
}

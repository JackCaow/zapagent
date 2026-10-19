// Display-width helpers for terminal layout. CJK characters render as 2 cells,
// most other unicode as 1. Pure ASCII fast-paths avoid the unicode walk.

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115F) || // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) || // CJK Radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33FF) || // Hiragana, Katakana, Bopomofo, CJK Symbols
    (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Extension A
    (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
    (cp >= 0xA000 && cp <= 0xA4CF) || // Yi
    (cp >= 0xAC00 && cp <= 0xD7A3) || // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compatibility Ideographs
    (cp >= 0xFE30 && cp <= 0xFE4F) || // CJK Compatibility Forms
    (cp >= 0xFF00 && cp <= 0xFF60) || // Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) || // Fullwidth signs
    (cp >= 0x1F300 && cp <= 0x1F9FF) || // Emoji
    (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Ext B–F
    (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Ext G+
  )
}

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    w += isWideCodePoint(ch.codePointAt(0)!) ? 2 : 1
  }
  return w
}

/** Truncate `s` so its terminal display width does not exceed `maxWidth`.
 *  When truncation occurs, an `ellipsis` (default "…", 1 cell) is appended,
 *  reserving its width within `maxWidth`. */
export function truncateToWidth(s: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return ""
  if (displayWidth(s) <= maxWidth) return s
  const ellipsisW = displayWidth(ellipsis)
  if (maxWidth <= ellipsisW) return ellipsis
  const budget = maxWidth - ellipsisW
  let w = 0
  let out = ""
  for (const ch of s) {
    const cw = isWideCodePoint(ch.codePointAt(0)!) ? 2 : 1
    if (w + cw > budget) break
    out += ch
    w += cw
  }
  return out + ellipsis
}

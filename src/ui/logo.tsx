// Welcome banner constants. Used by Welcome.tsx (Ink) and the --help
// output in index.tsx. ANSI helpers were dropped in the Ink migration —
// Welcome renders via Ink's color system, not raw escapes.

// ANSI Shadow trimmed to 5 rows: dropped the original's top + bottom shadow
// lines (which were just depth flourishes) so the body of each letter is
// fully preserved. Keeps the block-letter feel of the old 6-row banner
// without the chunky vertical footprint.
export const LOGO_LINES = [
  "███████╗ █████╗ ██████╗ ",
  "   ███╔╝██╔══██╗██╔══██╗",
  "  ███╔╝ ███████║██████╔╝",
  " ███╔╝  ██╔══██║██╔═══╝ ",
  "███████╗██║  ██║██║     ",
] as const

export const SHORTCUTS: Array<[string, string]> = [
  ["⏎",       "send"],
  ["⇧⏎",      "newline"],
  ["\\⏎",     "newline (Apple Terminal)"],
  ["Ctrl+C",  "cancel running agent / exit"],
  ["Ctrl+L",  "clear screen"],
  ["↑ / ↓",   "history"],
]

export const SLASH_INTRO: Array<[string, string]> = [
  ["/connect",  "set up provider & API key"],
  ["/model",    "switch model"],
  ["/mode",     "permission mode (plan / acceptEdits / bypass)"],
  ["/sessions", "browse saved sessions"],
  ["/compact",  "compress conversation context"],
  ["/help",     "full command reference"],
]

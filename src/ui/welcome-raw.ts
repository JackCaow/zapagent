// Raw-stdout Welcome banner. Bypasses React/Ink entirely so the
// banner is written as plain text to the terminal at boot and on
// /new / /clear / Ctrl+L, ending up in scrollback where it stays
// regardless of Ink's render cycle.
//
// We tried two routes through Ink first:
//   - <Static items={welcomeItems}> with bumpWelcome on /new — Ink's
//     Static commit timing fights with concurrent log-update writes
//     and the banner came out truncated (missing the bottom slash
//     command rows).
//   - inline render in the dynamic frame — Welcome ends up BELOW
//     transcript items because they Static-commit ABOVE the dynamic
//     frame.
// Raw stdout sidesteps both: the banner is just text in scrollback
// at the position we wrote it. Visually identical to a fresh boot.
import { LOGO_LINES, SHORTCUTS, SLASH_INTRO } from "./logo.js"
import { VERSION } from "../version.js"

// Mirrors src/ui/theme.ts — must be kept in sync when palette changes.
const PALETTE = {
  accent:    "#94b369",  // tundra400
  ghost:     "#80867a",  // gray500
  muted:     "#b3b9a5",  // gray300
  faint:     "#9aa090",  // gray400
  primary:   "#e5e8db",  // gray100
  secondary: "#c8cdbc",  // gray200
  success:   "#94b369",  // olive
  warning:   "#dab74a",  // mustard
  border:    "#424638",  // gray700
}

const IS_APPLE_TERMINAL = process.env.TERM_PROGRAM === "Apple_Terminal"

// Apple Terminal can't parse 24-bit truecolor — degrade to 256.
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]
function nearestCubeIdx(v: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const d = Math.abs(CUBE_LEVELS[i]! - v)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}
function rgbTo256(r: number, g: number, b: number): number {
  const cube = 16 + 36 * nearestCubeIdx(r) + 6 * nearestCubeIdx(g) + nearestCubeIdx(b)
  const grayAvg = (r + g + b) / 3
  const grayIdx = Math.max(0, Math.min(23, Math.round((grayAvg - 8) / 10)))
  const grayLevel = 8 + grayIdx * 10
  const grayDist = (grayLevel - r) ** 2 + (grayLevel - g) ** 2 + (grayLevel - b) ** 2
  const cubeR = CUBE_LEVELS[nearestCubeIdx(r)]!
  const cubeG = CUBE_LEVELS[nearestCubeIdx(g)]!
  const cubeB = CUBE_LEVELS[nearestCubeIdx(b)]!
  const cubeDist = (cubeR - r) ** 2 + (cubeG - g) ** 2 + (cubeB - b) ** 2
  return grayDist < cubeDist ? 232 + grayIdx : cube
}

const RESET = "\x1b[0m"
const BOLD  = "\x1b[1m"
const ITALIC = "\x1b[3m"

function fg(hex: string): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) return ""
  const r = parseInt(m[1]!.slice(0, 2), 16)
  const g = parseInt(m[1]!.slice(2, 4), 16)
  const b = parseInt(m[1]!.slice(4, 6), 16)
  if (IS_APPLE_TERMINAL) return `\x1b[38;5;${rgbTo256(r, g, b)}m`
  return `\x1b[38;2;${r};${g};${b}m`
}

function fmtCtx(n?: number): string {
  if (!n || n <= 0) return ""
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tokens`
  if (n >= 1_000)     return `${Math.round(n / 1000)}K tokens`
  return `${n} tokens`
}

interface Opts {
  providerLabel?: string
  contextWindow?: number
  hasApiKey?: boolean
}

export function renderWelcomeAnsi({
  providerLabel,
  contextWindow,
  hasApiKey = true,
}: Opts): string {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  const compactLogo = rows < 20
  const stack = cols < 120
  const out: string[] = []
  const PAD = "  " // 2-col left rail

  // Logo
  if (compactLogo) {
    out.push(`${PAD}${fg(PALETTE.accent)}${BOLD}⚡  ZAP${RESET}`)
  } else {
    for (const line of LOGO_LINES) {
      out.push(`${PAD}${fg(PALETTE.accent)}${line}${RESET}`)
    }
  }
  out.push("")
  out.push(`${PAD}${fg(PALETTE.ghost)}${ITALIC}zapAgent. Code flows.${RESET}`)
  out.push(`${PAD}${fg(PALETTE.faint)}v${VERSION}${RESET}`)
  out.push("")

  // Model card (right column in wide; below subtitle in stack)
  if (stack) {
    out.push(`${PAD}${fg(PALETTE.faint)}provider  ${RESET}${fg(PALETTE.primary)}${providerLabel ?? "—"}${RESET}`)
    const ctx = fmtCtx(contextWindow)
    if (ctx) out.push(`${PAD}${fg(PALETTE.faint)}context   ${RESET}${fg(PALETTE.muted)}${ctx}${RESET}`)
    const statusFg = hasApiKey ? PALETTE.success : PALETTE.warning
    const statusTxt = hasApiKey ? "● ready" : "● needs api key"
    out.push(`${PAD}${fg(PALETTE.faint)}status    ${RESET}${fg(statusFg)}${statusTxt}${RESET}`)
    if (!hasApiKey) {
      out.push("")
      out.push(`${PAD}${fg(PALETTE.warning)}${BOLD}▸ ${RESET}${fg(PALETTE.warning)}start by typing ${RESET}${fg(PALETTE.accent)}${BOLD}/connect${RESET}`)
    }
    out.push("")
  } else {
    // Wide layout: pad the model card to the right side of the row
    // containing the logo. We just output a separate column block
    // below the logo to keep things simple — same content, slightly
    // different position than the React version. The raw renderer
    // doesn't try to perfectly match Ink's flex layout.
    out.push(`${PAD}${fg(PALETTE.faint)}provider  ${RESET}${fg(PALETTE.primary)}${providerLabel ?? "—"}${RESET}`)
    const ctx = fmtCtx(contextWindow)
    if (ctx) out.push(`${PAD}${fg(PALETTE.faint)}context   ${RESET}${fg(PALETTE.muted)}${ctx}${RESET}`)
    const statusFg = hasApiKey ? PALETTE.success : PALETTE.warning
    const statusTxt = hasApiKey ? "● ready" : "● needs api key"
    out.push(`${PAD}${fg(PALETTE.faint)}status    ${RESET}${fg(statusFg)}${statusTxt}${RESET}`)
    if (!hasApiKey) {
      out.push("")
      out.push(`${PAD}${fg(PALETTE.warning)}${BOLD}▸ ${RESET}${fg(PALETTE.warning)}start by typing ${RESET}${fg(PALETTE.accent)}${BOLD}/connect${RESET}`)
    }
    out.push("")
  }

  // Divider
  const dividerWidth = Math.min(64, cols - 4)
  out.push(`${PAD}${fg(PALETTE.border)}${"─".repeat(dividerWidth)}${RESET}`)
  out.push("")

  // Shortcuts header + rows
  out.push(`${PAD}${fg(PALETTE.accent)}• ${RESET}${fg(PALETTE.secondary)}${BOLD}Shortcuts${RESET}`)
  for (const [k, desc] of SHORTCUTS) {
    out.push(`${PAD}  ${fg(PALETTE.ghost)}${k.padEnd(13)}${RESET}${fg(PALETTE.faint)}${desc}${RESET}`)
  }
  out.push("")

  // Slash commands header + rows
  out.push(`${PAD}${fg(PALETTE.accent)}• ${RESET}${fg(PALETTE.secondary)}${BOLD}Slash commands${RESET}`)
  for (const [cmd, desc] of SLASH_INTRO) {
    out.push(`${PAD}  ${fg(PALETTE.accent)}${cmd.padEnd(13)}${RESET}${fg(PALETTE.faint)}${desc}${RESET}`)
  }
  out.push("")

  return out.join("\n") + "\n"
}

/** Write the Welcome banner directly to stdout (bypassing Ink). */
export function printWelcomeRaw(opts: Opts): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(renderWelcomeAnsi(opts))
}

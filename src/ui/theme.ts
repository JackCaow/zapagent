/**
 * ZapCode Design System — 哈苏大地苔原绿
 *
 * 哈苏: Hasselblad's natural-colour science — damp moss, arctic lichen,
 * frosted sage, peat-dark forest floor. Photographic, organic, low-glare,
 * cool-cast. All UI colors must be sourced from this file — no hardcoded
 * hex in components.
 */

// ── Primitive palette ──────────────────────────────────────────────────────
// Tuned for dark terminals: mid-tones (gray400–700, tundra400) are lifted
// so borders / faint text / accent stay legible on near-black backgrounds.
const palette = {
  // 苔原核心 — damp moss / arctic lichen
  tundra50:  "#eff2e8",
  tundra100: "#dde3d0",
  tundra200: "#bcc8a5",
  tundra300: "#b1c896",   // light moss — accentSoft
  tundra400: "#94b369",   // ← 哈苏 primary (湿苔, dark-term legible)
  tundra500: "#6c7e54",   // pressed / darker — was tundra400
  tundra600: "#536339",
  tundra700: "#3b4828",
  tundra800: "#252e19",
  tundra900: "#15190e",

  // Neutrals (green-tinted cool grays — frosted stone, tuned for dark bg).
  // Whole ramp lifted +1 step so body/muted/faint text all clear the
  // WCAG AA 4.5:1 threshold on near-black terminals — earlier values left
  // gray500 / gray600 in the eye-strain zone.
  gray50:  "#eef0ea",
  gray100: "#e5e8db",     // body — was #dde0d3
  gray200: "#c8cdbc",     // secondary — was #b8bdac
  gray300: "#b3b9a5",     // muted — was #a1a691
  gray400: "#9aa090",     // faint — was #858a78
  gray500: "#80867a",     // ghost — was #62675a
  gray600: "#5d6357",     // border default — was #424638
  gray700: "#424638",     // border subtle — was #2d3128
  gray800: "#0d0f09",

  // Status — earth-toned, cool-cast, brightened for dark bg
  olive:    "#94b369",    // success — was #7d9655
  mustard:  "#dab74a",    // warning — was #cba037
  brick:    "#cc6651",    // error   — was #b85543
  sage:     "#b6c7b7",    // info    — was #9fb0a0

  // Absolute — cool warm-white (slightly brighter than gray100), peat-deep ink
  white: "#f3f5ea",
  black: "#070806",
} as const

// ── Semantic tokens ────────────────────────────────────────────────────────
export const c = {
  // Interactive / brand
  accent:     palette.tundra400,  // primary action color — 哈苏湿苔
  accentDim:  palette.tundra500,  // pressed / darker variant
  accentSoft: palette.tundra200,  // subtle highlight

  // Text hierarchy
  text: {
    primary:   palette.white,       // headings, active labels
    secondary: palette.gray200,     // body, descriptions
    muted:     palette.gray300,     // hints, metadata
    faint:     palette.gray400,     // dividers, placeholders
    ghost:     palette.gray500,     // barely-there
  },

  // Borders
  border: {
    focus:   palette.tundra400,   // focused input / active dialog
    default: palette.gray600,     // idle borders
    subtle:  palette.gray700,     // inner separators
  },

  // Status
  success: palette.olive,
  warning: palette.mustard,
  error:   palette.brick,
  info:    palette.sage,

  // Cursor / selection
  cursor: palette.tundra400,

} as const

export type ColorToken = typeof c

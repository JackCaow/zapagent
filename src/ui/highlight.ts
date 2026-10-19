/**
 * Shiki-based syntax highlighter (sync token API for the renderer).
 *
 * Why shiki and not the existing tree-sitter pipeline:
 *   - shiki returns colored tokens through a fully synchronous codeToTokens
 *     call after a one-time async init. The opentui tree-sitter path measured
 *     async, which produced phantom blank rows (the measure pass disagreed
 *     with the painted height) and was the root cause of a long tail of
 *     scrollback bugs.
 *   - Token output already includes a resolved color per chunk — no need to
 *     keep our own capture-name → color theme in lockstep with each grammar's
 *     highlights.scm. Themes live in one place.
 *
 * Boot model:
 *   `initHighlighter()` is fire-and-forget at startup; renderers call
 *   `tokenize()` synchronously and fall back to plain text until the
 *   highlighter is ready. We ship one curated language set (matches the
 *   tree-sitter grammars we used to bundle) plus markdown / sql / xml /
 *   diff that shiki gives us for free.
 *
 * Theme:
 *   Custom TextMate theme keyed to the 哈苏大地苔原绿 palette so highlighted code
 *   lives within the same earth / terracotta / olive family as the rest of
 *   the UI (see src/ui/theme.ts for the canonical color tokens). Shiki's
 *   bundled themes (github-dark, etc.) would clash visually.
 */
import {
  createHighlighter,
  type Highlighter,
  type ThemeRegistrationRaw,
  type ThemedToken,
} from "shiki"

// ── Theme: 哈苏大地苔原绿 palette → TextMate scopes ──────────────────────
// Hand-picked from src/ui/theme.ts to keep code blocks within the same
// tundra / moss / lichen family as the surrounding UI.
const C = {
  accent:    "#94b369",  // tundra400 — keywords, tags
  embedded:  "#b1c896",  // tundra300 — interpolation, props
  type:      "#b6c7b7",  // sage      — types, functions
  string:    "#dab74a",  // mustard   — strings, attributes
  number:    "#94b369",  // olive     — numbers, booleans, constants
  text:      "#e5e8db",  // gray100   — variables, members
  textMuted: "#c8cdbc",  // gray200   — properties, parameters
  operator:  "#b3b9a5",  // gray300   — operators
  punct:     "#9aa090",  // gray400   — punctuation, brackets
  comment:   "#80867a",  // gray500   — comments
  diffPlus:  "#94b369",
  diffMinus: "#cc6651",
} as const

const THEME_NAME = "zapcode-tundra"

const ZAPCODE_THEME: ThemeRegistrationRaw = {
  name: THEME_NAME,
  type: "dark",
  fg: C.text,
  bg: "#000000",
  // TextMate scope rules. Order matters: shiki picks the LAST matching rule,
  // so put broader scopes earlier and more specific ones later.
  settings: [
    { settings: { foreground: C.text } }, // default
    { scope: ["comment", "comment.line", "comment.block", "punctuation.definition.comment"],
      settings: { foreground: C.comment, fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "string.template", "string.regexp"],
      settings: { foreground: C.string } },
    { scope: ["string.escape", "constant.character.escape"],
      settings: { foreground: C.embedded } },
    { scope: ["constant.numeric", "constant.language", "constant.language.boolean"],
      settings: { foreground: C.number } },
    { scope: ["constant", "support.constant"],
      settings: { foreground: C.number } },
    { scope: ["keyword", "keyword.control", "keyword.operator.new", "keyword.other", "storage", "storage.type", "storage.modifier"],
      settings: { foreground: C.accent, fontStyle: "bold" } },
    { scope: ["keyword.operator", "punctuation.separator", "punctuation.terminator", "punctuation.section"],
      settings: { foreground: C.operator } },
    { scope: ["punctuation", "punctuation.definition", "meta.brace", "meta.delimiter"],
      settings: { foreground: C.punct } },
    { scope: ["punctuation.definition.template-expression", "meta.template.expression", "punctuation.section.embedded"],
      settings: { foreground: C.embedded } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function", "meta.definition.function entity.name.function"],
      settings: { foreground: C.type } },
    { scope: ["support.function.builtin", "support.function.magic"],
      settings: { foreground: C.type, fontStyle: "italic" } },
    { scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "entity.name.interface", "support.type", "support.class"],
      settings: { foreground: C.type, fontStyle: "bold" } },
    { scope: ["variable", "variable.other", "variable.other.readwrite", "variable.other.object"],
      settings: { foreground: C.text } },
    { scope: ["variable.parameter", "variable.parameter.function"],
      settings: { foreground: C.textMuted, fontStyle: "italic" } },
    { scope: ["variable.language", "variable.other.constant"],
      settings: { foreground: C.number } },
    { scope: ["variable.other.member", "variable.other.property", "support.variable.property"],
      settings: { foreground: C.embedded } },
    // CSS / JSON / YAML / TOML keys
    { scope: ["meta.object-literal.key", "support.type.property-name", "entity.name.tag.yaml", "support.type.property-name.json", "entity.name.tag.css"],
      settings: { foreground: C.embedded } },
    // HTML / JSX / Vue / Svelte
    { scope: ["entity.name.tag", "support.class.component"],
      settings: { foreground: C.accent } },
    { scope: ["entity.other.attribute-name"],
      settings: { foreground: C.string } },
    // Markdown
    { scope: ["markup.heading", "entity.name.section.markdown"],
      settings: { foreground: C.accent, fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { foreground: C.text, fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { foreground: C.text, fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"],
      settings: { foreground: C.string } },
    { scope: ["markup.underline.link", "markup.link"],
      settings: { foreground: C.embedded, fontStyle: "underline" } },
    // Diff
    { scope: ["markup.inserted", "punctuation.definition.inserted"],
      settings: { foreground: C.diffPlus } },
    { scope: ["markup.deleted", "punctuation.definition.deleted"],
      settings: { foreground: C.diffMinus } },
    { scope: ["markup.changed", "punctuation.definition.changed"],
      settings: { foreground: C.string } },
  ],
}

// ── Languages ────────────────────────────────────────────────────────────
// Curated to match what tree-sitter used to bundle, plus a few cheap freebies
// (markdown, diff, sql, xml) so common code blocks always highlight. Each
// shiki lang is a TextMate JSON grammar — they're loaded into oniguruma WASM
// once at init and kept resident.
const LANGS = [
  "javascript", "typescript", "tsx", "jsx",
  "python", "go", "rust",
  "json", "yaml", "toml",
  "bash", "shell",
  "html", "css", "scss",
  "java", "c", "cpp", "csharp",
  "dart", "kotlin", "swift",
  "svelte", "vue",
  "ruby", "php",
  "markdown", "diff",
  "sql", "xml",
] as const

// Aliases from filetypes the rest of the codebase produces (opentui's
// pathToFiletype, ZAP_FILETYPE_OVERRIDES, raw extensions). Maps to a shiki
// bundled language id. Keep this minimal — shiki itself has many aliases
// built in (e.g. it accepts "js" → "javascript"), so we only add what shiki
// won't resolve on its own.
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  rb: "ruby",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  "c++": "cpp",
  cc: "cpp",
  cs: "csharp",
  kt: "kotlin",
  md: "markdown",
}

function canonicalizeLang(filetype: string): string | null {
  if (!filetype) return null
  const ft = filetype.toLowerCase()
  return LANG_ALIAS[ft] ?? ft
}

// ── Singleton lifecycle ──────────────────────────────────────────────────
let _hl: Highlighter | null = null
let _initPromise: Promise<Highlighter | null> | null = null

/**
 * Kick off shiki init. Safe to call from module top-level — fire-and-forget;
 * `tokenize()` falls back to plain text until this resolves. Idempotent.
 *
 * Failures (network-less corp env, oniguruma WASM missing, etc.) are caught
 * and logged once — the highlighter stays null and rendering degrades to
 * plain text rather than crashing the UI.
 */
export function initHighlighter(): Promise<Highlighter | null> {
  if (_hl) return Promise.resolve(_hl)
  if (_initPromise) return _initPromise
  _initPromise = createHighlighter({
    langs: LANGS as unknown as string[],
    themes: [ZAPCODE_THEME],
  })
    .then((h) => { _hl = h; return h })
    .catch((err) => {
      // Log to stderr only — hijacking stdout would mangle the TUI.
      try { process.stderr.write(`[zapcode] shiki init failed: ${String(err)}\n`) } catch {}
      return null
    })
  return _initPromise
}

/** True once the highlighter is ready — useful for tests / status indicators. */
export function isHighlighterReady(): boolean { return _hl !== null }

/**
 * Synchronous tokenize. Returns shiki's per-line token arrays, or null when:
 *   - the highlighter isn't initialized yet (caller should fall back),
 *   - the filetype isn't a loaded language (caller should fall back),
 *   - shiki throws (corrupt code, unhandled grammar edge case).
 *
 * Callers MUST handle null — never assume highlighting is available.
 */
export function tokenize(code: string, filetype: string): ThemedToken[][] | null {
  if (!_hl) return null
  const lang = canonicalizeLang(filetype)
  if (!lang) return null
  // Shiki throws if the language isn't loaded; check first so the hot path
  // doesn't rely on exceptions for control flow.
  if (!_hl.getLoadedLanguages().includes(lang as any)) return null
  try {
    const result = _hl.codeToTokens(code, { lang: lang as any, theme: THEME_NAME })
    return result.tokens
  } catch {
    return null
  }
}

export type { ThemedToken }

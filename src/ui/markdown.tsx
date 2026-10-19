/** @jsxImportSource react */
// Lightweight markdown renderer for agent messages.
//
// Why a hand-rolled parser instead of `marked` / `remark`:
//   - The markdown subset agents emit is bounded (paragraphs, headings,
//     lists, fences, inline code/bold/italic/links/math, hr) — pulling in a
//     full CommonMark engine would multiply the dependency surface for
//     ~150 lines of parsing.
//   - We need to emit Ink <Box>/<Text> directly. Tree-walking a remark
//     AST plus a custom renderer is more code than parsing inline.
//   - Streaming: agent text arrives chunk-by-chunk. A line-based parser
//     handles incomplete-fence and partial-list states gracefully — full
//     parsers want a finished document.
//
// Output structure: top-level <Box flexDirection="column"> with one
// child per block. Inline runs collapse into <Text> with nested style
// spans. The caller is responsible for indenting (we don't pad here).
import { Fragment } from "react"
import { Box, Text } from "ink"
import { CodeBlock } from "./code-block.js"
import { c } from "./theme.js"
import { useTermWidth } from "./term-width.js"
import { displayWidth } from "./truncate.js"
import { formatLatexForTerminal } from "./latex.js"

// ── Inline parser (bold / italic / inline code / links / math) ──────────
// Tokenizer over a single line. Returns a flat list of styled runs that
// the renderer concatenates inside a single <Text>. Order of patterns
// matters: code spans first (they suppress all other markup), then links,
// then bold-before-italic so `**foo**` doesn't read as `*` + `*foo*` + `*`.

type InlineRun =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "math"; value: string }
  | { kind: "bold"; runs: InlineRun[] }
  | { kind: "italic"; runs: InlineRun[] }
  | { kind: "link"; label: string; href: string }

function findUnescapedDollar(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] !== "$") continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && src[j] === "\\"; j--) backslashes++
    if (backslashes % 2 === 0) return i
  }
  return -1
}

/**
 * A single-dollar pair is ambiguous in prose: `$x^2$` is math, while
 * `$100 to $200` is two currency amounts. Require a small amount of math
 * syntax, or a compact identifier/list, before consuming the delimiters.
 * Display math (`$$`) is unambiguous and is handled by the block parser.
 */
function looksLikeInlineMath(source: string): boolean {
  const value = source.trim()
  if (!value || /^\d+(?:[.,]\d+)?$/.test(value)) return false
  if (/\\[A-Za-z]+|[=^_{}+\-*/<>()[\]]/.test(value)) return true
  // Compact Latin/Greek identifiers and implicit products are common math
  // (`$α$`, `$πr$`, `$x y$`). Exclude Han prose so a paired currency string
  // such as `$100 到 $200` cannot be mistaken for a formula.
  if (/\p{Script=Han}/u.test(value)) return false
  return /[A-Za-z\p{Script=Greek}]/u.test(value)
    && /^[A-Za-z\p{Script=Greek}\p{N}]+(?:[\s,]+[A-Za-z\p{Script=Greek}\p{N}]+)*$/u.test(value)
}

function pushMathRun(runs: InlineRun[], latex: string): boolean {
  const value = formatLatexForTerminal(latex)
  if (!value) return false
  runs.push({ kind: "math", value })
  return true
}

function parseInline(src: string): InlineRun[] {
  const runs: InlineRun[] = []
  let i = 0
  let buf = ""
  const flush = () => { if (buf) { runs.push({ kind: "text", value: buf }); buf = "" } }

  while (i < src.length) {
    const ch = src[i]
    // ── escaped dollar: \$ ────
    // Render a literal dollar without leaking the Markdown escape slash.
    if (ch === "\\" && src[i + 1] === "$") {
      buf += "$"
      i += 2
      continue
    }
    // ── inline code: `...` (greedy until matching backtick) ────
    if (ch === "`") {
      const close = src.indexOf("`", i + 1)
      if (close > i) {
        flush()
        runs.push({ kind: "code", value: src.slice(i + 1, close) })
        i = close + 1
        continue
      }
    }
    // ── TeX inline delimiters: \(...\) and \[...\] ────
    if (ch === "\\" && (src[i + 1] === "(" || src[i + 1] === "[")) {
      const closing = src[i + 1] === "(" ? "\\)" : "\\]"
      const close = src.indexOf(closing, i + 2)
      if (close >= i + 2) {
        flush()
        if (pushMathRun(runs, src.slice(i + 2, close))) {
          i = close + 2
          continue
        }
      }
    }
    // ── paired display delimiters inside a prose line ────
    // A line beginning with `$$` is handled by parseBlocks. This path covers
    // model output such as "therefore $$x^2$$ follows" without leaking raw
    // delimiters or swallowing the trailing prose.
    if (ch === "$" && src[i + 1] === "$") {
      const close = src.indexOf("$$", i + 2)
      if (close >= i + 2) {
        flush()
        if (pushMathRun(runs, src.slice(i + 2, close))) {
          i = close + 2
          continue
        }
      }
    }
    // ── inline math: $...$ ────
    // A double-dollar opener belongs to the block parser. An unmatched
    // dollar remains plain text, which keeps currency like "$100" intact.
    if (ch === "$" && src[i + 1] !== "$" && src[i - 1] !== "\\") {
      const close = findUnescapedDollar(src, i + 1)
      if (close > i + 1 && src[close + 1] !== "$") {
        const latex = src.slice(i + 1, close)
        if (looksLikeInlineMath(latex)) {
          flush()
          if (pushMathRun(runs, latex)) {
            i = close + 1
            continue
          }
        }
      }
    }
    // ── link: [label](href) ────
    if (ch === "[") {
      const labelEnd = src.indexOf("]", i + 1)
      if (labelEnd > i && src[labelEnd + 1] === "(") {
        const hrefEnd = src.indexOf(")", labelEnd + 2)
        if (hrefEnd > labelEnd) {
          flush()
          runs.push({
            kind: "link",
            label: src.slice(i + 1, labelEnd),
            href: src.slice(labelEnd + 2, hrefEnd),
          })
          i = hrefEnd + 1
          continue
        }
      }
    }
    // ── bare URL: http(s)://… ────
    // Most terminals already make these clickable on mouse-hover, but
    // without an explicit underline+accent color the user has no way to
    // tell text is a link before clicking. Match http/https only — `ftp`
    // and obscure schemes are rare in transcript output and the false-
    // positive cost (highlighting random `://` strings) outweighs the
    // benefit. End the URL at whitespace, angle brackets, quotes, or
    // closing brackets so prose punctuation around the URL doesn't get
    // swallowed. Trailing sentence punctuation (`.`,`,`,`!`,etc.) is
    // also stripped so "see https://x.com." renders as link + ".".
    if (ch === "h" && (src.startsWith("http://", i) || src.startsWith("https://", i))) {
      const m = src.slice(i).match(/^https?:\/\/[^\s<>"'`)\]]+/)
      if (m) {
        let url = m[0]
        // Strip trailing prose punctuation that almost never belongs in
        // URLs but commonly follows them in writing. Stripped chars
        // stay in `src` — the outer loop's plain-text branch picks
        // them up on the next iterations.
        while (url.length > 0 && /[.,;:!?]/.test(url[url.length - 1]!)) {
          url = url.slice(0, -1)
        }
        if (url.length > "https://".length) {
          flush()
          runs.push({ kind: "link", label: url, href: url })
          i += url.length
          continue
        }
      }
    }
    // ── bold: **...** (greedy until matching pair) ────
    if (ch === "*" && src[i + 1] === "*") {
      const close = src.indexOf("**", i + 2)
      if (close > i + 1) {
        flush()
        runs.push({ kind: "bold", runs: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }
    // ── italic: *...* (single asterisk, but not at word boundary inside) ─
    if (ch === "*") {
      const close = src.indexOf("*", i + 1)
      if (close > i) {
        flush()
        runs.push({ kind: "italic", runs: parseInline(src.slice(i + 1, close)) })
        i = close + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return runs
}

function renderRuns(runs: InlineRun[], keyPrefix = ""): React.ReactNode {
  return runs.map((r, i) => {
    const k = `${keyPrefix}${i}`
    switch (r.kind) {
      case "text":   return <Fragment key={k}>{r.value}</Fragment>
      case "code":   return <Text key={k} color={c.warning}>{r.value}</Text>
      case "math":   return <Text key={k} color={c.info}>{r.value}</Text>
      case "bold":   return <Text key={k} bold>{renderRuns(r.runs, `${k}.`)}</Text>
      case "italic": return <Text key={k} italic>{renderRuns(r.runs, `${k}.`)}</Text>
      case "link":   return <Text key={k} color={c.accent} underline>{r.label || r.href}</Text>
    }
  })
}

// ── Block parser ─────────────────────────────────────────────────────────
// Splits source into block tokens by line. Code fences and lists are the
// multiline blocks; everything else is per-line.

type TableAlign = "left" | "right" | "center" | "default"

// Note: markdown horizontal rules (`---` / `***` / `___`) are detected in
// parseBlocks but produce NO block — they're dropped silently. We still
// recognise the syntax so a rule between paragraphs splits them correctly
// (without the check, "para A\n---\npara B" would merge into one paragraph).
type Block =
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "p"; text: string }
  | { kind: "blank" }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "fence"; lang: string; code: string }
  | { kind: "math"; latex: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; align: TableAlign[]; header: string[]; rows: string[][] }

// ── Table helpers ───────────────────────────────────────────────────────
// GitHub-flavored Markdown table sniff. A run of rows is a table when the
// SECOND line is a valid align row (`| --- | :---: | ---: |`). Anything
// short of that falls through to the paragraph parser unchanged, so plain
// text that happens to contain `|` is unaffected.

function splitTableRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith("|")) t = t.slice(1)
  if (t.endsWith("|")) t = t.slice(0, -1)
  return t.split("|").map(s => s.trim())
}

function looksLikeTableRow(line: string): boolean {
  if (!line || !line.includes("|")) return false
  return splitTableRow(line).length >= 2
}

function parseAlignRow(line: string): TableAlign[] | null {
  if (!looksLikeTableRow(line)) return null
  const cells = splitTableRow(line)
  const aligns: TableAlign[] = []
  for (const cell of cells) {
    // dashes (≥3) optionally bookended by `:` colons
    if (!/^:?-{3,}:?$/.test(cell)) return null
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : "default")
  }
  return aligns
}

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n")
  // Drop the trailing "" element produced by `split("\n")` when src ends
  // with `\n` — it represents the LF terminator of the last real content
  // line, not a separate blank line. Without this strip, every chunk that
  // ends with `\n` (which is most streaming chunks: "line\n") emits a
  // phantom trailing blank block. When chunks render adjacently in
  // <Static>, those phantom blanks stack as multiple empty rows between
  // every line. Strip it once here so each chunk renders compactly and
  // adjacency is preserved. (A real `\n\n` blank between paragraphs
  // produces a non-trailing "" between two content elements and survives.)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()

    // ── fence: ```lang ────
    const fenceMatch = trimmed.match(/^```(\S*)\s*$/)
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? ""
      const buf: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? "").trim().match(/^```\s*$/)) {
        buf.push(lines[i] ?? "")
        i++
      }
      if (i < lines.length) i++ // consume closing fence (if present)
      out.push({ kind: "fence", lang, code: buf.join("\n") })
      continue
    }

    // ── display math: $$...$$ or \[...\] ────
    // Preserve prose after a same-line closing delimiter as a paragraph.
    // An opener at EOF remains a streaming partial and is reparsed when the
    // closing delimiter arrives in a later render.
    const displayDelimiter = trimmed.startsWith("$$")
      ? { open: "$$", close: "$$" }
      : trimmed.startsWith("\\[")
        ? { open: "\\[", close: "\\]" }
        : null
    if (displayDelimiter) {
      const firstBody = trimmed.slice(displayDelimiter.open.length)
      const sameLineClose = firstBody.indexOf(displayDelimiter.close)
      if (sameLineClose >= 0) {
        out.push({ kind: "math", latex: firstBody.slice(0, sameLineClose) })
        const tail = firstBody.slice(sameLineClose + displayDelimiter.close.length).trim()
        if (tail) out.push({ kind: "p", text: tail })
        i++
        continue
      }

      const buf: string[] = []
      let trailingText = ""
      if (firstBody) buf.push(firstBody)
      i++
      while (i < lines.length) {
        const mathLine = lines[i] ?? ""
        const close = mathLine.indexOf(displayDelimiter.close)
        if (close >= 0) {
          if (close > 0) buf.push(mathLine.slice(0, close))
          const tail = mathLine.slice(close + displayDelimiter.close.length).trim()
          if (tail) trailingText = tail
          i++
          break
        }
        buf.push(mathLine)
        i++
      }
      out.push({ kind: "math", latex: buf.join("\n") })
      if (trailingText) out.push({ kind: "p", text: trailingText })
      continue
    }

    // ── headings ────
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (hMatch) {
      const level = hMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      out.push({ kind: "h", level, text: hMatch[2] ?? "" })
      i++
      continue
    }

    // ── horizontal rule ────
    // Agents like to sprinkle `---` between sections; in a terminal those
    // long horizontal lines just take vertical space without adding info,
    // so we drop them entirely (no block emitted). Surrounding blank lines
    // still come through normally so paragraphs around the hr stay spaced.
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      i++
      continue
    }

    // ── unordered list ────
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*+]\s+/, ""))
        i++
      }
      out.push({ kind: "ul", items })
      continue
    }

    // ── ordered list ────
    const olMatch = line.match(/^(\s*)(\d+)\.\s+/)
    if (olMatch) {
      const items: string[] = []
      const startNum = parseInt(olMatch[2] ?? "1", 10)
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""))
        i++
      }
      out.push({ kind: "ol", items, start: startNum })
      continue
    }

    // ── blockquote ────
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^>\s?/, ""))
        i++
      }
      out.push({ kind: "quote", text: buf.join("\n") })
      continue
    }

    // ── blank ────
    if (trimmed === "") {
      out.push({ kind: "blank" })
      i++
      continue
    }

    // ── GFM table ────
    // Two-step sniff: current line has ≥ 2 pipe-separated cells AND the
    // next line is a valid align row. Falling through here is harmless —
    // a paragraph that happens to contain `|` renders the way it used to.
    if (looksLikeTableRow(line)) {
      const aligns = parseAlignRow(lines[i + 1] ?? "")
      if (aligns) {
        const header = splitTableRow(line)
        const rows: string[][] = []
        let j = i + 2
        while (j < lines.length && looksLikeTableRow(lines[j] ?? "")) {
          rows.push(splitTableRow(lines[j] ?? ""))
          j++
        }
        // Reconcile ragged column counts: pad align/header/rows to the
        // widest row. Defensive — well-formed tables are already aligned,
        // but streaming chunks can land mid-row.
        const cols = Math.max(
          aligns.length,
          header.length,
          ...rows.map(r => r.length),
        )
        const padAlign = aligns.slice()
        while (padAlign.length < cols) padAlign.push("default")
        const padHeader = header.slice()
        while (padHeader.length < cols) padHeader.push("")
        const padRows = rows.map(r => {
          const pr = r.slice()
          while (pr.length < cols) pr.push("")
          return pr
        })
        out.push({ kind: "table", align: padAlign, header: padHeader, rows: padRows })
        i = j
        continue
      }
    }

    // ── paragraph (greedy until blank / block-starting line) ────
    const buf: string[] = [line]
    i++
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6}\s|>\s?|```|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").trimStart().startsWith("$$") &&
      !(lines[i] ?? "").trimStart().startsWith("\\[") &&
      !/^(\*{3,}|-{3,}|_{3,})\s*$/.test((lines[i] ?? "").trim())
    ) {
      buf.push(lines[i] ?? "")
      i++
    }
    out.push({ kind: "p", text: buf.join(" ") })
  }
  return out
}

/**
 * Wrap a formatted display formula at readable operator boundaries. Ink's
 * default wrapping treats a no-space formula as one long word and can split
 * it at an arbitrary glyph. Existing explicit rows (matrices/cases) remain
 * independent lines.
 */
function wrapMathForTerminal(source: string, width: number): string[] {
  const targetWidth = Math.max(8, width)
  const output: string[] = []

  for (const sourceLine of source.split("\n")) {
    let remaining = sourceLine.trim()
    if (!remaining) {
      output.push("")
      continue
    }

    while (displayWidth(remaining) > targetWidth) {
      const chars = Array.from(remaining)
      let visualWidth = 0
      let hardBreak = 0
      let preferredBreak = -1

      for (let i = 0; i < chars.length; i++) {
        const charWidth = displayWidth(chars[i]!)
        if (visualWidth + charWidth > targetWidth) break
        visualWidth += charWidth
        hardBreak = i + 1
        if (/\s|[=+−,;]/u.test(chars[i]!)) preferredBreak = i + 1
      }

      const minimumReadableBreak = Math.min(8, Math.floor(targetWidth / 3))
      const cut = preferredBreak >= minimumReadableBreak ? preferredBreak : Math.max(1, hardBreak)
      output.push(chars.slice(0, cut).join("").trimEnd())
      remaining = chars.slice(cut).join("").trimStart()
    }
    if (remaining) output.push(remaining)
  }

  return output.length > 0 ? output : [""]
}

// ── Renderer ─────────────────────────────────────────────────────────────

const HEADING_COLORS = [c.accent, c.accent, c.text.primary, c.text.primary, c.text.secondary, c.text.secondary]

function DisplayMath({ latex }: { latex: string }) {
  const termWidth = useTermWidth()
  const formatted = formatLatexForTerminal(latex)
  const lines = wrapMathForTerminal(formatted, Math.max(12, termWidth - 8))
  return (
    <Box flexDirection="column" marginY={0}>
      {lines.map((line, index) => (
        <Text key={index} color={c.info}>{index > 0 ? `  ${line}` : line}</Text>
      ))}
    </Box>
  )
}

/**
 * Bullet / ordered list / blockquote line. Two-column flex with EXPLICIT
 * widths so the body column stays bounded — flexGrow alone doesn't
 * constrain Text wrap inside Static's render context, so wrapped
 * continuation rows fall back to col 0 instead of staying under the
 * first character of the body. Marker on the first row only; subsequent
 * wrap rows have a blank gutter.
 */
function ListLine({
  marker,
  markerColor,
  textColor,
  runs,
}: {
  marker: string
  markerColor: string
  textColor: string
  runs: InlineRun[]
}) {
  const termWidth = useTermWidth()
  const markerWidth = marker.length
  // Markdown is rendered inside the AgentMessage's IndentedRow content
  // column (terminal width minus its 3-col gutter). Reserve marker
  // width on the LEFT of the list line, give the rest to body.
  const bodyWidth = Math.max(20, termWidth - 3 /* outer indent */ - markerWidth - 2 /* breathing */)
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} width={markerWidth}>
        <Text color={markerColor}>{marker}</Text>
      </Box>
      <Box width={bodyWidth} flexDirection="column">
        <Text color={textColor}>{renderRuns(runs)}</Text>
      </Box>
    </Box>
  )
}

/**
 * Render a GFM table with a full ASCII grid: outer border on all four sides
 * plus a horizontal rule between every row.
 *
 * Why pre-wrap manually instead of letting Ink wrap inside flex cells: with
 * Ink-wrapped cells the row's rendered height varies per cell, so vertical
 * separators ` │ ` only appear on the first wrap row and the inter-row
 * dividers can't be aligned. We pre-wrap each cell into an array of
 * `Atom[]` per visual line and emit one <Text> per visual row — borders,
 * content, and rules all use the same `colWidths` array so column
 * positions match across every kind of line.
 *
 * Styling: cells are wrapped via `wrapAtoms`, which preserves the per-atom
 * style (`code` / `bold` / `italic` / `link` / `math`) across line boundaries. So a
 * `` `kebab-case-thing` `` in a cell stays yellow even when it wraps onto
 * a continuation line.
 *
 * Chrome budget per row: `│ <content> │ <content> │ … │` —
 * 1 left border + cols × (2 padding + colWidth) + cols right borders =
 * sum(colWidths) + 3·cols + 1.
 */
function TableBlock({
  align,
  header,
  rows,
}: {
  align: TableAlign[]
  header: string[]
  rows: string[][]
}) {
  // useTermWidth() so a stdout resize re-renders the table through React's
  // memo barriers — matches the same pattern ListLine adopted in upstream's
  // resize fix (commit 772399d).
  const termWidth = useTermWidth()
  const reserve = 4
  const cols = align.length
  const MIN_COL = 4
  // 1 left │ + per-cell (space + content + space + │) for every column.
  const chromeWidth = 3 * cols + 1

  // Flatten parseInline runs to atoms; width math + wrap operate on these.
  const headerAtoms = header.map(h => flattenRuns(parseInline(h)))
  const bodyAtoms = rows.map(r => r.map(cell => flattenRuns(parseInline(cell))))

  // Natural widths: max(atomLineWidth) per column over header + all rows.
  const colMaxWidths: number[] = []
  for (let cIdx = 0; cIdx < cols; cIdx++) {
    let w = atomLineWidth(headerAtoms[cIdx] ?? [])
    for (const r of bodyAtoms) {
      const cw = atomLineWidth(r[cIdx] ?? [])
      if (cw > w) w = cw
    }
    colMaxWidths.push(Math.max(MIN_COL, w))
  }

  const avail = Math.max(MIN_COL * cols + chromeWidth, termWidth - reserve)
  const wanted = colMaxWidths.reduce((a, b) => a + b, 0) + chromeWidth

  let colWidths: number[]
  if (wanted <= avail) {
    colWidths = colMaxWidths.slice()
  } else {
    const cellsAvail = avail - chromeWidth
    const naturalSum = colMaxWidths.reduce((a, b) => a + b, 0)
    const ratio = cellsAvail / naturalSum
    colWidths = colMaxWidths.map(w => Math.max(MIN_COL, Math.floor(w * ratio)))
    let total = colWidths.reduce((a, b) => a + b, 0)
    while (total > cellsAvail) {
      let mi = 0
      for (let i = 1; i < cols; i++) if (colWidths[i] > colWidths[mi]) mi = i
      if (colWidths[mi] <= MIN_COL) break
      colWidths[mi]--
      total--
    }
  }

  function buildRule(type: "top" | "mid" | "bot"): string {
    const L = type === "top" ? "┌" : type === "bot" ? "└" : "├"
    const R = type === "top" ? "┐" : type === "bot" ? "┘" : "┤"
    const X = type === "top" ? "┬" : type === "bot" ? "┴" : "┼"
    return L + colWidths.map(w => "─".repeat(w + 2)).join(X) + R
  }

  function atomStyleProps(s: AtomStyle, isHeader: boolean): {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    color?: string
  } {
    const props: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string } = {}
    if (s.bold || isHeader) props.bold = true
    if (s.italic) props.italic = true
    // Color resolution priority: code (warning) wins, then link (accent),
    // then header-vs-body default. Each Ink <Text> sets its own style so
    // nesting/inheritance doesn't matter here.
    if (s.code) props.color = c.warning
    else if (s.math) props.color = c.info
    else if (s.link) { props.color = c.accent; props.underline = true }
    else props.color = isHeader ? c.accent : c.text.primary
    return props
  }

  function renderCellLineContent(atomLine: Atom[], col: number, isHeader: boolean): React.ReactNode {
    const w = atomLineWidth(atomLine)
    const padN = Math.max(0, colWidths[col] - w)
    const a = align[col] ?? "default"
    let leftPad = 0
    let rightPad = 0
    if (a === "right") leftPad = padN
    else if (a === "center") { leftPad = Math.floor(padN / 2); rightPad = padN - leftPad }
    else rightPad = padN
    return (
      <>
        {leftPad > 0 && <Text>{" ".repeat(leftPad)}</Text>}
        {atomLine.map((atom, i) => (
          <Text key={i} {...atomStyleProps(atom.style, isHeader)}>{atom.value}</Text>
        ))}
        {rightPad > 0 && <Text>{" ".repeat(rightPad)}</Text>}
      </>
    )
  }

  function renderRowLines(cellLines: Atom[][][], isHeader: boolean, keyPrefix: string): React.ReactNode {
    const rowHeight = Math.max(1, ...cellLines.map(l => l.length))
    const out: React.ReactNode[] = []
    for (let li = 0; li < rowHeight; li++) {
      out.push(
        <Text key={`${keyPrefix}-${li}`}>
          <Text color={c.text.faint}>│</Text>
          {cellLines.map((wrappedLines, ci) => (
            <Fragment key={ci}>
              <Text> </Text>
              {renderCellLineContent(wrappedLines[li] ?? [], ci, isHeader)}
              <Text> </Text>
              <Text color={c.text.faint}>│</Text>
            </Fragment>
          ))}
        </Text>,
      )
    }
    return out
  }

  // Pre-wrap every cell's atoms at its assigned column width.
  const headerLines = headerAtoms.map((atoms, ci) => wrapAtoms(atoms, colWidths[ci]))
  const bodyLines = bodyAtoms.map(row =>
    row.map((atoms, ci) => wrapAtoms(atoms, colWidths[ci])),
  )

  return (
    <Box flexDirection="column">
      <Text color={c.text.faint}>{buildRule("top")}</Text>
      {renderRowLines(headerLines, true, "h")}
      <Text color={c.text.faint}>{buildRule("mid")}</Text>
      {bodyLines.map((cellLines, ri) => (
        <Fragment key={ri}>
          {renderRowLines(cellLines, false, `r${ri}`)}
          {ri < bodyLines.length - 1 && (
            <Text color={c.text.faint}>{buildRule("mid")}</Text>
          )}
        </Fragment>
      ))}
      <Text color={c.text.faint}>{buildRule("bot")}</Text>
    </Box>
  )
}

// ── Inline atom model for styled cell wrapping ─────────────────────────
// Table cells need word-wrap that preserves `code` / `bold` / `italic` /
// link / math styling across line boundaries. Ink's built-in Text wrap doesn't
// know our column widths, and pure plain-text wrap drops the styling.
// The atom model flattens parseInline runs to a sequence of
// `{ style, value }` segments — each one a single styled span — then
// wrapAtoms re-packs them into per-line arrays whose total displayWidth
// fits the target column. Render time, each atom becomes its own Ink
// <Text> with style derived from `atom.style` + the header flag.

type AtomStyle = {
  bold?: boolean
  italic?: boolean
  code?: boolean
  math?: boolean
  /** href if this atom is part of a link, undefined otherwise. */
  link?: string
}
type Atom = { style: AtomStyle; value: string }

function flattenRuns(runs: InlineRun[], base: AtomStyle = {}): Atom[] {
  const out: Atom[] = []
  for (const r of runs) {
    if (r.kind === "text") {
      if (r.value) out.push({ style: { ...base }, value: r.value })
    } else if (r.kind === "code") {
      if (r.value) out.push({ style: { ...base, code: true }, value: r.value })
    } else if (r.kind === "math") {
      if (r.value) out.push({ style: { ...base, math: true }, value: r.value })
    } else if (r.kind === "bold") {
      out.push(...flattenRuns(r.runs, { ...base, bold: true }))
    } else if (r.kind === "italic") {
      out.push(...flattenRuns(r.runs, { ...base, italic: true }))
    } else if (r.kind === "link") {
      const label = r.label || r.href
      if (label) out.push({ style: { ...base, link: r.href }, value: label })
    }
  }
  return out
}

function stylesEqual(a: AtomStyle, b: AtomStyle): boolean {
  return a.bold === b.bold
    && a.italic === b.italic
    && a.code === b.code
    && a.math === b.math
    && a.link === b.link
}

function atomLineWidth(line: Atom[]): number {
  let w = 0
  for (const a of line) w += displayWidth(a.value)
  return w
}

/** Tokenize a string into alternating whitespace and non-whitespace runs.
 *  Used by wrapAtoms to find wrap points without re-scanning the value. */
function tokenize(s: string): Array<{ kind: "ws" | "word"; value: string; w: number }> {
  const out: Array<{ kind: "ws" | "word"; value: string; w: number }> = []
  let buf = ""
  let bufIsWs = false
  for (const ch of s) {
    const isWs = /\s/.test(ch)
    if (buf === "") {
      buf = ch
      bufIsWs = isWs
    } else if (isWs === bufIsWs) {
      buf += ch
    } else {
      out.push({ kind: bufIsWs ? "ws" : "word", value: buf, w: displayWidth(buf) })
      buf = ch
      bufIsWs = isWs
    }
  }
  if (buf) out.push({ kind: bufIsWs ? "ws" : "word", value: buf, w: displayWidth(buf) })
  return out
}

/**
 * Word-wrap an atom sequence into lines of total display-width ≤ `width`,
 * preserving each atom's style. Whitespace at line boundaries is dropped.
 * Words longer than `width` (long CJK runs, URLs) get hard-broken by
 * character — the originating atom's style is carried onto each chunk so
 * a wrapped inline `code` span stays yellow across the break.
 *
 * Consecutive atoms with identical style are coalesced into one atom on
 * the output line so the renderer emits fewer Ink <Text> spans.
 */
function wrapAtoms(atoms: Atom[], width: number): Atom[][] {
  if (width <= 0 || atoms.length === 0) return [atoms.map(a => ({ ...a }))]
  if (atomLineWidth(atoms) <= width) return [atoms.map(a => ({ ...a }))]

  const lines: Atom[][] = []
  let current: Atom[] = []
  let currentW = 0

  const pushLine = (): void => {
    // Trim trailing whitespace inside the last atom of the line; if the
    // atom is whitespace-only after trim, drop it entirely. Repeat until a
    // content atom remains so a multi-atom trailing-ws tail collapses
    // cleanly (e.g. `[text "foo ", code " "]` → `[text "foo"]`).
    while (current.length > 0) {
      const last = current[current.length - 1]
      const trimmed = last.value.replace(/\s+$/, "")
      if (trimmed.length === 0) {
        current.pop()
        continue
      }
      if (trimmed !== last.value) {
        current[current.length - 1] = { style: last.style, value: trimmed }
      }
      break
    }
    lines.push(current)
    current = []
    currentW = 0
  }

  const append = (style: AtomStyle, value: string): void => {
    if (!value) return
    const last = current[current.length - 1]
    if (last && stylesEqual(last.style, style)) {
      current[current.length - 1] = { style: last.style, value: last.value + value }
    } else {
      current.push({ style: { ...style }, value })
    }
    currentW += displayWidth(value)
  }

  for (const atom of atoms) {
    for (const tok of tokenize(atom.value)) {
      if (tok.kind === "ws") {
        if (currentW === 0) continue // drop leading whitespace on new line
        if (currentW + tok.w > width) pushLine()
        else append(atom.style, tok.value)
      } else if (currentW + tok.w <= width) {
        append(atom.style, tok.value)
      } else if (tok.w <= width) {
        if (currentW > 0) pushLine()
        append(atom.style, tok.value)
      } else {
        // Word too long even for a fresh line — hard-break by character,
        // carrying the atom's style onto each chunk.
        if (currentW > 0) pushLine()
        for (const ch of tok.value) {
          const cw = displayWidth(ch)
          if (currentW + cw > width) pushLine()
          append(atom.style, ch)
        }
      }
    }
  }

  if (current.length > 0) pushLine()
  return lines.length > 0 ? lines : [[]]
}

function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.kind) {
    case "blank":
      return <Box key={key} height={1} />
    case "h":
      return (
        <Box key={key} marginTop={block.level <= 2 ? 1 : 0}>
          <Text bold color={HEADING_COLORS[block.level - 1]}>
            {renderRuns(parseInline(block.text))}
          </Text>
        </Box>
      )
    case "p":
      return (
        <Box key={key}>
          <Text color={c.text.primary}>{renderRuns(parseInline(block.text))}</Text>
        </Box>
      )
    case "quote":
      return (
        <Box key={key} flexDirection="column">
          {block.text.split("\n").map((line, i) => (
            <ListLine
              key={i}
              marker="│ "
              markerColor={c.text.faint}
              textColor={c.text.muted}
              runs={parseInline(line)}
            />
          ))}
        </Box>
      )
    case "ul":
      return (
        <Box key={key} flexDirection="column">
          {block.items.map((item, i) => (
            <ListLine
              key={i}
              marker="• "
              markerColor={c.accent}
              textColor={c.text.primary}
              runs={parseInline(item)}
            />
          ))}
        </Box>
      )
    case "ol":
      return (
        <Box key={key} flexDirection="column">
          {block.items.map((item, i) => (
            <ListLine
              key={i}
              marker={`${block.start + i}. `}
              markerColor={c.accent}
              textColor={c.text.primary}
              runs={parseInline(item)}
            />
          ))}
        </Box>
      )
    case "fence":
      return (
        <Box key={key} marginY={0}>
          <CodeBlock code={block.code} lang={block.lang} />
        </Box>
      )
    case "math":
      return <DisplayMath key={key} latex={block.latex} />
    case "table":
      return (
        <Box key={key} flexDirection="column">
          <TableBlock align={block.align} header={block.header} rows={block.rows} />
        </Box>
      )
  }
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source)
  return (
    <Box flexDirection="column">
      {blocks.map(renderBlock)}
    </Box>
  )
}

// Test-only — internal parser exposed so block detection (especially the
// GFM table sniff) can be unit-tested without booting an Ink renderer.
export const __test = {
  parseBlocks,
  parseAlignRow,
  splitTableRow,
  looksLikeTableRow,
  flattenRuns,
  wrapAtoms,
  wrapMathForTerminal,
  parseInline,
}

/** @jsxImportSource react */
// Unified-diff renderer for tool outputs (edit_file / multi_edit / write_file)
// and the ApprovalBar preview.
//
// Visual layout (per body line):
//
//     | 123  124 │ +foo()
//       ^   ^   ^ ^ ^
//       old new │ marker + shiki-tokenized body
//
// Hunk headers (`@@ -a,b +c,d @@`) render as muted full-width lines so
// users can orient when there are multiple regions. The body text inside
// each hunk is fed through shiki using the language inferred from the
// `+++ b/path.ext` header (or an explicit `lang` prop), so the diff
// itself shows syntax-highlighted code — not just colored +/- markers.
import { Fragment, memo } from "react"
import { Box, Text } from "ink"
import { tokenize, type ThemedToken } from "./highlight.js"
import { fontStyleToProps } from "./code-block.js"
import { displayWidth } from "./truncate.js"
import { c } from "./theme.js"
import { useTermWidth } from "./term-width.js"

// ── Diff palette ────────────────────────────────────────────────────────
// Mirrors the diff scope colors in highlight.ts's theme. Background tints
// are *very* dim so syntax-highlighted body text on top stays legible.
const DIFF_PLUS_FG  = "#8aa755"   // olive
const DIFF_MINUS_FG = "#c8543a"   // brick
const DIFF_PLUS_BG  = "#1a2415"   // dim olive
const DIFF_MINUS_BG = "#2a1715"   // dim brick
const HUNK_HEADER_FG = c.text.faint
const GUTTER_FG      = c.text.faint

// ── Parser ──────────────────────────────────────────────────────────────
type Kind = "header" | "context" | "added" | "removed"

interface Line {
  kind: Kind
  text: string         // body without leading +/-/space marker (or full @@ for headers)
  oldNo?: number
  newNo?: number
}

interface Parsed {
  lines: Line[]
  /** Max line number across both sides — drives gutter width sizing. */
  maxLine: number
  /** Filetype inferred from `+++ b/path.ext`, or "" when missing. */
  filetype: string
}

function inferFiletype(diff: string): string {
  const m = diff.match(/^\+\+\+ (?:b\/)?(.+?)(?:\s|$)/m)
  if (!m) return ""
  const path = m[1] ?? ""
  const dot = path.lastIndexOf(".")
  return dot >= 0 ? path.slice(dot + 1) : ""
}

function parseDiff(diff: string): Parsed {
  const out: Line[] = []
  const filetype = inferFiletype(diff)
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  let maxLine = 0

  const raws = diff.split(/\r?\n/)
  if (raws.length > 0 && raws[raws.length - 1] === "") raws.pop()

  for (const raw of raws) {
    if (!inHunk) {
      // Skip preamble (`diff --git`, `index abc..def`, `--- a/x`, `+++ b/y`)
      // — bodies start at the first hunk header.
      if (
        raw.startsWith("diff ") || raw.startsWith("index ") ||
        raw.startsWith("--- ")  || raw.startsWith("+++ ") ||
        raw === ""
      ) {
        if (!raw.startsWith("@@")) continue
      }
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@(.*)$/)
      if (m) {
        oldNo = parseInt(m[1] ?? "1", 10)
        newNo = parseInt(m[2] ?? "1", 10)
        inHunk = true
        out.push({ kind: "header", text: raw })
        continue
      }
      // Malformed hunk header — render as context, don't crash
      out.push({ kind: "context", text: raw })
      continue
    }
    if (!inHunk) {
      // Junk before any hunk — keep visible as context (better than dropping)
      out.push({ kind: "context", text: raw })
      continue
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "added", text: raw.slice(1), newNo })
      maxLine = Math.max(maxLine, newNo)
      newNo++
    } else if (raw.startsWith("-")) {
      out.push({ kind: "removed", text: raw.slice(1), oldNo })
      maxLine = Math.max(maxLine, oldNo)
      oldNo++
    } else {
      // Context — strip exactly one leading space (the diff marker), but
      // tolerate the "no space" case some tools emit.
      const text = raw.startsWith(" ") ? raw.slice(1) : raw
      out.push({ kind: "context", text, oldNo, newNo })
      maxLine = Math.max(maxLine, Math.max(oldNo, newNo))
      oldNo++
      newNo++
    }
  }
  return { lines: out, maxLine, filetype }
}

// ── Render ───────────────────────────────────────────────────────────────

interface Props {
  source: string
  /** Override the language used to tokenize body text. When omitted, we
   *  infer from the diff's `+++` header. */
  lang?: string
}

// Memoized: a tool result's diff source is finalized when the tool completes
// and never changes afterward, but the spinner ticks every 150ms during agent
// runs and re-renders the active log inline. Without memo, every spinner
// frame re-parses the diff and re-tokenizes every body line through shiki,
// which is heavy enough that the resulting log-update repaints flash visibly
// (the "diff-while-streaming flicker" symptom). Default shallow compare on
// {source, lang} is sufficient — both are stable strings on the log object.
export const Diff = memo(function Diff({ source, lang }: Props) {
  const parsed = parseDiff(source)
  const ft = lang ?? parsed.filetype
  const gutterWidth = String(parsed.maxLine).length

  return (
    <Box flexDirection="column">
      {parsed.lines.map((line, i) => (
        <DiffRow key={i} line={line} gutterWidth={gutterWidth} filetype={ft} />
      ))}
    </Box>
  )
})

interface RowProps {
  line: Line
  gutterWidth: number
  filetype: string
}

// Estimate of how much horizontal real estate the diff has after the
// outer indent + chrome the parent (ToolResult) wraps it in. Used as a
// floor when terminal columns aren't readable; the actual layout uses
// the live terminal width minus the gutter+outer-indent.
const ASSUMED_OUTER_INDENT = 5

function DiffRow({ line, gutterWidth, filetype }: RowProps) {
  if (line.kind === "header") {
    return <Text wrap="truncate-end" color={HUNK_HEADER_FG}>{line.text}</Text>
  }

  const oldStr = line.oldNo !== undefined ? String(line.oldNo).padStart(gutterWidth) : " ".repeat(gutterWidth)
  const newStr = line.newNo !== undefined ? String(line.newNo).padStart(gutterWidth) : " ".repeat(gutterWidth)
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
  const fg     = line.kind === "added" ? DIFF_PLUS_FG : line.kind === "removed" ? DIFF_MINUS_FG : c.text.muted
  const bg     = line.kind === "added" ? DIFF_PLUS_BG : line.kind === "removed" ? DIFF_MINUS_BG : undefined

  // Empty body → render a single space so the row keeps its background.
  const body = line.text === "" ? " " : line.text

  // Manual word-wrap: split the body into chunks that fit in the
  // available body column, then render each chunk on its own row with
  // the gutter+marker prefix repeated. Continuation rows show a blank
  // line-number column but still keep the marker — matches the
  // conventional diff viewer (and Claude Code's NAPI-driven renderer)
  // where you can tell at a glance "this row is part of a -/+ change".
  const termWidth = useTermWidth()
  const gutterText = `${oldStr} ${newStr} │ `
  const blankGutter = " ".repeat(gutterText.length)
  const prefixCols = gutterText.length + 2 // + marker(1) + space(1)
  const bodyMax = Math.max(20, termWidth - ASSUMED_OUTER_INDENT - prefixCols - 1)

  const chunks = wrapBody(body, bodyMax)

  // Each chunk renders as a single <Text> element, not a Box of Text
  // children. Why: Ink's flex layout on a <Box flexDirection="row"> with
  // backgroundColor + Text children produces a phantom blank row beneath
  // each `+`/`-` line. Inline nested <Text> avoids the flex pass entirely
  // — every nested Text contributes one styled span on the same visual
  // line. Same pattern the markdown table renderer uses. Background tint
  // still applies via Text.backgroundColor on the outermost Text.
  return (
    <Fragment>
      {chunks.map((chunk, i) => (
        <Text key={i} {...(bg ? { backgroundColor: bg } : {})}>
          <Text color={GUTTER_FG}>{i === 0 ? gutterText : blankGutter}</Text>
          <Text color={fg}>{marker} </Text>
          <Text>{renderBody(chunk, filetype, fg)}</Text>
        </Text>
      ))}
    </Fragment>
  )
}

/** Split a body line into chunks that each fit within `width` cells. Uses
 *  display-width for CJK awareness; chunks at character boundaries (no
 *  word-boundary tracking — accept mid-word splits for simplicity, matches
 *  what `git diff | less -S` does when wrap kicks in). */
function wrapBody(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text]
  const out: string[] = []
  let buf = ""
  let bufW = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    if (bufW + w > width && buf.length > 0) {
      out.push(buf)
      buf = ""
      bufW = 0
    }
    buf += ch
    bufW += w
  }
  if (buf.length > 0) out.push(buf)
  return out
}

function renderBody(text: string, filetype: string, fallbackFg: string): React.ReactNode {
  if (!filetype) return <Text color={fallbackFg}>{text}</Text>
  const tokens = tokenize(text, filetype)
  if (!tokens || tokens.length === 0) return <Text color={fallbackFg}>{text}</Text>
  // Diffs are line-by-line; tokenize returned an array (one entry, since the
  // input had no newline). Apply colors + font style; fall back to the +/-
  // foreground for tokens that don't carry an explicit color.
  const line: ThemedToken[] = tokens[0] ?? []
  if (line.length === 0) return <Text color={fallbackFg}>{text}</Text>
  return line.map((tok, j) => {
    const style = fontStyleToProps(tok.fontStyle)
    return (
      <Text key={j} color={tok.color ?? fallbackFg} {...style}>
        {tok.content}
      </Text>
    )
  })
}

/** Detect whether a string looks like a unified diff. Used by tool result
 *  renderers to decide between Diff vs plain output rendering. */
export function looksLikeDiff(text: string): boolean {
  if (!text) return false
  return /(^|\n)@@\s/.test(text) || /(^|\n)\+\+\+ /.test(text)
}

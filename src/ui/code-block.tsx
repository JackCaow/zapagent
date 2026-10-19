/** @jsxImportSource react */
// Syntax-highlighted code block, Ink edition. Pulls colored tokens from
// the shiki highlighter (initialized at boot in src/ui/highlight.ts) and
// emits them as Ink <Text>. Falls back to plain `c.text.muted` when the
// highlighter isn't ready or the language isn't loaded — never throws.
//
// Token attributes carried from shiki (bold / italic / underline / strike)
// are mapped onto Ink Text props so theme rules like `keyword → bold` and
// `comment → italic` actually render. The opentui-era code did this via
// TextAttributes bit flags; here we splay the bits into named JSX props.
import { Box, Text } from "ink"
import { tokenize, type ThemedToken } from "./highlight.js"
import { c } from "./theme.js"

// Shiki's FontStyle enum (textmate convention).
const FS_ITALIC        = 1
const FS_BOLD          = 2
const FS_UNDERLINE     = 4
const FS_STRIKETHROUGH = 8

interface TokenStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

export function fontStyleToProps(fs: number | undefined): TokenStyle {
  if (!fs || fs < 0) return {}
  return {
    italic:        (fs & FS_ITALIC)        !== 0 || undefined,
    bold:          (fs & FS_BOLD)          !== 0 || undefined,
    underline:     (fs & FS_UNDERLINE)     !== 0 || undefined,
    strikethrough: (fs & FS_STRIKETHROUGH) !== 0 || undefined,
  }
}

interface Props {
  code: string
  lang?: string
  /** When true, render with no surrounding chrome — useful when the caller
   *  already provides a container (e.g. Transcript indents code blocks
   *  inside an indented Box). */
  bare?: boolean
}

export function CodeBlock({ code, lang = "", bare = false }: Props) {
  const trimmed = code.replace(/\n+$/, "")
  const tokens = tokenize(trimmed, lang)
  const lines: React.ReactNode[] = tokens
    ? tokens.map((line, i) => <Text key={i}>{renderLine(line)}</Text>)
    : trimmed.split("\n").map((line, i) => (
        <Text key={i} color={c.text.muted}>{line || " "}</Text>
      ))

  if (bare) {
    return <Box flexDirection="column">{lines}</Box>
  }

  // Per-line left rail in faint border color + optional language label
  // above. No box border — the rail is enough to visually delimit the
  // block from prose without the heavy "framed widget" look.
  return (
    <Box flexDirection="column">
      {lang && (
        <Box>
          <Text color={c.text.faint} italic>{lang}</Text>
        </Box>
      )}
      {lines.map((line, i) => (
        <Box key={i} flexDirection="row">
          <Box flexShrink={0} width={2}>
            <Text color={c.border.subtle}>│ </Text>
          </Box>
          <Box flexGrow={1}>{line}</Box>
        </Box>
      ))}
    </Box>
  )
}

function renderLine(line: ThemedToken[]): React.ReactNode {
  // Empty source line → single space so the row doesn't collapse to 0 height.
  if (line.length === 0) return " "
  return line.map((tok, j) => {
    const style = fontStyleToProps(tok.fontStyle)
    return (
      <Text key={j} color={tok.color ?? c.text.muted} {...style}>
        {tok.content}
      </Text>
    )
  })
}

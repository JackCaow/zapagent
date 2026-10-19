/** @jsxImportSource react */
// File-reference palette — popup shown beneath the prompt when the user
// types `@<query>`. Lists matching project files (gitignore-respecting,
// dirs end in "/"). Tab/Enter inserts the path back into the input via
// replaceAtToken; the file content itself is inlined into the model
// message at submit time (App.tsx handleSubmit).
import { Box, Text } from "ink"
import { c } from "./theme.js"

const VISIBLE_ROWS = 12

interface Props {
  entries: string[]
  selected: number
}

export function FilePalette({ entries, selected }: Props) {
  if (entries.length === 0) return null
  // Window the list around the selection — same windowing rule as
  // SlashPalette so the popup never exceeds VISIBLE_ROWS.
  let start = 0
  if (entries.length > VISIBLE_ROWS) {
    start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), entries.length - VISIBLE_ROWS))
  }
  const window = entries.slice(start, start + VISIBLE_ROWS)
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {window.map((path, i) => {
        const idx = start + i
        const active = idx === selected
        const isDir = path.endsWith("/")
        const fg = active ? c.accent : isDir ? c.text.muted : c.text.faint
        return (
          <Box key={path}>
            <Text color={fg} bold={active} wrap="truncate">
              {path}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

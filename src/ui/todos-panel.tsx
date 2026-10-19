/** @jsxImportSource react */
import { memo } from "react"
import { Box, Text } from "ink"
import type { Todo } from "../../zapsdk/index.js"
import { c } from "./theme.js"

function statusGlyph(status: Todo["status"]): { glyph: string; fg: string } {
  switch (status) {
    case "completed":   return { glyph: "✓", fg: c.text.muted }
    case "blocked":     return { glyph: "!", fg: c.text.muted }
    case "in_progress": return { glyph: "▸", fg: c.accent }
    default:            return { glyph: "·", fg: c.text.faint }
  }
}

function countBy(todos: Todo[], status: Todo["status"]): number {
  let n = 0
  for (const t of todos) if (t.status === status) n++
  return n
}

export const TodosPanel = memo(function TodosPanel({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return null
  const doneCount = countBy(todos, "completed")
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={c.text.muted}>
        {"▾ Todos  "}
        <Text color={c.text.faint}>{`${doneCount}/${todos.length}`}</Text>
      </Text>
      {todos.map((todo, i) => {
        const { glyph, fg } = statusGlyph(todo.status)
        const textFg = todo.status === "completed"
          ? c.text.muted
          : todo.status === "in_progress"
            ? c.accent
            : c.text.primary
        return (
          <Box key={i} flexDirection="row">
            <Text color={fg}>{`  ${glyph} `}</Text>
            <Text color={textFg}>{todo.content}{todo.status === "blocked" && todo.blocked ? ` — ${todo.blocked.reason}` : ""}</Text>
          </Box>
        )
      })}
    </Box>
  )
})

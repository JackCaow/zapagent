/** @jsxImportSource react */
import { memo, type ReactNode } from "react"
import { Box, Text } from "ink"
import type { Todo } from "../../zapsdk/index.js"
import { goalActionText, goalObjectiveText, type GoalView } from "../goal-view.js"
import { displayWidth, truncateToWidth } from "./truncate.js"
import { c } from "./theme.js"

export interface GoalStatusProps {
  goal: GoalView
  termWidth: number
  attached?: boolean
  todos?: readonly Todo[]
  children?: ReactNode
}

/** Dynamic input-area content, never an item in Transcript's Static history. */
export const GoalStatus = memo(function GoalStatus({ goal, termWidth, attached = false, todos = [], children }: GoalStatusProps) {
  const width = Math.max(1, termWidth - 4)
  const prefix = "◇ 目标："
  const progress = attached && todos.length && width >= 40 ? `已完成 ${todos.filter(todo => todo.status === "completed").length}/${todos.length} 步` : ""
  const title = truncateToWidth(prefix + goalObjectiveText(goal.objective), Math.max(1, width - (progress ? displayWidth(progress) + 2 : 0)))
  const warning = ["blocked", "paused", "awaiting_acceptance", "budget_limited"].includes(goal.status)
  const symbol = goal.status === "completed" ? "✓" : goal.status === "paused" ? "Ⅱ" : warning ? "!" : "·"
  return (
    <Box flexDirection="column" paddingX={2} marginTop={1}>
      <Box flexDirection="row">
        <Text color={c.text.primary} wrap="truncate-end">{title}</Text>
        {progress ? <Text color={c.text.faint}>{`  ${progress}`}</Text> : null}
      </Box>
      {children ?? <Text color={warning ? c.warning : c.text.muted} wrap="truncate-end">
        {truncateToWidth(`${symbol} ${goalActionText(goal, attached, todos)}`, width)}
      </Text>}
    </Box>
  )
})

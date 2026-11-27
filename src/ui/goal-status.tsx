/** @jsxImportSource react */
import { memo, type ReactNode } from "react"
import { Box, Text } from "ink"
import { goalActionText, goalObjectiveText, type GoalView } from "../goal-view.js"
import { truncateToWidth } from "./truncate.js"
import { c } from "./theme.js"

export interface GoalStatusProps {
  goal: GoalView
  termWidth: number
  attached?: boolean
  children?: ReactNode
}

/** Dynamic input-area content, never an item in Transcript's Static history. */
export const GoalStatus = memo(function GoalStatus({ goal, termWidth, attached = false, children }: GoalStatusProps) {
  const width = Math.max(1, termWidth - 4)
  const prefix = "◇ 目标："
  const title = truncateToWidth(prefix + goalObjectiveText(goal.objective), width)
  const warning = ["blocked", "paused", "awaiting_acceptance", "budget_limited", "failed"].includes(goal.status)
  const symbol = goal.status === "completed" ? "✓" : goal.status === "paused" ? "Ⅱ" : warning ? "!" : "·"
  return (
    <Box flexDirection="column" paddingX={2} marginTop={1}>
      <Box flexDirection="row">
        <Text color={c.text.primary} wrap="truncate-end">{title}</Text>
      </Box>
      {children ?? <Text color={goal.status === "failed" ? c.error : warning ? c.warning : c.text.muted} wrap="truncate-end">
        {truncateToWidth(`${symbol} ${goalActionText(goal, attached)}`, width)}
      </Text>}
    </Box>
  )
})

/** @jsxImportSource react */
// One-line context-usage warning that surfaces above the Prompt as the
// conversation approaches the auto-compact trigger.
//
//   - error tier (≥ 70% of context window, ALWAYS shown): warning color,
//     "Context low (XX% remaining) · Run /compact to compact & continue".
//     This is actionable — the user is close enough to the trigger that
//     they may want to compact manually to control the boundary.
//   - heads-up tier (≥ 60%, ZAPCODE_VERBOSE_CTX=1 only): dim text,
//     "XX% until auto-compact". Useful while debugging context behaviour
//     but noisy for everyday use — a row that says "everything's fine"
//     at 60-70% just adds chrome.
//
// Hidden entirely when usage is below 70% (or 60% under verbose mode).

import { memo } from "react"
import { Box, Text } from "ink"
import type { ContextBudgetSnapshot } from "../context-budget.js"
import { c } from "./theme.js"

const VERBOSE = process.env.ZAPCODE_VERBOSE_CTX === "1"

interface Props {
  contextBudget: ContextBudgetSnapshot
}

export function tokenWarningText(
  contextBudget: ContextBudgetSnapshot,
  options: { verbose?: boolean } = {},
): { text: string; color: string } | null {
  if (contextBudget.usage.source === "pending") return null
  const percentLeft = contextBudget.percentUntilCompact
  if (percentLeft === null) return null
  if (contextBudget.severity === "warning" || contextBudget.severity === "critical") {
    return {
      text: `Context low (${percentLeft}% remaining) · Run /compact to compact & continue`,
      color: c.warning,
    }
  }
  if ((options.verbose ?? VERBOSE) && contextBudget.severity === "notice") {
    return {
      text: `${percentLeft}% until auto-compact`,
      color: c.text.faint,
    }
  }
  return null
}

export const TokenWarning = memo(function TokenWarning({ contextBudget }: Props) {
  const warning = tokenWarningText(contextBudget)
  if (!warning) return null
  if (warning.color === c.warning) {
    return (
      <Box paddingX={1}>
        <Text color={warning.color}>{warning.text}</Text>
      </Box>
    )
  }
  return (
    <Box paddingX={1}>
      <Text color={warning.color}>{warning.text}</Text>
    </Box>
  )
})

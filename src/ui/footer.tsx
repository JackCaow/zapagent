/** @jsxImportSource react */
import { memo } from "react"
import { Box, Text } from "ink"
import { c } from "./theme.js"
import { displayWidth, truncateToWidth } from "./truncate.js"
import type { OutputThroughputSample } from "../agent/outputThroughput.js"
import type { PermissionMode } from "../config.js"
import type { ContextBudgetSnapshot } from "../context-budget.js"

/** Compact "85.9K" / "1.2M" rendering for the always-visible footer
 *  segment. 1 decimal place across the K and M ranges so the user can
 *  see real movement turn-to-turn — `Math.round` was hiding sub-1K
 *  deltas (e.g. 50.4K and 49.8K both rendered as "50K"). */
function formatTokensK(n: number): string {
  if (n <= 0) return "0"
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function contextFooterText(contextBudget: ContextBudgetSnapshot): string {
  const contextTokens = contextBudget.usage.currentPromptTokens
  const maxContextTokens = contextBudget.limits.contextWindow
  if (contextBudget.usage.source === "pending") {
    return contextTokens !== null && contextTokens > 0
      ? `?/${formatTokensK(maxContextTokens)}`
      : ""
  }
  if (contextTokens === null || contextTokens <= 0) return ""
  return `${contextBudget.usage.approximate ? "~" : ""}${formatTokensK(contextTokens)}/${formatTokensK(maxContextTokens)}`
}

export function throughputFooterText(sample: OutputThroughputSample | undefined): string {
  if (!sample || !Number.isFinite(sample.tokensPerSecond) || sample.tokensPerSecond <= 0) return ""
  return `${sample.estimated ? "~" : ""}${sample.tokensPerSecond.toFixed(1)} token/s`
}

interface FooterProps {
  outputThroughput?: OutputThroughputSample
  cwd: string
  provider: string
  model: string
  effort?: string
  isRunning: boolean
  step: number
  maxSteps: number
  contextBudget: ContextBudgetSnapshot
  hasApiKey: boolean
  showWelcome?: boolean
  shellMode?: boolean
  permissionMode?: PermissionMode
  termWidth: number
  /** Compact MCP server status: `{ready, total, degraded, needsAuth, error}`.
   *  Footer renders a single token when total > 0 — green if all ready,
   *  yellow if anything is degraded/connecting, red if anything is errored
   *  or needs auth. Click-to-expand maps to `/mcp` slash command, not
   *  enforced in the footer itself. */
  mcp?: { ready: number; total: number; degraded: number; needsAuth: number; error: number }
}

export const Footer = memo(function Footer({
  outputThroughput,
  cwd,
  provider,
  model,
  effort,
  isRunning,
  contextBudget,
  hasApiKey,
  showWelcome,
  shellMode,
  permissionMode = "default",
  termWidth,
  mcp,
}: FooterProps) {
  const dotColor = isRunning ? c.warning : hasApiKey ? c.success : c.warning
  // The denominator is the advertised model window. Operational urgency is
  // computed centrally against compactAt, so Footer, TokenWarning and /status
  // cannot drift into three different threshold systems.
  const tpsText = throughputFooterText(outputThroughput)
  const ctxText = contextFooterText(contextBudget)
  const ctxColor =
    contextBudget.severity === "critical" ? c.error
    : contextBudget.severity === "warning" ? c.warning
    : contextBudget.severity === "notice" ? c.accent
    : c.text.faint

  const modeLabel: Record<PermissionMode, string | null> = {
    default:            null,
    acceptEdits:        "accept-edits",
    plan:               "plan",
    bypassPermissions:  "bypass",
  }
  const modeColor: Record<PermissionMode, string> = {
    default:            c.text.faint,
    acceptEdits:        c.text.muted,
    plan:               c.accent,
    bypassPermissions:  c.warning,
  }

  type Seg = { text: string; fg: string; key: string }
  const rightSegments: Seg[] = []
  if (shellMode && !isRunning) rightSegments.push({ text: "shell", fg: c.warning, key: "shell" })
  if (modeLabel[permissionMode]) rightSegments.push({ text: modeLabel[permissionMode]!, fg: modeColor[permissionMode], key: "mode" })
  if (!hasApiKey && !showWelcome) rightSegments.push({ text: "! /connect", fg: c.warning, key: "connect" })
  if (showWelcome && !hasApiKey) rightSegments.push({ text: "/connect", fg: c.accent, key: "connect" })
  if (tpsText) rightSegments.push({ text: tpsText, fg: c.text.muted, key: "tps" })
  if (ctxText) rightSegments.push({ text: ctxText, fg: ctxColor, key: "ctx" })
  if (mcp && mcp.total > 0) {
    const hasError = mcp.error > 0 || mcp.needsAuth > 0
    const hasDegraded = mcp.degraded > 0 || mcp.ready < mcp.total - mcp.error - mcp.needsAuth
    const mcpColor = hasError ? c.error : hasDegraded ? c.warning : c.success
    rightSegments.push({
      text: `mcp ${mcp.ready}/${mcp.total}${hasError ? "!" : ""}`,
      fg: mcpColor,
      key: "mcp",
    })
  }
  rightSegments.push({ text: "●", fg: dotColor, key: "dot" })
  rightSegments.push({
    text: `${provider}/${model}${effort ? ` · ${effort}` : ""}`,
    fg: c.text.muted,
    key: "provider",
  })
  const DROP_ORDER = ["shell", "mode", "mcp", "ctx", "connect", "tps"] as const
  const safeWidth = Math.max(20, termWidth - 4)
  const computeRightWidth = (segs: Seg[]) =>
    segs.reduce((sum, s, i) => sum + displayWidth(s.text) + (i > 0 ? 2 : 0), 0)
  let rightWidth = computeRightWidth(rightSegments)
  const cwdWidth = displayWidth(cwd)
  for (const key of DROP_ORDER) {
    if (cwdWidth + rightWidth + 1 <= safeWidth) break
    const idx = rightSegments.findIndex(s => s.key === key)
    if (idx >= 0) {
      rightSegments.splice(idx, 1)
      rightWidth = computeRightWidth(rightSegments)
    }
  }
  const cwdBudget = Math.max(8, safeWidth - rightWidth - 1)
  const displayCwd = cwdWidth > cwdBudget ? truncateToWidth(cwd, cwdBudget) : cwd

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Text color={c.text.muted} wrap="truncate-end">{displayCwd}</Text>
      <Box flexDirection="row" gap={2}>
        {rightSegments.map(s => (
          <Text key={s.key} color={s.fg} wrap="truncate-end">{s.text}</Text>
        ))}
      </Box>
    </Box>
  )
})

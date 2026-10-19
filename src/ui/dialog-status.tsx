/** @jsxImportSource react */
// /status as a dropdown popup. Renders the same content as
// buildStatusText (kept in commands/status.ts for any future
// copy/headless use) but as a transient panel under the Prompt — Esc
// or Enter dismisses, no log row left in the transcript. Layout
// mirrors the slash palette: no border, single-column rows, faint
// chrome with one accent-colored title line on top.

import { useEffect, useMemo } from "react"
import { Box, Text, useInput } from "ink"
import { buildStatusText, type StatusContextDiagnostics, type StatusDiagnostics, type StatusUsageDetail } from "../commands/status.js"
import type { AppConfig } from "../config.js"
import type { ContextBudgetSnapshot } from "../context-budget.js"
import { c } from "./theme.js"
import { isReturnInput } from "./controlled-input.js"
import {
  cacheMemoryAuditPath,
  readRecentCacheMemoryAudit,
} from "../agent/cacheMemoryAudit.js"

interface Props {
  config: AppConfig
  contextBudget: ContextBudgetSnapshot
  contextDiagnostics?: StatusContextDiagnostics
  contextDiagnosticsHistory?: StatusContextDiagnostics[]
  usage?: StatusUsageDetail
  usageHistory?: StatusUsageDetail[]
  diagnostics?: StatusDiagnostics
  cwd: string
  onCancel: () => void
}

export function StatusDialog({
  config,
  contextBudget,
  contextDiagnostics,
  contextDiagnosticsHistory = [],
  usage,
  usageHistory = [],
  diagnostics,
  cwd,
  onCancel,
}: Props) {
  useInput((input, key) => {
    if (key.escape || isReturnInput(input, key)) onCancel()
  })
  // Hide the native terminal cursor while the dropdown is up — matches
  // PickerDialog's useHideNativeCursor without pulling in DialogFrame
  // (which would draw a border, not the slash-palette look the user asked
  // for). One-time write at mount; log-update keeps it hidden afterwards.
  useEffect(() => { process.stderr.write("\x1b[?25l") }, [])

  const cacheMemoryAudit = useMemo(() => ({
    path: cacheMemoryAuditPath(cwd),
    entries: readRecentCacheMemoryAudit(cwd),
  }), [cwd])
  const effectiveDiagnostics: StatusDiagnostics = {
    ...diagnostics,
    cacheMemoryAudit,
  }

  const text = buildStatusText(
    config,
    cwd,
    contextBudget.usage.currentPromptTokens ?? 0,
    usage,
    contextDiagnostics,
    contextDiagnosticsHistory,
    usageHistory,
    effectiveDiagnostics,
    contextBudget.usage.source === "pending",
    contextBudget,
  )
  const rows = text.split("\n")
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {rows.map((row, i) => {
        // Title row (first non-empty line, contains the lightning bolt):
        // accent + bold so it reads as the panel header.
        if (i === 0) {
          return <Text key={i} color={c.accent} bold>{row}</Text>
        }
        // Empty spacer rows render as a single blank line.
        if (!row.trim()) return <Text key={i}> </Text>
        // Section rows split into "key:        value" — render the key
        // faint and the value muted so the columns scan as a definition
        // list. The progress-bar row (no colon match) falls through to
        // the all-muted branch.
        const colon = row.indexOf(":")
        if (colon > 0 && colon < 24) {
          const key = row.slice(0, colon + 1)
          const value = row.slice(colon + 1)
          return (
            <Box key={i}>
              <Text color={c.text.faint}>{key}</Text>
              <Text color={c.text.muted}>{value}</Text>
            </Box>
          )
        }
        return <Text key={i} color={c.text.muted}>{row}</Text>
      })}
      <Box marginTop={1}>
        <Text color={c.text.faint}>esc / ⏎ close</Text>
      </Box>
    </Box>
  )
}

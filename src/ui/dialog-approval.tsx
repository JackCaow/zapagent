/** @jsxImportSource react */
// Inline approval bar — numbered select list, arrow-key navigation +
// Enter to confirm, Esc cancels. 1/2/3/4 numeric shortcuts skip nav.
//
// Compact layout (~9 rows total, border included):
//
//   ╭─────────────────────────────────────────────╮
//   │ bash(some command here)                     │
//   │ Approve?                                    │
//   │ ❯ 1. Yes                                    │
//   │   2. Yes, and don't ask again ... (session) │
//   │   3. Yes, and don't ask again ... (project) │
//   │   4. No                                     │
//   ╰─────────────────────────────────────────────╯
//
// The prior 14-row layout (separate "Tool use" header, argument-expansion
// line, "Do you want to proceed?", "Esc to cancel" footer, and three
// blank rows) reliably ended up partially committed to terminal scrollback
// — Ink's incremental render path can only erase the visible portion of
// the previous dynamic frame, so any rows that OS-scroll-on-output pushed
// out of viewport stuck around forever once a sibling Static commit
// landed. Halving the dialog raises that scroll threshold significantly.
import { useState } from "react"
import { Box, Text, useInput } from "ink"
import { commandInput, isReturnInput } from "./controlled-input.js"
import { useHideNativeCursor } from "./dialog-frame.js"
import { c } from "./theme.js"
import { ToolGrantDialog } from "./dialog-tool-grant.js"
import type { ToolGrantRequest } from "../tool-grants.js"
import { formatToolCall, getToolAlias } from "./transcript-format.js"

export type ApprovalChoice = "once" | "always" | "forever" | "deny"
const APPROVAL_CHOICES: ApprovalChoice[] = ["once", "always", "forever", "deny"]

interface Props {
  toolName: string
  args: Record<string, unknown>
  onChoose: (choice: ApprovalChoice) => void
  /** Concrete rule pattern that "always"/"forever" will save (e.g.
   *  "Edit(src/**)" or "Bash(git log:*)"). Shown to the user so they
   *  know the actual scope they're granting — without it, "for edit_file
   *  commands in this project" reads as a broad project-wide grant when
   *  in reality the saved rule is dir-scoped. Optional: when omitted or
   *  null (no pattern can be inferred), falls back to the legacy generic
   *  wording. */
  rulePreview?: string | null
  unsandboxed?: boolean
  allowScope?: boolean
  availableTools?: string[]
  onGrant?: (request: ToolGrantRequest, availableTools: string[]) => string | void
}

interface Option {
  value: ApprovalChoice
  label: string
}

export function ApprovalBar({ toolName, args, onChoose, rulePreview, unsandboxed: escape, allowScope = true, availableTools = [], onGrant }: Props) {
  useHideNativeCursor()
  // Three accept tiers ("once" / session-scoped "always" / persistent
  // "forever") + deny. Both persistent consent and ordinary tool grants
  // use host-owned project storage.
  // When rulePreview is provided, surface the actual saved pattern in
  // both "always" and "forever" labels so the user sees the literal
  // glob/prefix rather than a vague "in this session/project".
  const scopeText = rulePreview
    ? rulePreview === toolName ? `${getToolAlias(toolName)} (entire tool)` : `${rulePreview}`
    : `${getToolAlias(toolName)} commands`
  const unsandboxed = escape ?? isUnsandboxedBash(toolName, args)
  const canCustomize = allowScope && !unsandboxed && toolName !== "delegate_agent" && availableTools.includes(toolName) && !!onGrant
  const options: Option[] = !allowScope
    ? [
        { value: "once", label: unsandboxed ? "Yes, run outside the sandbox this once" : "Yes, this once" },
        { value: "deny", label: "No" },
      ]
    : unsandboxed ? [
        { value: "once", label: "Yes, run outside the sandbox this once" },
        { value: "always", label: "Yes, allow outside-sandbox commands for this session" },
        { value: "forever", label: "Yes, allow outside-sandbox commands for this project" },
        { value: "deny", label: "No" },
      ] : [
        { value: "once",    label: "Yes" },
        { value: "always",  label: `Yes, and don't ask again for ${scopeText} (this session)` },
        { value: "forever", label: `Yes, and don't ask again for ${scopeText} (this project)` },
        { value: "deny",    label: "No" },
      ]
  const [idx, setIdx] = useState(0)
  const [customizing, setCustomizing] = useState(false)

  useInput((input, key) => {
    if (input === "g" && canCustomize) { setCustomizing(true); return }
    const directChoice = approvalChoiceForInput(input, key, idx, allowScope)
    if (directChoice) { onChoose(directChoice); return }
    if (key.upArrow)   { setIdx(i => (i - 1 + options.length) % options.length); return }
    if (key.downArrow) { setIdx(i => (i + 1) % options.length); return }
  }, { isActive: !(customizing && canCustomize) })

  if (customizing && canCustomize && onGrant) return <ToolGrantDialog availableTools={availableTools} initialTools={[toolName]}
    initialPattern={rulePreview?.match(/^[^(]+\(([^()]*)\)$/)?.[1] ?? ""}
    onSave={request => onGrant(request, availableTools)} onCancel={() => setCustomizing(false)} />

  // Height is load-bearing: a tall dynamic frame above a long transcript
  // gets partially scrolled into scrollback by every re-render that
  // happens while the dialog is up (streaming chunks commit Static items
  // each time, and Ink's eraseLines can only reach back to viewport top).
  // Every saved row here lowers the bar for the dialog content to leak
  // into permanent scrollback on dismissal. Borderless layout matches the
  // rest of the dialog suite; warning-colored "Approve?" line + the
  // numbered options carry the visual emphasis that the box border used to.

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={c.text.primary}>{formatToolCall(toolName, args)}</Text>
      {unsandboxed && <Text color={c.error}>Runs outside the OS sandbox: full access to your files and network.</Text>}
      <Text color={c.warning} bold>Approve?</Text>
      <Box flexDirection="column">
        {options.map((opt, i) => {
          const active = i === idx
          return (
            <Box key={opt.value}>
              <Text color={active ? c.accent : c.text.muted}>{`${i + 1}. `}</Text>
              <Text color={active ? c.text.primary : c.text.muted} bold={active}>
                {opt.label}
              </Text>
            </Box>
          )
        })}
      </Box>
      {canCustomize && <Text color={c.text.muted}>g customize scope / select tools</Text>}
    </Box>
  )
}

export function isUnsandboxedBash(toolName: string, args: Record<string, unknown>): boolean {
  return toolName === "bash" && args.dangerouslyDisableSandbox === true
}

export function approvalChoiceForInput(
  input: string,
  key: { escape?: boolean; return?: boolean },
  selectedIndex: number,
  allowScope = true,
): ApprovalChoice | null {
  if (key.escape) return "deny"
  const choices: ApprovalChoice[] = allowScope ? APPROVAL_CHOICES : ["once", "deny"]
  const prefix = commandInput(input, key)
  if (prefix !== null && /^[1-9]$/.test(prefix)) return choices[Number(prefix) - 1] ?? null
  if (isReturnInput(input, key)) return choices[selectedIndex] ?? null
  return null
}

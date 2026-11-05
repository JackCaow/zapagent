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
import { suggestToolGrantDirectory, type ToolGrantRequest } from "../tool-grants.js"
import { inferPattern, type PermissionRule } from "../permissions.js"
import { REQUEST_CAPABILITIES_TOOL, describeCapabilityPatterns } from "../capabilities.js"
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
  /** One-time approvals of the same consent earlier this session. */
  repeats?: number
  availableTools?: string[]
  cwd?: string
  workspaceRoot?: string
  onGrant?: (request: ToolGrantRequest, availableTools: string[], reviewedRules?: readonly PermissionRule[]) => string | void
}

interface Option {
  value: ApprovalChoice
  label: string
}

export function ApprovalBar({ toolName, args, onChoose, rulePreview, unsandboxed: escape, allowScope = true, repeats = 0, availableTools = [], cwd, workspaceRoot, onGrant }: Props) {
  useHideNativeCursor()
  // Three accept tiers ("once" / session-scoped "always" / persistent
  // "forever") + deny. Both persistent consent and ordinary tool grants
  // use host-owned project storage.
  // When rulePreview is provided, surface the actual saved pattern in
  // both "always" and "forever" labels so the user sees the literal
  // glob/prefix rather than a vague "in this session/project".
  const capabilityText = rulePreview ? describeCapabilityPatterns(rulePreview.split(", ")) : null
  const scopeText = capabilityText ?? (rulePreview
    ? rulePreview === toolName ? `${getToolAlias(toolName)} (entire tool)` : `${rulePreview}`
    : `${getToolAlias(toolName)} commands`)
  const unsandboxed = escape ?? isUnsandboxedBash(toolName, args)
  const request = toolName === REQUEST_CAPABILITIES_TOOL
  const canCustomize = allowScope && !unsandboxed && !request && toolName !== "delegate_agent" && availableTools.includes(toolName) && !!onGrant
  const directory = canCustomize ? suggestToolGrantDirectory(toolName, args, cwd) : undefined
  // A capability request is only worth something when it is remembered.
  const options: Option[] = request && allowScope ? [
        { value: "always",  label: `Yes, allow ${scopeText} for this session` },
        { value: "forever", label: `Yes, allow ${scopeText} for this project` },
        { value: "deny",    label: "No" },
      ]
    : !allowScope
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
  const [directoryShortcut, setDirectoryShortcut] = useState(false)

  useInput((input, key) => {
    if (input === "g" && canCustomize) { setDirectoryShortcut(false); setCustomizing(true); return }
    if (input === "d" && directory) { setDirectoryShortcut(true); setCustomizing(true); return }
    const directChoice = approvalChoiceForInput(input, key, idx, allowScope, options.map(option => option.value))
    if (directChoice) { onChoose(directChoice); return }
    if (key.upArrow)   { setIdx(i => (i - 1 + options.length) % options.length); return }
    if (key.downArrow) { setIdx(i => (i + 1) % options.length); return }
  }, { isActive: !(customizing && canCustomize) })

  if (customizing && canCustomize && onGrant) return <ToolGrantDialog availableTools={availableTools} initialTools={[toolName]}
    initialPattern={(capabilityText ? inferPattern(toolName, args, workspaceRoot ?? cwd ?? process.cwd()) : rulePreview)?.match(/^[^(]+\(([^()]*)\)$/)?.[1] ?? ""}
    initialDirectory={directory} directoryShortcut={directoryShortcut} cwd={workspaceRoot}
    onSave={(request, reviewedRules) => onGrant(request, availableTools, reviewedRules)} onCancel={() => setCustomizing(false)} />

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
      {toolName === "bash" && ([ ["read_paths", "Additional read access"], ["write_paths", "Additional write access"] ] as const).map(([field, label]) =>
        Array.isArray(args[field]) && args[field].length > 0
          ? <Text key={field} color={c.warning}>{label}: {JSON.stringify(args[field])}</Text> : null)}
      {request && typeof args.reason === "string" && <Text color={c.text.secondary} wrap="truncate-end">{`Reason: ${args.reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")}`}</Text>}
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
      {allowScope && !unsandboxed && !request && repeats >= 2 && <Text color={c.text.muted}>{`Approved ${repeats} times this session; 2 stops asking for the rest of it`}</Text>}
      {canCustomize && <Text color={c.text.muted}>g customize scope / select tools</Text>}
      {directory && <Text color={c.text.muted}>d authorize folder / select tools: {directory}</Text>}
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
  choices: readonly ApprovalChoice[] = allowScope ? APPROVAL_CHOICES : ["once", "deny"],
): ApprovalChoice | null {
  if (key.escape) return "deny"
  const prefix = commandInput(input, key)
  if (prefix !== null && /^[1-9]$/.test(prefix)) return choices[Number(prefix) - 1] ?? null
  if (isReturnInput(input, key)) return choices[selectedIndex] ?? null
  return null
}

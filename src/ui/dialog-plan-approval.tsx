/** @jsxImportSource react */
// Plan-mode approval bar — appears when the agent calls `exit_plan_mode`
// with a proposed plan body. User can:
//   ⏎/y   accept  → mode flips back to default; agent continues with edits
//   r     revise  → mode stays plan; reason captured + sent back to agent
//   esc/n reject  → mode stays plan; agent retries without explicit reason
import { useState } from "react"
import { Box, Text, useInput } from "ink"
import { DialogFrame } from "./dialog-frame.js"
import { Markdown } from "./markdown.js"
import { c } from "./theme.js"
import { commandInput, isReturnInput, textBeforeReturn } from "./controlled-input.js"

export type PlanChoice =
  | { kind: "approve" }
  | { kind: "reject"; reason?: string }
type PlanIdleAction = PlanChoice | { kind: "start_reason" }

interface Props {
  plan: string
  onChoose: (choice: PlanChoice) => void
}

export function PlanApprovalBar({ plan, onChoose }: Props) {
  // Two micro-states: idle (preview + accept/reject keys) and "typing
  // a reason" (capture printable chars until Enter).
  const [reason, setReason] = useState<string | null>(null)

  useInput((input, key) => {
    if (reason !== null) {
      if (key.escape) { setReason(null); return }
      if (isReturnInput(input, key)) {
        const prefix = textBeforeReturn(input).replace(/[\r\n]/g, "")
        const finalReason = `${reason}${prefix}`.trim()
        onChoose({ kind: "reject", reason: finalReason || undefined })
        return
      }
      if (key.backspace || key.delete) { setReason(reason.slice(0, -1)); return }
      if (key.ctrl || key.meta) return
      const printable = input.replace(/[\r\n]/g, "")
      if (printable) setReason(reason + printable)
      return
    }
    const idleAction = planIdleActionForInput(input, key)
    if (!idleAction) return
    if (idleAction.kind === "start_reason") { setReason(""); return }
    onChoose(idleAction)
  })

  if (reason !== null) {
    return (
      <DialogFrame
        title="Reject plan — reason"
        hint="⏎ send  esc back"
        accentColor={c.warning}
      >
        <Box>
          <Text color={c.accent}>{"❯ "}</Text>
          <Text color={c.text.primary}>{reason || ""}</Text>
          <Text color={c.text.faint}>{reason ? "" : "(optional)"}</Text>
        </Box>
      </DialogFrame>
    )
  }

  return (
    <DialogFrame
      title="Plan ready — approve to start implementation"
      hint="⏎/y approve   r reject with reason   esc/n reject"
      accentColor={c.warning}
    >
      <Box flexDirection="column">
        <Markdown source={plan} />
      </Box>
    </DialogFrame>
  )
}

export function planIdleActionForInput(
  input: string,
  key: { escape?: boolean; return?: boolean },
): PlanIdleAction | null {
  if (key.escape) return { kind: "reject" }
  const prefix = commandInput(input, key)
  if (prefix === "y" || prefix === "1") return { kind: "approve" }
  if (prefix === "n" || prefix === "2") return { kind: "reject" }
  if (prefix === "r") return { kind: "start_reason" }
  if (isReturnInput(input, key)) return { kind: "approve" }
  return null
}

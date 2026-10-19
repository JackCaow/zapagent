// Headless `onApproval`. Returns true or a reasoned denial — never prompts a
// human, since by definition there isn't one.
//
// Policy evaluation is shared with the TUI; absent a host approval transport,
// asks are denied. Dangerous execution remains denied in headless hosts.

import type { PermissionMode } from "../config.js"
import { evaluateApprovalPolicy } from "../permission-policy.js"
import { PermissionManager } from "../permissions.js"
import type { ApprovalCallback, ApprovalDenial } from "../../zapsdk/tools/executor.js"

export interface HeadlessApprovalOptions {
  cwd: string
  permissionMode: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Called every time a tool gets denied (so the runner can flip its
   *  stopReason to "permission_denied" and surface a stderr line). */
  onDeny?: (toolName: string, reason: string) => void
  /** Called on every decision (allow + deny) for stream-json telemetry. */
  onDecision?: (toolName: string, decision: "allow" | "deny", reason: string) => void
  /** Interactive hosts may resolve an ask through their own transport.
   * Explicit denies and safety gates above remain authoritative. */
  onAsk?: ApprovalCallback
}

export interface HeadlessApprovalResult {
  /** Tell the permission rules whether commands run inside the OS sandbox or VM. */
  setSandboxConfined: (confined: boolean, autoAllowAll?: boolean) => void
  setSandboxExcludedCommands: (patterns: string[] | undefined) => void
  onApproval: ApprovalCallback
  /** True iff at least one tool was denied during the run. */
  anyDenied: () => boolean
}

export function buildHeadlessApproval(opts: HeadlessApprovalOptions): HeadlessApprovalResult {
  const mgr = new PermissionManager(opts.cwd)
  const allowed = new Set(opts.allowedTools ?? [])
  const disallowed = new Set(opts.disallowedTools ?? [])
  let denied = false

  const deny = (tool: string, reason: string, source: ApprovalDenial["source"] = "policy"): ApprovalDenial => {
    denied = true
    opts.onDeny?.(tool, reason)
    opts.onDecision?.(tool, "deny", reason)
    return { approved: false, source, reason }
  }
  const allow = (tool: string, reason: string): boolean => {
    opts.onDecision?.(tool, "allow", reason)
    return true
  }

  return {
    setSandboxConfined: (confined, autoAllowAll) => mgr.setSandboxConfined(confined, autoAllowAll),
    setSandboxExcludedCommands: patterns => mgr.setSandboxExcludedCommands(patterns),
    onApproval: async (toolName, args, signal, context) => {
      if (signal?.aborted) return deny(toolName, "approval cancelled")
      const evaluate = () => evaluateApprovalPolicy(mgr, toolName, args, {
        mode: opts.permissionMode, cwd: opts.cwd, context,
        allowedTools: [...allowed], disallowedTools: [...disallowed],
      })
      const decision = evaluate()
      if (decision.decision === "deny" || decision.source === "dangerous") return deny(toolName, decision.reason)
      if (decision.decision === "allow") return allow(toolName, decision.reason)
      if (!opts.onAsk) return deny(toolName, `${decision.reason}; non-interactive approval required`)
      const granted = await opts.onAsk(toolName, args, signal, context)
      if (signal?.aborted) return deny(toolName, "approval cancelled")
      const current = evaluate()
      if (current.decision === "deny" || current.source === "dangerous") return deny(toolName, current.reason)
      if (granted === true) return allow(toolName, "host approval")
      return granted && typeof granted === "object"
        ? deny(toolName, granted.reason, granted.source)
        : deny(toolName, "host declined approval", "approval")

    },
    anyDenied: () => denied,
  }
}

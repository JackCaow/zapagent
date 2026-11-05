// Headless `onApproval`. Returns true or a reasoned denial — never prompts a
// human, since by definition there isn't one.
//
// Policy evaluation is shared with the TUI; absent a host approval transport,
// asks are denied. Dangerous execution remains denied in headless hosts.

import type { PermissionMode } from "../config.js"
import { evaluateApprovalPolicy, type ApprovalPolicyDecision } from "../permission-policy.js"
import { PermissionManager } from "../permissions.js"
import { REQUEST_CAPABILITIES_TOOL } from "../capabilities.js"
import type { ApprovalCallback, ApprovalDenial, ApprovalResponse } from "../../zapsdk/tools/executor.js"
import type { NetworkPolicy } from "../../zapsdk/execution/network-proxy.js"

export interface HeadlessApprovalOptions {
  cwd: string
  permissionMode: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Called every time a tool gets denied (so the runner can flip its
   *  stopReason to "permission_denied" and surface a stderr line). */
  onDeny?: (toolName: string, reason: string) => void
  /** Called on every decision (allow + deny) for stream-json telemetry. */
  onDecision?: (toolName: string, decision: "allow" | "deny", reason: string, evaluated?: Pick<ApprovalPolicyDecision, "category" | "tier">) => void
  /** Interactive hosts may resolve an ask through their own transport.
   * Explicit denies and safety gates above remain authoritative. */
  onAsk?: ApprovalCallback
}

export interface HeadlessApprovalResult {
  /** Tell the permission rules whether commands run inside the OS sandbox or VM. */
  setSandboxConfined: (confined: boolean, autoAllowAll?: boolean) => void
  setSandboxExcludedCommands: (patterns: string[] | undefined) => void
  setSandboxNetworkPolicy: (policy: NetworkPolicy | undefined) => void
  onApproval: ApprovalCallback
  /** Whether rules now cover a `request_capabilities` call. */
  capabilitiesGranted: (args: Record<string, unknown>) => boolean
  /** True iff at least one tool was denied during the run. */
  anyDenied: () => boolean
}

export function buildHeadlessApproval(opts: HeadlessApprovalOptions): HeadlessApprovalResult {
  const mgr = new PermissionManager(opts.cwd)
  const allowed = new Set(opts.allowedTools ?? [])
  const disallowed = new Set(opts.disallowedTools ?? [])
  let denied = false

  const deny = (tool: string, reason: string, source: ApprovalDenial["source"] = "policy", evaluated?: Pick<ApprovalPolicyDecision, "category" | "tier">): ApprovalDenial => {
    denied = true
    opts.onDeny?.(tool, reason)
    opts.onDecision?.(tool, "deny", reason, evaluated)
    return { approved: false, source, reason }
  }
  const allow = (tool: string, reason: string, evaluated?: Pick<ApprovalPolicyDecision, "category" | "tier">): boolean => {
    opts.onDecision?.(tool, "allow", reason, evaluated)
    return true
  }

  const evaluate = (toolName: string, args: Record<string, unknown>, context?: Parameters<ApprovalCallback>[3]) => evaluateApprovalPolicy(mgr, toolName, args, {
    mode: opts.permissionMode, cwd: opts.cwd, context,
    allowedTools: [...allowed], disallowedTools: [...disallowed],
  })
  /** The answer when no host needs asking, else undefined. */
  const settle = (toolName: string, decision: ApprovalPolicyDecision): ApprovalResponse | undefined => {
    if (decision.decision === "deny" || decision.source === "dangerous") return deny(toolName, decision.reason, "policy", decision)
    if (decision.decision === "allow") return allow(toolName, decision.reason, decision)
    if (!opts.onAsk) return deny(toolName, `${decision.reason}; non-interactive approval required`, "policy", decision)
    return undefined
  }
  // Settled decisions skip the executor's approval queue; only host asks wait in it.
  const onApproval: ApprovalCallback = Object.assign(async (toolName: string, args: Record<string, unknown>, signal?: AbortSignal, context?: Parameters<ApprovalCallback>[3]) => {
    if (signal?.aborted) return deny(toolName, "approval cancelled")
    const decision = evaluate(toolName, args, context)
    const settled = settle(toolName, decision)
    if (settled !== undefined) return settled
    const granted = await opts.onAsk!(toolName, args, signal, context)
    if (signal?.aborted) return deny(toolName, "approval cancelled", "policy", decision)
    const current = evaluate(toolName, args, context)
    if (current.decision === "deny" || current.source === "dangerous") return deny(toolName, current.reason, "policy", current)
    if (granted === true && toolName === REQUEST_CAPABILITIES_TOOL) {
      // The host's yes is the user's grant for the rest of this run.
      try { mgr.addSessionRule(toolName, args, context) } catch {}
    }
    if (granted === true) return allow(toolName, "host approval", decision)
    return granted && typeof granted === "object"
      ? deny(toolName, granted.reason, granted.source, decision)
      : deny(toolName, "host declined approval", "approval", decision)
  }, {
    precheck: (toolName: string, args: Record<string, unknown>, context?: Parameters<ApprovalCallback>[3]) =>
      settle(toolName, evaluate(toolName, args, context)),
  })

  return {
    setSandboxConfined: (confined, autoAllowAll) => mgr.setSandboxConfined(confined, autoAllowAll),
    setSandboxExcludedCommands: patterns => mgr.setSandboxExcludedCommands(patterns),
    setSandboxNetworkPolicy: policy => mgr.setSandboxNetworkPolicy(policy),
    onApproval,
    capabilitiesGranted: args => mgr.checkPermission(REQUEST_CAPABILITIES_TOOL, args).decision === "allow",
    anyDenied: () => denied,
  }
}

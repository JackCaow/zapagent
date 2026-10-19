import type { PermissionMode } from "./config.js"
import { PermissionManager, isPathReadTool, pathReadOutsideCwdReason } from "./permissions.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import { approvalFacts } from "./approval-facts.js"
import { matchDangerousToolCall } from "../zapsdk/utils/safety.js"

export interface ApprovalPolicyOptions {
  mode: PermissionMode
  cwd: string
  context?: Readonly<ApprovalContext>
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
}
export interface ApprovalPolicyDecision {
  decision: "allow" | "deny" | "ask"
  reason: string
  source: "rule" | "dangerous" | "policy" | "sandbox" | "fallback"
  allowScope: boolean
}

/** One factual policy order shared by interactive and headless hosts. */
export function evaluateApprovalPolicy(manager: PermissionManager, name: string, args: Record<string, unknown>, options: ApprovalPolicyOptions): ApprovalPolicyDecision {
  const result = (decision: ApprovalPolicyDecision["decision"], reason: string, source: ApprovalPolicyDecision["source"] = "policy", allowScope = false): ApprovalPolicyDecision => ({ decision, reason, source, allowScope })
  const facts = approvalFacts(name, args, options.context)
  if (options.mode === "plan" && !facts.readOnly) return result("deny", "plan-mode is read-only")
  if (options.disallowedTools?.includes(name)) return result("deny", "disallowed by --disallowed-tools")
  const rule = manager.checkPermission(name, args, options.context)
  const escape = facts.sandboxEscape
  const sandbox = escape ? manager.checkSandboxEscape() : undefined
  const denial = rule.decision === "deny" ? rule : sandbox?.decision === "deny" ? sandbox : undefined
  if (denial) return result("deny", `matched deny rule ${denial.rule?.pattern}`, "rule")
  if (facts.shellCommands) {
    const danger = facts.shellCommands.map(command => matchDangerousToolCall({ ...args, command, check_steps: undefined }, options.context?.workspaceRoot ?? options.cwd, options.context?.cwd ?? options.cwd, options.context?.shell)).find(Boolean)
    if (danger) return result("ask", `dangerous bash (${danger.id})`, "dangerous")
  }
  const ask = rule.decision === "ask" && rule.rule ? rule : sandbox?.decision === "ask" && sandbox.rule ? sandbox : undefined
  if (ask) return result("ask", ask.reason ?? `ask rule ${ask.rule?.pattern}`, "rule")
  if (facts.shellCommands === null) return result("ask", "shell adapter did not provide executable payloads; one-time review required")
  if (escape) {
    if (sandbox?.decision === "allow") return result("allow", `${sandbox.scope} sandbox authorization`, "sandbox")
    if (options.mode === "bypassPermissions") return result("allow", "unsandboxed under bypassPermissions", "sandbox")
    return result("ask", "unsandboxed bash needs interactive approval or a project sandbox authorization", "sandbox", true)
  }
  if (name === "bash" && options.mode !== "bypassPermissions") {
    const paths = manager.checkShellPaths(args, options.context)
    if (paths.decision === "ask") return result("ask", paths.reason ?? "Shell filesystem paths require authorization", "fallback", true)
  }
  if (rule.decision === "allow") return result("allow", rule.reason ?? `rule ${rule.rule?.pattern}`, "rule")
  if (options.allowedTools?.includes(name)) return result("allow", "allowed by --allowed-tools")
  if (name === "read_tool_output") return result("allow", "session-scoped runtime output read")
  if (isPathReadTool(name)) {
    const outside = pathReadOutsideCwdReason(name, args, options.context?.workspaceRoot ?? options.cwd)
    return outside ? result("ask", outside, "fallback", true) : result("allow", "project path read")
  }
  if (options.mode === "bypassPermissions") return result("allow", "bypassPermissions mode")
  if (options.mode === "acceptEdits" && facts.editOnly) return result("allow", "acceptEdits mode")
  return result("ask", "no rule, prompting user", "fallback", true)
}

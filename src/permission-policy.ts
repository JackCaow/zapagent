import type { PermissionMode } from "./config.js"
import { PermissionManager, isPathReadTool } from "./permissions.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import { approvalFacts } from "./approval-facts.js"
import { matchDangerousToolCall } from "../zapsdk/utils/safety.js"
import { REQUEST_CAPABILITIES_TOOL, parseCapabilityRequest } from "./capabilities.js"

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
  /** What kind of capability the call needs; used to measure interruptions. */
  category: ApprovalCategory
  /** R0 read-only, R1 workspace-contained, R2 beyond the workspace, R3 dangerous. */
  tier: RiskTier
}

export type RiskTier = "R0" | "R1" | "R2" | "R3"

export type ApprovalCategory = "read" | "edit" | "shell" | "sandbox-escape" | "dangerous" | "mcp" | "tool"

/** One factual policy order shared by interactive and headless hosts. */
export function evaluateApprovalPolicy(manager: PermissionManager, name: string, args: Record<string, unknown>, options: ApprovalPolicyOptions): ApprovalPolicyDecision {
  const facts = approvalFacts(name, args, options.context)
  const kind: ApprovalCategory = facts.sandboxEscape ? "sandbox-escape" : facts.shellCommands !== undefined ? "shell"
    : name.startsWith("mcp__") ? "mcp" : facts.editOnly ? "edit" : facts.readOnly ? "read" : "tool"
  const projectMemory = name === "memory_save" && (args.type === "project" || args.type === "reference")
  const tier = (): RiskTier => facts.readOnly ? "R0" : projectMemory ? "R1"
    : facts.shellCommands !== undefined ? (!facts.sandboxEscape && manager.isSandboxConfined() ? "R1" : "R2")
    : manager.changesOnlyWorkspaceFiles(name, args, options.context) ? "R1" : "R2"
  const result = (decision: ApprovalPolicyDecision["decision"], reason: string, source: ApprovalPolicyDecision["source"] = "policy", allowScope = false): ApprovalPolicyDecision =>
    ({ decision, reason, source, allowScope, category: source === "dangerous" ? "dangerous" : kind, tier: source === "dangerous" ? "R3" : tier() })
  if (options.mode === "plan" && !facts.readOnly) return result("deny", "plan-mode is read-only")
  if (options.disallowedTools?.includes(name)) return result("deny", "disallowed by --disallowed-tools")
  if (name === REQUEST_CAPABILITIES_TOOL) {
    if (options.mode === "plan") return result("deny", "plan-mode is read-only")
    const requested = parseCapabilityRequest(args)
    if (typeof requested === "string") return result("deny", requested)
  }
  const rule = manager.checkPermission(name, args, options.context)
  const escape = facts.sandboxEscape
  const sandbox = escape ? manager.checkSandboxEscape() : undefined
  const denial = rule.decision === "deny" ? rule : sandbox?.decision === "deny" ? sandbox : undefined
  if (denial) return result("deny", denial.rule ? `matched deny rule ${denial.rule.pattern}` : denial.reason ?? "denied", "rule")
  if (manager.declinedThisTurn(name, args, options.context))
    return result("deny", "the user declined this request earlier in this turn; ask the user before trying it again or choose another approach", "policy")
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
    const network = manager.checkShellNetwork(args, options.context)
    if (network.decision === "ask") return result("ask", network.reason ?? "Shell network destinations require authorization", "fallback", true)
  }
  if (rule.decision === "allow") return result("allow", rule.reason ?? `rule ${rule.rule?.pattern}`, "rule")
  if (options.allowedTools?.includes(name)) return result("allow", "allowed by --allowed-tools")
  if (name === "read_tool_output") return result("allow", "session-scoped runtime output read")
  // The handler only stops tasks owned by the calling session.
  if (name === "task_stop") return result("allow", "stops a task owned by this session")
  // Project notes are agent-owned, reviewable in /mem and stay in this project.
  // Global user/feedback memory reaches every project, so it still asks.
  if (projectMemory) return result("allow", "project memory write")
  // Reading screenshots, skill resources and reference files must not require
  // a new grant for every path. Explicit restrictions were checked above;
  // filesystem confinement remains the executor/backend's responsibility.
  if (isPathReadTool(name) && facts.readOnly) return result("allow", "read-only filesystem access")
  if (options.mode === "bypassPermissions") return result("allow", "bypassPermissions mode")
  if (options.mode === "acceptEdits" && facts.editOnly) return result("allow", "acceptEdits mode")
  return result("ask", "no rule, prompting user", "fallback", true)
}

import type { PermissionMode } from "./config.js"
import { inferInvocationRules, PermissionManager, isPathReadTool } from "./permissions.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import { approvalFacts, isAcpAgentRequest } from "./approval-facts.js"
import { matchDangerousToolCall } from "../zapsdk/utils/safety.js"
import { REQUEST_CAPABILITIES_TOOL, parseCapabilityRequest } from "./capabilities.js"

export interface ApprovalPolicyOptions {
  mode: PermissionMode
  cwd: string
  context?: Readonly<ApprovalContext>
  hostCommands?: "trusted" | "untrusted" | "disabled"
  /** The execution host enforces its offline Shell profile. */
  disableShellNetwork?: boolean
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
  const decided = decide(manager, name, args, options)
  // No session/project grant for an ACP agent's free-form request: a saved
  // rule could only be the bare tool name, which would allow every future one.
  const decision = isAcpAgentRequest(name) ? { ...decided, allowScope: false } : decided
  // Only a prompt the user already answered this turn becomes a refusal; a
  // mode change or new rule that allows the call still lets it run.
  return decision.decision === "ask" && manager.declinedThisTurn(name, args, options.context)
    ? { ...decision, decision: "deny", source: "policy", allowScope: false,
        reason: "the user declined this request earlier in this turn; ask the user before trying it again or choose another approach" }
    : decision
}

function decide(manager: PermissionManager, name: string, args: Record<string, unknown>, options: ApprovalPolicyOptions): ApprovalPolicyDecision {
  const facts = approvalFacts(name, args, options.context)
  const escape = options.hostCommands === undefined && facts.sandboxEscape
  const confinedShell = manager.isConfinedWorkspaceShell(facts)
  const kind: ApprovalCategory = escape ? "sandbox-escape" : facts.shellCommands !== undefined ? "shell"
    : name.startsWith("mcp__") ? "mcp" : facts.editOnly ? "edit" : facts.readOnly ? "read" : "tool"
  // Only a new, unpinned note that replaces nothing: overwriting, pinning or
  // superseding memory steers future sessions, so it still asks.
  const projectMemory = name === "memory_save" && (args.type === "project" || args.type === "reference")
    && !(Array.isArray(args.tags) && args.tags.includes("pinned")) && !(Array.isArray(args.supersedes) && args.supersedes.length > 0)
    && typeof args.name === "string" && manager.isNewProjectMemory(args.name)
  const tier = (): RiskTier => facts.readOnly ? "R0" : projectMemory ? "R1"
    : facts.shellCommands !== undefined ? (confinedShell && !manager.reachesBeyondAllowlist(args) ? "R1" : "R2")
    : manager.changesOnlyWorkspaceFiles(name, args, options.context) ? "R1" : "R2"
  const result = (decision: ApprovalPolicyDecision["decision"], reason: string, source: ApprovalPolicyDecision["source"] = "policy", allowScope = false): ApprovalPolicyDecision =>
    ({ decision, reason, source, allowScope, category: source === "dangerous" ? "dangerous" : kind, tier: source === "dangerous" ? "R3" : tier() })
  if (options.mode === "plan" && (!facts.readOnly || name === REQUEST_CAPABILITIES_TOOL)) {
    return result("deny", options.hostCommands === undefined ? "plan-mode is read-only" : "This session is read-only")
  }
  if (options.disallowedTools?.includes(name)) return result("deny", "disallowed by --disallowed-tools")
  if (name === REQUEST_CAPABILITIES_TOOL) {
    const requested = parseCapabilityRequest(args)
    if (typeof requested === "string") return result("deny", requested)
  }
  const requireShellConsent = facts.shellCommands !== undefined
    && (options.hostCommands !== undefined || (options.mode === "acceptEdits" && !(confinedShell && options.disableShellNetwork)))
  const shellConsent = options.hostCommands === "untrusted" ? "session" : "project"
  const rule = manager.checkPermission(name, args, options.context, requireShellConsent ? shellConsent : undefined)
  const sandbox = escape ? manager.checkSandboxEscape() : undefined
  const denial = rule.decision === "deny" ? rule : sandbox?.decision === "deny" ? sandbox : undefined
  if (denial) return result("deny", denial.rule ? `matched deny rule ${denial.rule.pattern}` : denial.reason ?? "denied", "rule")
  if (options.hostCommands === "disabled" && (facts.shellCommands !== undefined || name === "delegate_agent" || name === "acp_agent")) {
    return result("deny", "Local commands are disabled by your configuration")
  }
  if (facts.shellCommands) {
    const danger = facts.shellCommands.map(command => matchDangerousToolCall({ ...args, command, check_steps: undefined }, options.context?.workspaceRoot ?? options.cwd, options.context?.cwd ?? options.cwd, options.context?.shell)).find(Boolean)
    if (danger) return result("ask", `dangerous bash (${danger.id})`, "dangerous")
  }
  const ask = rule.decision === "ask" && rule.rule ? rule : sandbox?.decision === "ask" && sandbox.rule ? sandbox : undefined
  if (ask) return result("ask", ask.reason ?? `ask rule ${ask.rule?.pattern}`, "rule")
  if (options.hostCommands !== undefined && options.mode === "default" && !facts.readOnly) {
    return result("ask", "Manual mode requires approval for this action")
  }
  if (facts.shellCommands === null) return result("ask", "shell adapter did not provide executable payloads; one-time review required")
  if (escape) {
    if (sandbox?.decision !== "allow" && options.mode !== "bypassPermissions") {
      return result("ask", "unsandboxed bash needs interactive approval or a project sandbox authorization", "sandbox", true)
    }
    if (!requireShellConsent) {
      return result("allow", sandbox?.decision === "allow" ? `${sandbox.scope} sandbox authorization` : "unsandboxed under bypassPermissions", "sandbox")
    }
  }
  if (name === "bash" && (requireShellConsent || options.mode !== "bypassPermissions")) {
    const paths = manager.checkShellPaths(args, options.context)
    if (paths.decision === "ask") return result("ask", paths.reason ?? "Shell filesystem paths require authorization", "fallback", !requireShellConsent)
    const network = manager.checkShellNetwork(args, options.context)
    if (network.decision === "ask") return result("ask", network.reason ?? "Shell network destinations require authorization", "fallback", !requireShellConsent)
  }
  if (requireShellConsent) {
    if (rule.decision === "allow" && rule.rule) return result("allow", "saved Shell command approval", "rule")
    if (options.allowedTools?.includes(name)) return result("allow", "allowed by --allowed-tools")
    return result("ask", "Shell command needs approval", "fallback", inferInvocationRules(name, args, options.cwd, options.context, true).length > 0)
  }
  if (rule.decision === "allow") return result("allow", rule.reason ?? `rule ${rule.rule?.pattern}`, "rule")
  if (options.allowedTools?.includes(name)) return result("allow", "allowed by --allowed-tools")
  if (name === "read_tool_output") return result("allow", "session-scoped runtime output read")
  // The handler only stops tasks owned by the calling session.
  if (name === "task_stop") return result("allow", "stops a task owned by this session")
  // New project notes are agent-owned, reviewable in /mem and stay in this
  // project. Global user/feedback memory reaches every project, so it asks.
  if (projectMemory) return result("allow", "new project memory note")
  // Reading screenshots, skill resources and reference files must not require
  // a new grant for every path. Explicit restrictions were checked above;
  // filesystem confinement remains the executor/backend's responsibility.
  if (isPathReadTool(name) && facts.readOnly) return result("allow", "read-only filesystem access")
  if (options.mode === "bypassPermissions") return result("allow", "bypassPermissions mode")
  if (options.mode === "acceptEdits" && facts.editOnly && manager.changesOnlyWorkspaceFiles(name, args, options.context)) return result("allow", "approved workspace edit")
  return result("ask", "no rule, prompting user", "fallback", true)
}

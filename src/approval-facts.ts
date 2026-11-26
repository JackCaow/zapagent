import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import type { ToolApprovalFacts } from "../zapsdk/tools/approval.js"
import { shellExecutionCommands, requiresShellReview } from "../zapsdk/utils/shell.js"

// Compatibility for pre-effects adapters and direct onApproval embedders.
// New tools declare effects/resolveShellCommands; do not extend these lists.
const legacyWrites = new Set(["write_file", "create_file", "edit_file", "multi_edit", "delete_file", "move_file", "bash", "execute_command", "memory_save", "memory_review", "memory_merge", "cron_create", "cron_delete", "monitor", "service_start", "service_stop", "task_stop", "http_request", "delegate_agent", "acp_agent"])
const legacyEdits = new Set(["write_file", "create_file", "edit_file", "multi_edit"])
const legacyShells = new Set(["bash", "execute_command", "service_start", "monitor"])

/** Delegation tools whose own approval is scoped to agent@cwd. Running that
 * agent's host process is part of that consent, not a general sandbox
 * escape: it must neither use nor grant the bash outside-sandbox authorization. */
const SCOPED_AGENT_TOOLS = new Set(["delegate_agent", "acp_agent"])

/** Names zap gives an external ACP agent's own permission requests
 * (`acp_<agent>_<kind>`). Only these kinds are read-only. */
const ACP_REQUEST = /^acp_(?!agent$).+_(\w+)$/
const ACP_READ_KINDS = new Set(["read", "search", "think"])

export function approvalFacts(name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): Readonly<ToolApprovalFacts> {
  const facts = context?.authorization
  if (facts && !(facts.legacy && legacyWrites.has(name))) {
    return SCOPED_AGENT_TOOLS.has(name) && facts.sandboxEscape ? { ...facts, sandboxEscape: false } : facts
  }
  const acpKind = ACP_REQUEST.exec(name)?.[1]
  return {
    readOnly: acpKind ? ACP_READ_KINDS.has(acpKind) : !legacyWrites.has(name) && !name.startsWith("mcp__"),
    editOnly: legacyEdits.has(name),
    sandboxEscape: name === "bash" && args.dangerouslyDisableSandbox === true,
    workspaceShell: name === "bash",
    ...(legacyShells.has(name) ? { shellCommands: shellExecutionCommands(args) } : {}),
  }
}

/** Opacity limits command-pattern proof, not the user's whole-tool consent. */
export function opaqueShell(facts: Readonly<ToolApprovalFacts>, context?: Readonly<ApprovalContext>): boolean {
  if (facts.shellCommands === undefined) return false
  return facts.shellCommands === null || context?.shell.syntax === "unknown" || context?.shell.syntax === "cmd"
    || facts.shellCommands.some(command => requiresShellReview(command, context?.shell.syntax))
}

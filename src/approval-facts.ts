import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import type { ToolApprovalFacts } from "../zapsdk/tools/approval.js"
import { shellExecutionCommands, requiresShellReview } from "../zapsdk/utils/shell.js"

// Compatibility for pre-effects adapters and direct onApproval embedders.
// New tools declare effects/resolveShellCommands; do not extend these lists.
const legacyWrites = new Set(["write_file", "create_file", "edit_file", "multi_edit", "delete_file", "move_file", "bash", "execute_command", "memory_save", "memory_review", "memory_merge", "cron_create", "cron_delete", "monitor", "service_start", "service_stop", "task_stop", "http_request", "delegate_agent"])
const legacyEdits = new Set(["write_file", "create_file", "edit_file", "multi_edit"])
const legacyShells = new Set(["bash", "execute_command", "service_start", "monitor"])

export function approvalFacts(name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): Readonly<ToolApprovalFacts> {
  const facts = context?.authorization
  if (facts && !(facts.legacy && legacyWrites.has(name))) return facts
  return {
    readOnly: !legacyWrites.has(name) && !name.startsWith("mcp__"),
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

import { isAbsolute } from "node:path"
import { type PermissionRule } from "./permissions.js"

export interface ToolGrantRequest {
  tools: string[]
  resource: { kind: "all" } | { kind: "pattern"; value: string }
  lifetime: "session" | "project"
}

export const FILE_GRANT_TOOLS = ["read_file", "list_tree", "read_document", "search_files", "glob_files", "write_file", "create_file", "edit_file", "multi_edit", "delete_file", "move_file"]
export const READ_GRANT_TOOLS = ["read_file", "list_tree", "read_document", "search_files", "glob_files"]
export const EDIT_GRANT_TOOLS = ["write_file", "create_file", "edit_file", "multi_edit"]

/** Expand a reviewed snapshot of exact registry names; never save a tool wildcard. */
export function buildToolGrantRules(request: ToolGrantRequest, availableTools: readonly string[]): PermissionRule[] {
  if (!["session", "project"].includes(request.lifetime)) throw new Error("Choose session or project lifetime")
  const tools = [...new Set(request.tools)]
  if (!tools.length) throw new Error("Select at least one tool")
  for (const tool of tools) {
    if (!availableTools.includes(tool) || !/^[\w.-]+$/.test(tool)) throw new Error(`Tool is not available: ${tool}`)
    if (tool === "delegate_agent") throw new Error("delegate_agent requires a provider/cwd-scoped approval")
  }
  if (request.resource.kind === "all") return tools.map(tool => ({ pattern: tool, type: "allow" }))
  if (request.resource.kind !== "pattern") throw new Error("Choose a resource scope")
  const value = request.resource.value.trim()
  if (!value || /[\r\n\0()]/.test(value)) throw new Error("Enter a nonempty path glob or command pattern without parentheses")
  const filesOnly = tools.every(tool => FILE_GRANT_TOOLS.includes(tool))
  const bashOnly = tools.length === 1 && tools[0] === "bash"
  if (!filesOnly && !bashOnly) throw new Error("A resource filter needs only file tools, or Bash alone; use entire tools for a mixed set")
  if (filesOnly && (isAbsolute(value) || value.split(/[\\/]/).includes(".."))) throw new Error("Use a project-relative path glob without ..")
  return tools.map(tool => ({ pattern: `${tool}(${value})`, type: "allow" }))
}

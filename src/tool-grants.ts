import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { type PermissionRule } from "./permissions.js"
import { canonicalizeWithNearestExistingAncestorSync } from "../zapsdk/builtin-tools/filesystem.js"

export interface ToolGrantRequest {
  tools: string[]
  resource: { kind: "all" } | { kind: "pattern" | "directory"; value: string }
  lifetime: "session" | "project"
}

export const FILE_GRANT_TOOLS = ["read_file", "list_tree", "read_document", "search_files", "glob_files", "write_file", "create_file", "edit_file", "multi_edit", "delete_file", "move_file"]
export const READ_GRANT_TOOLS = ["read_file", "list_tree", "read_document", "search_files", "glob_files"]
export const EDIT_GRANT_TOOLS = ["write_file", "create_file", "edit_file", "multi_edit"]

function expandDirectory(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
}

/** Freeze the reviewed directory target; descendants outside it need another grant. */
function directoryGrantPattern(value: string, cwd: string): string {
  const valid = (path: string) => !!path.trim() && !/[\r\n\0*?{}]/.test(path) && (process.platform === "win32" || !path.includes("\\"))
  if (!valid(value)) throw new Error("Enter a literal folder path without glob characters")
  const base = canonicalizeWithNearestExistingAncestorSync(resolve(cwd))
  const target = canonicalizeWithNearestExistingAncestorSync(resolve(cwd, expandDirectory(value)))
  if (!valid(target)) throw new Error("The folder target contains unsupported glob characters")
  const rel = relative(base, target)
  if (!rel) return "**"
  const scope = (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") ? rel : target).replaceAll("\\", "/")
  return scope.endsWith("/") ? `${scope}{,**}` : `${scope}{,/**}`
}

export function suggestToolGrantDirectory(name: string, args: Record<string, unknown>, cwd = process.cwd()): string | undefined {
  if (!FILE_GRANT_TOOLS.includes(name) || typeof args.path !== "string" || !args.path.trim()) return undefined
  const path = resolve(cwd, expandDirectory(args.path))
  return ["list_tree", "search_files", "glob_files"].includes(name) ? path : dirname(path)
}

/** Expand a reviewed snapshot of exact registry names; never save a tool wildcard. */
function expandToolGrantRules(request: ToolGrantRequest, availableTools: readonly string[], cwd: string): PermissionRule[] {
  if (!["session", "project"].includes(request.lifetime)) throw new Error("Choose session or project lifetime")
  const tools = [...new Set(request.tools)]
  if (!tools.length) throw new Error("Select at least one tool")
  for (const tool of tools) {
    if (!availableTools.includes(tool) || !/^[\w.-]+$/.test(tool)) throw new Error(`Tool is not available: ${tool}`)
    if (tool === "delegate_agent") throw new Error("delegate_agent requires a provider/cwd-scoped approval")
  }
  if (request.resource.kind === "all") return tools.map(tool => ({ pattern: tool, type: "allow" }))
  const filesOnly = tools.every(tool => FILE_GRANT_TOOLS.includes(tool))
  if (request.resource.kind === "directory") {
    if (!filesOnly) throw new Error("Folder authorization requires file tools only")
    const pattern = directoryGrantPattern(request.resource.value, cwd)
    return tools.map(tool => ({ pattern: `${tool}(${pattern})`, type: "allow", canonicalPath: true }))
  }
  if (request.resource.kind !== "pattern") throw new Error("Choose a resource scope")
  const value = request.resource.value.trim()
  if (!value || /[\r\n\0()]/.test(value)) throw new Error("Enter a nonempty path glob or command pattern without parentheses")
  const bashOnly = tools.length === 1 && tools[0] === "bash"
  if (!filesOnly && !bashOnly) throw new Error("A resource filter needs only file tools, or Bash alone; use entire tools for a mixed set")
  if (filesOnly && (isAbsolute(value) || value.split(/[\\/]/).includes(".."))) throw new Error("Use a project-relative path glob without ..")
  return tools.map(tool => ({ pattern: `${tool}(${value})`, type: "allow" }))
}

/** A save must still describe exactly the scope shown when review began. */
export function buildToolGrantRules(request: ToolGrantRequest, availableTools: readonly string[], cwd = process.cwd(), reviewedRules?: readonly PermissionRule[]): PermissionRule[] {
  const rules = expandToolGrantRules(request, availableTools, cwd)
  if (reviewedRules && JSON.stringify(rules) !== JSON.stringify(reviewedRules)) {
    throw new Error("Authorization scope changed after review; go back and review it again")
  }
  return rules
}

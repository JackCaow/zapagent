import type { CapabilityKind, ToolCapability } from "../zapsdk/tools/approval.js"
import { destinationHostPattern } from "../zapsdk/execution/network-proxy.js"

// Capability rules are stored as ordinary `{ pattern, type }` rules with the
// pattern `Capability(<kind>:<scope>)`. They never match a tool name, so older
// versions read them as inert rules.

export const CAPABILITY_KINDS: readonly CapabilityKind[] = ["fs.write", "fs.delete", "net.read", "net.write", "external.read", "external.write"]
const RULE = /^Capability\(([a-z.]+):(.+)\)$/

export function capabilityPattern(kind: CapabilityKind, scope: string): string {
  return `Capability(${kind}:${scope})`
}

export function parseCapabilityPattern(pattern: string): ToolCapability | null {
  const match = RULE.exec(pattern)
  if (!match || !CAPABILITY_KINDS.includes(match[1] as CapabilityKind) || /[\r\n\0]/.test(match[2]!)) return null
  return { kind: match[1] as CapabilityKind, scope: match[2]! }
}

export function isFileCapability(kind: CapabilityKind): boolean {
  return kind === "fs.write" || kind === "fs.delete"
}

/** Host and system scopes: `*` matches any run of characters, nothing else is special. */
export function matchCapabilityScope(value: string, pattern: string): boolean {
  // Greedy two-pointer glob: linear in practice, no regex backtracking.
  const text = value.toLowerCase(), glob = pattern.toLowerCase()
  let t = 0, g = 0, star = -1, mark = 0
  while (t < text.length) {
    if (g < glob.length && glob[g] !== "*" && glob[g] === text[t]) { t++; g++ }
    else if (g < glob.length && glob[g] === "*") { star = g++; mark = t }
    else if (star >= 0) { g = star + 1; t = ++mark }
    else return false
  }
  while (glob[g] === "*") g++
  return g === glob.length
}

/** The content-editing tools; one `fs.write` consent covers all of them. */
export const WORKSPACE_EDIT_TOOLS: readonly string[] = ["write_file", "create_file", "edit_file", "multi_edit"]
const FILE_WRITE_TOOLS = new Set(WORKSPACE_EDIT_TOOLS)

/** File tools a capability can stand in for; their tool rules restrict it too. */
export function capabilityFileTools(kind: CapabilityKind): readonly string[] {
  return kind === "fs.write" ? [...WORKSPACE_EDIT_TOOLS, "move_file"] : kind === "fs.delete" ? ["delete_file", "move_file"] : []
}

/** Built-in file tools are judged from their arguments, like their tool rules,
 * so a shell's write_paths check never borrows the shell's own facts. */
export function fileToolCapabilities(name: string, args: Record<string, unknown>): ToolCapability[] | undefined {
  const path = (key: string) => typeof args[key] === "string" && args[key] ? args[key] as string : null
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = path("path")
    return target ? [{ kind: "fs.write", scope: target }] : undefined
  }
  if (name === "delete_file") {
    const target = path("path")
    return target ? [{ kind: "fs.delete", scope: target }] : undefined
  }
  if (name === "move_file") {
    const source = path("source"), destination = path("destination")
    return source && destination ? [{ kind: "fs.delete", scope: source }, { kind: "fs.write", scope: destination }] : undefined
  }
  return []
}

function describeOne(capability: ToolCapability): string {
  const { kind, scope } = capability
  const where = scope === "**" ? "anywhere in this project" : `in ${scope.replace(/\/\*\*$/, "")}`
  switch (kind) {
    case "fs.write": return `file edits ${where}`
    case "fs.delete": return `file deletes ${where}`
    case "net.read": return `network reads from ${scope}`
    case "net.write": return `network access to ${scope} (send and receive)`
    case "external.read": return scope.startsWith("mcp:") ? `read-only tools of MCP server ${scope.slice(4)}` : `reads from ${scope}`
    case "external.write": return scope.startsWith("mcp:") ? `changes through MCP server ${scope.slice(4)}` : `changes through ${scope}`
  }
}

/** Plain-language summary for an approval label; other rules stay as written.
 * Null when no rule is a capability. */
export function describeCapabilityPatterns(patterns: readonly string[]): string | null {
  const capabilities = patterns.map(parseCapabilityPattern)
  if (!capabilities.some(Boolean)) return null
  return capabilities.map((capability, index) => capability ? describeOne(capability) : patterns[index]).join(", ")
}

export const REQUEST_CAPABILITIES_TOOL = "request_capabilities"
export const MAX_REQUESTED_CAPABILITIES = 8

/** Capabilities `request_capabilities` asks for, in rule form, or why they
 * cannot be granted. Files stay project-relative; hosts and systems are
 * named exactly or by `*.` subdomain, never by `*` alone. */
export function parseCapabilityRequest(args: Record<string, unknown>): ToolCapability[] | string {
  const list = args.capabilities
  if (!Array.isArray(list) || !list.length) return "request at least one capability"
  if (list.length > MAX_REQUESTED_CAPABILITIES) return `request at most ${MAX_REQUESTED_CAPABILITIES} capabilities`
  const parsed: ToolCapability[] = []
  for (const item of list) {
    const kind = (item as { kind?: unknown })?.kind, raw = (item as { scope?: unknown })?.scope
    if (!CAPABILITY_KINDS.includes(kind as CapabilityKind) || typeof raw !== "string") return "each capability needs a kind and a scope"
    const scope = raw.trim()
    if (!scope || /[\r\n\0\\()]/.test(scope)) return `invalid scope: ${JSON.stringify(raw)}`
    if (isFileCapability(kind as CapabilityKind)) {
      if (/^[/~]|^[a-zA-Z]:/.test(scope) || scope.split("/").includes(".."))
        return `${kind} scope must be a project-relative path or glob; paths outside the project are approved per call`
      parsed.push({ kind: kind as CapabilityKind, scope: scope.replace(/^\.\//, "") })
    } else if (kind === "net.read" || kind === "net.write") {
      const host = destinationHostPattern(scope)
      if (!host) return `${kind} scope must be a host such as api.github.com or *.github.com`
      parsed.push({ kind, scope: host })
    } else {
      if (!/^[a-z][\w.-]*(?::[\w.-]+)?$/i.test(scope)) return `${kind} scope must name one system, such as mcp:<server> or http`
      // MCP tools that change state have unknown effects and keep per-tool consent.
      if (kind === "external.write" && scope.startsWith("mcp:")) return "MCP changes are approved per tool; request external.read for read-only MCP tools"
      parsed.push({ kind: kind as CapabilityKind, scope })
    }
  }
  return parsed.filter((capability, index) => parsed.findIndex(other => other.kind === capability.kind && other.scope === capability.scope) === index)
}

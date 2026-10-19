// Implementation of the `/mcp` slash command family. Output is built as
// plain text and fed back via addLog("system", ...) so it appears inline
// in the transcript exactly like other slash-command output.

import type { MCPManager, MCPServerSnapshot } from "../../zapsdk/index.js"
import { getMCPManager } from "../singletons.js"

export interface MCPCommandDeps {
  addLog: (type: "system" | "error", text: string) => void
}

/** Entry point. `argString` is everything after `/mcp ` (may be empty). */
export async function dispatchMCPCommand(argString: string, deps: MCPCommandDeps): Promise<void> {
  const mgr = getMCPManager()
  if (!mgr) {
    deps.addLog("error", "MCP subsystem not initialised yet")
    return
  }

  const parts = argString.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? "").toLowerCase()
  const arg = parts[1] ?? ""

  switch (sub) {
    case "":
      return printSummary(mgr, deps)
    case "list":
    case "ls":
      return printSummary(mgr, deps)
    case "status":
      return printStatus(mgr, arg, deps)
    case "tools":
      return printTools(mgr, arg, deps)
    case "resources":
      return printResources(mgr, arg, deps)
    case "prompts":
      return printPrompts(mgr, arg, deps)
    case "logs":
      deps.addLog("system", `Server logs are streamed live to ~/.zapcode/latest.log. Filter with: grep '^mcp:${arg || "<server>"}:' ~/.zapcode/latest.log`)
      return
    case "reconnect":
      if (!arg) { deps.addLog("error", "Usage: /mcp reconnect <server>"); return }
      try {
        await mgr.reconnect(arg)
        deps.addLog("system", `mcp: reconnect requested for "${arg}"`)
      } catch (err) {
        deps.addLog("error", `mcp reconnect failed: ${msg(err)}`)
      }
      return
    case "auth":
      if (!arg) { deps.addLog("error", "Usage: /mcp auth <server>"); return }
      deps.addLog("system", `mcp: opening browser to authorize "${arg}"…`)
      try {
        await mgr.runAuth(arg)
        deps.addLog("system", `mcp: "${arg}" authorized.`)
      } catch (err) {
        deps.addLog("error", `mcp auth failed: ${msg(err)}`)
      }
      return
    default:
      deps.addLog(
        "error",
        `Unknown /mcp subcommand: ${sub}. Try: list | status <s> | tools <s> | resources <s> | prompts <s> | reconnect <s> | auth <s>`,
      )
      return
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function printSummary(mgr: MCPManager, deps: MCPCommandDeps): void {
  const snaps = mgr.snapshots()
  if (snaps.length === 0) {
    deps.addLog("system", "No MCP servers configured. Edit ~/.zapcode/config.json (key: mcpServers).")
    return
  }
  const lines = ["MCP servers:"]
  for (const s of snaps) {
    lines.push(`  ${statusGlyph(s.status)} ${s.name.padEnd(20)} ${s.status.padEnd(13)} tools=${s.toolCount}  resources=${s.resourceCount}  prompts=${s.promptCount}${s.lastError ? `  err=${trimErr(s.lastError)}` : ""}`)
  }
  lines.push("", "Subcommands: /mcp status <s> · tools <s> · resources <s> · prompts <s> · reconnect <s> · auth <s>")
  deps.addLog("system", lines.join("\n"))
}

function printStatus(mgr: MCPManager, name: string, deps: MCPCommandDeps): void {
  if (!name) { deps.addLog("error", "Usage: /mcp status <server>"); return }
  const snap = mgr.snapshots().find((s) => s.name === name)
  if (!snap) { deps.addLog("error", `Unknown MCP server: ${name}`); return }
  const lines = [
    `MCP server: ${snap.name}`,
    `  status:        ${statusGlyph(snap.status)} ${snap.status}`,
    `  tools:         ${snap.toolCount}`,
    `  resources:     ${snap.resourceCount}`,
    `  prompts:       ${snap.promptCount}`,
    `  connectedAt:   ${snap.connectedAt ?? "—"}`,
    `  reconnects:    ${snap.reconnectAttempts}`,
    `  lastError:     ${snap.lastError ?? "—"}`,
    `  capabilities:  ${formatCaps(snap)}`,
  ]
  deps.addLog("system", lines.join("\n"))
}

function printTools(mgr: MCPManager, name: string, deps: MCPCommandDeps): void {
  if (!name) { deps.addLog("error", "Usage: /mcp tools <server>"); return }
  const tools = mgr.allTools().filter((t) => t.definition.name.startsWith(`mcp__${name}__`))
  if (tools.length === 0) { deps.addLog("system", `mcp: no tools from "${name}".`); return }
  const lines = [`Tools from ${name}:`]
  for (const t of tools) {
    const bare = t.definition.name.replace(`mcp__${name}__`, "")
    lines.push(`  ${bare.padEnd(40)}  ${t.definition.description?.slice(0, 80) ?? ""}`)
  }
  deps.addLog("system", lines.join("\n"))
}

function printResources(mgr: MCPManager, name: string, deps: MCPCommandDeps): void {
  if (!name) { deps.addLog("error", "Usage: /mcp resources <server>"); return }
  const { resources, templates } = mgr.allResources()
  const own = resources.filter((r) => r.server === name)
  const ownT = templates.filter((t) => t.server === name)
  if (own.length === 0 && ownT.length === 0) { deps.addLog("system", `mcp: no resources from "${name}".`); return }
  const lines = [`Resources from ${name}:`]
  for (const r of own) {
    lines.push(`  ${r.uri.padEnd(48)}  ${(r.title ?? r.name ?? "").slice(0, 50)}`)
  }
  for (const t of ownT) {
    lines.push(`  template: ${t.uriTemplate.padEnd(40)}  ${(t.title ?? t.name ?? "").slice(0, 50)}`)
  }
  deps.addLog("system", lines.join("\n"))
}

function printPrompts(mgr: MCPManager, name: string, deps: MCPCommandDeps): void {
  if (!name) { deps.addLog("error", "Usage: /mcp prompts <server>"); return }
  const prompts = mgr.allPrompts().filter((p) => p.server === name)
  if (prompts.length === 0) { deps.addLog("system", `mcp: no prompts from "${name}".`); return }
  const lines = [`Prompts from ${name}:`]
  for (const p of prompts) {
    const args = p.arguments.length
      ? ` (${p.arguments.map((a) => `${a.name}${a.required ? "" : "?"}`).join(", ")})`
      : ""
    lines.push(`  /mcp.${name}.${p.name}${args}  —  ${(p.title ?? p.description ?? "").slice(0, 60)}`)
  }
  deps.addLog("system", lines.join("\n"))
}

function statusGlyph(s: MCPServerSnapshot["status"]): string {
  switch (s) {
    case "ready":        return "✓"
    case "connecting":   return "…"
    case "degraded":     return "↻"
    case "needs_auth":   return "🔒"
    case "error":        return "✗"
    case "disconnected": return "·"
    case "idle":         return " "
  }
}

function formatCaps(snap: MCPServerSnapshot): string {
  const c = snap.capabilities ?? {}
  const parts: string[] = []
  if (c.tools)      parts.push(`tools${c.tools.listChanged ? "*" : ""}`)
  if (c.resources)  parts.push(`resources${c.resources.subscribe ? "+sub" : ""}${c.resources.listChanged ? "*" : ""}`)
  if (c.prompts)    parts.push(`prompts${c.prompts.listChanged ? "*" : ""}`)
  if (c.logging)    parts.push("logging")
  if (c.completions) parts.push("completions")
  return parts.length ? parts.join(", ") : "—"
}

function trimErr(e: string): string {
  return e.length > 60 ? `${e.slice(0, 60)}…` : e
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

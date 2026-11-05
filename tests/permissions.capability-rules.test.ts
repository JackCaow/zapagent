import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeCapabilityPatterns, matchCapabilityScope, parseCapabilityPattern } from "../src/capabilities.js"
import { buildHeadlessApproval } from "../src/headless/approval.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { getProjectSettingsPath, inferInvocationRules, PermissionManager, savePermissionSettings, type PermissionRule } from "../src/permissions.js"
import { httpFetchTool, httpRequestTool } from "../zapsdk/builtin-tools/http.js"
import { resolveToolApprovalFacts, resolveToolCapabilities } from "../zapsdk/tools/approval.js"
import { emptyToolEffects, type ToolEffects } from "../zapsdk/tools/effects.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import type { ToolDefinition } from "../zapsdk/tools/types.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-capability-rules-"))
  cwd = join(root, "project")
  mkdirSync(join(cwd, "src"), { recursive: true })
  previousDataDir = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

// Policy subjects only: no request is sent and no MCP server is started.
const shell = { syntax: "posix" as const, filesystem: "host" as const }
function contextFor(definition: ToolDefinition, args: Record<string, unknown>, effects?: ToolEffects): ApprovalContext {
  const resolved = effects ?? definition.resolveEffects!(args, { cwd, toolName: definition.name })
  return { cwd, workspaceRoot: cwd, shell, authorization: resolveToolApprovalFacts(definition, args, resolved as ToolEffects) }
}
const mcpDefinition = (name: string): ToolDefinition => ({ name, description: "fixture", permission: "confirm", parameters: {} as never })
const mcpRead = (server: string): ToolEffects => ({ ...emptyToolEffects("inferred"),
  external: [{ kind: "external", system: `mcp:${server}`, operation: "read", resource: "x" }] })
const decide = (manager: PermissionManager, name: string, args: Record<string, unknown>, context: ApprovalContext, mode: "default" | "bypassPermissions" = "default") =>
  evaluateApprovalPolicy(manager, name, args, { cwd, mode, context })
const project = (rules: PermissionRule[]) => savePermissionSettings(getProjectSettingsPath(cwd), { rules })

describe("capabilities derived from effects", () => {
  it("maps declared network and external effects to host-scoped capabilities", () => {
    const fetch = httpFetchTool().definition, request = httpRequestTool().definition
    expect(contextFor(fetch, { url: "https://API.github.com/repos" }).authorization?.capabilities)
      .toEqual([{ kind: "net.read", scope: "api.github.com" }])
    expect(contextFor(request, { url: "https://api.github.com/x", method: "POST" }).authorization?.capabilities)
      .toEqual([{ kind: "net.write", scope: "api.github.com" }, { kind: "external.write", scope: "http" }])
  })

  it("has no capabilities when an effect has no reusable form", () => {
    expect(resolveToolCapabilities({ ...emptyToolEffects(), process: [{ kind: "process", operation: "spawn" }] })).toBeUndefined()
    expect(resolveToolCapabilities({ ...emptyToolEffects(), network: [{ kind: "network", operation: "connect", destinations: ["*"] }] })).toBeUndefined()
    expect(resolveToolCapabilities({ ...emptyToolEffects(), external: [{ kind: "external", system: "mcp:gh", operation: "destructive" }] })).toBeUndefined()
    expect(resolveToolCapabilities(emptyToolEffects("unknown"))).toBeUndefined()
    expect(resolveToolCapabilities({ ...emptyToolEffects(), filesystem: [{ kind: "filesystem", operation: "read", paths: ["/a"] }] })).toEqual([])
  })
})

describe("capability rules", () => {
  it("parses, matches and describes rules", () => {
    expect(parseCapabilityPattern("Capability(net.read:*.github.com)")).toEqual({ kind: "net.read", scope: "*.github.com" })
    expect(parseCapabilityPattern("Capability(exec:*)")).toBeNull()
    expect(parseCapabilityPattern("Bash(git:*)")).toBeNull()
    expect(matchCapabilityScope("api.github.com", "*.github.com")).toBe(true)
    expect(matchCapabilityScope("github.com.evil.io", "*.github.com")).toBe(false)
    expect(describeCapabilityPatterns(["Capability(fs.write:**)", "Capability(net.write:api.x.com)"]))
      .toBe("file edits anywhere in this project, network writes to api.x.com")
    expect(describeCapabilityPatterns(["Capability(external.read:mcp:gh)"])).toBe("read-only tools of MCP server gh")
    expect(describeCapabilityPatterns(["Bash(git:*)"])).toBeNull()
    expect(describeCapabilityPatterns(["Bash(curl:*)", "Capability(net.read:api.x.com)"])).toBe("Bash(curl:*), network reads from api.x.com")
  })

  it("remembers a network write per host, not per tool or for every host", () => {
    const definition = httpRequestTool().definition
    const call = (url: string) => ({ args: { url, method: "POST" }, context: contextFor(definition, { url, method: "POST" }) })
    const first = call("https://api.github.com/repos/a/issues")
    expect(inferInvocationRules("http_request", first.args, cwd, first.context).map(rule => rule.pattern))
      .toEqual(["Capability(net.write:api.github.com)", "Capability(external.write:http)"])
    const manager = new PermissionManager(cwd)
    expect(decide(manager, "http_request", first.args, first.context).decision).toBe("ask")
    manager.addSessionRule("http_request", first.args, first.context)
    const same = call("https://api.github.com/repos/b/pulls")
    expect(decide(manager, "http_request", same.args, same.context).decision).toBe("allow")
    const other = call("https://hooks.example.com/x")
    expect(decide(manager, "http_request", other.args, other.context).decision).toBe("ask")
  })

  it("grants read-only MCP tools per server, never its unknown-effect tools", () => {
    const manager = new PermissionManager(cwd)
    const list = contextFor(mcpDefinition("mcp__gh__list"), {}, mcpRead("gh"))
    manager.addSessionRule("mcp__gh__list", {}, list)
    expect(decide(manager, "mcp__gh__get", {}, contextFor(mcpDefinition("mcp__gh__get"), {}, mcpRead("gh"))).decision).toBe("allow")
    expect(decide(manager, "mcp__jira__get", {}, contextFor(mcpDefinition("mcp__jira__get"), {}, mcpRead("jira"))).decision).toBe("ask")
    expect(decide(manager, "mcp__gh__create", {}, contextFor(mcpDefinition("mcp__gh__create"), {}, emptyToolEffects("unknown"))).decision).toBe("ask")
  })

  it("lets a restriction stop its whole family, even under bypass", () => {
    project([{ pattern: "Capability(net.read:*.evil.io)", type: "deny" }, { pattern: "Capability(fs.write:secrets/**)", type: "ask" }])
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "http_request", type: "allow" }, { pattern: "Capability(fs.write:**)", type: "allow" }, { pattern: "Capability(fs.delete:**)", type: "allow" }], "session")
    const url = "https://x.evil.io/a"
    const request = contextFor(httpRequestTool().definition, { url, method: "POST" })
    expect(decide(manager, "http_request", { url, method: "POST" }, request, "bypassPermissions").decision).toBe("deny")
    const plain = { cwd, workspaceRoot: cwd, shell }
    expect(decide(manager, "edit_file", { path: "secrets/k.ts" }, plain).decision).toBe("ask")
    expect(decide(manager, "delete_file", { path: "secrets/k.ts" }, plain).decision).toBe("ask")
    expect(decide(manager, "edit_file", { path: "src/a.ts" }, plain).decision).toBe("allow")
  })

  it("an allow never crosses kinds", () => {
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "Capability(fs.write:**)", type: "allow" }, { pattern: "Capability(net.read:api.x.com)", type: "allow" }], "session")
    const plain = { cwd, workspaceRoot: cwd, shell }
    expect(decide(manager, "delete_file", { path: "src/a.ts" }, plain).decision).toBe("ask")
    const url = "https://api.x.com/a"
    expect(decide(manager, "http_request", { url, method: "POST" }, contextFor(httpRequestTool().definition, { url, method: "POST" })).decision).toBe("ask")
  })

  it("does not apply to shells", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(false)
    manager.addToolRules([{ pattern: "Capability(fs.write:**)", type: "allow" }], "session")
    expect(decide(manager, "bash", { command: "touch src/a.ts" }, { cwd, workspaceRoot: cwd, shell }).decision).toBe("ask")
  })

  it("keeps older tool rules working beside capability rules", () => {
    project([{ pattern: "http_request", type: "allow" }])
    const url = "https://any.example.com/a"
    expect(decide(new PermissionManager(cwd), "http_request", { url, method: "POST" }, contextFor(httpRequestTool().definition, { url, method: "POST" })).decision).toBe("allow")
  })

  it("decides the same way in headless runs", async () => {
    project([{ pattern: "Capability(net.write:api.github.com)", type: "allow" }, { pattern: "Capability(external.write:http)", type: "allow" }])
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default" })
    const url = "https://api.github.com/x"
    expect(await approval.onApproval("http_request", { url, method: "POST" }, undefined, contextFor(httpRequestTool().definition, { url, method: "POST" }))).toBe(true)
    const other = "https://example.com/x"
    expect(await approval.onApproval("http_request", { url: other, method: "POST" }, undefined, contextFor(httpRequestTool().definition, { url: other, method: "POST" })))
      .toMatchObject({ approved: false })
  })
})

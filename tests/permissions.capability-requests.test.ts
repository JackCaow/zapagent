import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchCapabilityScope, parseCapabilityRequest, REQUEST_CAPABILITIES_TOOL } from "../src/capabilities.js"
import { parsePermissionMode, type PermissionMode } from "../src/config.js"
import { buildHeadlessApproval } from "../src/headless/approval.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { getProjectSettingsPath, inferInvocationRules, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { requestCapabilitiesTool } from "../src/request-capabilities-tool.js"
import { approvalChoiceForInput } from "../src/ui/dialog-approval.js"
import { DEFAULT_ALLOWED_DOMAINS } from "../zapsdk/execution/network-proxy.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-capability-requests-"))
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

// Policy subjects only: nothing is edited, fetched or saved to memory.
const context = () => ({ cwd, workspaceRoot: cwd, shell: { syntax: "posix" as const, filesystem: "host" as const } })
const decide = (manager: PermissionManager, name: string, args: Record<string, unknown>, mode: PermissionMode = "default") =>
  evaluateApprovalPolicy(manager, name, args, { cwd, mode, context: context() })
const request = (...capabilities: Array<[string, string]>) => ({ capabilities: capabilities.map(([kind, scope]) => ({ kind, scope })), reason: "fixture" })

describe("permission presets", () => {
  it("name existing modes and reject unknown names", () => {
    expect(parsePermissionMode("strict")).toBe("default")
    expect(parsePermissionMode("balanced")).toBe("acceptEdits")
    expect(parsePermissionMode("autonomous")).toBe("bypassPermissions")
    expect(parsePermissionMode("bypass")).toBe("bypassPermissions")
    expect(parsePermissionMode("plan")).toBe("plan")
    expect(parsePermissionMode("toString")).toBeNull()
    expect(parsePermissionMode("yolo")).toBeNull()
  })
})

describe("memory writes", () => {
  it("allow new project notes and ask for anything that steers later sessions", () => {
    const manager = new PermissionManager(cwd)
    const save = (fields: Record<string, unknown>) => decide(manager, "memory_save", { type: "project", name: "n", description: "d", content: "c", ...fields })
    // Without a lookup a name might already exist.
    expect(save({}).decision).toBe("ask")
    manager.setProjectMemoryLookup(name => name === "taken")
    expect(save({})).toMatchObject({ decision: "allow", tier: "R1" })
    expect(save({ type: "reference" }).decision).toBe("allow")
    expect(save({ name: "taken" }).decision).toBe("ask")
    expect(save({ tags: ["pinned"] }).decision).toBe("ask")
    expect(save({ supersedes: ["old"] }).decision).toBe("ask")
    expect(save({ type: "user" }).decision).toBe("ask")
    expect(save({ type: "feedback" }).decision).toBe("ask")
    expect(evaluateApprovalPolicy(manager, "memory_save", { type: "project", name: "n" }, { cwd, mode: "plan", context: context() }).decision).toBe("deny")
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "memory_save", type: "ask" }] })
    manager.reload()
    expect(save({}).decision).toBe("ask")
  })
})

describe("capability requests", () => {
  it("accept narrow scopes and refuse broad or outside ones", () => {
    expect(parseCapabilityRequest(request(["fs.write", "./src/**"], ["net.read", "https://API.example.com/x"], ["external.read", "mcp:gh"])))
      .toEqual([{ kind: "fs.write", scope: "src/**" }, { kind: "net.read", scope: "api.example.com" }, { kind: "external.read", scope: "mcp:gh" }])
    for (const bad of [request(["fs.write", "/etc/**"]), request(["fs.write", "../x"]), request(["fs.delete", "~/x"]), request(["net.read", "*"]),
      request(["net.write", "localhost"]), request(["external.write", "*"]), request(["exec", "*"]), request()])
      expect(typeof parseCapabilityRequest(bad)).toBe("string")
    expect(typeof parseCapabilityRequest(request(["external.write", "mcp:gh"]))).toBe("string")
    const hosts = (count: number) => request(...Array.from({ length: count }, (_, i): [string, string] => ["net.read", `h${i}.example.com`]))
    expect(parseCapabilityRequest(hosts(8))).toHaveLength(8)
    expect(typeof parseCapabilityRequest(hosts(9))).toBe("string")
  })

  it("asks once and saves exactly what was requested", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(true)
    manager.setSandboxNetworkPolicy({ allowedDomains: [...DEFAULT_ALLOWED_DOMAINS], deniedDomains: [] })
    const args = request(["fs.write", "src/**"], ["net.write", "api.example.com"])
    expect(decide(manager, REQUEST_CAPABILITIES_TOOL, args)).toMatchObject({ decision: "ask", allowScope: true })
    expect(inferInvocationRules(REQUEST_CAPABILITIES_TOOL, args, cwd).map(rule => rule.pattern))
      .toEqual(["Capability(fs.write:src/**)", "Capability(net.write:api.example.com)"])
    manager.addSessionRule(REQUEST_CAPABILITIES_TOOL, args, context())
    expect(decide(manager, "edit_file", { path: "src/a.ts" }).decision).toBe("allow")
    expect(decide(manager, "write_file", { path: "src/deep/b.ts" }).decision).toBe("allow")
    expect(decide(manager, "edit_file", { path: "README.md" }).decision).toBe("ask")
    expect(decide(manager, "delete_file", { path: "src/a.ts" }).decision).toBe("ask")
    expect(decide(manager, "bash", { command: "curl -s https://api.example.com/v1", network_destinations: ["api.example.com"] }).decision).toBe("allow")
    // A request inside what is already granted needs no prompt.
    expect(decide(manager, REQUEST_CAPABILITIES_TOOL, request(["fs.write", "src/**"])).decision).toBe("allow")
  })

  it("keeps restrictions, plan mode and invalid requests ahead of a grant", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Capability(net.read:*.evil.io)", type: "deny" }, { pattern: "Capability(fs.write:src/secret/**)", type: "deny" }] })
    const manager = new PermissionManager(cwd)
    expect(decide(manager, REQUEST_CAPABILITIES_TOOL, request(["net.write", "x.evil.io"])).decision).toBe("deny")
    expect(decide(manager, REQUEST_CAPABILITIES_TOOL, request(["fs.write", "src/**"]), "plan").decision).toBe("deny")
    expect(decide(manager, REQUEST_CAPABILITIES_TOOL, request(["fs.write", "/etc/**"])).reason).toContain("project-relative")
    manager.addSessionRule(REQUEST_CAPABILITIES_TOOL, request(["fs.write", "src/**"]), context())
    expect(decide(manager, "edit_file", { path: "src/secret/k.ts" }).decision).toBe("deny")
  })

  it("is never saved by a headless host's one-time yes", async () => {
    let asked = 0
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default", onAsk: async () => { asked++; return true } })
    expect(await approval.onApproval(REQUEST_CAPABILITIES_TOOL, request(["fs.write", "src/**"]), undefined, context())).toBe(true)
    expect(await approval.onApproval("edit_file", { path: "src/a.ts" }, undefined, context())).toBe(true)
    expect(asked).toBe(2)
  })

  it("is not asked again in a headless run after the host declines it", async () => {
    let asked = 0
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default", onAsk: async () => { asked++; return false } })
    const args = request(["fs.write", "src/**"])
    expect(await approval.onApproval(REQUEST_CAPABILITIES_TOOL, args, undefined, context())).toMatchObject({ approved: false })
    expect(await approval.onApproval(REQUEST_CAPABILITIES_TOOL, args, undefined, context())).toMatchObject({ approved: false })
    expect(asked).toBe(1)
  })

  it("matches long wildcard scopes without backtracking", () => {
    const started = performance.now()
    expect(matchCapabilityScope("a".repeat(240) + ".com", "*a*a*a*a*a*a*a*a*b")).toBe(false)
    expect(performance.now() - started).toBeLessThan(50)
    expect(matchCapabilityScope("API.github.com", "*.github.com")).toBe(true)
  })

  it("logs shell egress beyond the allowlist as R2", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(true)
    manager.setSandboxNetworkPolicy({ allowedDomains: [...DEFAULT_ALLOWED_DOMAINS], deniedDomains: [] })
    expect(decide(manager, "bash", { command: "curl -s https://x", network_destinations: ["api.example.com"] }).tier).toBe("R2")
    expect(decide(manager, "bash", { command: "curl -s https://x", network_destinations: ["github.com"] }).tier).toBe("R1")
  })

  it("never lets a grant step around a sibling tool's restriction", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Edit(.env)", type: "deny" }, { pattern: "Write(secrets/**)", type: "ask" },
      { pattern: "Capability(net.read:secret.example.com)", type: "deny" }] })
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(true)
    manager.setSandboxNetworkPolicy({ allowedDomains: [...DEFAULT_ALLOWED_DOMAINS], deniedDomains: [] })
    manager.addSessionRule("edit_file", { path: "src/a.ts" }, context())
    manager.addToolRules([{ pattern: "Capability(net.write:*.example.com)", type: "allow" }], "session")
    for (const tool of ["edit_file", "write_file", "multi_edit", "create_file"]) expect(decide(manager, tool, { path: ".env" }).decision).toBe("deny")
    expect(decide(manager, "edit_file", { path: "secrets/k.ts" }).decision).toBe("ask")
    expect(decide(manager, "edit_file", { path: "src/b.ts" }).decision).toBe("allow")
    const curl = (host: string) => decide(manager, "bash", { command: "curl -s https://x", network_destinations: [host] }).decision
    expect(curl("*.example.com")).toBe("deny")
    expect(curl("api.example.com")).toBe("allow")
    expect(decide(manager, REQUEST_CAPABILITIES_TOOL, request(["net.write", "*.example.com"])).decision).toBe("deny")
  })

  it("reports whether the grant was saved", async () => {
    let saved = false
    const tool = requestCapabilitiesTool(() => saved)
    const args = request(["fs.write", "src/**"])
    expect((await tool.handler(args)).output.startsWith("Approved without saving: file edits in src")).toBe(true)
    saved = true
    expect((await tool.handler(args)).output.startsWith("Granted: file edits in src")).toBe(true)
    expect((await tool.handler(request(["net.read", "*"]))).success).toBe(false)
  })

  it("offers only remembering choices in the approval bar", () => {
    const choices = ["always", "forever", "deny"] as const
    expect(approvalChoiceForInput("1", {}, 0, true, choices)).toBe("always")
    expect(approvalChoiceForInput("2", {}, 0, true, choices)).toBe("forever")
    expect(approvalChoiceForInput("3", {}, 0, true, choices)).toBe("deny")
    expect(approvalChoiceForInput("4", {}, 0, true, choices)).toBeNull()
  })
})

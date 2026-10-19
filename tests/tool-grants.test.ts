import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { buildToolGrantRules, type ToolGrantRequest } from "../src/tool-grants.js"
import { inferInvocationRules, getGlobalSettingsPath, getProjectAuthorizationSettingsPath, getProjectLocalSettingsPath, getProjectSettingsPath, loadPermissionSettings, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { buildHeadlessApproval } from "../src/headless/approval.js"

let root: string, cwd: string, previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-tool-grants-")); cwd = join(root, "project"); mkdirSync(cwd)
  previous = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})
const request = (tools: string[], resource: ToolGrantRequest["resource"] = { kind: "all" }, lifetime: ToolGrantRequest["lifetime"] = "session"): ToolGrantRequest => ({ tools, resource, lifetime })
const inventory = ["bash", "write_file", "edit_file", "multi_edit", "read_file", "move_file", "delegate_agent", "mcp__fixture__Read"]

describe("tool grant expansion and resource contracts", () => {
  it("saves exact tool snapshots, deduplicates names, and preserves MCP case", () => {
    const rules = buildToolGrantRules(request(["read_file", "mcp__fixture__Read", "read_file"]), inventory)
    expect(rules.map(rule => rule.pattern)).toEqual(["read_file", "mcp__fixture__Read"])
    const mgr = new PermissionManager(cwd)
    mgr.addToolRules(rules, "session")
    expect(mgr.checkPermission("mcp__fixture__Read", {}).decision).toBe("allow")
    expect(mgr.checkPermission("mcp__fixture__NewTool", {}).decision).toBe("ask")
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
  })
  it("supports multiple file tools with project-relative globs, including absolute runtime paths", () => {
    const mgr = new PermissionManager(cwd)
    mgr.addToolRules(buildToolGrantRules(request(["edit_file", "multi_edit"], { kind: "pattern", value: "src/**" }), inventory), "session")
    for (const name of ["edit_file", "multi_edit"]) {
      expect(mgr.checkPermission(name, { path: join(cwd, "src", "a.ts") }).decision).toBe("allow")
      expect(mgr.checkPermission(name, { path: "lib/a.ts" }).decision).toBe("ask")
    }
  })
  it("previews every compound/structured rule using exactly the saved session/project expansion", () => {
    const args = { check_steps: ["git status", "npm test", "git status --short"] }
    const expected = [{ pattern: "Bash(git status:*)", type: "allow" }, { pattern: "Bash(npm test:*)", type: "allow" }]
    expect(inferInvocationRules("bash", args, cwd)).toEqual(expected)
    const mgr = new PermissionManager(cwd); mgr.setSessionId("first")
    mgr.addSessionRule("bash", args)
    expect(mgr.getSummary().find(group => group.label === "session")?.rules).toEqual(expected)
    mgr.addProjectRule("bash", args)
    expect(loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd)).rules).toEqual(expected)
  })
  it("requires scope coverage for each shell/check_steps command and both move endpoints", () => {
    const mgr = new PermissionManager(cwd)
    const rules = buildToolGrantRules(request(["bash"], { kind: "pattern", value: "git log:*" }), inventory)
    expect(mgr.grantCoversCall(rules, "bash", { check_steps: ["git log --oneline", "git push"] })).toBe(false)
    expect(mgr.grantCoversCall(rules, "bash", { command: "nohup git log --oneline" })).toBe(true)
    expect(mgr.grantCoversCall(rules, "bash", { command: "git log && git push" })).toBe(false)
    const moves = buildToolGrantRules(request(["move_file"], { kind: "pattern", value: "src/**" }), inventory)
    expect(mgr.grantCoversCall(moves, "move_file", { source: join(cwd, "src/a"), destination: "src/b" })).toBe(true)
    expect(mgr.grantCoversCall(moves, "move_file", { source: "/outside/a", destination: "src/b" })).toBe(false)
    const union = [...moves, ...buildToolGrantRules(request(["move_file"], { kind: "pattern", value: "lib/**" }), inventory)]
    mgr.addToolRules(union, "session")
    expect(mgr.grantCoversCall(union, "move_file", { source: "src/a", destination: "lib/a" })).toBe(true)
    expect(mgr.checkPermission("move_file", { source: "src/a", destination: "lib/a" }).decision).toBe("allow")
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Move(lib/**)", type: "deny" }] })
    expect(mgr.checkPermission("move_file", { source: "src/a", destination: "lib/a" }).decision).toBe("deny")
  })
  for (const invalid of [request([]), request(["unknown"]), request(["delegate_agent"]), request(["bash", "edit_file"], { kind: "pattern", value: "*" }), request(["edit_file"], { kind: "pattern", value: "../**" }), request(["edit_file"], { kind: "pattern", value: "/**" }), request(["bash"], { kind: "pattern", value: "" }), request(["mcp__fixture__Read"], { kind: "pattern", value: "*" })]) {
    it(`rejects an invalid batch ${JSON.stringify(invalid)}`, () => expect(() => buildToolGrantRules(invalid, inventory)).toThrow())
  }
})

describe("unified rule priority and lifecycle", () => {
  const layers = ["session", "project grants", "personal", "project", "global"] as const
  for (const restrictiveLayer of layers) {
    it(`${restrictiveLayer} deny/ask outranks allows from every other source`, () => {
      const mgr = new PermissionManager(cwd)
      mgr.setSessionId("first")
      for (const type of ["ask", "deny"] as const) {
        for (const layer of layers) {
          const rule = { pattern: "Bash(*)", type: layer === restrictiveLayer ? type : "allow" as const }
          if (layer === "session") {
            mgr.setSessionId(`phase-${type}`)
            if (rule.type === "allow") mgr.addToolRules([rule], "session")
            else if (rule.type === "deny") mgr.addSessionDenyRule("bash", { command: "git log" })
            // Explicit session asks can be represented in the same policy rule set.
            else mgr.addSessionDenyRule("bash", { command: "never-matches" })
          } else {
            const path = layer === "project grants" ? getProjectAuthorizationSettingsPath(cwd) : layer === "personal" ? getProjectLocalSettingsPath(cwd) : layer === "project" ? getProjectSettingsPath(cwd) : getGlobalSettingsPath()
            savePermissionSettings(path, { rules: [rule] })
          }
        }
        if (restrictiveLayer === "session" && type === "ask") continue // Session API creates user allows/denies, not asks.
        expect(mgr.checkPermission("bash", { command: "git log" }).decision).toBe(type)
        expect(mgr.checkPermission("bash", { command: "echo ok && git log" }).decision).toBe(type)
      }
    })
  }
  it("clears all session grants on identity change, retaining persisted project grants", () => {
    const mgr = new PermissionManager(cwd); mgr.setSessionId("first")
    mgr.addToolRules(buildToolGrantRules(request(["edit_file"]), inventory), "session")
    mgr.grantSandboxEscape("session")
    mgr.addToolRules(buildToolGrantRules(request(["read_file"], { kind: "all" }, "project"), inventory), "project")
    mgr.setSessionId("first")
    expect(mgr.checkPermission("edit_file", {}).decision).toBe("allow")
    mgr.setSessionId("restored-fork")
    expect(mgr.checkPermission("edit_file", {}).decision).toBe("ask")
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
    expect(mgr.checkPermission("read_file", {}).decision).toBe("allow")
  })
  it("persists a batch once, preserves sandbox consent, and sees revocation in existing headless instances", async () => {
    const mgr = new PermissionManager(cwd)
    mgr.grantSandboxEscape("project")
    mgr.addToolRules(buildToolGrantRules(request(["edit_file", "write_file"], { kind: "all" }, "project"), inventory), "project")
    const path = getProjectAuthorizationSettingsPath(cwd)
    expect(loadPermissionSettings(path).rules).toHaveLength(3)
    const headless = buildHeadlessApproval({ cwd, permissionMode: "default" })
    expect(await headless.onApproval("write_file", { path: "a" })).toBe(true)
    mgr.removeRule("write_file", "allow", "project-grants")
    expect(await headless.onApproval("write_file", { path: "a" })).toMatchObject({ approved: false })
    expect(mgr.checkSandboxEscape().decision).toBe("allow")
  })
  it("does not partially install a failed project batch", () => {
    const path = getProjectAuthorizationSettingsPath(cwd)
    mkdirSync(dirname(dirname(path)), { recursive: true }); writeFileSync(dirname(path), "blocked")
    const mgr = new PermissionManager(cwd)
    const rules = buildToolGrantRules(request(["edit_file", "write_file"], { kind: "all" }, "project"), inventory)
    expect(() => mgr.addToolRules(rules, "project")).toThrow()
    expect(mgr.checkPermission("edit_file", { path: "a" }).decision).toBe("ask")
    expect(mgr.getSummary()).toEqual([])
  })
  it("annotates a later deny above an earlier broad allow", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(*)", type: "allow" }, { pattern: "Bash(*)", type: "deny" }] })
    const rules = new PermissionManager(cwd).getSummaryAnnotated()[0].rules
    expect(rules[0].shadowedBy?.rule.type).toBe("deny")
    expect(rules[1].shadowedBy).toBeUndefined()
  })
})

describe("shared host policy", () => {
  for (const name of ["bash", "edit_file", "read_file", "mcp__fixture__Read"]) {
    for (const type of ["ask", "deny"] as const) {
      it(`${name} explicit ${type} overrides allowed-tools and bypass in both hosts`, async () => {
        savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: name, type }] })
        const args = name === "bash" ? { command: "echo hi" } : { path: "a" }
        const options = { mode: "bypassPermissions" as const, cwd, allowedTools: [name] }
        expect(evaluateApprovalPolicy(new PermissionManager(cwd), name, args, options).decision).toBe(type)
        let prompts = 0
        const headless = buildHeadlessApproval({ cwd, permissionMode: "bypassPermissions", allowedTools: [name], onAsk: async () => { prompts++; return true } })
        const result = await headless.onApproval(name, args)
        if (type === "deny") expect(result).toMatchObject({ approved: false })
        else expect(result).toBe(true)
        expect(prompts).toBe(type === "ask" ? 1 : 0)
      })
    }
  }
})

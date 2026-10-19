import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { getGlobalSettingsPath, getProjectAuthorizationSettingsPath, getProjectLocalSettingsPath, getProjectSettingsPath, PermissionManager, SANDBOX_ESCAPE_RULE, savePermissionSettings } from "../src/permissions.js"

let root: string, cwd: string, previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-sandbox-grants-"))
  cwd = join(root, "project")
  mkdirSync(cwd)
  previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

describe("dedicated sandbox authorization", () => {
  it("clears all session consent when the actual session changes", () => {
    const mgr = new PermissionManager(cwd)
    mgr.setSessionId("first")
    mgr.addSessionRule("bash", { command: "echo hi" })
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
    mgr.grantSandboxEscape("session")
    mgr.setSessionId("first")
    expect(mgr.checkSandboxEscape().scope).toBe("session")
    expect(new PermissionManager(cwd).checkSandboxEscape().decision).toBe("ask")
    mgr.setSessionId("second")
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
    expect(mgr.checkPermission("bash", { command: "echo hi" }).decision).toBe("ask")
  })

  it("persists owner-only project consent outside the repository and isolates directory identity", () => {
    const mgr = new PermissionManager(cwd)
    mgr.grantSandboxEscape("project")
    const path = getProjectAuthorizationSettingsPath(cwd)
    expect(path.startsWith(join(root, "data"))).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new PermissionManager(cwd).checkSandboxEscape().scope).toBe("project")
    expect(new PermissionManager(root).checkSandboxEscape().decision).toBe("ask")
    symlinkSync(cwd, join(root, "alias"))
    expect(getProjectAuthorizationSettingsPath(join(root, "alias"))).toBe(path)
    // The dedicated capability does not manufacture ordinary command rules.
    expect(mgr.checkPermission("bash", { command: "node unknown.js", dangerouslyDisableSandbox: true }).decision).toBe("ask")
  })

  it("does not accept capability grants from repository, personal, or global ordinary settings", () => {
    for (const path of [getProjectSettingsPath(cwd), getProjectLocalSettingsPath(cwd), getGlobalSettingsPath()]) {
      savePermissionSettings(path, { rules: [{ pattern: SANDBOX_ESCAPE_RULE, type: "allow" }, { pattern: "Bash(*)", type: "allow" }] })
    }
    const mgr = new PermissionManager(cwd)
    expect(mgr.checkPermission("bash", { command: "echo hi", dangerouslyDisableSandbox: true }).decision).toBe("allow")
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
  })

  it("lets trusted explicit restrictions override both consent scopes", () => {
    const mgr = new PermissionManager(cwd)
    mgr.grantSandboxEscape("session")
    for (const type of ["ask", "deny"] as const) {
      savePermissionSettings(getProjectAuthorizationSettingsPath(cwd), { rules: [
        { pattern: SANDBOX_ESCAPE_RULE, type: "allow" }, { pattern: SANDBOX_ESCAPE_RULE, type },
      ] })
      expect(mgr.checkSandboxEscape().decision).toBe(type)
    }
  })

  it("revokes each scope independently without losing command permissions", () => {
    const mgr = new PermissionManager(cwd)
    mgr.addSessionRule("bash", { command: "echo hi" })
    mgr.grantSandboxEscape("session")
    mgr.grantSandboxEscape("project")
    expect(mgr.getSummary().find(group => group.label === "project grants")?.rules).toHaveLength(1)
    expect(mgr.removeRule(SANDBOX_ESCAPE_RULE, "allow", "project-grants")).toBe("project")
    expect(mgr.checkSandboxEscape().scope).toBe("session")
    mgr.grantSandboxEscape("project")
    expect(mgr.removeRule(SANDBOX_ESCAPE_RULE, "allow", "session")).toBe("session")
    expect(mgr.checkSandboxEscape().scope).toBe("project")
    expect(mgr.checkPermission("bash", { command: "echo hi" }).decision).toBe("allow")
    mgr.removeRule(SANDBOX_ESCAPE_RULE, "allow", "project-grants")
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
  })

  it("revoking an inert repository rule cannot remove the trusted project grant", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: SANDBOX_ESCAPE_RULE, type: "allow" }] })
    const mgr = new PermissionManager(cwd)
    mgr.grantSandboxEscape("project")
    expect(mgr.removeRule(SANDBOX_ESCAPE_RULE, "allow", "project")).toBe("project")
    expect(mgr.checkSandboxEscape().decision).toBe("allow")
    expect(mgr.getSummary().some(group => group.label === "project")).toBe(false)
  })

  it("does not install a project grant if persistence fails", () => {
    const path = getProjectAuthorizationSettingsPath(cwd)
    mkdirSync(dirname(dirname(path)), { recursive: true })
    writeFileSync(dirname(path), "not a directory")
    const mgr = new PermissionManager(cwd)
    expect(() => mgr.grantSandboxEscape("project")).toThrow()
    expect(mgr.checkSandboxEscape().decision).toBe("ask")
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { getProjectSettingsPath, inferInvocationRules, PermissionManager, savePermissionSettings } from "../src/permissions.js"

let fixture: string, root: string, saved: string | undefined
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "zap-shell-paths-")))
  root = join(fixture, "workspace"); mkdirSync(root)
  saved = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = join(fixture, "data")
})
afterEach(() => {
  if (saved === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = saved
  rmSync(fixture, { recursive: true, force: true })
})
const context = () => ({ cwd: root, workspaceRoot: root, shell: { syntax: "posix" as const, filesystem: "host" as const } })
const external = () => join(fixture, "external")
function policy(args: Record<string, unknown>, mode: "default" | "bypassPermissions" = "default") {
  return evaluateApprovalPolicy(new PermissionManager(root), "bash", { command: "cat ../external", ...args },
    { mode, cwd: root, context: context(), allowedTools: ["bash"] })
}
describe("explicit shell filesystem capabilities", () => {
  it("does not turn Bash or CLI tool grants into external file grants", () => {
    savePermissionSettings(getProjectSettingsPath(root), { rules: [{ pattern: "Bash(*)", type: "allow" }] })
    expect(policy({ read_paths: [external()] }).decision).toBe("ask")
    expect(policy({ write_paths: [external()] }).decision).toBe("ask")
  })
  it("accepts an authorized Read for Bash, preserving Write and Bash denies", () => {
    savePermissionSettings(getProjectSettingsPath(root), { rules: [
      { pattern: `Read(${external()})`, type: "allow" }, { pattern: `Write(${external()})`, type: "deny" },
    ] })
    expect(policy({ read_paths: [external()] }).decision).toBe("allow")
    expect(policy({ write_paths: [external()] }, "bypassPermissions").decision).toBe("deny")
    savePermissionSettings(getProjectSettingsPath(root), { rules: [{ pattern: "Bash(*)", type: "deny" }] })
    expect(policy({ read_paths: [external()] }, "bypassPermissions").decision).toBe("deny")
  })
  it("does not grant a parent directory containing an explicitly denied descendant", () => {
    savePermissionSettings(getProjectSettingsPath(root), { rules: [
      { pattern: `Read(${external()})`, type: "allow" }, { pattern: `Read(${external()}/secret)`, type: "deny" },
    ] })
    expect(policy({ read_paths: [external()] }).decision).toBe("deny")
  })
  it("checks symlink aliases as well as targets", () => {
    mkdirSync(external()); symlinkSync(external(), join(root, "alias"), "junction")
    savePermissionSettings(getProjectSettingsPath(root), { rules: [{ pattern: "Read(alias/**)", type: "deny" }] })
    expect(policy({ read_paths: ["alias"] }).decision).toBe("deny")
  })
  it("persists the reviewed file scope separately from the command scope", () => {
    const manager = new PermissionManager(root)
    manager.setSessionId("fixture")
    const args = { command: "cat ../external", read_paths: [external()] }
    manager.addSessionRule("bash", args, context())
    const evaluate = (paths: string[]) => evaluateApprovalPolicy(manager, "bash", { ...args, read_paths: paths },
      { mode: "default", cwd: root, context: context() })
    expect(evaluate([external()]).decision).toBe("allow")
    expect(evaluate([join(fixture, "another")]).decision).toBe("ask")
  })
  it("requires custom approval to cover file paths for parsed and opaque commands", () => {
    const manager = new PermissionManager(root)
    for (const command of ["cat ../external", "cat <<'EOF'\nfixture\nEOF"]) {
      const args = { command, read_paths: [external()] }
      expect(manager.grantCoversCall([{ pattern: "Bash(*)", type: "allow" }], "bash", args, context())).toBe(false)
      const rules = inferInvocationRules("bash", args, root, context())
      expect(rules.some(rule => rule.pattern === `Read(${external()})` && rule.type === "allow")).toBe(true)
      expect(manager.grantCoversCall(rules, "bash", args, context())).toBe(true)
    }
  })
  it("reuses an existing full sandbox escape while still honoring explicit file denies", () => {
    const manager = new PermissionManager(root)
    manager.setSessionId("fixture"); manager.grantSandboxEscape("session")
    const args = { command: "cat ../external", read_paths: [external()], dangerouslyDisableSandbox: true }
    const evaluate = () => evaluateApprovalPolicy(manager, "bash", args, { mode: "default", cwd: root, context: context() })
    expect(evaluate().decision).toBe("allow")
    savePermissionSettings(getProjectSettingsPath(root), { rules: [{ pattern: `Read(${external()})`, type: "deny" }] })
    expect(evaluate().decision).toBe("deny")
  })
})

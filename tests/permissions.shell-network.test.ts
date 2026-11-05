import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHeadlessApproval } from "../src/headless/approval.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { getProjectAuthorizationSettingsPath, getProjectSettingsPath, inferInvocationRules, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { DEFAULT_ALLOWED_DOMAINS } from "../zapsdk/execution/network-proxy.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-shell-network-"))
  cwd = join(root, "project")
  mkdirSync(cwd)
  previousDataDir = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

// Policy subjects only: no command runs and no request is sent.
const context = { cwd: "", workspaceRoot: "", shell: { syntax: "posix" as const, filesystem: "host" as const } }
const policy = { allowedDomains: [...DEFAULT_ALLOWED_DOMAINS], deniedDomains: ["*.blocked.example"] }
function sandboxed() {
  const manager = new PermissionManager(cwd)
  manager.setSandboxConfined(true)
  manager.setSandboxNetworkPolicy(policy)
  return manager
}
const curl = (...hosts: string[]) => ({ command: "curl -s https://api.example.com/v1", network_destinations: hosts })
const decide = (manager: PermissionManager, args: Record<string, unknown>, mode: "default" | "bypassPermissions" = "default") =>
  evaluateApprovalPolicy(manager, "bash", args, { cwd, mode, context: { ...context, cwd, workspaceRoot: cwd } })

describe("declared shell network destinations", () => {
  it("asks once per host beyond the allowlist and remembers it as a capability", () => {
    const manager = sandboxed()
    expect(decide(manager, curl())).toMatchObject({ decision: "allow" })
    expect(decide(manager, curl("github.com", "*.npmjs.org"))).toMatchObject({ decision: "allow" })
    expect(decide(manager, curl("https://api.example.com/v1"))).toMatchObject({
      decision: "ask", allowScope: true, reason: "Shell network access requires authorization: api.example.com" })
    const rules = inferInvocationRules("bash", curl("https://api.example.com/v1"), cwd).map(rule => rule.pattern)
    expect(rules).toContain("Capability(net.write:api.example.com)")
    manager.addSessionRule("bash", curl("https://api.example.com/v1"), { ...context, cwd, workspaceRoot: cwd })
    expect(decide(manager, { command: "wget -q https://api.example.com/x", network_destinations: ["api.example.com"] }).decision).toBe("allow")
    expect(decide(manager, curl("other.example.com")).decision).toBe("ask")
  })

  it("never admits a denied domain, even under bypass", () => {
    const manager = sandboxed()
    expect(decide(manager, curl("x.blocked.example"), "bypassPermissions")).toMatchObject({ decision: "deny" })
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Capability(net.read:*.evil.example)", type: "deny" }] })
    expect(decide(sandboxed(), curl("a.evil.example"), "bypassPermissions").decision).toBe("deny")
  })

  it("keeps an explicit ask rule one-time", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Capability(net.read:api.example.com)", type: "ask" }] })
    expect(decide(sandboxed(), curl("api.example.com"))).toMatchObject({ decision: "ask", allowScope: false })
  })

  it("does not apply outside the sandbox or where egress is not filtered", () => {
    const manager = sandboxed()
    expect(manager.checkShellNetwork({ ...curl("api.example.com"), dangerouslyDisableSandbox: true }).decision).toBe("allow")
    const open = new PermissionManager(cwd)
    open.setSandboxConfined(true)
    open.setSandboxNetworkPolicy(undefined)
    expect(decide(open, curl("api.example.com")).decision).toBe("allow")
  })

  it("requires a custom grant to cover the declared host", () => {
    const manager = sandboxed()
    const args = curl("api.example.com")
    expect(manager.grantCoversCall([{ pattern: "bash", type: "allow" }], "bash", args)).toBe(false)
    expect(manager.grantCoversCall([{ pattern: "bash", type: "allow" }, { pattern: "Capability(net.write:*.example.com)", type: "allow" }], "bash", args)).toBe(true)
  })

  it("decides the same way in headless runs", async () => {
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default" })
    approval.setSandboxConfined(true)
    approval.setSandboxNetworkPolicy(policy)
    expect(await approval.onApproval("bash", curl("github.com"))).toBe(true)
    expect(await approval.onApproval("bash", curl("api.example.com"))).toMatchObject({ approved: false })
    // A repository settings file cannot widen egress; the user's own grants can.
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Capability(net.write:api.example.com)", type: "allow" }] })
    expect(await approval.onApproval("bash", curl("api.example.com"))).toMatchObject({ approved: false })
    savePermissionSettings(getProjectAuthorizationSettingsPath(cwd), { rules: [{ pattern: "Capability(net.write:api.example.com)", type: "allow" }] })
    expect(await approval.onApproval("bash", curl("api.example.com"))).toBe(true)
  })

  it("never counts a read-only host grant as shell egress", () => {
    const manager = sandboxed()
    manager.addToolRules([{ pattern: "Capability(net.read:api.example.com)", type: "allow" }], "session")
    expect(decide(manager, curl("api.example.com")).decision).toBe("ask")
  })
})

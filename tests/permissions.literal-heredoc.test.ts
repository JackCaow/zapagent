import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHeadlessApproval } from "../src/headless/approval.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { getProjectSettingsPath, inferInvocationRules, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { requiresShellReview, splitShellSubcommands } from "../zapsdk/utils/shell.js"

let root: string, cwd: string, previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-literal-heredoc-")); cwd = join(root, "workspace"); mkdirSync(cwd)
  previous = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})
const context = () => ({ cwd, workspaceRoot: cwd, shell: { syntax: "posix" as const, filesystem: "host" as const } })
const document = "cat > _probe.html <<'EOF'\n<!doctype html><script>render(0)</script>\ngit push\n$(printf literal)\nEOF"

const payloads = [
  document,
  "python3 <<'END'\nprint('fixture')\nEND",
  "sh <<'END'\nprintf fixture\nEND",
  "custom-interpreter <<'END'\nfixture-data\nEND",
  "cat >file <<END\n$(printf fixture)\nEND",
  "for item in one two; do printf '%s' \"$item\"; done",
  "printf '%s' \"$(printf fixture)\"",
]

describe("opaque execution capability (no consumer whitelist)", () => {
  for (const command of payloads) {
    it(`offers an explicit whole-tool grant: ${JSON.stringify(command)}`, () => {
      const manager = new PermissionManager(cwd)
      expect(evaluateApprovalPolicy(manager, "bash", { command }, { cwd, mode: "default", context: context() }))
        .toMatchObject({ decision: "ask", allowScope: true })
      expect(inferInvocationRules("bash", { command }, cwd, context())).toEqual([{ pattern: "bash", type: "allow" }])
      expect(manager.grantCoversCall([{ pattern: "Bash(cat:*)", type: "allow" }], "bash", { command }, context())).toBe(false)
    })
    for (const lifetime of ["session", "project"] as const) {
      it(`reuses ${lifetime} consent across consumers: ${JSON.stringify(command)}`, () => {
        const manager = new PermissionManager(cwd)
        manager.setSessionId("fixture")
        if (lifetime === "session") manager.addSessionRule("bash", { command: document }, context())
        else manager.addProjectRule("bash", { command: document }, context())
        const active = lifetime === "project" ? new PermissionManager(cwd) : manager
        expect(evaluateApprovalPolicy(active, "bash", { command }, { cwd, mode: "default", context: context() }).decision).toBe("allow")
      })
    }
  }
  it("does not project a heredoc body into executable commands", () => {
    expect(splitShellSubcommands(document, "posix")).toEqual([document])
    expect(requiresShellReview(document, "posix")).toBe(true)
  })
  it("inherits sandbox confinement", () => {
    const manager = new PermissionManager(cwd); manager.setSandboxConfined(true)
    for (const command of payloads) expect(evaluateApprovalPolicy(manager, "bash", { command }, { cwd, mode: "default", context: context() }).decision).toBe("allow")
  })
  for (const type of ["deny", "ask"] as const) {
    it(`preserves directly matched ${type}`, () => {
      savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(cat:*)", type }] })
      const manager = new PermissionManager(cwd); manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
      expect(evaluateApprovalPolicy(manager, "bash", { command: document }, { cwd, mode: "bypassPermissions", context: context() })).toMatchObject({ decision: type, allowScope: false })
    })
    it(`cannot silently bypass an unresolved ${type} restriction`, () => {
      savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(git push:*)", type }] })
      const manager = new PermissionManager(cwd); manager.setSandboxConfined(true); manager.grantSandboxEscape("session")
      manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
      for (const command of payloads) expect(evaluateApprovalPolicy(manager, "bash", { command, dangerouslyDisableSandbox: true }, {
        cwd, mode: "bypassPermissions", allowedTools: ["bash"], context: context(),
      })).toMatchObject({ decision: "ask", allowScope: false, reason: `cannot verify command restriction Bash(git push:*) for opaque shell input` })
    })
  }
  it("headless uses identical scope semantics", async () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(cat:*)", type: "allow" }] })
    const headless = buildHeadlessApproval({ cwd, permissionMode: "default" })
    expect(await headless.onApproval("bash", { command: document }, undefined, context())).toMatchObject({ approved: false })
    const manager = new PermissionManager(cwd); manager.addToolRules([{ pattern: "bash", type: "allow" }], "project")
    for (const command of payloads) expect(await headless.onApproval("bash", { command }, undefined, context())).toBe(true)
  })
  for (const syntax of ["cmd", "unknown"] as const) {
    it(`requires whole-tool scope for ${syntax}`, () => {
      const ctx = { ...context(), shell: { syntax, filesystem: "host" as const } }
      const manager = new PermissionManager(cwd)
      manager.addToolRules([{ pattern: "Bash(echo:*)", type: "allow" }], "session")
      expect(evaluateApprovalPolicy(manager, "bash", { command: "echo fixture" }, { cwd, mode: "default", context: ctx })).toMatchObject({ decision: "ask", allowScope: true })
      manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
      expect(evaluateApprovalPolicy(manager, "bash", { command: "echo fixture" }, { cwd, mode: "default", context: ctx }).decision).toBe("allow")
    })
  }
  it("retains dangerous-operation gates", () => {
    const manager = new PermissionManager(cwd); manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
    expect(evaluateApprovalPolicy(manager, "bash", { command: "cat <<'EOF'\nrm -rf /\nEOF" }, { cwd, mode: "default", context: context() })).toMatchObject({ decision: "ask", source: "dangerous", allowScope: false })
  })
})

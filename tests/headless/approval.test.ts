import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildHeadlessApproval } from "../../src/headless/approval.js"
import { getProjectAuthorizationSettingsPath, getProjectSettingsPath, SANDBOX_ESCAPE_RULE, PermissionManager, savePermissionSettings } from "../../src/permissions.js"

function makeTmpDir(prefix = "zapcode-headless-approval"): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("buildHeadlessApproval path reads", () => {
  let dataDir = ""
  let cwd = ""
  let outside = ""
  let dataDirBackup: string | undefined

  beforeAll(() => {
    dataDirBackup = process.env.ZAPCODE_DATA_DIR
    dataDir = makeTmpDir("zapcode-headless-approval-data")
    process.env.ZAPCODE_DATA_DIR = dataDir
  })

  afterAll(() => {
    if (dataDirBackup === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = dataDirBackup
    rmSync(dataDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    cwd = makeTmpDir()
    outside = makeTmpDir("zapcode-headless-approval-outside")
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it("allows path reads inside cwd without a saved rule", async () => {
    const decisions: Array<{ tool: string; decision: string; reason: string }> = []
    const approval = buildHeadlessApproval({
      cwd,
      permissionMode: "default",
      onDecision: (tool, decision, reason) => decisions.push({ tool, decision, reason }),
    })

    await expect(approval.onApproval("read_file", { path: "src/index.ts" })).resolves.toBe(true)
    expect(approval.anyDenied()).toBe(false)
    expect(decisions).toEqual([
      { tool: "read_file", decision: "allow", reason: "project path read" },
    ])
  })

  it("host approval cannot bypass plan, explicit deny, or dangerous commands", async () => {
    let asks = 0
    const onAsk = async () => { asks++; return true }
    expect(await buildHeadlessApproval({ cwd, permissionMode: "plan", onAsk }).onApproval("write_file", {})).toEqual({ approved: false, source: "policy", reason: "plan-mode is read-only" })
    expect(await buildHeadlessApproval({ cwd, permissionMode: "plan", onAsk }).onApproval("mcp__external__write", {})).toMatchObject({ approved: false, source: "policy" })
    expect(await buildHeadlessApproval({ cwd, permissionMode: "default", disallowedTools: ["write_file"], onAsk }).onApproval("write_file", {})).toMatchObject({ approved: false, source: "policy" })
    expect(await buildHeadlessApproval({ cwd, permissionMode: "default", onAsk }).onApproval("bash", { command: "rm -rf /" })).toMatchObject({ approved: false, source: "policy" })
    expect(asks).toBe(0)
  })

  it("checks dangerous operations inside structured steps before bypass or host approval", async () => {
    let asks = 0
    const approval = buildHeadlessApproval({ cwd, permissionMode: "bypassPermissions",
      onAsk: async () => { asks++; return true } })
    const result = await approval.onApproval("bash", { command: "(sudo true) && (printf done)",
      check_steps: ["sudo true", "printf done"] })
    expect(result).toMatchObject({ approved: false, source: "policy", reason: "dangerous bash (sudo_elevation)" })
    expect(asks).toBe(0)
  })

  it("keeps a later compound deny ahead of bypass and host approval", async () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [
      { pattern: "Bash(blocked-tool:*)", type: "deny" },
    ] })
    let asks = 0
    for (const permissionMode of ["default", "bypassPermissions"] as const) {
      const approval = buildHeadlessApproval({ cwd, permissionMode,
        onAsk: async () => { asks++; return true } })
      for (const dangerouslyDisableSandbox of [false, true]) {
        const result = await approval.onApproval("bash", {
          command: "unknown-tool && blocked-tool payload", dangerouslyDisableSandbox,
        })
        expect(result).toMatchObject({ approved: false, source: "policy", reason: "matched deny rule Bash(blocked-tool:*)" })
      }
    }
    expect(asks).toBe(0)
  })

  it("rechecks mode and cancellation after a pending host decision", async () => {
    let mode: "default" | "plan" = "default"
    const controller = new AbortController()
    const approval = buildHeadlessApproval({ cwd, get permissionMode() { return mode },
      onAsk: async () => { mode = "plan"; return true } })
    expect(await approval.onApproval("write_file", {})).toMatchObject({ approved: false, source: "policy" })
    const cancelled = buildHeadlessApproval({ cwd, permissionMode: "default",
      onAsk: async () => { controller.abort(); return true } })
    expect(await cancelled.onApproval("write_file", {}, controller.signal)).toMatchObject({ approved: false, reason: "approval cancelled" })
  })

  it("plan hard-denies persistent and external writes before saved or explicit grants", async () => {
    let asks = 0
    const tools = ["memory_save", "memory_review", "memory_merge", "cron_create", "cron_delete",
      "monitor", "task_stop", "http_request", "delegate_agent"]
    const mgr = new PermissionManager(cwd)
    for (const name of tools) mgr.addProjectRule(name, {})
    const approval = buildHeadlessApproval({ cwd, permissionMode: "plan", allowedTools: tools,
      onAsk: async () => { asks++; return true } })
    const saved = buildHeadlessApproval({ cwd, permissionMode: "plan", onAsk: async () => { asks++; return true } })
    for (const name of tools) {
      expect(await approval.onApproval(name, {})).toMatchObject({ approved: false, source: "policy" })
      expect(await saved.onApproval(name, {})).toMatchObject({ approved: false, source: "policy" })
    }
    expect(asks).toBe(0)
  })

  it("denies path reads outside cwd by default", async () => {
    const denied: Array<{ tool: string; reason: string }> = []
    const approval = buildHeadlessApproval({
      cwd,
      permissionMode: "default",
      onDeny: (tool, reason) => denied.push({ tool, reason }),
    })

    await expect(approval.onApproval("list_tree", { path: outside })).resolves.toMatchObject({ approved: false, source: "policy" })
    expect(approval.anyDenied()).toBe(true)
    expect(denied[0]?.tool).toBe("list_tree")
    expect(denied[0]?.reason).toContain("path outside cwd:")
  })

  it("keeps outside path reads denied even in bypassPermissions mode", async () => {
    const approval = buildHeadlessApproval({
      cwd,
      permissionMode: "bypassPermissions",
    })

    await expect(approval.onApproval("list_tree", { path: outside })).resolves.toMatchObject({ approved: false, source: "policy" })
    expect(approval.anyDenied()).toBe(true)
  })

  it("--allowed-tools explicitly allows outside path reads", async () => {
    const approval = buildHeadlessApproval({
      cwd,
      permissionMode: "default",
      allowedTools: ["read_file"],
    })

    await expect(approval.onApproval("read_file", { path: join(outside, "notes.txt") })).resolves.toBe(true)
    expect(approval.anyDenied()).toBe(false)
  })

  it("preserves a host's structured denial instead of treating its object as approval", async () => {
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default",
      onAsk: async () => ({ approved: false, source: "approval", reason: "user declined approval" }) })
    expect(await approval.onApproval("write_file", {})).toEqual({ approved: false, source: "approval", reason: "user declined approval" })
    expect(approval.anyDenied()).toBe(true)
  })
})

describe("buildHeadlessApproval sandbox escape", () => {
  const cwd = process.cwd()
  const escape = { command: "npm install", dangerouslyDisableSandbox: true }

  it("is not granted by allow lists or acceptEdits", async () => {
    const approval = buildHeadlessApproval({ cwd, permissionMode: "acceptEdits", allowedTools: ["bash"] })
    expect(await approval.onApproval("bash", escape)).toMatchObject({ approved: false })
    expect(await approval.onApproval("bash", { command: "echo ok" })).toBe(true)
  })

  it("is granted under bypassPermissions", async () => {
    const approval = buildHeadlessApproval({ cwd, permissionMode: "bypassPermissions" })
    expect(await approval.onApproval("bash", escape)).toBe(true)
  })

  it("defers to the host prompt when one exists", async () => {
    const asked: string[] = []
    const approval = buildHeadlessApproval({
      cwd, permissionMode: "default", allowedTools: ["bash"],
      onAsk: async (name) => { asked.push(name); return true },
    })
    expect(await approval.onApproval("bash", escape)).toBe(true)
    expect(asked).toEqual(["bash"])
  })
})

describe("buildHeadlessApproval sandbox escape vs deny rules", () => {
  it("a saved deny rule wins over bypassPermissions", async () => {
    const dir = makeTmpDir("zapcode-escape-deny")
    const data = makeTmpDir("zapcode-escape-deny-data")
    const backup = process.env.ZAPCODE_DATA_DIR
    process.env.ZAPCODE_DATA_DIR = data
    try {
      new PermissionManager(dir).addProjectDenyRule("bash", { command: "rm -rf build" })
      const approval = buildHeadlessApproval({ cwd: dir, permissionMode: "bypassPermissions" })
      expect(await approval.onApproval("bash", { command: "rm -rf build", dangerouslyDisableSandbox: true }))
        .toMatchObject({ approved: false })
    } finally {
      if (backup === undefined) delete process.env.ZAPCODE_DATA_DIR
      else process.env.ZAPCODE_DATA_DIR = backup
      rmSync(dir, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })
})


describe("headless project sandbox consent", () => {
  it("reuses trusted consent while preserving ask, deny, plan, dangerous and disallow gates", async () => {
    const root = makeTmpDir("zap-project-consent")
    const previous = process.env.ZAPCODE_DATA_DIR
    process.env.ZAPCODE_DATA_DIR = join(root, "data")
    try {
      new PermissionManager(root).grantSandboxEscape("project")
      const args = { command: "printf hi", dangerouslyDisableSandbox: true }
      const approval = buildHeadlessApproval({ cwd: root, permissionMode: "default" })
      expect(await approval.onApproval("bash", args)).toBe(true)
      expect(await approval.onApproval("bash", { ...args, command: "echo other" })).toBe(true)
      for (const permissionMode of ["plan"] as const) {
        expect(await buildHeadlessApproval({ cwd: root, permissionMode }).onApproval("bash", args)).toMatchObject({ approved: false })
      }
      expect(await buildHeadlessApproval({ cwd: root, permissionMode: "default", disallowedTools: ["bash"] }).onApproval("bash", args)).toMatchObject({ approved: false })
      expect(await approval.onApproval("bash", { ...args, command: "rm -rf /" })).toMatchObject({ approved: false })
      for (const type of ["ask", "deny"] as const) {
        savePermissionSettings(getProjectSettingsPath(root), { rules: [{ pattern: "Bash(*)", type }] })
        const restricted = buildHeadlessApproval({ cwd: root, permissionMode: "bypassPermissions" })
        expect(await restricted.onApproval("bash", args)).toMatchObject({ approved: false })
      }
      savePermissionSettings(getProjectSettingsPath(root), { rules: [] })
      savePermissionSettings(getProjectAuthorizationSettingsPath(root), { rules: [{ pattern: SANDBOX_ESCAPE_RULE, type: "ask" }] })
      let received: unknown
      const context = { cwd: root, workspaceRoot: root, shell: { syntax: "posix" as const, filesystem: "host" as const } }
      const interactive = buildHeadlessApproval({ cwd: root, permissionMode: "bypassPermissions", onAsk: async (_n, _a, _s, value) => { received = value; return true } })
      expect(await interactive.onApproval("bash", args, undefined, context)).toBe(true)
      expect(received).toEqual(context)
    } finally {
      if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
      else process.env.ZAPCODE_DATA_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})

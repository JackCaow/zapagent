import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { WorkspaceAccess } from "../src/workspace-access.js"
import { getProjectAuthorizationSettingsPath, getProjectSettingsPath, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { parseCommand } from "../src/commands.js"

let root: string, project: string, previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-workspace-access-"))
  project = join(root, "project")
  mkdirSync(project)
  previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(root, "state")
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

it("allows ordinary Auto follow-ups and only grants live child actors the active project's permissions", () => {
  expect(parseCommand("/work")).toMatchObject({ type: "run_skill" })
  const access = new WorkspaceAccess(project)
  for (const run of ["first", "follow-up"]) {
    const scope = access.begin("a", run, "auto", { kind: "user" })
    expect(scope.mode).toBe("acceptEdits")
    expect(access.mode("plan", "a", run)).toBe("plan")
    expect(access.mode("auto", "a", "stale")).toBe("plan")
    expect(access.mode("auto", "different-session", run)).toBe("plan")
    scope.assertActive()
    access.end(run)
    expect(scope.assertActive).toThrow("no longer")
  }
  expect(access.remembered()).toBe(false)
})

it("continues an owned Auto task once and refuses unknown, cancelled, or revoked task authority", () => {
  const access = new WorkspaceAccess(project)
  const signal = new AbortController()
  const cancelled = new AbortController()
  access.begin("a", "start", "auto", { kind: "user" })
  access.rememberTask("known", "a", signal.signal)
  access.rememberTask("cancelled", "a", cancelled.signal)
  access.rememberTask("revoked", "a", signal.signal)
  access.end("start")
  cancelled.abort()
  const resume = (session: string, ids: string[]) => {
    const scope = access.begin(session, "resume", "auto", { kind: "task", ids })
    const mode = scope.mode
    access.end("resume")
    return mode
  }
  expect(resume("b", ["known"])).toBe("plan")
  expect(resume("a", ["known", "missing"])).toBe("plan")
  expect(resume("a", ["cancelled"])).toBe("plan")
  expect(resume("a", ["known"])).toBe("acceptEdits")
  access.consumeTasks(["known"])
  expect(resume("a", ["known"])).toBe("plan")
  access.choose("revoke", "a")
  expect(resume("a", ["revoked"])).toBe("plan")
  expect(access.begin("a", "manual", "default", { kind: "task", ids: ["revoked"] }).mode).toBe("plan")
})

it("keeps Manual one-time approvals independent of a saved project grant", () => {
  const access = new WorkspaceAccess(project)
  const manager = new PermissionManager(project)
  access.choose("project", "a")
  const run = access.begin("a", "manual", "default", { kind: "user" })
  const options = { mode: run.mode, cwd: project, hostCommands: "trusted" as const }
  expect(access.canRunHostCommands("a", "manual")).toBe(true)
  expect(evaluateApprovalPolicy(manager, "read_file", { path: "src/main.ts" }, options).decision).toBe("allow")
  expect(evaluateApprovalPolicy(manager, "edit_file", { path: "src/main.ts" }, options)).toMatchObject({ decision: "ask", allowScope: false })
  expect(evaluateApprovalPolicy(manager, "bash", { command: "bun test" }, options)).toMatchObject({ decision: "ask", allowScope: false })
})

it("requires fresh consent before allowing commands with host permissions", () => {
  const access = new WorkspaceAccess(project)
  access.choose("project", "a")
  const record = join(dirname(getProjectAuthorizationSettingsPath(project)), "workspace-access.json")
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), version: 1, capability: "workspace-work" }))
  const scope = access.begin("a", "run", "auto", { kind: "user" })
  expect(scope.mode).toBe("acceptEdits")
  expect(access.canRunHostCommands("a", "run")).toBe(false)
  access.choose("project", "a")
  expect(access.canRunHostCommands("a", "run")).toBe(true)
  expect(access.canRunHostCommands("a", "other")).toBe(false)
  access.choose("revoke", "a")
  expect(access.canRunHostCommands("a", "run")).toBe(false)
})

it("validates project identity on restart and does not follow a grant to a replacement checkout", () => {
  const access = new WorkspaceAccess(project)
  access.choose("project", "a")
  const alias = join(root, "alias")
  symlinkSync(project, alias)
  expect(new WorkspaceAccess(alias).remembered()).toBe(true)
  renameSync(project, join(root, "old"))
  mkdirSync(project)
  expect(new WorkspaceAccess(project).remembered()).toBe(false)
  process.env.ZAPCODE_DATA_DIR = join(project, ".zapcode")
  const insecure = new WorkspaceAccess(project)
  expect(() => insecure.choose("project", "a")).toThrow("outside the workspace")
  expect(insecure.remembered()).toBe(false)
})

it("revokes active and future work and asks about an edit beyond the assigned workspace", () => {
  const access = new WorkspaceAccess(project)
  access.choose("project", "a")
  access.begin("a", "notification", "default", { kind: "task", ids: [] })
  expect(access.mode("default", "a")).toBe("plan")
  access.end("notification")
  access.begin("a", "run", "auto", { kind: "user" })
  const mode = access.mode("auto", "a")
  const manager = new PermissionManager(project)
  for (const [path, decision] of [["src/main.ts", "allow"], [join(root, "other"), "ask"]]) {
    expect(evaluateApprovalPolicy(manager, "edit_file", { path }, { mode, cwd: project }).decision).toBe(decision)
  }
  const publishing = evaluateApprovalPolicy(manager, "bash", { command: "git status && git push origin topic" }, { mode, cwd: project })
  expect(publishing.decision).toBe("ask")
  access.choose("revoke", "a")
  expect(access.mode("default", "a")).toBe("plan")
  expect(new WorkspaceAccess(project).remembered()).toBe(false)
})

it("reuses user command rules without letting the checkout or project access authorize a shell", () => {
  const manager = new PermissionManager(project)
  const context = { cwd: project, workspaceRoot: project, shell: { syntax: "posix", filesystem: "host" } } as const
  savePermissionSettings(getProjectSettingsPath(project), { rules: [{ type: "allow", pattern: "Bash(*)" }] })
  const decide = (command: string, hostCommands: "trusted" | "untrusted" = "trusted", mode: "acceptEdits" | "bypassPermissions" = "acceptEdits") =>
    evaluateApprovalPolicy(manager, "bash", { command }, { mode, cwd: project, context, hostCommands }).decision
  expect(decide("sh ./publish.sh")).toBe("ask")
  expect(decide("sh ./publish.sh", "trusted", "bypassPermissions")).toBe("ask")
  manager.addProjectRule("bash", { command: "sh ./check.sh" }, context, true)
  expect(decide("sh ./check.sh")).toBe("allow")
  expect(decide("sh ./check.sh && sh ./publish.sh")).toBe("ask")
  expect(decide("sh ./check.sh other-script")).toBe("ask")
  expect(decide("sh ./check.sh", "untrusted")).toBe("ask")
  manager.addToolRules([{ type: "allow", pattern: "bash(printf fixture)" }], "project")
  expect(decide("printf fixture")).toBe("allow")
  const forwarded = evaluateApprovalPolicy(manager, "bash", { command: "printf fixture" }, {
    mode: "acceptEdits", cwd: project, hostCommands: "trusted", context: { ...context, authorization: {
      readOnly: false, editOnly: false, sandboxEscape: false, workspaceShell: false, shellCommands: ["printf fixture"],
    } },
  })
  expect(forwarded).toMatchObject({ decision: "ask", allowScope: false })
  savePermissionSettings(getProjectSettingsPath(project), { rules: [{ type: "deny", pattern: "Bash(sh ./check.sh:*)" }] })
  expect(decide("sh ./check.sh")).toBe("deny")
})

it("stops a project-authorized task when another host forgets the project", async () => {
  const first = new WorkspaceAccess(project), second = new WorkspaceAccess(project)
  first.choose("project", "one")
  let onRevoked!: () => void
  const revoked = new Promise<void>(resolve => { onRevoked = resolve })
  const unwatch = second.watchProject(() => "two", onRevoked)
  const scope = second.begin("two", "run", "auto", { kind: "user" })
  try {
    expect(second.mode("auto", "two")).toBe("acceptEdits")
    scope.assertActive()
    first.choose("revoke", "one")
    expect(scope.assertActive).toThrow("no longer")
    await revoked
    expect(second.mode("auto", "two")).toBe("plan")
  } finally { unwatch(); second.end("run") }
})

it("does not transfer revoked authority when another window immediately reauthorizes the project", async () => {
  const first = new WorkspaceAccess(project), second = new WorkspaceAccess(project)
  first.choose("project", "one")
  let onRevoked!: () => void
  const revoked = new Promise<void>(resolve => { onRevoked = resolve })
  const unwatch = second.watchProject(() => "two", onRevoked)
  const scope = second.begin("two", "old", "auto", { kind: "user" })
  second.rememberTask("background", "two", new AbortController().signal)
  try {
    first.choose("revoke", "one")
    first.choose("project", "one")
    expect(first.remembered()).toBe(true)
    expect(second.canRunHostCommands("two", "old")).toBe(false)
    expect(scope.assertActive).toThrow("no longer")
    await revoked
    expect(scope.signal.aborted).toBe(true)
  } finally { unwatch(); second.end("old") }
  const continuation = second.begin("two", "continuation", "auto", { kind: "task", ids: ["background"] })
  expect(continuation.mode).toBe("plan")
  second.end("continuation")
  expect(second.begin("two", "new", "auto", { kind: "user" }).mode).toBe("acceptEdits")
})

it("binds external approval to the host actor and discards an answer after revocation", async () => {
  const access = new WorkspaceAccess(project)
  const scope = access.begin("a", "first", "auto", { kind: "user" })
  let resolveApproval!: (allow: boolean) => void
  const approve = scope.bindApproval(async (_name, _args, signal, context) => {
    expect(context?.actor).toEqual(scope.actor)
    expect(context?.workspaceRoot).toBe(realpathSync(project))
    expect(signal?.aborted).toBe(false)
    return new Promise(resolve => { resolveApproval = resolve })
  })
  const pending = approve("write_file", { path: "artifact" })
  access.choose("revoke", "a")
  expect(scope.signal.aborted).toBe(true)
  access.end("first")
  access.begin("a", "second", "auto", { kind: "user" })
  resolveApproval(true)
  expect(await pending).toMatchObject({ approved: false, source: "policy" })
  expect(approve.precheck?.("write_file", {})).toMatchObject({ approved: false, source: "policy" })
})

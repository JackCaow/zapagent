import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { WorkspaceAccess } from "../src/workspace-access.js"
import { getProjectAuthorizationSettingsPath, PermissionManager } from "../src/permissions.js"
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
  expect(access.begin("a", "manual", "acceptEdits", { kind: "task", ids: ["revoked"] }).mode).toBe("plan")
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
  access.begin("a", "run", "default", { kind: "user" })
  const mode = access.mode("default", "a")
  const manager = new PermissionManager(project)
  for (const [path, decision] of [["src/main.ts", "allow"], [join(root, "other"), "ask"]]) {
    expect(evaluateApprovalPolicy(manager, "edit_file", { path }, { mode, cwd: project }).decision).toBe(decision)
  }
  const publishing = evaluateApprovalPolicy(manager, "bash", { command: "git status && git push origin topic" }, { mode, cwd: project })
  expect(publishing.decision).toBe("ask")
  expect(publishing.allowScope).toBe(false)
  access.choose("revoke", "a")
  expect(access.mode("default", "a")).toBe("plan")
  expect(new WorkspaceAccess(project).remembered()).toBe(false)
})

it("stops a project-authorized task when another host forgets the project", async () => {
  const first = new WorkspaceAccess(project), second = new WorkspaceAccess(project)
  first.choose("project", "one")
  let onRevoked!: () => void
  const revoked = new Promise<void>(resolve => { onRevoked = resolve })
  const unwatch = second.watchProject(() => "two", onRevoked)
  const scope = second.begin("two", "run", "default", { kind: "user" })
  try {
    expect(second.mode("default", "two")).toBe("acceptEdits")
    scope.assertActive()
    first.choose("revoke", "one")
    expect(scope.assertActive).toThrow("no longer")
    await revoked
    expect(second.mode("default", "two")).toBe("plan")
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

import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceAccess } from "../src/workspace-access.js"
import { PermissionManager } from "../src/permissions.js"
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
    access.begin("a", run, "auto", { kind: "user" })
    expect(access.mode("auto", "a", run)).toBe("acceptEdits")
    expect(access.mode("plan", "a", run)).toBe("plan")
    expect(access.mode("auto", "a", "stale")).toBe("plan")
    expect(access.mode("auto", "different-session", run)).toBe("plan")
    access.assertProjectCommandAllowed("auto", "a", run)
    access.end(run)
    expect(() => access.assertProjectCommandAllowed("auto", "a", run)).toThrow("no longer")
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
    access.begin(session, "resume", "auto", { kind: "task", ids })
    const mode = access.mode("auto", session, "resume")
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
  const revoked = new Promise<void>(resolve => second.begin("two", "run", "default", { kind: "user" }, resolve))
  try {
    expect(second.mode("default", "two")).toBe("acceptEdits")
    second.assertProjectCommandAllowed("default", "two", "run")
    first.choose("revoke", "one")
    expect(() => second.assertProjectCommandAllowed("default", "two", "run")).toThrow("no longer")
    await revoked
    expect(second.mode("default", "two")).toBe("plan")
  } finally { second.end("run") }
})

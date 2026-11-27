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

it("binds an approved task to the matching foreground submission and releases it on completion", () => {
  expect(parseCommand("/work fix parser")).toEqual({ type: "open_workspace_access", value: "fix parser" })
  const access = new WorkspaceAccess(project)
  access.choose("task", "a", "fix parser")
  access.bindSubmission("a", "selected", "fix parser", "fix parser")
  for (const [id, visible, task] of [["background", false, "fix parser"], ["queued", true, "fix parser"]] as const) {
    access.begin("a", id, visible, task, id)
    expect(access.mode("default", "a")).toBe("plan")
    access.end(id)
  }
  access.begin("a", "work", true, "fix parser", "selected")
  expect(access.mode("default", "a")).toBe("acceptEdits")
  expect(access.mode("plan", "a")).toBe("plan")
  expect(access.mode("default", "different-session")).toBe("plan")
  access.end("old-run")
  expect(access.mode("default", "a")).toBe("acceptEdits")
  expect(access.mode("acceptEdits", "a", "unrelated-run")).toBe("plan")
  access.end("work")
  access.approvePlan("a")
  access.begin("a", "follow-up", true, "")
  expect(access.mode("default", "a")).toBe("plan")
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
  access.begin("a", "notification", false, "")
  expect(access.mode("default", "a")).toBe("plan")
  access.end("notification")
  access.begin("a", "run", true, "")
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
  const revoked = new Promise<void>(resolve => second.begin("two", "run", true, "task", undefined, resolve))
  try {
    expect(second.mode("default", "two")).toBe("acceptEdits")
    second.assertProjectCommandAllowed("default", "two", "run")
    first.choose("revoke", "one")
    expect(() => second.assertProjectCommandAllowed("default", "two", "run")).toThrow("no longer")
    await revoked
    expect(second.mode("default", "two")).toBe("plan")
  } finally { second.end("run") }
})

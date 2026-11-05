import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { PermissionManager } from "../src/permissions.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-turn-denials-"))
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

// Policy subjects only: nothing runs.
const context = () => ({ cwd, workspaceRoot: cwd, shell: { syntax: "posix" as const, filesystem: "host" as const } })
const decide = (manager: PermissionManager, name: string, args: Record<string, unknown>) =>
  evaluateApprovalPolicy(manager, name, args, { cwd, mode: "default", context: context() })

describe("requests declined this turn", () => {
  it("are refused without a prompt when they ask for nothing new", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(false)
    expect(decide(manager, "bash", { command: "git push origin feature" }).decision).toBe("ask")
    manager.recordDenial("bash", { command: "git push origin feature" }, context())
    const repeat = decide(manager, "bash", { command: "git push --tags" })
    expect(repeat.decision).toBe("deny")
    expect(repeat.reason).toContain("declined this request earlier in this turn")
    // A request needing something else still asks.
    expect(decide(manager, "bash", { command: "git push origin feature && npm publish" }).decision).toBe("ask")
    expect(decide(manager, "bash", { command: "npm test" }).decision).toBe("ask")
  })

  it("pin the exact arguments when consent would cover a whole tool", () => {
    const manager = new PermissionManager(cwd)
    manager.recordDenial("mcp__tracker__create", { title: "first" }, context())
    expect(decide(manager, "mcp__tracker__create", { title: "first" }).decision).toBe("deny")
    expect(decide(manager, "mcp__tracker__create", { title: "second" }).decision).toBe("ask")
  })

  it("expire with the next user message or a new session", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(false)
    const args = { command: "git push" }
    manager.recordDenial("bash", args, context())
    manager.startTurn()
    expect(decide(manager, "bash", args).decision).toBe("ask")
    manager.setSessionId("a")
    manager.recordDenial("bash", args, context())
    manager.setSessionId("b")
    expect(decide(manager, "bash", args).decision).toBe("ask")
  })

  it("never turn an allowed call into a denial", () => {
    const manager = new PermissionManager(cwd)
    manager.recordDenial("read_file", { path: "README.md" }, context())
    expect(decide(manager, "edit_file", { path: "src/a.ts" }).decision).toBe("ask")
    manager.recordDenial("edit_file", { path: "src/a.ts" }, context())
    // Reads were never part of the declined consent.
    expect(decide(manager, "read_file", { path: "src/a.ts" }).decision).toBe("allow")
  })
})

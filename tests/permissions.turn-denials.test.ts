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
  it("refuse only the identical call again", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(false)
    const push = { command: "git push origin feature" }
    expect(decide(manager, "bash", push).decision).toBe("ask")
    manager.recordDenial("bash", push, context())
    const repeat = decide(manager, "bash", push)
    expect(repeat.decision).toBe("deny")
    expect(repeat.reason).toContain("declined this request earlier in this turn")
    // A different call, even one a saved rule would group with it, still asks.
    expect(decide(manager, "bash", { command: "git push --tags" }).decision).toBe("ask")
    manager.recordDenial("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" }, context())
    expect(decide(manager, "edit_file", { path: "src/b.ts", old_string: "a", new_string: "b" }).decision).toBe("ask")
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
    expect(decide(manager, "read_file", { path: "README.md" }).decision).toBe("allow")
    manager.recordDenial("edit_file", { path: "src/a.ts" }, context())
    expect(decide(manager, "edit_file", { path: "src/a.ts" }).decision).toBe("deny")
    // A later mode switch or rule from the user lets the call run.
    expect(evaluateApprovalPolicy(manager, "edit_file", { path: "src/a.ts" }, { cwd, mode: "acceptEdits", context: context() }).decision).toBe("allow")
    manager.addToolRules([{ pattern: "Capability(fs.write:**)", type: "allow" }], "session")
    expect(decide(manager, "edit_file", { path: "src/a.ts" }).decision).toBe("allow")
  })
})

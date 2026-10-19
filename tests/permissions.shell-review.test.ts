import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHeadlessApproval } from "../src/headless/approval.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { getProjectSettingsPath, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { splitShellSubcommands } from "../zapsdk/utils/shell.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-shell-authorization-review-"))
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

// Every command below is a policy subject only. No shell, provider, or git
// process is started: a denial regression must never actually run git push.
const context = () => ({ cwd, workspaceRoot: cwd, shell: { syntax: "posix" as const, filesystem: "host" as const } })

describe("newline shell command restrictions", () => {
  for (const separator of ["\n", "\r\n"]) {
    for (const type of ["deny", "ask"] as const) {
      it(`preserves an explicit ${type} after ${JSON.stringify(separator)} despite a whole-Bash grant`, async () => {
        savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(git push:*)", type }] })
        const manager = new PermissionManager(cwd)
        manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
        manager.setSandboxConfined(true)
        const args = { command: `echo safe${separator}git push` }
        expect(manager.checkPermission("bash", args).decision).toBe(type)
        expect(evaluateApprovalPolicy(manager, "bash", args, {
          cwd, mode: "bypassPermissions", allowedTools: ["bash"], context: context(),
        })).toMatchObject({ decision: type, allowScope: false })
        const headless = buildHeadlessApproval({ cwd, permissionMode: "bypassPermissions", allowedTools: ["bash"] })
        headless.setSandboxConfined(true)
        expect(await headless.onApproval("bash", args, undefined, context())).toMatchObject({ approved: false })
      })
    }
  }

  it("recognizes newline-separated restrictions within structured check steps", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(git push:*)", type: "deny" }] })
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
    expect(manager.checkPermission("bash", { check_steps: ["echo first", "echo safe\ngit push"] }).decision).toBe("deny")
  })

  it("keeps quoted and escaped line breaks inside their current command", () => {
    expect(splitShellSubcommands("printf 'first\nsecond'\necho done")).toEqual(["printf 'first\nsecond'", "echo done"])
    const continuation = "echo first\\\nsecond"
    expect(splitShellSubcommands(continuation)).toHaveLength(1)
  })
})

const executableStructures = [
  "echo $(git push)",
  'echo "$(git push)"',
  "echo `git push`",
  '(git push)',
  "if true; then git push; fi",
  "for item in one; do git push; done",
  "{ git push; }",
]

describe("shell complexity limits prefix grants, not execution capabilities", () => {
  for (const profile of ["prefix", "whole-tool", "sandbox-auto", "bypass"] as const) {
    for (const command of executableStructures) {
      it(`${profile} evaluates authority for ${command}`, () => {
        const manager = new PermissionManager(cwd)
        if (profile === "prefix") manager.addToolRules([{ pattern: "Bash(echo:*)", type: "allow" }], "session")
        if (profile === "whole-tool") manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
        if (profile === "sandbox-auto") manager.setSandboxConfined(true)
        expect(evaluateApprovalPolicy(manager, "bash", { command }, {
          cwd, mode: profile === "bypass" ? "bypassPermissions" : "default", context: context(),
        })).toMatchObject(profile === "prefix" ? { decision: "ask", allowScope: true } : { decision: "allow" })
      })
    }
  }

  it("reuses explicit outside-sandbox execution consent for opaque scripts", () => {
    const manager = new PermissionManager(cwd)
    manager.grantSandboxEscape("session")
    expect(evaluateApprovalPolicy(manager, "bash", { command: "echo $(git push)", dangerouslyDisableSandbox: true }, {
      cwd, mode: "bypassPermissions", allowedTools: ["bash"], context: context(),
    })).toMatchObject({ decision: "allow" })
  })

  it("lets non-interactive Headless reuse explicit broad grants", async () => {
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "bash", type: "allow" }], "project")
    const headless = buildHeadlessApproval({ cwd, permissionMode: "bypassPermissions", allowedTools: ["bash"] })
    headless.setSandboxConfined(true)
    for (const command of executableStructures) {
      expect(await headless.onApproval("bash", { command }, undefined, context())).toBe(true)
    }
    expect(headless.anyDenied()).toBe(false)
  })

  it("covers structured steps with a whole-tool grant", () => {
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
    expect(evaluateApprovalPolicy(manager, "bash", { check_steps: ["echo first", "echo $(git push)"] }, {
      cwd, mode: "default", context: context(),
    })).toMatchObject({ decision: "allow" })
  })
})

describe("literal shell text does not cause additional approval", () => {
  const literals = [
    "echo '$(git push)'",
    "echo '`git push`'",
    "echo 'if true; then git push; fi'",
    "echo \\$\\(git\\ push\\)",
    "echo \\`git\\ push\\`",
    'echo "\\$(git push)"',
    "echo 'first\nsecond'",
  ]
  for (const command of literals) {
    it(`keeps a literal expression authorized: ${command}`, () => {
      const manager = new PermissionManager(cwd)
      manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
      expect(evaluateApprovalPolicy(manager, "bash", { command }, {
        cwd, mode: "default", context: context(),
      })).toMatchObject({ decision: "allow" })
    })
  }
})

describe("all shell entry points share capability policy", () => {
  for (const command of ["sudo fixture-only-command", "echo $(git push)"]) {
    it(`monitor distinguishes risk from syntax: ${command}`, async () => {
      const manager = new PermissionManager(cwd)
      manager.addToolRules([{ pattern: "monitor", type: "allow" }], "project")
      const args = { command, description: "Policy-only fixture; never started" }
      expect(evaluateApprovalPolicy(manager, "monitor", args, {
        cwd, mode: "bypassPermissions", allowedTools: ["monitor"], context: context(),
      })).toMatchObject(command.startsWith("sudo") ? { decision: "ask", allowScope: false } : { decision: "allow" })
      const headless = buildHeadlessApproval({ cwd, permissionMode: "bypassPermissions", allowedTools: ["monitor"] })
      const outcome = await headless.onApproval("monitor", args, undefined, context())
      if (command.startsWith("sudo")) expect(outcome).toMatchObject({ approved: false })
      else expect(outcome).toBe(true)
    })
  }

  const indirectExecutions = [
    "! git push",
    "coproc git push",
    "eval 'git push'",
    "source script.sh",
    ". script.sh",
    "echo safe; ! git push",
    "echo safe\neval 'git push'",
    "FLAG=x eval 'git push'",
    "time eval 'git push'",
    "FLAG='two words' time -p eval 'git push'",
    "command eval 'git push'",
    "exec -a 'fixture label' git push",
    'exec -a "fixture label" git push',
  ]
  for (const command of indirectExecutions) {
    it(`honors whole-tool consent for shell execution syntax: ${command}`, () => {
      const manager = new PermissionManager(cwd)
      manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
      expect(evaluateApprovalPolicy(manager, "bash", { command }, {
        cwd, mode: "bypassPermissions", allowedTools: ["bash"], context: context(),
      })).toMatchObject({ decision: "allow" })
    })
  }

  it("does not interpret shell builtin names in ordinary arguments as execution syntax", () => {
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
    for (const command of ["echo ! coproc eval source .", "printf '%s' source", "echo 'eval git push'", "echo FLAG=x time eval"]) {
      expect(evaluateApprovalPolicy(manager, "bash", { command }, {
        cwd, mode: "default", context: context(),
      })).toMatchObject({ decision: "allow" })
    }
  })

  it("matches explicit Bash restrictions through a direct exec wrapper", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(git push:*)", type: "deny" }] })
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
    for (const command of ["exec git push", "exec -a fixture git push", "exec -- git push"]) {
      expect(evaluateApprovalPolicy(manager, "bash", { command }, {
        cwd, mode: "bypassPermissions", context: context(),
      })).toMatchObject({ decision: "deny" })
    }
    expect(evaluateApprovalPolicy(manager, "service_start", { command: "exec /fixture/service /fixture/script" }, {
      cwd, mode: "default", allowedTools: ["service_start"], context: context(),
    })).toMatchObject({ decision: "allow" })
  })
})

describe("heredoc payload is opaque policy input", () => {
  for (const command of [
    "cat <<EOF\ngit push\nEOF",
    "python3 <<EOF\nprint('git push')\nEOF",
  ]) {
    it(`asks once rather than hard-denying heredoc content: ${JSON.stringify(command)}`, async () => {
      savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(git push:*)", type: "deny" }] })
      const manager = new PermissionManager(cwd)
      manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
      expect(manager.checkPermission("bash", { command }).decision).not.toBe("deny")
      expect(evaluateApprovalPolicy(manager, "bash", { command }, {
        cwd, mode: "bypassPermissions", context: context(),
      })).toMatchObject({ decision: "ask", allowScope: false })
      let prompts = 0
      const headless = buildHeadlessApproval({
        cwd, permissionMode: "bypassPermissions", allowedTools: ["bash"],
        onAsk: async () => { prompts++; return true },
      })
      expect(await headless.onApproval("bash", { command }, undefined, context())).toBe(true)
      expect(prompts).toBe(1)
    })
  }

  it("does not mistake quoted heredoc operators for shell execution", () => {
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "bash", type: "allow" }], "session")
    for (const command of ["echo '<<'", 'echo "<<EOF"', "echo \\<\\<"]) {
      expect(evaluateApprovalPolicy(manager, "bash", { command }, {
        cwd, mode: "default", context: context(),
      })).toMatchObject({ decision: "allow" })
    }
  })
})

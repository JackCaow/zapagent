import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { inferPattern, PermissionManager, ruleMatchesTool } from "../src/permissions.js"
import { approvalFacts } from "../src/approval-facts.js"
import { acpAgentTool } from "../zapsdk/builtin-tools/acp-agent.js"
import { AcpWorkspace, createAcpHostHandlers, permissionTarget } from "../zapsdk/acp-client/host-handlers.js"
import type { ApprovalCallback } from "../zapsdk/tools/executor.js"
import { resolveToolApprovalFacts } from "../zapsdk/tools/approval.js"
import type { ToolEffects } from "../zapsdk/tools/effects.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-acp-permissions-"))
  cwd = join(root, "project")
  mkdirSync(cwd, { recursive: true })
  cwd = realpathSync(cwd)
  previousDataDir = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const shell = { syntax: "posix" as const, filesystem: "host" as const }

function acpAgentContext(args: Record<string, unknown>): ApprovalContext {
  const definition = acpAgentTool({ agents: [{ id: "agy", command: "agy" }], defaultCwd: cwd })!.definition
  const effects = definition.resolveEffects!(args, { cwd, toolName: definition.name }) as ToolEffects
  return { cwd, workspaceRoot: cwd, shell, authorization: resolveToolApprovalFacts(definition, args, effects) }
}

describe("acp_agent approval", () => {
  it("is not a sandbox escape: bash's outside-sandbox grant neither allows it nor is granted by it", () => {
    const args = { agent: "agy", task: "x" }
    const context = acpAgentContext(args)
    // The raw effect facts say unsandboxed; the policy view must not.
    expect(context.authorization?.sandboxEscape).toBe(true)
    expect(approvalFacts("acp_agent", args, context).sandboxEscape).toBe(false)

    const manager = new PermissionManager(cwd)
    manager.grantSandboxEscape("session")
    const decision = evaluateApprovalPolicy(manager, "acp_agent", args, { cwd, mode: "default", context })
    expect(decision.decision).toBe("ask")
    expect(decision.category).not.toBe("sandbox-escape")
    expect(decision.allowScope).toBe(true)
  })

  it("honours an agent@cwd session grant and keeps it scoped to that agent", () => {
    const manager = new PermissionManager(cwd)
    const agy = { agent: "agy", task: "x" }
    manager.addSessionRule("acp_agent", agy, acpAgentContext(agy))
    expect(evaluateApprovalPolicy(manager, "acp_agent", { agent: "agy", task: "other" },
      { cwd, mode: "default", context: acpAgentContext({ agent: "agy", task: "other" }) }).decision).toBe("allow")
    const codex = { agent: "codex", task: "x" }
    expect(evaluateApprovalPolicy(manager, "acp_agent", codex,
      { cwd, mode: "default", context: acpAgentContext(codex) }).decision).toBe("ask")
  })

  it("is refused in plan mode", () => {
    const args = { agent: "agy", task: "x" }
    expect(evaluateApprovalPolicy(new PermissionManager(cwd), "acp_agent", args,
      { cwd, mode: "plan", context: acpAgentContext(args) }).decision).toBe("deny")
  })
})

describe("ACP agent permission requests", () => {
  const request = (toolCall: Record<string, unknown>) => ({ sessionId: "s", options: [], toolCall: { toolCallId: "t", ...toolCall } })
  const target = (agent: string, toolCall: Record<string, unknown>) => {
    const { name, args } = permissionTarget(agent, request(toolCall) as never, new AcpWorkspace(cwd))
    return { name, args }
  }

  it("maps concrete in-workspace effects onto zap's own tools", () => {
    const file = join(cwd, "a.txt")
    expect(target("agy", { kind: "execute", title: "ls", rawInput: { CommandLine: "ls" } }))
      .toEqual({ name: "bash", args: { command: "ls", description: "ls" } })
    expect(target("agy", { kind: "edit", title: "File a.txt", locations: [{ path: file }], rawInput: { Path: file, Content: "hi\n" } }))
      .toEqual({ name: "write_file", args: { path: file, content: "hi\n" } })
    expect(target("codex", { kind: "edit", title: "Edit", content: [{ type: "diff", path: file, oldText: "a", newText: "b" }] }))
      .toEqual({ name: "write_file", args: { path: file, content: "b" } })
    expect(target("agy", { kind: "delete", title: "rm", locations: [{ path: file }] }))
      .toEqual({ name: "delete_file", args: { path: file } })
    expect(target("agy", { kind: "read", title: "read", locations: [{ path: file }] }))
      .toEqual({ name: "read_file", args: { path: file } })
    expect(target("agy", { kind: "edit", title: "Edit two", locations: [{ path: file }, { path: join(cwd, "b.txt") }] }).name)
      .toBe("acp_agy_edit")
  })

  it("keeps out-of-workspace and protected paths off zap's file tools", () => {
    const outside = join(root, "elsewhere.txt")
    expect(target("agy", { kind: "edit", title: "x", locations: [{ path: outside }], rawInput: { Content: "x" } }).name).toBe("acp_agy_edit")
    expect(target("agy", { kind: "edit", title: "x", locations: [{ path: join(cwd, ".git", "hooks", "pre-commit") }], rawInput: { Content: "x" } }).name).toBe("acp_agy_edit")
    expect(target("agy", { kind: "delete", title: "x", locations: [{ path: join(cwd, ".zapcode", "settings.json") }] }).name).toBe("acp_agy_delete")
    expect(target("agy", { kind: "read", title: "x", locations: [{ path: outside }] }).name).toBe("acp_agy_read")
  })

  it("quotes argv commands instead of joining them", () => {
    expect(target("codex", { kind: "execute", title: "commit", rawInput: { command: ["git", "commit", "-m", "a && b"] } }).args.command)
      .toBe("git commit -m 'a && b'")
  })

  it("never auto-allows an agent's command as a sandboxed zap command", () => {
    const manager = new PermissionManager(cwd)
    manager.setSandboxConfined(true, true)
    const agentCommand = permissionTarget("agy", request({ kind: "execute", title: "ls", rawInput: { CommandLine: "ls" } }) as never, new AcpWorkspace(cwd))
    expect(evaluateApprovalPolicy(manager, agentCommand.name, agentCommand.args, { cwd, mode: "default", context: agentCommand.context }).decision).toBe("ask")
    // zap's own sandboxed bash keeps its auto-allow.
    const own = { cwd, workspaceRoot: cwd, shell, authorization: { readOnly: false, editOnly: false, sandboxEscape: false, workspaceShell: true, shellCommands: ["ls"] } }
    expect(evaluateApprovalPolicy(manager, "bash", { command: "ls" }, { cwd, mode: "default", context: own }).decision).toBe("allow")
    // Dangerous-command review still applies to agent commands.
    const rm = permissionTarget("agy", request({ kind: "execute", title: "rm", rawInput: { CommandLine: "rm -rf /" } }) as never, new AcpWorkspace(cwd))
    expect(evaluateApprovalPolicy(manager, rm.name, rm.args, { cwd, mode: "default", context: rm.context }).source).toBe("dangerous")
  })

  it("treats unmapped requests as writes except read/search/think, so plan mode refuses them", () => {
    const manager = new PermissionManager(cwd)
    const plan = (name: string) => evaluateApprovalPolicy(manager, name, { title: "x" }, { cwd, mode: "plan" }).decision
    expect(approvalFacts("acp_agy_edit", {}).readOnly).toBe(false)
    expect(approvalFacts("acp_agy_other", {}).readOnly).toBe(false)
    expect(approvalFacts("acp_agy_fetch", {}).readOnly).toBe(false)
    expect(approvalFacts("acp_agy_read", {}).readOnly).toBe(true)
    expect(approvalFacts("acp_my_agent_search", {}).readOnly).toBe(true)
    expect(plan("acp_agy_edit")).toBe("deny")
    expect(plan("acp_agy_execute")).toBe("deny")
    expect(plan("acp_agy_read")).not.toBe("deny")
  })

  it("approves unmapped requests one at a time: no saved scope, bare allow rules ignored", () => {
    const manager = new PermissionManager(cwd)
    const unmappedShell = permissionTarget("codex", request({ kind: "execute", title: "Run task" }) as never, new AcpWorkspace(cwd))
    expect(evaluateApprovalPolicy(manager, unmappedShell.name, unmappedShell.args,
      { cwd, mode: "bypassPermissions", hostCommands: "trusted", context: unmappedShell.context }))
      .toMatchObject({ decision: "ask", allowScope: false, category: "shell" })
    const decision = evaluateApprovalPolicy(manager, "acp_agy_edit", { title: "x", paths: [cwd] }, { cwd, mode: "default" })
    expect(decision).toMatchObject({ decision: "ask", allowScope: false })
    expect(inferPattern("acp_agy_edit", { title: "x" }, cwd)).toBeNull()
    expect(ruleMatchesTool({ pattern: "acp_agy_edit", type: "allow" }, "acp_agy_edit", { title: "x" })).toBe(false)
    expect(ruleMatchesTool({ pattern: "acp_agy_edit", type: "deny" }, "acp_agy_edit", { title: "x" })).toBe(true)
    expect(evaluateApprovalPolicy(manager, "acp_agy_edit", { title: "x" }, { cwd, mode: "acceptEdits" }).decision).toBe("ask")
  })
})

describe("ACP fs requests stay inside the workspace", () => {
  const recorder = () => {
    const calls: string[] = []
    const approve = (async (name: string) => { calls.push(name); return true }) as ApprovalCallback
    return { calls, approve }
  }

  it("asks per call outside the workspace and never writes .git or .zapcode", async () => {
    const { calls, approve } = recorder()
    const handlers = createAcpHostHandlers({ agentId: "agy", cwd, approve })
    const signal = new AbortController().signal
    writeFileSync(join(cwd, "in.txt"), "a\nb\nc\n")
    const outside = join(root, "secret.txt")
    writeFileSync(outside, "s")
    await handlers.readTextFile!({ sessionId: "s", path: join(cwd, "in.txt"), line: 2, limit: -3 }, signal)
    await handlers.readTextFile!({ sessionId: "s", path: outside }, signal)
    await handlers.writeTextFile!({ sessionId: "s", path: join(root, "out.txt"), content: "x" }, signal)
    expect(calls).toEqual(["read_file", "acp_agy_read", "acp_agy_edit"])
    await expect(handlers.writeTextFile!({ sessionId: "s", path: join(cwd, ".git", "config"), content: "x" }, signal)).rejects.toThrow()
    await expect(handlers.writeTextFile!({ sessionId: "s", path: join(cwd, ".zapcode", "settings.json"), content: "x" }, signal)).rejects.toThrow()
    expect(existsSync(join(cwd, ".git", "config"))).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it("clamps line/limit and refuses oversized files before reading them", async () => {
    const handlers = createAcpHostHandlers({ agentId: "agy", cwd, approve: (async () => true) as ApprovalCallback })
    const signal = new AbortController().signal
    writeFileSync(join(cwd, "in.txt"), "a\nb\nc")
    expect((await handlers.readTextFile!({ sessionId: "s", path: join(cwd, "in.txt"), line: 2, limit: -1 }, signal)).content).toBe("")
    expect((await handlers.readTextFile!({ sessionId: "s", path: join(cwd, "in.txt"), line: -5, limit: 1 }, signal)).content).toBe("a")
    const big = join(cwd, "big.bin")
    writeFileSync(big, "")
    const { truncateSync } = await import("node:fs")
    truncateSync(big, 11 * 1024 * 1024)
    await expect(handlers.readTextFile!({ sessionId: "s", path: big }, signal)).rejects.toThrow()
  })
})

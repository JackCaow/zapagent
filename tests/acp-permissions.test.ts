import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { PermissionManager } from "../src/permissions.js"
import { approvalFacts } from "../src/approval-facts.js"
import { acpAgentTool } from "../zapsdk/builtin-tools/acp-agent.js"
import { permissionTarget } from "../zapsdk/acp-client/host-handlers.js"
import { resolveToolApprovalFacts } from "../zapsdk/tools/approval.js"
import type { ToolEffects } from "../zapsdk/tools/effects.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"

let root: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-acp-permissions-"))
  cwd = join(root, "project")
  mkdirSync(cwd, { recursive: true })
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

  it("maps concrete effects onto zap's own tools", () => {
    const file = join(cwd, "a.txt")
    expect(permissionTarget("agy", request({ kind: "execute", title: "ls", rawInput: { CommandLine: "ls" } })))
      .toEqual({ name: "bash", args: { command: "ls", description: "ls" } })
    expect(permissionTarget("agy", request({ kind: "edit", title: "File a.txt", locations: [{ path: file }], rawInput: { Path: file, Content: "hi\n" } })))
      .toEqual({ name: "write_file", args: { path: file, content: "hi\n" } })
    expect(permissionTarget("codex", request({ kind: "edit", title: "Edit", content: [{ type: "diff", path: file, oldText: "a", newText: "b" }] })))
      .toEqual({ name: "write_file", args: { path: file, content: "b" } })
    expect(permissionTarget("agy", request({ kind: "delete", title: "rm", locations: [{ path: file }] })))
      .toEqual({ name: "delete_file", args: { path: file } })
    expect(permissionTarget("agy", request({ kind: "read", title: "read", locations: [{ path: file }] })))
      .toEqual({ name: "read_file", args: { path: file } })
    expect(permissionTarget("agy", request({ kind: "edit", title: "Edit two", locations: [{ path: file }, { path: join(cwd, "b.txt") }] })).name)
      .toBe("acp_agy_edit")
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
})

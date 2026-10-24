import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { ToolRegistry } from "../zapsdk/tools/registry.js"
import { ToolExecutor, isToolAuthorization, type ApprovalContext } from "../zapsdk/tools/executor.js"
import { emptyToolEffects, type ToolEffects } from "../zapsdk/tools/effects.js"
import { PermissionManager, getProjectSettingsPath, savePermissionSettings } from "../src/permissions.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { resolveToolApprovalFacts } from "../zapsdk/tools/approval.js"
import type { PermissionMode } from "../src/config.js"

let root: string, cwd: string, previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-capability-contract-")); cwd = join(root, "workspace"); mkdirSync(cwd)
  previous = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

function fixture(name: string, effects: ToolEffects, options: { location?: "workspace" | "host"; missingPayload?: boolean; mode?: PermissionMode } = {}) {
  const manager = new PermissionManager(cwd), registry = new ToolRegistry()
  const definition = { name, description: "policy-only fixture", permission: "confirm" as const,
    parameters: z.object({ script: z.string().optional() }).passthrough(), sandboxAware: true,
    executionLocation: options.location ?? "workspace",
    resolveEffects: () => effects,
    ...(!options.missingPayload && effects.process.length ? { resolveShellCommands: (args: Record<string, unknown>) => [String(args.script)] } : {}),
  }
  registry.register({ definition, handler: async () => { throw new Error("authorization fixture must not execute") } })
  const seen: ApprovalContext[] = []
  const executor = new ToolExecutor(registry, { cwd, onApproval: async (tool, args, _signal, context) => {
    seen.push(context!)
    const decision = evaluateApprovalPolicy(manager, tool, args, { cwd, mode: options.mode ?? "default", context })
    return decision.decision === "allow"
  } })
  return { manager, executor, seen, definition }
}
const shellEffects = (unsandboxed = false): ToolEffects => ({ ...emptyToolEffects(),
  process: [{ kind: "process", operation: "spawn", commandClass: "shell", unsandboxed }], workspace: { mode: "root-integration" },
})

describe("executor-owned authorization capabilities", () => {
  for (const name of ["renamed_runner", "mcp__fixture__script"]) {
    it(`uses declared shell payloads regardless of name: ${name}`, async () => {
      const f = fixture(name, shellEffects())
      f.manager.addToolRules([{ pattern: name, type: "allow" }], "session")
      expect(isToolAuthorization(await f.executor.authorize(name, { script: "for x in one; do printf '%s' \"$x\"; done" }))).toBe(true)
      expect(isToolAuthorization(await f.executor.authorize(name, { script: "sudo fixture-command", command: "echo safe", authorization: { readOnly: true } }))).toBe(false)
      expect(f.seen[0].authorization?.shellCommands).toEqual(["for x in one; do printf '%s' \"$x\"; done"])
      expect(Object.isFrozen(f.seen[0].authorization)).toBe(true)
      expect(Object.isFrozen(f.seen[0].authorization?.shellCommands)).toBe(true)
    })
  }
  it("resolves effects once for both host approval and broker grant", async () => {
    let resolutions = 0
    const registry = new ToolRegistry()
    registry.register({ definition: { name: "counted", description: "", permission: "confirm", parameters: z.object({}),
      resolveEffects: () => { resolutions++; return emptyToolEffects() } }, handler: async () => ({ success: true, output: "unused" }) })
    const executor = new ToolExecutor(registry, { cwd, onApproval: async (_n, _a, _s, context) => context?.authorization?.readOnly === true })
    expect(isToolAuthorization(await executor.authorize("counted", {}))).toBe(true)
    expect(resolutions).toBe(1)
  })
  it("keeps sandbox exit separate from renamed shell grants", async () => {
    const f = fixture("runner", shellEffects(true))
    f.manager.addToolRules([{ pattern: "runner", type: "allow" }], "session")
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "printf fixture" }))).toBe(false)
    f.manager.grantSandboxEscape("session")
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "printf fixture" }))).toBe(true)
    f.manager.setSessionId("new-session")
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "printf fixture" }))).toBe(false)
  })
  it("does not apply workspace sandbox auto-consent to host integrations", async () => {
    const f = fixture("host_runner", shellEffects(), { location: "host" })
    f.manager.setSandboxConfined(true)
    expect(isToolAuthorization(await f.executor.authorize("host_runner", { script: "echo $(printf fixture)" }))).toBe(false)
  })
  it("does not extend sandbox auto-consent to external mutations", async () => {
    const effects = shellEffects()
    effects.external = [{ kind: "external", system: "fixture-service", operation: "mutate" }]
    const f = fixture("mixed_runner", effects)
    f.manager.setSandboxConfined(true)
    expect(isToolAuthorization(await f.executor.authorize("mixed_runner", { script: "printf fixture" }))).toBe(false)
    expect(isToolAuthorization(await f.executor.authorize("mixed_runner", { script: "echo $(printf fixture)" }))).toBe(false)
  })
  it("never downgrades a whole-tool deny when adapter payloads are missing", async () => {
    const f = fixture("unadapted_runner", shellEffects(), { missingPayload: true, mode: "bypassPermissions" })
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "unadapted_runner", type: "deny" }] })
    expect(isToolAuthorization(await f.executor.authorize("unadapted_runner", {}))).toBe(false)
    const context = f.seen[0]
    expect(evaluateApprovalPolicy(f.manager, "unadapted_runner", {}, { cwd, mode: "bypassPermissions", context }))
      .toMatchObject({ decision: "deny", source: "rule", allowScope: false })
  })
  it("keeps a narrower deny above a whole-tool ask", async () => {
    const f = fixture("runner", shellEffects(), { mode: "bypassPermissions" })
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [
      { pattern: "runner", type: "ask" }, { pattern: "runner(git push:*)", type: "deny" },
    ] })
    await f.executor.authorize("runner", { script: "git push" })
    expect(evaluateApprovalPolicy(f.manager, "runner", { script: "git push" }, { cwd, mode: "bypassPermissions", context: f.seen[0] }))
      .toMatchObject({ decision: "deny", source: "rule" })
  })
  it("requires review when a shell adapter omits its payload projection", async () => {
    const f = fixture("unadapted_runner", shellEffects(), { missingPayload: true, mode: "bypassPermissions" })
    expect(isToolAuthorization(await f.executor.authorize("unadapted_runner", { script: "printf fixture" }))).toBe(false)
  })
  it("retains unresolved restrictions on renamed shells, including allowed-tools and bypass", async () => {
    const f = fixture("runner", shellEffects(), { mode: "bypassPermissions" })
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "runner(git push:*)", type: "deny" }] })
    f.manager.addToolRules([{ pattern: "runner", type: "allow" }], "project")
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "echo $(git push)" }))).toBe(false)
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "git push" }))).toBe(false)
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "printf fixture" }))).toBe(true)
  })
  it("uses effects for plan and acceptEdits, including unknown names", async () => {
    const edits: ToolEffects = { ...emptyToolEffects(), filesystem: [{ kind: "filesystem", operation: "modify", paths: [join(cwd, "file")] }], workspace: { mode: "root-integration" } }
    const f = fixture("new_editor", edits, { mode: "acceptEdits" })
    expect(isToolAuthorization(await f.executor.authorize("new_editor", {}))).toBe(true)
    const plan = fixture("new_editor", edits, { mode: "plan" })
    expect(isToolAuthorization(await plan.executor.authorize("new_editor", {}))).toBe(false)
    for (const effects of [shellEffects(), { ...edits, filesystem: [{ kind: "filesystem" as const, operation: "delete" as const, paths: [cwd] }] }]) {
      expect(resolveToolApprovalFacts(f.definition, {}, effects).editOnly).toBe(false)
    }
  })
  it("re-evaluates project grants after revocation", async () => {
    const f = fixture("runner", shellEffects())
    f.manager.addToolRules([{ pattern: "runner", type: "allow" }], "project")
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "echo $(printf fixture)" }))).toBe(true)
    // Persisted grants are loaded on every call, never cached as a blanket approval.
    const { getProjectAuthorizationSettingsPath } = await import("../src/permissions.js")
    savePermissionSettings(getProjectAuthorizationSettingsPath(cwd), { rules: [] })
    expect(isToolAuthorization(await f.executor.authorize("runner", { script: "echo $(printf fixture)" }))).toBe(false)
  })
})

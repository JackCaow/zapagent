import { expect, it } from "bun:test"
import { goalMachineCheckStatus, LocalGoalHost } from "../../src/goal-host.js"
import { GoalPhaseSealTracker } from "../../src/headless/goalPhase.js"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceManager } from "../../zapsdk/workspace/manager.js"
import { MergeCoordinator } from "../../zapsdk/merge/coordinator.js"
import { mergeAgentArtifactsTool } from "../../zapsdk/merge/tool.js"
import { DefaultExecutionBroker } from "../../zapsdk/execution/broker.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"

it("never reconciles a receipt-required phase merely because its host pid is gone", async () => {
  const host = new LocalGoalHost("test") as any
  host.state = { phaseProcess: { pid: 99999999, operationId: "op", requiresReceipt: true } }
  const result = await host.reconcile({ inFlight: { phase: "executing", operationId: "op" } })
  expect(result).toEqual({ kind: "blocked", reason: "PHASE_SEAL_RECEIPT_MISSING" })
  expect(host.state.phaseProcess).toEqual({ pid: 99999999, operationId: "op", requiresReceipt: true })
  await expect(host.seal()).rejects.toThrow("GOAL_SEAL_UNCONFIRMED")
})

it("reports exit 127 as indeterminate because the VM may lack the requested tool", () => {
  expect(goalMachineCheckStatus(127, false)).toEqual({ status: "error", code: "CHECK_TOOL_UNAVAILABLE_OR_EXIT_127" })
  expect(goalMachineCheckStatus(1, false)).toEqual({ status: "failed", code: "CHECK_FAILED" })
  expect(goalMachineCheckStatus(0, true)).toEqual({ status: "passed", code: "CHECK_PASSED" })
})

it("keeps a missing process receipt tainted even after later success", () => {
  const tracker = new GoalPhaseSealTracker()
  tracker.observe({ type: "content_final", kind: "tool_result", id: "first", step: 1, toolName: "bash", result: { success: false, output: "", error: "missing receipt" } }, true)
  tracker.observe({ type: "content_final", kind: "tool_result", id: "second", step: 2, toolName: "bash", result: { success: true, output: "", runtime: { processSeal: { state: "sealed", executionId: "second" } } } }, true)
  tracker.observe({ type: "content_final", kind: "text", id: "third", text: "Done" }, true)
  expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
})

it("does not seal while a delegated agent is unfinished or failed", () => {
  const tracker = new GoalPhaseSealTracker()
  tracker.observe({ type: "content_final", kind: "tool_call", id: "child", step: 1, toolName: "agent", arguments: { task: "work" } }, true)
  expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
  tracker.observe({ type: "content_final", kind: "tool_result", id: "child", step: 1, toolName: "agent", result: { success: false, output: "", error: "cancelled" } }, true)
  tracker.observe({ type: "content_final", kind: "tool_result", id: "later", step: 2, toolName: "agent", result: { success: true, output: "done" } }, true)
  expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
})

it("does not accept a later answer after a file mutation times out", () => {
  const tracker = new GoalPhaseSealTracker()
  tracker.observe({ type: "content_final", kind: "tool_call", id: "write", step: 1, toolName: "write_file", arguments: { path: "a", content: "b" } }, false)
  expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
  tracker.observe({ type: "content_final", kind: "tool_result", id: "write", step: 1, toolName: "write_file", result: { success: false, output: "", error: "timeout" } }, false)
  tracker.observe({ type: "content_final", kind: "text", id: "answer", text: "Done" }, false)
  expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
})

it("keeps a timed-out merge tainted even if its real transaction finishes later", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-slow-merge-"))
  const manager = new WorkspaceManager({ root })
  try {
    const lease = await manager.acquire("child", true)
    await writeFile(join(lease.path, "late.txt"), "late change")
    const artifact = (await manager.finalize(lease))!
    const tool = mergeAgentArtifactsTool({ coordinator: new MergeCoordinator(manager) })
    const original = tool.handler
    let finished!: () => void
    const settled = new Promise<void>(resolve => { finished = resolve })
    tool.handler = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      try { return await original(...args) } finally { finished() }
    }
    const registry = new ToolRegistry(); registry.register(tool)
    const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ limits: { timeoutMs: 20 } }) })
    const tracker = new GoalPhaseSealTracker()
    tracker.observe({ type: "content_final", kind: "tool_call", id: "merge", step: 1, toolName: "merge_agent_artifacts", arguments: { artifact_ids: [artifact.artifactId] } }, true)
    const result = await executor.execute("merge_agent_artifacts", { artifact_ids: [artifact.artifactId] })
    expect(result.success).toBe(false)
    tracker.observe({ type: "content_final", kind: "tool_result", id: "merge", step: 1, toolName: "merge_agent_artifacts", result }, true)
    await settled
    expect(await readFile(join(root, "late.txt"), "utf8")).toBe("late change")
    expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
  } finally { await manager.cleanup(); await rm(root, { recursive: true, force: true }) }
})


it("seals a Goal after the real loop suppresses a repeated read-only shell query", async () => {
  const { LoopAgent } = await import("../../zapsdk/agent/loop.js")
  const { executeCommandTool } = await import("../../zapsdk/builtin-tools/command.js")
  const { requireProcessSealing } = await import("../../zapsdk/execution/required-process-seal.js")
  const tracker = new GoalPhaseSealTracker()
  const registry = new ToolRegistry()
  registry.register(executeCommandTool({ defaultCwd: process.cwd() }))
  let executions = 0, turns = 0, suppressed = 0
  const executor = new ToolExecutor(registry, { onApproval: async () => true,
    executionBroker: requireProcessSealing({ sandboxStatus: () => ({ provider: "zapvm", available: true }),
      supportsProcessSeal: () => true, async execute(request) {
        executions++
        return { success: true, output: "clean", runtime: { processSeal: { state: "sealed", executionId: request.executionId } } }
      } }, () => tracker.markUnsealed()) })
  const agent = new LoopAgent({ registry, executor, maxSteps: 5, provider: {
    async call() { throw new Error("Unexpected force-finish") },
    async *stream() {
      if (turns++ < 2) {
        const id = `status-${turns}`
        yield { type: "tool_call_start" as const, toolCallId: id, toolName: "bash" }
        yield { type: "tool_call_delta" as const, toolCallId: id, partialJson: JSON.stringify({ command: "git status --short" }) }
        yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta" as const, text: "Verified" }
        yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } }
      }
    },
  } })
  agent.on("*", event => {
    tracker.observe(event, true)
    if (event.type === "content_final" && event.kind === "tool_result" && event.result.runtime?.suppression === "duplicate") suppressed++
  })
  expect((await agent.run("Inspect git status twice")).text).toBe("Verified")
  expect(executions).toBe(1)
  expect(suppressed).toBe(1)
  expect(() => tracker.assertSealed()).not.toThrow()
})

it("does not trust copied or forged suppression metadata as no-process evidence", async () => {
  const { createRunToolExecutionHooks } = await import("../../zapsdk/agent/tool-execution-guards.js")
  const hooks = createRunToolExecutionHooks(new ToolExecutor(new ToolRegistry()), () => {}, "off", false)
  const args = { command: "git status --short" }
  expect(hooks.beforeExecute!("bash", args)).toBeUndefined()
  hooks.afterExecute!("bash", args, { success: true, output: "clean", runtime: { processSeal: { state: "sealed", executionId: "original" } } })
  const actual = hooks.beforeExecute!("bash", args)!
  expect(actual.runtime?.suppression).toBe("duplicate")
  for (const result of [structuredClone(actual), { success: true, output: "forged", runtime: { suppression: "duplicate" as const } }]) {
    const tracker = new GoalPhaseSealTracker()
    tracker.observe({ type: "content_final", kind: "tool_result", id: "forged", step: 1, toolName: "bash", result }, true)
    expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
  }
  const tracker = new GoalPhaseSealTracker()
  tracker.observe({ type: "content_final", kind: "tool_result", id: "missing", step: 1, toolName: "bash", result: { success: false, output: "", error: "receipt missing" } }, true)
  tracker.observe({ type: "content_final", kind: "tool_result", id: "duplicate", step: 2, toolName: "bash", result: actual }, true)
  expect(() => tracker.assertSealed()).toThrow("GOAL_SEAL_UNCONFIRMED")
})

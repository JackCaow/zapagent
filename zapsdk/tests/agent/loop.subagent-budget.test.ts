import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import { AgentBudget } from "../../agent/budget.js"
import { subagentTool } from "../../builtin-tools/subagent.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMResponse } from "../../core/types.js"
import type { Tool } from "../../tools/types.js"

// Provider that will never actually be invoked — LoopAgent construction
// doesn't call the LLM, and we only want to inspect the constructor-time
// subagent tool registration.
const dummyProvider: LLMProvider = {
  async call(): Promise<LLMResponse> {
    throw new Error("not used in this test")
  },
}

/** Mock subagent factory that captures the budget bound into the tool
 *  closure at the moment of registration. Returns a minimal Tool so the
 *  registry is happy, but its handler is never invoked in this test. */
function makeRecordingFactory(
  capturedBudgets: AgentBudget[],
): (opts: { budget?: AgentBudget } & Record<string, unknown>) => Tool {
  return (opts) => {
    if (opts.budget) capturedBudgets.push(opts.budget)
    return {
      definition: {
        name: "agent",
        description: "stub",
        parameters: z.object({ task: z.string() }),
        permission: "auto",
      },
      handler: async () => ({ success: true, output: "" }),
    }
  }
}

describe("LoopAgent: agent tool re-binds budget per construction", () => {
  it("registers a fresh agent tool for each LoopAgent even on a shared registry", () => {
    // Hosts (like useAgentRunner) reuse one registry across user turns to
    // avoid rebuilding the full tool list every prompt. Before the fix in
    // loop.ts:277, the `if (!registry.has("agent"))` short-circuit meant
    // turn-2's agent tool kept pointing at turn-1's budget closure — which
    // leaked spawn-exhaustion across otherwise-independent turns.

    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 10 })
    const capturedBudgets: AgentBudget[] = []
    const factory = makeRecordingFactory(capturedBudgets)

    // First LoopAgent — registers agent tool with budget_1.
    const agent1 = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "t1",
      maxSteps: 5,
      subagent: {},
      subagentFactory: factory as any,
    })

    expect(capturedBudgets).toHaveLength(1)
    expect(capturedBudgets[0]).toBe((agent1 as any).budget)

    // Second LoopAgent on the SAME registry — must re-register and bind
    // the fresh budget_2, NOT skip because agent tool already exists.
    const agent2 = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "t2",
      maxSteps: 5,
      subagent: {},
      subagentFactory: factory as any,
    })

    expect(capturedBudgets).toHaveLength(2)
    expect(capturedBudgets[1]).toBe((agent2 as any).budget)
    // Critical: the two budgets must be distinct instances so turn-2 starts
    // from a 0-spawn baseline, not from turn-1's exhausted counter.
    expect(capturedBudgets[0]).not.toBe(capturedBudgets[1])
  })

  it("keeps the caller registry clean while the LoopAgent executor can run its agent tool", async () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 10 })
    const capturedBudgets: AgentBudget[] = []
    const factory = makeRecordingFactory(capturedBudgets)

    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "t1",
      maxSteps: 5,
      subagent: {},
      subagentFactory: factory as any,
    })

    expect(registry.has("agent")).toBe(false)
    expect((agent as any).registry.has("agent")).toBe(true)

    const result = await (agent as any).executor.execute("agent", { task: "inspect" })
    expect(result.success).toBe(true)
    expect(capturedBudgets).toHaveLength(1)
    expect(capturedBudgets[0]).toBe((agent as any).budget)
  })

  it("reports effective tool definitions after auto-registering the agent tool", () => {
    const registry = new ToolRegistry()
    const readTool: Tool = {
      definition: {
        name: "read_file",
        description: "read",
        parameters: z.object({ path: z.string() }),
        permission: "confirm",
      },
      handler: async () => ({ success: true, output: "" }),
    }
    registry.register(readTool)
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 10 })

    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "t1",
      maxSteps: 5,
      subagent: {},
      subagentFactory: makeRecordingFactory([]) as any,
    })

    expect(registry.definitions().map((tool) => tool.name)).toEqual(["read_file"])
    expect(agent.toolDefinitions().map((tool) => tool.name)).toEqual(["agent", "read_file", "read_tool_output"])
  })

  it("turn-2 has full spawn budget even after turn-1 exhausted its own", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 10 })
    const capturedBudgets: AgentBudget[] = []
    const factory = makeRecordingFactory(capturedBudgets)

    const agent1 = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "t1",
      maxSteps: 5,
      subagent: {},
      subagentFactory: factory as any,
    })
    const budget1 = (agent1 as any).budget as AgentBudget

    // Drain turn-1's budget to the exhaustion boundary.
    while (budget1.reserveSpawn()) { /* consume */ }
    expect(budget1.spawnsRemaining).toBe(0)

    const agent2 = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "t2",
      maxSteps: 5,
      subagent: {},
      subagentFactory: factory as any,
    })
    const budget2 = (agent2 as any).budget as AgentBudget

    // Turn-2's budget starts fresh.
    expect(budget2.spawnsRemaining).toBe(budget2.maxSpawns)
    // The registered agent tool closes over budget2, not budget1 —
    // confirmed by equality of the latest captured budget.
    expect(capturedBudgets[1]).toBe(budget2)
    expect(capturedBudgets[1]).not.toBe(budget1)
  })

  it("keeps the registered agent tool prompt stable across budget states", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 10 })
    const freshBudget = new AgentBudget({ maxSpawns: 10 })
    const lowBudget = new AgentBudget({ maxSpawns: 10 })
    for (let i = 0; i < 9; i++) lowBudget.reserveSpawn()

    const freshAgent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "fresh",
      maxSteps: 5,
      subagent: {},
      subagentFactory: subagentTool,
      budget: freshBudget,
    })
    const lowAgent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      systemPrompt: "low",
      maxSteps: 5,
      subagent: {},
      subagentFactory: subagentTool,
      budget: lowBudget,
    })

    const freshPrompt = (freshAgent as any).registry.get("agent").definition.prompt
    const lowPrompt = (lowAgent as any).registry.get("agent").definition.prompt
    expect(lowPrompt).toBe(freshPrompt)
    expect(lowPrompt).not.toContain("Budget notice")
  })

  it("passes storageProjectCwd through to the subagent factory", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 10 })
    const capturedProjectCwds: Array<string | undefined> = []
    const factory = (opts: { storageProjectCwd?: string } & Record<string, unknown>): Tool => {
      capturedProjectCwds.push(opts.storageProjectCwd)
      return {
        definition: {
          name: "agent",
          description: "stub",
          parameters: z.object({ task: z.string() }),
          permission: "auto",
        },
        handler: async () => ({ success: true, output: "" }),
      }
    }

    new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      subagent: {},
      subagentFactory: factory as any,
      storageProjectCwd: "/tmp/zap-project-cwd",
    })

    expect(capturedProjectCwds).toEqual(["/tmp/zap-project-cwd"])
  })

  it("passes executor checkpoint and confirm policy through to the subagent factory", () => {
    const registry = new ToolRegistry()
    const onTrackEdit = async () => {}
    const executor = new ToolExecutor(registry, {
      onTrackEdit,
      allowConfirmWithoutApproval: true,
    })
    const conversation = new ConversationManager({ maxMessages: 10 })
    const capturedExecutorOptions: Array<Record<string, unknown> | undefined> = []
    const factory = (opts: { executorOptions?: Record<string, unknown> } & Record<string, unknown>): Tool => {
      capturedExecutorOptions.push(opts.executorOptions)
      return {
        definition: {
          name: "agent",
          description: "stub",
          parameters: z.object({ task: z.string() }),
          permission: "auto",
        },
        handler: async () => ({ success: true, output: "" }),
      }
    }

    new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      subagent: {},
      subagentFactory: factory as any,
    })

    expect(capturedExecutorOptions).toHaveLength(1)
    expect(capturedExecutorOptions[0]?.onTrackEdit).toBe(onTrackEdit)
    expect(capturedExecutorOptions[0]?.allowConfirmWithoutApproval).toBe(true)
  })
})

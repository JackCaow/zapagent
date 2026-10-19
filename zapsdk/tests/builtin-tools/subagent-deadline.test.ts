import { test, expect } from "bun:test";
import { z } from "zod";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { InMemoryAgentCoordinatorStateStore } from "../../coordinator/store.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import type { LLMProvider } from "../../core/llm.js";

for (const coordinated of [false, true]) {
  test(`${coordinated ? "coordinated" : "direct"} child sees shrinking broker deadline without extra requests`, async () => {
    const registry = new ToolRegistry();
    const remaining: number[] = [];
    let calls = 0;
    registry.register({ definition: { name: "read_file", description: "fixture", parameters: z.object({}), permission: "auto" },
      handler: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { success: true, output: "OBSERVED" }; } });
    const provider: LLMProvider = {
      async call(messages) {
        calls++;
        const context = messages.map(m => m.content).join("\n");
        const match = context.match(/At most (\d+)ms remain before the known outer execution deadline/);
        expect(match).not.toBeNull();
        remaining.push(Number(match![1]));
        expect(messages.find(m => m.role === "system")?.content).not.toContain("known outer execution deadline");
        return calls === 1
          ? { type: "tool_call", text: "", toolCalls: [{ id: "read", name: "read_file", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { type: "text", text: "OBSERVED", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "deadline-fixture", executor: bridge });
    registry.register(subagentTool({ provider, registry, timeoutMs: 20_000,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}) }));
    const executor = new ToolExecutor(registry, { executionBroker: new DefaultExecutionBroker({ limits: { timeoutMs: 5_000 } }) });
    const result = await executor.execute("agent", { agent_type: "explore", task: "Inspect the fixture." });
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(remaining[0]).toBeGreaterThan(4_000);
    expect(remaining[0]).toBeLessThanOrEqual(5_000);
    expect(remaining[1]).toBeLessThan(remaining[0]!);
  });
}

for (const coordinated of [false, true]) {
  test(`${coordinated ? "coordinated" : "direct"} nested delegation cannot reset the inherited deadline`, async () => {
    const registry = new ToolRegistry();
    const seen: number[] = [];
    let outerCalls = 0;
    const provider: LLMProvider = {
      async call(messages) {
        const context = messages.map(m => m.content).join("\n");
        const match = context.match(/At most (\d+)ms remain before the known outer execution deadline/);
        expect(match).not.toBeNull();
        seen.push(Number(match![1]));
        const inner = messages.some(m => m.role === "user" && m.content === "INNER_SENTINEL");
        if (!inner && ++outerCalls === 1) {
          await new Promise(resolve => setTimeout(resolve, 30));
          return { type: "tool_call", text: "", toolCalls: [{ id: "nested", name: "agent", arguments: { agent_type: "explore", task: "INNER_SENTINEL" } }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return { type: "text", text: "Synthetic finding.", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const stateStore = new InMemoryAgentCoordinatorStateStore();
    const coordinator = new AgentCoordinator({ threadId: "nested-deadline", executor: bridge, stateStore });
    registry.register(subagentTool({ provider, registry, timeoutMs: 20_000,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}) }));
    const result = await new ToolExecutor(registry).execute("agent", { task: "OUTER_SENTINEL", agent_type: "general" }, undefined, { deadlineAtMs: Date.now() + 1_500 });
    expect(result.success).toBe(true);
    expect(seen.length).toBe(3);
    expect(seen[0]).toBeGreaterThan(1_000);
    expect(seen[0]).toBeLessThanOrEqual(1_500);
    expect(seen[1]).toBeLessThan(seen[0]!);
    expect(seen[2]).toBeLessThanOrEqual(seen[1]!);
    if (coordinated) expect(JSON.stringify(await stateStore.load("nested-deadline"))).not.toContain("deadlineAtMs");
  });
}

test("coordinator resume does not reuse a previous invocation deadline", async () => {
  const seen: Array<number | undefined> = [];
  const stateStore = new InMemoryAgentCoordinatorStateStore();
  const coordinator = new AgentCoordinator({ threadId: "resume-deadline", stateStore, executor: {
    async execute(context) { seen.push(context.deadlineAtMs); return { success: false, text: "unresolved" }; },
  } });
  const deadlineAtMs = Date.now() + 1_000;
  const first = await coordinator.spawn({ task: "fixture", agentType: "explore" }, { deadlineAtMs });
  await coordinator.wait(first.runId);
  const resumed = await coordinator.resume(first.runId);
  await coordinator.wait(resumed.runId);
  expect(seen).toEqual([deadlineAtMs, undefined]);
  expect(JSON.stringify(await stateStore.load("resume-deadline"))).not.toContain("deadlineAtMs");
});

import { expect, test } from "bun:test";
import { z } from "zod";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";

for (const coordinated of [false, true]) for (const readSucceeded of [false, true]) {
  test(`${coordinated ? "coordinated" : "direct"} provider failure preserves a completed ${readSucceeded ? "successful" : "failed"} observation`, async () => {
    const registry = new ToolRegistry();
    let reads = 0;
    let requests = 0;
    registry.register({
      definition: { name: "read_file", description: "Synthetic read", permission: "auto", parameters: z.object({}) },
      handler: async () => {
        reads++;
        return { success: readSucceeded, output: "SETTLED_RECORD: inspected 17 entries",
          ...(readSucceeded ? {} : { error: "One entry was unreadable" }) };
      },
    });
    const provider: LLMProvider = {
      async call(messages) {
        requests++;
        if (requests === 1) return { type: "tool_call", text: "UNFINISHED_DRAFT",
          toolCalls: [{ id: "read-once", name: "read_file", arguments: {} }],
          usage: { inputTokens: 1, outputTokens: 1 } };
        expect(messages.some(m => m.role === "tool_result" && m.content.includes("SETTLED_RECORD"))).toBe(true);
        throw new Error("Synthetic provider transport failure");
      },
    };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "provider-failure-observations", executor: bridge });
    registry.register(subagentTool({ provider, registry,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}) }));
    const result = await new ToolExecutor(registry).execute("agent", {
      task: "Inspect the synthetic record and report its contents.", agent_type: "explore",
    });
    expect(result.success).toBe(false);
    expect(result.failure?.code).toBe("EXECUTION_FAILED");
    expect(result.error).toContain("Synthetic provider transport failure");
    expect(result.output).toContain("Partial completed tool observations");
    expect(result.output).toContain("SETTLED_RECORD: inspected 17 entries");
    expect(result.output).toContain(`[read_file: ${readSucceeded ? "succeeded" : "failed"}]`);
    if (!readSucceeded) expect(result.output).toContain("One entry was unreadable");
    expect(result.output).not.toContain("UNFINISHED_DRAFT");
    expect(reads).toBe(1);
    expect(requests).toBe(2);
  });
}

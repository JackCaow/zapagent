import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { AgentBudget } from "../../agent/budget.js";
import type { LLMProvider } from "../../core/llm.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const usage = { inputTokens: 4, outputTokens: 8, providerUsageReported: true };
function fixture(provider: LLMProvider, budget: AgentBudget, registry = new ToolRegistry(), maxSteps = 8) {
  return new LoopAgent({ provider, budget, registry, maxSteps,
    executor: new ToolExecutor(registry, { onApproval: async () => true }),
    conversation: new ConversationManager({ maxMessages: 100 }) });
}

describe("shared budget request admission", () => {
  test("does not request recovery or synthesis after reaching the exact token cap", async () => {
    let calls = 0;
    const budget = new AgentBudget({ maxTokens: 12 });
    const agent = fixture({ async call() { calls++; return { type: "text", text: "", usage, finishReason: "length" }; } }, budget);
    const result = await agent.run("Explain briefly.");
    expect(calls).toBe(1);
    expect(result.stopped).toBe("budget");
    expect(result.text).toContain("unverified");
    expect(budget.tokensUsed).toBe(12);
  });

  test("accepts a complete response that exactly consumes the token cap", async () => {
    let calls = 0;
    const budget = new AgentBudget({ maxTokens: 12 });
    const result = await fixture({ async call() { calls++; return { type: "text", text: "Complete answer.", usage, finishReason: "stop" }; } }, budget).run("Explain briefly.");
    expect(calls).toBe(1);
    expect(result.stopped).toBeUndefined();
    expect(result.text).toBe("Complete answer.");
  });

  test("does not admit another agent using an already exhausted shared budget", async () => {
    let calls = 0;
    const budget = new AgentBudget({ maxTokens: 12 });
    const provider: LLMProvider = { async call() { calls++; return { type: "text", text: "First answer.", usage, finishReason: "stop" }; } };
    await fixture(provider, budget).run("First task.");
    const result = await fixture(provider, budget).run("Second task.");
    expect(calls).toBe(1);
    expect(result.stopped).toBe("budget");
    expect(budget.stepsUsed).toBe(1);
    expect(budget.tokensUsed).toBe(12);
  });

  test("does not synthesize outside the shared step cap", async () => {
    let calls = 0;
    const budget = new AgentBudget({ maxSteps: 1 });
    const result = await fixture({ async call() { calls++; return { type: "text", text: "", usage, finishReason: "length" }; } }, budget).run("Explain briefly.");
    expect(calls).toBe(1);
    expect(result.stopped).toBe("budget");
    expect(budget.stepsUsed).toBe(1);
    expect(budget.tokensUsed).toBe(12);
  });

  test("an initially exhausted step cap produces an honest local result without calling the provider", async () => {
    let calls = 0;
    const result = await fixture({ async call() { calls++; return { type: "text", text: "Unsupported success", usage }; } }, new AgentBudget({ maxSteps: 0 })).run("Do work.");
    expect(calls).toBe(0);
    expect(result.stopped).toBe("budget");
    expect(result.text).toContain("unverified");
    expect(result.text).not.toContain("Unsupported success");
  });

  test("settles an exact-cap tool result once without another provider call", async () => {
    let requests = 0, writes = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "save", description: "Synthetic write", parameters: z.object({}) }, handler: async () => { writes++; return { success: true, output: "saved once" }; } });
    const provider: LLMProvider = { async call() { requests++; throw new Error("No synthesis budget"); }, async *stream() {
      requests++;
      yield { type: "tool_call_start", toolCallId: "once", toolName: "save" };
      yield { type: "tool_call_delta", toolCallId: "once", partialJson: "{}" };
      yield { type: "done", usage, finishReason: "tool_calls" };
    } };
    const budget = new AgentBudget({ maxTokens: 12 });
    const result = await fixture(provider, budget, registry).run("Save once.");
    expect(requests).toBe(1);
    expect(writes).toBe(1);
    expect(result.toolResults).toHaveLength(1);
    expect(result.stopped).toBe("budget");
  });

  test("charges final synthesis including cached prompt tokens to the shared budget", async () => {
    let requests = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "read", description: "Synthetic read", parameters: z.object({}) }, handler: async () => ({ success: true, output: "observation" }) });
    const provider: LLMProvider = { async call() { requests++; return { type: "text", text: "Observed result; incomplete.", usage: { inputTokens: 2, cacheReadInputTokens: 5, outputTokens: 3, providerUsageReported: true } }; }, async *stream() {
      requests++;
      yield { type: "tool_call_start", toolCallId: "read-once", toolName: "read" };
      yield { type: "tool_call_delta", toolCallId: "read-once", partialJson: "{}" };
      yield { type: "done", usage, finishReason: "tool_calls" };
    } };
    const budget = new AgentBudget({ maxSteps: 2, maxTokens: 30 });
    const result = await fixture(provider, budget, registry, 1).run("Read and summarize.");
    expect(requests).toBe(2);
    expect(result.text).toBe("Observed result; incomplete.");
    expect(budget.stepsUsed).toBe(2);
    expect(budget.tokensUsed).toBe(22);
  });
});

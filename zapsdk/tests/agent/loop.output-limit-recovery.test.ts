import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { AgentBudget } from "../../agent/budget.js";
import type { AgentEvent } from "../../agent/events.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const usage = { inputTokens: 4, outputTokens: 8, providerUsageReported: true };
function fixture(provider: LLMProvider, options: { budget?: AgentBudget; maxOutputTokensRecoveries?: number } = {}) {
  const registry = new ToolRegistry();
  const conversation = new ConversationManager({ maxMessages: 100 });
  const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
    conversation, maxSteps: 8, ...options });
  const observations: AgentEvent[] = [];
  agent.on("observation", event => observations.push(event));
  return { agent, conversation, observations };
}

describe("output-limit recovery", () => {
  for (const streaming of [true, false]) {
    for (const text of ["", " \n\t "]) {
      test(`${streaming ? "stream" : "call"} recovers ${text ? "whitespace" : "absent"} text without an empty assistant prefix`, async () => {
        const requests: Message[][] = [];
        const response = (messages: Message[]): LLMResponse => {
          requests.push(structuredClone(messages));
          return { type: "text", text: requests.length === 1 ? text : "I cannot verify this yet.",
            usage, finishReason: requests.length === 1 ? "length" : "stop" };
        };
        const provider: LLMProvider = { async call(messages) { return response(messages); } };
        if (streaming) provider.stream = async function* (messages): AsyncIterable<LLMChunk> {
          const r = response(messages);
          yield { type: "thinking_delta", text: "Synthetic computation" };
          if (r.text) yield { type: "text_delta", text: r.text };
          yield { type: "done", usage: r.usage, finishReason: r.finishReason };
        };
        const f = fixture(provider);
        const result = await f.agent.run("Explain a concept briefly.");
        expect(requests).toHaveLength(2);
        expect(requests[1].filter(m => m.role === "assistant")).toHaveLength(0);
        const reminder = requests[1].filter(m => m.role === "user").at(-1)?.content;
        expect(reminder).not.toContain("mid-sentence");
        expect(reminder).toContain("without producing a usable answer");
        expect(result.text).toBe("I cannot verify this yet.");
        expect(result.toolResults).toHaveLength(0);
        expect(result.totalUsage).toMatchObject({ inputTokens: 8, outputTokens: 16 });
        expect(f.observations.find(e => e.type === "observation" && e.kind === "max_tokens_recovery")).toMatchObject({ type: "observation", kind: "max_tokens_recovery",
          detail: { attempt: 1, mode: "no_visible_output" } });
      });
    }
  }

  for (const finishReason of ["length", "max_tokens"]) {
    test(`preserves a partial visible answer for ${finishReason}`, async () => {
      let calls = 0;
      const prefix = "  The partial explanation is";
      const provider: LLMProvider = { async call(messages) {
        calls++;
        if (calls === 2) {
          expect(messages.filter(m => m.role === "assistant").at(-1)?.content).toBe(prefix);
          expect(messages.filter(m => m.role === "user").at(-1)?.content).toContain("Resume mid-sentence");
        }
        return { type: "text", text: calls === 1 ? prefix : "continued.", usage,
          finishReason: calls === 1 ? finishReason : "stop" };
      } };
      const f = fixture(provider);
      await f.agent.run("Explain a concept.");
      expect(calls).toBe(2);
      expect(f.observations.find(e => e.type === "observation" && e.kind === "max_tokens_recovery")).toMatchObject({ type: "observation", kind: "max_tokens_recovery",
        detail: { attempt: 1, mode: "partial_text" } });
    });
  }

  test("does not replay a settled tool when the following response hits its output limit", async () => {
    let calls = 0, writes = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "save_fixture", description: "Synthetic write", parameters: z.object({}) },
      handler: async () => { writes++; return { success: true, output: "saved once" }; } });
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream(messages) {
      calls++;
      if (calls === 1) {
        yield { type: "tool_call_start", toolCallId: "once", toolName: "save_fixture" };
        yield { type: "tool_call_delta", toolCallId: "once", partialJson: "{}" };
        yield { type: "done", usage, finishReason: "tool_calls" };
      } else if (calls === 2) {
        yield { type: "thinking_delta", text: "Synthetic computation" };
        yield { type: "done", usage, finishReason: "length" };
      } else {
        expect(messages.filter(m => m.role === "tool_result")).toHaveLength(1);
        yield { type: "text_delta", text: "Saved once; no further action." };
        yield { type: "done", usage, finishReason: "stop" };
      }
    } };
    const agent = new LoopAgent({ provider, registry, maxSteps: 8,
      executor: new ToolExecutor(registry, { onApproval: async () => true }),
      conversation: new ConversationManager({ maxMessages: 100 }) });
    const result = await agent.run("Save once and report.");
    expect(calls).toBe(3);
    expect(writes).toBe(1);
    expect(result.toolResults).toHaveLength(1);
    expect(result.totalUsage).toMatchObject({ inputTokens: 12, outputTokens: 24 });
  });

  test("retains the configured recovery count for repeated reasoning-only limits", async () => {
    let calls = 0;
    const provider: LLMProvider = { async call() {
      calls++;
      return { type: "text", text: "", usage, finishReason: "length" };
    } };
    const f = fixture(provider, { maxOutputTokensRecoveries: 2 });
    await f.agent.run("Explain briefly.");
    expect(calls).toBe(3);
    expect(f.observations.filter(e => e.type === "observation" && e.kind === "max_tokens_recovery")).toHaveLength(2);
  });

  test("does not recover when the response exceeds the shared token budget", async () => {
    let calls = 0;
    const provider: LLMProvider = { async call() {
      calls++;
      return { type: "text", text: "", usage, finishReason: "length" };
    } };
    const f = fixture(provider, { budget: new AgentBudget({ maxTokens: 11 }) });
    const result = await f.agent.run("Explain briefly.");
    expect(result.stopped).toBe("budget");
    expect(calls).toBe(1);
    expect(f.observations.some(e => e.type === "observation" && e.kind === "max_tokens_recovery")).toBe(false);
  });
});

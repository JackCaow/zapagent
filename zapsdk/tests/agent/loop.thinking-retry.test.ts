import { describe, expect, test } from "bun:test";
import { RetryProvider } from "../../core/retry.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { LoopAgent } from "../../agent/loop.js";
import { AgentEventEmitter, type AgentEvent } from "../../agent/events.js";
import { StreamingToolExecutor } from "../../agent/streaming-tool-executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ConversationManager } from "../../memory/conversation.js";
import { z } from "zod";

const done: LLMChunk = { type: "done", usage: { inputTokens: 10, outputTokens: 3, providerUsageReported: true } };
const failure = () => new Error("The socket connection was closed unexpectedly");
async function collect(source: AsyncIterable<LLMChunk>) {
  const chunks: LLMChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}
function loop(provider: LLMProvider, conversation = new ConversationManager({ maxMessages: 100 })) {
  const registry = new ToolRegistry();
  return new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, {}),
    conversation, systemPrompt: "fixture", maxSteps: 3 });
}

describe("reasoning-only stream recovery", () => {
  test("retries only the current request and never replays a completed tool round", async () => {
    let calls = 0;
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "fixture_write", description: "fixture", parameters: z.object({}) },
      handler: async () => { executions++; return { success: true, output: "saved" }; } });
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream(messages) {
      calls++;
      if (calls === 1) {
        yield { type: "tool_call_start", toolCallId: "once", toolName: "fixture_write" };
        yield { type: "tool_call_delta", toolCallId: "once", partialJson: "{}" };
        yield done;
        return;
      }
      expect(messages.filter(m => m.role === "tool_result")).toHaveLength(1);
      yield { type: "thinking_delta", text: "thought" };
      if (calls === 2) throw failure();
      yield { type: "text_delta", text: "finished" };
      yield done;
    } };
    const agent = new LoopAgent({ provider: new RetryProvider(provider, { maxRetries: 2, initialDelayMs: 1 }),
      registry, executor: new ToolExecutor(registry, { onApproval: async () => true }), systemPrompt: "fixture",
      conversation: new ConversationManager({ maxMessages: 100 }), maxSteps: 3 });
    const result = await agent.run("save once");
    expect(result.text).toBe("finished");
    expect(executions).toBe(1);
    expect(calls).toBe(3);
    expect(result.totalUsage).toMatchObject({ inputTokens: 20, outputTokens: 6, providerUsageReported: true, usageIncomplete: true });
  });

  test("keeps non-transient errors terminal even before tools", async () => {
    let calls = 0;
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      calls++; yield { type: "thinking_delta", text: "partial" };
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    } };
    await expect(collect(new RetryProvider(provider, { maxRetries: 2 }).stream([], undefined,
      { allowThinkingRetry: true }))).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  test("abandons the failed attempt before retry; never concatenates thoughts", async () => {
    let requests = 0;
    const inner: LLMProvider = {
      async call() { throw new Error("unused"); },
      async *stream() {
        requests++;
        const text = requests === 1 ? "abandoned thought" : "fresh thought";
        yield { type: "thinking_delta", text, rawDelta: { reasoning_content: text } } as const;
        if (requests === 1) throw failure();
        yield { type: "text_delta", text: "answer" } as const;
        yield done;
      },
    };
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = loop(new RetryProvider(inner, { maxRetries: 2, initialDelayMs: 1 }), conversation);
    const events: AgentEvent[] = [];
    agent.on("*", e => events.push(e));
    const result = await agent.run("hello");
    expect(requests).toBe(2);
    expect(result.text).toBe("answer");
    expect(result.totalUsage).toMatchObject({ inputTokens: 10, outputTokens: 3, usageIncomplete: true, providerUsageReported: true });
    const abandoned = events.find(e => e.type === "content_abandoned");
    expect(abandoned).toMatchObject({ kind: "thinking", attempt: 1, usageUnknown: true });
    expect(events.filter(e => e.type === "content_final" && e.kind === "thinking")
      .map(e => "text" in e ? e.text : "")).toEqual(["fresh thought"]);
    expect(JSON.stringify(conversation.getMessages())).not.toContain("abandoned thought");
    expect(conversation.getMessages().findLast(m => m.role === "assistant")?.raw)
      .toEqual({ reasoning_content: "fresh thought" });
  });

  test("does not opt external stream consumers into reset events", async () => {
    let calls = 0;
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      calls++; yield { type: "thinking_delta", text: "partial" }; throw failure();
    } };
    await expect(collect(new RetryProvider(provider, { maxRetries: 2 }).stream([]))).rejects.toThrow("socket");
    expect(calls).toBe(1);
  });

  for (const unsafe of [
    { type: "text_delta", text: "partial answer" },
    { type: "text_delta", text: "" },
    { type: "tool_call_start", toolCallId: "t", toolName: "write_file" },
    { type: "tool_call_delta", toolCallId: "t", partialJson: "{}" },
    { type: "tool_call_delta", toolCallId: "t", partialJson: "" },
    { type: "tool_call_end", toolCallId: "t" },
    done,
  ] as LLMChunk[]) {
    test(`never retries after ${unsafe.type}, even when opted in`, async () => {
      let calls = 0;
      const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
        calls++; yield { type: "thinking_delta", text: "thought" }; yield unsafe; throw failure();
      } };
      await expect(collect(new RetryProvider(provider, { maxRetries: 2 }).stream([], undefined,
        { allowThinkingRetry: true }))).rejects.toThrow("socket");
      expect(calls).toBe(1);
    });
  }

  test("retains unknown usage when the retry budget is exhausted", async () => {
    let calls = 0;
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      calls++; yield { type: "thinking_delta", text: "partial" }; throw failure();
    } };
    const agent = loop(new RetryProvider(provider, { maxRetries: 2, initialDelayMs: 1 }));
    const events: AgentEvent[] = [];
    agent.on("*", e => events.push(e));
    await expect(agent.run("hello")).rejects.toThrow("socket");
    expect(calls).toBe(3);
    expect(events.filter(e => e.type === "content_abandoned")).toHaveLength(2);
    expect(events.find(e => e.type === "run_ended")).toMatchObject({ usage: { usageIncomplete: true } });
  });

  test("cancellation during retry does not start a fresh attempt or restore abandoned thinking", async () => {
    let calls = 0;
    const controller = new AbortController();
    const conversation = new ConversationManager({ maxMessages: 100 });
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      calls++; yield { type: "thinking_delta", text: "abandoned thought" }; throw failure();
    } };
    const agent = loop(new RetryProvider(provider, { maxRetries: 2, initialDelayMs: 1000 }), conversation);
    agent.on("provider_request", e => { if (e.type === "provider_request" && e.request.phase === "retrying") controller.abort(); });
    await expect(agent.run("hello", { signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(JSON.stringify(conversation.getMessages())).not.toContain("abandoned thought");
  });

  test("consumer rejects a reset after a tool has launched", async () => {
    let executions = 0;
    const executor = new StreamingToolExecutor({ execute: async () => { executions++; return { success: true, output: "done" }; },
      isReadOnly: () => false } as any, new AgentEventEmitter());
    async function* source(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t", toolName: "write" };
      yield { type: "tool_call_delta", toolCallId: "t", partialJson: "{}" };
      yield { type: "thinking_reset", attempt: 1, reason: "CONNECTION_ERROR" };
    }
    await expect(executor.consumeStream(source(), 0)).rejects.toThrow("Cannot reset");
    expect(executions).toBe(1);
  });
});

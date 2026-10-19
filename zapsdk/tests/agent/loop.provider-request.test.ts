import { describe, expect, test } from "bun:test";
import { LoopAgent } from "../../agent/loop.js";
import type { AgentEvent } from "../../agent/events.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { RetryProvider } from "../../core/retry.js";

function agentFor(provider: LLMProvider, fallbackProvider?: LLMProvider, conversation = new ConversationManager({ maxMessages: 100 })) {
  const registry = new ToolRegistry();
  return new LoopAgent({ provider, fallbackProvider, registry, executor: new ToolExecutor(registry, {}),
    conversation, systemPrompt: "fixture", maxSteps: 2 });
}

describe("LoopAgent provider requests", () => {
  test("forwards bounded output statistics without adding them to conversation history", async () => {
    const observed: AgentEvent[] = [];
    const adapter = new OpenAICompatibleProvider({ model: "fixture", client: {
      chat: { completions: { create: async () => (async function* () {
        yield { choices: [{ delta: { reasoning_content: "plan" }, finish_reason: null }] };
        yield { choices: [{ delta: { content: "ANSWER" }, finish_reason: "stop" }] };
      })() } },
    } as any });
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = agentFor(adapter, undefined, conversation);
    agent.on("provider_request", event => observed.push(event));
    expect((await agent.run("hello")).text).toBe("ANSWER");
    expect(observed.find(event => event.type === "provider_request" && event.request.phase === "completed"))
      .toMatchObject({ type: "provider_request", step: 0, request: {
        output: { thinkingChars: 4, textChars: 6, toolArgumentChars: 0 },
      } });
    expect(JSON.stringify(conversation.getMessages())).not.toContain("thinkingChars");
    expect(JSON.stringify(conversation.getMessages())).not.toContain("firstThinkingMs");
  });

  for (const streaming of [false, true]) {
    test(`forwards ${streaming ? "stream" : "call"} lifecycle into the event journal`, async () => {
      const observed: AgentEvent[] = [];
      const provider: LLMProvider = {
        async call(_messages, _tools, opts) {
          opts?.onRequestEvent?.({ phase: "requesting", attempt: 1, maxAttempts: 3, startedAt: 1, at: 1, elapsedMs: 0 });
          return { type: "text", text: "ANSWER", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      if (streaming) provider.stream = async function* (_messages, _tools, opts) {
        opts?.onRequestEvent?.({ phase: "requesting", attempt: 1, maxAttempts: 3, startedAt: 1, at: 1, elapsedMs: 0 });
        yield { type: "text_delta", text: "ANSWER" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      };
      const agent = agentFor(provider);
      agent.on("provider_request", event => observed.push(event));
      await agent.run("hello");
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ type: "provider_request", step: 0, request: { phase: "requesting" } });
    });
  }

  test("does not use a fallback to replay a partial tool stream", async () => {
    let fallbackCalls = 0;
    let primaryCalls = 0;
    const primary: LLMProvider = { async call() { throw new Error("unused"); },
      async *stream(messages): AsyncIterable<LLMChunk> {
        if (++primaryCalls > 1) {
          expect(messages.filter(m => m.role === "tool_result")).toHaveLength(1);
          expect(messages.some(m => m.content.includes("not executed"))).toBe(true);
          yield { type: "text_delta", text: "continued from saved state" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "tool_call_start", toolCallId: "write1", toolName: "write_file" };
        throw new Error("connection lost");
      } };
    const fallback: LLMProvider = { async call() { fallbackCalls++; return { type: "text", text: "replayed", usage: { inputTokens: 1, outputTokens: 1 } }; } };
    expect((await agentFor(primary, fallback).run("write something")).text).toBe("continued from saved state");
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  test("cancelling retry backoff is recorded as user interruption, not an API error", async () => {
    const controller = new AbortController();
    const primary: LLMProvider = {
      async call() { throw Object.assign(new Error("busy"), { status: 503 }); },
      async *stream() { throw Object.assign(new Error("busy"), { status: 503 }); },
    };
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = agentFor(new RetryProvider(primary, { maxRetries: 2, initialDelayMs: 5_000 }), undefined, conversation);
    agent.on("provider_request", event => {
      if (event.type === "provider_request" && event.request.phase === "retrying") controller.abort();
    });
    await expect(agent.run("hello", { signal: controller.signal })).rejects.toThrow("aborted");
    expect(conversation.getMessages().some(message => message.content === "[Request interrupted by user]")).toBe(true);
  });

  test("adapter-level cancellation still preserves received thinking", async () => {
    const controller = new AbortController();
    const adapter = new OpenAICompatibleProvider({ model: "fixture", client: {
      chat: { completions: { create: async () => (async function* () {
        yield { choices: [{ delta: { reasoning_content: "I was planning the work" }, finish_reason: null }] };
        controller.abort();
        await new Promise(() => {});
      })() } },
    } as any });
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = agentFor(adapter, undefined, conversation);
    await expect(agent.run("hello", { signal: controller.signal })).rejects.toThrow("aborted");
    expect(conversation.getMessages().some(message => message.content.includes("I was planning the work"))).toBe(true);
  });
});

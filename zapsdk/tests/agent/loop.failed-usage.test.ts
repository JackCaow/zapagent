import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { AgentEventEmitter, type AgentEvent } from "../../agent/events.js";
import type { LLMCallOptions, LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { ProviderRequest } from "../../core/provider-request.js";
import { RetryProvider } from "../../core/retry.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const done: LLMChunk = { type: "done", usage: {
  inputTokens: 10, outputTokens: 3, providerUsageReported: true,
} };
const failure = () => new Error("socket connection closed");

function fixture(provider: LLMProvider, maxSteps = 3) {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "fixture_write", description: "fixture", parameters: z.object({}) },
    handler: async () => { executions++; return { success: true, output: "saved" }; } });
  const agent = new LoopAgent({ provider, registry, maxSteps, systemPrompt: "fixture",
    executor: new ToolExecutor(registry, { onApproval: async () => true }),
    conversation: new ConversationManager({ maxMessages: 100 }) });
  const events: AgentEvent[] = [];
  agent.on("*", event => events.push(event));
  return { agent, events, executions: () => executions };
}

async function* toolRound(): AsyncIterable<LLMChunk> {
  yield { type: "tool_call_start", toolCallId: "once", toolName: "fixture_write" };
  yield { type: "tool_call_delta", toolCallId: "once", partialJson: "{}" };
  yield done;
}

describe("failed provider request usage accounting", () => {
  test("retains prior usage and tool effects after partial continuation is exhausted", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async call() { throw new Error("unused"); },
      async *stream(_messages, _tools, options) {
        const request = new ProviderRequest(options);
        const attempt = ++calls;
        yield* request.watch((async function* (): AsyncIterable<LLMChunk> {
          if (attempt === 1) { yield* toolRound(); return; }
          yield { type: "text_delta", text: "partial answer" };
          throw failure();
        })());
      },
    };
    const f = fixture(new RetryProvider(provider, { maxRetries: 2, initialDelayMs: 1 }), 10);
    await expect(f.agent.run("save once")).rejects.toThrow("socket");
    expect(calls).toBe(4);
    expect(f.executions()).toBe(1);
    expect(f.events.filter(e => e.type === "content_abandoned")).toHaveLength(0);
    expect(f.events.find(e => e.type === "run_ended")).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 3, providerUsageReported: true, usageIncomplete: true },
    });
    expect(f.events.filter(e => e.type === "run_usage").at(-1)).toMatchObject({
      inputTokens: 0, outputTokens: 0, providerUsageReported: false, usageIncomplete: true,
    });
  });

  test("retains missing usage after a retry before any content is received", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async call() { throw new Error("unused"); },
      async *stream(_messages, _tools, options) {
        const request = new ProviderRequest(options);
        const attempt = ++calls;
        yield* request.watch((async function* (): AsyncIterable<LLMChunk> {
          if (attempt === 1) throw failure();
          yield { type: "text_delta", text: "done" };
          yield done;
        })());
      },
    };
    const f = fixture(new RetryProvider(provider, { maxRetries: 1, initialDelayMs: 1 }));
    const result = await f.agent.run("hello");
    expect(calls).toBe(2);
    expect(result.totalUsage).toMatchObject({ inputTokens: 10, outputTokens: 3, usageIncomplete: true });
    expect(f.events.filter(e => e.type === "content_abandoned")).toHaveLength(0);
    expect(f.events.filter(e => e.type === "run_usage").at(-1)).toMatchObject({
      inputTokens: 10, outputTokens: 3, providerUsageReported: true, usageIncomplete: true,
    });
  });

  test("marks a failed final-synthesis request without losing completed tool usage", async () => {
    let finalCalls = 0;
    const provider: LLMProvider = {
      async call(_messages, _tools, options) {
        finalCalls++;
        const request = new ProviderRequest(options);
        return request.wait(Promise.reject(failure()));
      },
      async *stream(_messages, _tools, options) {
        yield* new ProviderRequest(options).watch(toolRound());
      },
    };
    const f = fixture(provider, 1);
    const result = await f.agent.run("save once");
    expect(result.stopped).toBe("max_steps");
    expect(finalCalls).toBe(1);
    expect(f.executions()).toBe(1);
    expect(result.totalUsage).toMatchObject({ inputTokens: 10, outputTokens: 3, usageIncomplete: true });
  });

  test("keeps the marker on successful final synthesis after an earlier failed attempt", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async call() { return { type: "text", text: "summary", toolCalls: [], usage: {
        inputTokens: 5, outputTokens: 2, providerUsageReported: true,
      } }; },
      async *stream(_messages, _tools, options) {
        const request = new ProviderRequest(options);
        const attempt = ++calls;
        yield* request.watch((async function* (): AsyncIterable<LLMChunk> {
          if (attempt === 1) throw failure();
          yield* toolRound();
        })());
      },
    };
    const f = fixture(new RetryProvider(provider, { maxRetries: 1, initialDelayMs: 1 }), 1);
    const result = await f.agent.run("save once");
    expect(f.executions()).toBe(1);
    expect(result.totalUsage).toMatchObject({ inputTokens: 15, outputTokens: 5, usageIncomplete: true });
    expect(f.events.filter(e => e.type === "run_usage").at(-1)).toMatchObject({
      inputTokens: 5, outputTokens: 2, providerUsageReported: true, usageIncomplete: true,
    });
  });

  test("marks cancellation without retrying the interrupted request", async () => {
    let calls = 0;
    const controller = new AbortController();
    const provider: LLMProvider = {
      async call() { throw new Error("unused"); },
      async *stream(_messages, _tools, options) {
        calls++;
        yield* new ProviderRequest(options).watch((async function* (): AsyncIterable<LLMChunk> {
          yield { type: "thinking_delta", text: "partial" };
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        })());
      },
    };
    const f = fixture(new RetryProvider(provider, { maxRetries: 2, initialDelayMs: 1 }));
    await expect(f.agent.run("hello", { signal: controller.signal })).rejects.toThrow("aborted");
    expect(calls).toBe(1);
    expect(f.events.find(e => e.type === "run_ended")).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, providerUsageReported: false, usageIncomplete: true },
    });
  });

  test("does not carry failure state into the next run or retain listeners after completion", async () => {
    let calls = 0;
    let lastOptions: LLMCallOptions | undefined;
    const provider: LLMProvider = {
      async call() { throw new Error("unused"); },
      async *stream(_messages, _tools, options) {
        lastOptions = options;
        const request = new ProviderRequest(options);
        const attempt = ++calls;
        yield* request.watch((async function* (): AsyncIterable<LLMChunk> {
          yield { type: "text_delta", text: "answer" };
          if (attempt === 1) throw failure();
          yield done;
        })());
      },
    };
    const f = fixture(provider);
    expect((await f.agent.run("first")).text).toBe("answer");
    expect(f.events.find(e => e.type === "run_ended")).toMatchObject({ usage: { usageIncomplete: true } });
    const result = await f.agent.run("second");
    expect(result.totalUsage.usageIncomplete).toBeUndefined();
    lastOptions?.onRequestEvent?.({ phase: "failed", attempt: 1, maxAttempts: 1, startedAt: 0, at: 1, elapsedMs: 1 });
    expect(result.totalUsage.usageIncomplete).toBeUndefined();
  });

  test("does not attribute forwarded child request failures to the root counters", async () => {
    const provider: LLMProvider = {
      async call() { throw new Error("unused"); },
      async *stream() { yield { type: "text_delta", text: "done" }; yield done; },
    };
    const f = fixture(provider);
    const emitter = (f.agent as unknown as { emitter: AgentEventEmitter }).emitter;
    f.agent.on("run_step", () => emitter.emit({ type: "provider_request", path: ["child"], step: 0,
      request: { phase: "failed", attempt: 1, maxAttempts: 1, startedAt: 0, at: 1, elapsedMs: 1 } }));
    expect((await f.agent.run("hello")).totalUsage.usageIncomplete).toBeUndefined();
  });
});

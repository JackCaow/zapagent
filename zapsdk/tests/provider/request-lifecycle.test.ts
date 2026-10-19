import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMCallOptions, LLMProvider, ProviderRequestEvent } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { OpenAIResponsesProvider } from "../../core/providers/openai-responses.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { AnthropicProvider } from "../../core/providers/anthropic.js";
import { RetryProvider } from "../../core/retry.js";
import { ProviderRequest, ProviderRequestTimeoutError } from "../../core/provider-request.js";

const messages = [{ role: "user" as const, content: "hello" }];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function collect(source: AsyncIterable<LLMChunk>) {
  const chunks: LLMChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}
function provider(kind: "openai" | "anthropic" | "openai-responses", create: (params: any, opts: any) => any) {
  return kind === "openai-responses"
    ? new OpenAIResponsesProvider({ model: "fixture", client: { responses: { create } } as any })
    : kind === "openai"
    ? new OpenAICompatibleProvider({ model: "fixture", client: { chat: { completions: { create } } } as any })
    : new AnthropicProvider({ model: "fixture", client: { messages: { create, stream: create } } as any });
}

for (const kind of ["openai", "anthropic", "openai-responses"] as const) {
  describe(`${kind} request lifecycle`, () => {
    test("bounds stream creation before headers and aborts the transport", async () => {
      let signal: AbortSignal | undefined;
      const events: ProviderRequestEvent[] = [];
      const adapter = provider(kind, (_params, options) => {
        signal = options.signal;
        expect(options.maxRetries).toBe(0);
        return new Promise(() => {});
      });
      await expect(collect(adapter.stream(messages, undefined, {
        requestTimeoutMs: 35, onRequestEvent: event => events.push(event),
      }))).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      expect(signal?.aborted).toBe(true);
      expect(events.map(event => event.phase)).toEqual(["requesting", "failed"]);
    });

    test("bounds non-streaming calls and forwards cancellation", async () => {
      let signal: AbortSignal | undefined;
      const adapter = provider(kind, (_params, options) => {
        signal = options.signal;
        return new Promise(() => {});
      });
      await expect(adapter.call(messages, undefined, { requestTimeoutMs: 35 }))
        .rejects.toBeInstanceOf(ProviderRequestTimeoutError);
      expect(signal?.aborted).toBe(true);
      const controller = new AbortController();
      const call = adapter.call(messages, undefined, { signal: controller.signal });
      controller.abort();
      await expect(call).rejects.toMatchObject({ name: "AbortError" });
      expect(signal?.aborted).toBe(true);
    });

    test("parent cancellation stops a stalled stream promptly", async () => {
      let calls = 0;
      const adapter = provider(kind, () => { calls++; return new Promise(() => {}); });
      const controller = new AbortController();
      const result = collect(adapter.stream(messages, undefined, { signal: controller.signal }));
      controller.abort();
      expect(await result).toEqual([]);
      const stopped = new AbortController();
      stopped.abort();
      await expect(collect(adapter.stream(messages, undefined, { signal: stopped.signal }))).rejects.toBeDefined();
      expect(calls).toBe(1);
    });

    test("raw keep-alives do not satisfy first meaningful output", async () => {
      const adapter = provider(kind, async () => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 15; i++) {
            yield kind === "openai" ? { choices: [{ delta: {}, finish_reason: null }] } : { type: "ping" };
            await sleep(10);
          }
        },
      }));
      const events: ProviderRequestEvent[] = [];
      await expect(collect(adapter.stream(messages, undefined, {
        requestTimeoutMs: 300, firstOutputTimeoutMs: 45, onRequestEvent: event => events.push(event),
      }))).rejects.toMatchObject({ code: "FIRST_OUTPUT_TIMEOUT" });
      expect(events.map(event => event.phase)).toEqual(["requesting", "waiting_output", "failed"]);
    });

    test("real output removes the first-output deadline without removing raw idle protection", async () => {
      const events: ProviderRequestEvent[] = [];
      const adapter = provider(kind, async () => ({
        async *[Symbol.asyncIterator]() {
          yield kind === "openai-responses" ? { type: "response.output_text.delta", delta: "hello" }
            : kind === "openai" ? { choices: [{ delta: { content: "hello" }, finish_reason: null }] }
            : { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } };
          await sleep(65);
          yield kind === "openai-responses" ? { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] } }
            : kind === "openai" ? { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
            : { type: "message_stop" };
        },
        finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }),
      }));
      const chunks = await collect(adapter.stream(messages, undefined, {
        firstOutputTimeoutMs: 35, onRequestEvent: event => events.push(event),
      }));
      expect(chunks[0]).toEqual({ type: "text_delta", text: "hello" });
      expect(events.map(event => event.phase)).toEqual(["requesting", "waiting_output", "streaming", "completed"]);
    });
  });
}

describe("request guard", () => {
  test("broken telemetry cannot break deadline cleanup", async () => {
    const request = new ProviderRequest({ requestTimeoutMs: 20, onRequestEvent() { throw new Error("observer bug"); } });
    await expect(request.wait(new Promise(() => {}))).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(request.signal.aborted).toBe(true);
  });

  test("thinking is meaningful; empty deltas are not", async () => {
    const request = new ProviderRequest({ firstOutputTimeoutMs: 30 });
    async function* source(): AsyncIterable<LLMChunk> {
      request.responseReceived();
      yield { type: "thinking_delta", text: "reasoning" };
      await sleep(50);
      yield { type: "text_delta", text: "answer" };
    }
    expect(await collect(request.watch(source()))).toHaveLength(2);
  });

  test("late response callbacks cannot resurrect a timed-out attempt", async () => {
    const events: ProviderRequestEvent[] = [];
    const request = new ProviderRequest({ requestTimeoutMs: 20, onRequestEvent: event => events.push(event) });
    await expect(request.wait(sleep(60))).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    request.responseReceived();
    expect(events.map(event => event.phase)).toEqual(["requesting", "failed"]);
  });

  test("Anthropic MessageStream construction is not mistaken for HTTP response", async () => {
    const client = new Anthropic({ apiKey: "fixture", fetch: (() => new Promise(() => {})) as any });
    const events: ProviderRequestEvent[] = [];
    const adapter = new AnthropicProvider({ model: "fixture", client });
    await expect(collect(adapter.stream(messages, undefined, {
      requestTimeoutMs: 40, onRequestEvent: event => events.push(event),
    }))).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(events.map(event => event.phase)).toEqual(["requesting", "failed"]);
  });

  test("Anthropic connect starts the output deadline even before any SSE frame", async () => {
    const client = new Anthropic({ apiKey: "fixture", fetch: (async () => new Response(new ReadableStream(), {
      headers: { "content-type": "text/event-stream" },
    })) as any });
    const events: ProviderRequestEvent[] = [];
    await expect(collect(new AnthropicProvider({ model: "fixture", client }).stream(messages, undefined, {
      requestTimeoutMs: 500, firstOutputTimeoutMs: 40, onRequestEvent: event => events.push(event),
    }))).rejects.toMatchObject({ code: "FIRST_OUTPUT_TIMEOUT" });
    expect(events.map(event => event.phase)).toEqual(["requesting", "waiting_output", "failed"]);
  });

  test("actual SDK plus RetryProvider makes three HTTP attempts, not nine", async () => {
    let calls = 0;
    const client = new OpenAI({ apiKey: "fixture", maxRetries: 2, fetch: (async () => {
      calls++;
      return Response.json({ error: { message: "busy" } }, { status: 503 });
    }) as any });
    const retried = new RetryProvider(new OpenAICompatibleProvider({ model: "fixture", client }), { maxRetries: 2, initialDelayMs: 1 });
    const events: ProviderRequestEvent[] = [];
    await expect(collect(retried.stream(messages, undefined, { onRequestEvent: event => events.push(event) }))).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
    expect(events.filter(event => event.phase === "retrying").map(event => [event.attempt, event.reason])).toEqual([[2, "HTTP_503"], [3, "HTTP_503"]]);
  });

  test("Anthropic SDK retries are also disabled on injected clients", async () => {
    let calls = 0;
    const client = new Anthropic({ apiKey: "fixture", maxRetries: 2, fetch: (async () => {
      calls++;
      return Response.json({ error: { type: "overloaded_error", message: "busy" } }, { status: 503 });
    }) as any });
    const retry = new RetryProvider(new AnthropicProvider({ model: "fixture", client }), { maxRetries: 2, initialDelayMs: 1 });
    await expect(collect(retry.stream(messages))).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
  });
});

describe("RetryProvider", () => {
  for (const mode of ["call", "stream"] as const) {
    for (const code of ["REQUEST_TIMEOUT", "FIRST_OUTPUT_TIMEOUT"] as const) {
      for (const policy of [
        { label: "default", patterns: undefined, attempts: 3 },
        { label: "empty whitelist", patterns: [], attempts: 1 },
        { label: "HTTP-only whitelist", patterns: ["429"], attempts: 1 },
        { label: "matching whitelist", patterns: [code.toLowerCase()], attempts: 3 },
      ]) {
        test(`${mode} ${code} respects ${policy.label}`, async () => {
          let calls = 0;
          const events: ProviderRequestEvent[] = [];
          const error = new ProviderRequestTimeoutError(code, 35);
          const fail = () => { calls++; throw error; };
          const inner: LLMProvider = { async call() { return fail(); }, async *stream() { fail(); } };
          const retry = new RetryProvider(inner, {
            maxRetries: 2, initialDelayMs: 1, retryableErrors: policy.patterns,
          });
          const options = { onRequestEvent: (event: ProviderRequestEvent) => events.push(event) };
          await expect(mode === "call" ? retry.call(messages, undefined, options)
            : collect(retry.stream(messages, undefined, options))).rejects.toBe(error);
          expect(calls).toBe(policy.attempts);
          expect(events.filter(event => event.phase === "retrying")).toHaveLength(policy.attempts - 1);
        });
      }
    }
  }

  for (const status of [400, 401, 403, 404, 422]) {
    test(`HTTP ${status} is not retried`, async () => {
      let calls = 0;
      const inner: LLMProvider = { async call() { calls++; throw Object.assign(new Error("bad request"), { status }); } };
      const retry = new RetryProvider(inner, { maxRetries: 2, initialDelayMs: 1 });
      await expect(retry.call(messages)).rejects.toMatchObject({ status });
      expect(calls).toBe(1);
    });
  }

  test("unknown programming errors are not retried", async () => {
    let calls = 0;
    const retry = new RetryProvider({ async call() { calls++; throw new Error("schema bug"); } }, { maxRetries: 2 });
    await expect(retry.call(messages)).rejects.toThrow("schema bug");
    expect(calls).toBe(1);
  });

  for (const chunk of [
    { type: "text_delta", text: "partial" },
    { type: "thinking_delta", text: "reasoning" },
    { type: "tool_call_start", toolCallId: "tool1", toolName: "write_file" },
  ] as LLMChunk[]) {
    test(`does not replay after ${chunk.type}`, async () => {
      let calls = 0;
      const inner: LLMProvider = {
        async call() { throw new Error("unused"); },
        async *stream() { calls++; yield chunk; throw Object.assign(new Error("busy"), { status: 503 }); },
      };
      await expect(collect(new RetryProvider(inner, { maxRetries: 2, initialDelayMs: 1 }).stream(messages)))
        .rejects.toMatchObject({ status: 503 });
      expect(calls).toBe(1);
    });
  }

  for (const mode of ["call", "stream"] as const) {
    test(`cancels ${mode} backoff and never starts another attempt`, async () => {
      let calls = 0;
      const controller = new AbortController();
      const options: LLMCallOptions = { signal: controller.signal, onRequestEvent(event) {
        if (event.phase === "retrying") setTimeout(() => controller.abort(), 15);
      } };
      const fail = () => { calls++; throw Object.assign(new Error("busy"), { status: 503 }); };
      const inner: LLMProvider = { async call() { return fail(); }, async *stream() { fail(); } };
      const retry = new RetryProvider(inner, { maxRetries: 2, initialDelayMs: 5_000 });
      const started = Date.now();
      await expect(mode === "call" ? retry.call(messages, undefined, options) : collect(retry.stream(messages, undefined, options)))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(calls).toBe(1);
    });
  }
});

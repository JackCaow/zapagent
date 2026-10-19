import { expect, test } from "bun:test";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { RetryProvider } from "../../core/retry.js";
import { ProviderRequest, ProviderRequestTimeoutError } from "../../core/provider-request.js";
import { AutoCompact } from "../../context/autocompact.js";
import { ReactiveCompact } from "../../context/reactive-compact.js";

const messages = [{ role: "user" as const, content: "synthetic input" }];
async function consume(source: AsyncIterable<LLMChunk>) { for await (const _ of source) {} }

for (const streaming of [false, true]) {
  test(`${streaming ? "stream" : "call"} rejects an expired first attempt without transport or retry`, async () => {
    let calls = 0, retries = 0;
    const inner: LLMProvider = {
      async call() { calls++; throw new Error("unexpected transport"); },
      async *stream() { calls++; throw new Error("unexpected transport"); },
    };
    const provider = new RetryProvider(inner, { maxRetries: 2, onRetry: () => { retries++; } });
    const options = { deadline: { atMs: 100, now: () => 100 } };
    const result = streaming ? consume(provider.stream(messages, [], options)) : provider.call(messages, [], options);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    expect(retries).toBe(0);
  });

  test(`${streaming ? "stream" : "call"} rechecks the deadline after retry backoff`, async () => {
    let now = 0, calls = 0;
    const fail = () => { calls++; throw new ProviderRequestTimeoutError("REQUEST_TIMEOUT", 1); };
    const inner: LLMProvider = { async call() { return fail(); }, async *stream() { fail(); } };
    const provider = new RetryProvider(inner, { maxRetries: 2, initialDelayMs: 1,
      onRetry: () => { now = 100; } });
    const options = { deadline: { atMs: 100, now: () => now } };
    const result = streaming ? consume(provider.stream(messages, [], options)) : provider.call(messages, [], options);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
}

test("request lifecycle rejects an expired deadline before emitting requesting", () => {
  let events = 0;
  expect(() => new ProviderRequest({ deadline: { atMs: 100, now: () => 101 },
    onRequestEvent: () => { events++; } })).toThrow("Provider execution deadline exceeded");
  expect(events).toBe(0);
});

test("reactive compaction cannot restart transport after compaction consumes the budget", async () => {
  let now = 0, calls = 0;
  const compact = new ReactiveCompact({ onCompact: messages => { now = 100; return messages; } });
  const provider: LLMProvider = { async call() { calls++; throw new Error("maximum context length exceeded"); } };
  await expect(compact.callWithCompaction(provider, messages, [], { deadline: { atMs: 100, now: () => now } }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

test("invalid auto-summary cannot request repair after its budget expires", async () => {
  let now = 0, calls = 0;
  const compact = new AutoCompact({ charThreshold: 10, keepRecent: 1 });
  const history = [...messages, ...messages, ...messages];
  const provider: LLMProvider = { async call() {
    calls++; now = 100;
    return { type: "text", text: "invalid summary", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const result = await compact.compact(history, provider, { deadline: { atMs: 100, now: () => now } });
  expect(calls).toBe(1);
  expect(result.summary).toBe("");
  expect(result.messages).toBe(history);
  expect(result.failureReason).toContain("deadline exceeded");
});

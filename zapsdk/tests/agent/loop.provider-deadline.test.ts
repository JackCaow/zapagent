import { expect, test } from "bun:test";
import { LoopAgent } from "../../agent/loop.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse } from "../../core/types.js";
import { RetryProvider } from "../../core/retry.js";
import { ProviderRequestTimeoutError } from "../../core/provider-request.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";

const response = (): LLMResponse => ({ type: "text", text: "late answer", usage: { inputTokens: 1, outputTokens: 1 } });

for (const streaming of [false, true]) for (const recovery of ["retry", "fallback", "compact"] as const) {
  test(`${streaming ? "stream" : "call"} ${recovery} cannot start after the run budget expires`, async () => {
    let now = 0;
    const attempts: number[] = [];
    const fail = () => {
      attempts.push(now);
      if (attempts.length > 1) return;
      now = 2000;
      if (recovery === "compact") throw new Error("maximum context length exceeded");
      throw new ProviderRequestTimeoutError("FIRST_OUTPUT_TIMEOUT", 1);
    };
    const inner: LLMProvider = { async call() { fail(); return response(); } };
    if (streaming) inner.stream = async function* () {
      if (recovery === "retry") yield { type: "thinking_delta", text: "partial reasoning" };
      fail();
      yield { type: "text_delta", text: response().text };
      yield { type: "done", usage: response().usage };
    };
    const fallback: LLMProvider = { async call() { attempts.push(now); return response(); } };
    const registry = new ToolRegistry();
    const retry = new RetryProvider(inner, { maxRetries: 1, initialDelayMs: 0 });
    const provider = recovery !== "retry" ? inner : streaming ? retry : { call: retry.call.bind(retry) };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      ...(recovery === "fallback" ? { fallbackProvider: fallback } : {}),
      timeoutMs: 1000, forceFinishTimeoutMs: 100, now: () => now });
    const result = await agent.run("Synthetic recovery deadline.");
    expect(attempts).toEqual([0]);
    expect(result.stopped).toBe("timeout");
    expect(result.text).not.toBe("late answer");
  });
}

test("final synthesis retries share its remaining deadline", async () => {
  let now = 0;
  const calls: number[] = [];
  const inner: LLMProvider = {
    async *stream() {
      now = 950;
      throw new Error("synthetic late failure");
    },
    async call() {
      calls.push(now);
      if (calls.length === 1) { now = 2000; throw new ProviderRequestTimeoutError("REQUEST_TIMEOUT", 1); }
      return response();
    },
  };
  const registry = new ToolRegistry();
  const agent = new LoopAgent({ provider: new RetryProvider(inner, { maxRetries: 1, initialDelayMs: 0 }),
    registry, executor: new ToolExecutor(registry), timeoutMs: 1000, forceFinishTimeoutMs: 100, now: () => now });
  const result = await agent.run("Synthetic finalization deadline.");
  expect(calls).toEqual([950]);
  expect(result.stopped).toBe("timeout");
  expect(result.text).toContain("unverified");
});

test("automatic summarizer retries share the run budget before the main step", async () => {
  let now = 0, summaryCalls = 0, mainCalls = 0;
  const summarizer = new RetryProvider({ async call() {
    summaryCalls++; now = 2000;
    throw new ProviderRequestTimeoutError("REQUEST_TIMEOUT", 1);
  } }, { maxRetries: 2, initialDelayMs: 0 });
  const registry = new ToolRegistry();
  const agent = new LoopAgent({ provider: { async call() { mainCalls++; return response(); } }, summarizer,
    registry, executor: new ToolExecutor(registry), timeoutMs: 1000, forceFinishTimeoutMs: 100,
    autoCompactThreshold: 10, now: () => now });
  const result = await agent.run("Synthetic long input for automatic compaction.");
  expect(summaryCalls).toBe(1);
  expect(mainCalls).toBe(0);
  expect(result.stopped).toBe("timeout");
});

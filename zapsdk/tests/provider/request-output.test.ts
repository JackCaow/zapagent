import { describe, expect, test } from "bun:test";
import type { ProviderRequestEvent } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { RetryProvider } from "../../core/retry.js";
import { ProviderRequest } from "../../core/provider-request.js";

const messages = [{ role: "user" as const, content: "fixture" }];
const frame = (delta: Record<string, unknown>) => ({ choices: [{ delta, finish_reason: null }] });
async function collect(source: AsyncIterable<LLMChunk>) {
  const chunks: LLMChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}
function adapter(source: () => AsyncIterable<unknown>) {
  return new OpenAICompatibleProvider({ model: "fixture", client: {
    chat: { completions: { create: async () => source() } },
  } as any });
}

describe("provider output telemetry", () => {
  test("empty frames and usage do not invent a first output time", async () => {
    const events: ProviderRequestEvent[] = [];
    const request = new ProviderRequest({ onRequestEvent: e => events.push(e) });
    await collect(request.watch((async function* (): AsyncIterable<LLMChunk> {
      yield { type: "thinking_delta", text: "" };
      yield { type: "text_delta", text: "" };
      yield { type: "tool_call_delta", toolCallId: "empty", partialJson: "" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 0 } };
    })()));
    expect(events.at(-1)).toMatchObject({ phase: "completed" });
    expect(events.at(-1)!.output).toEqual({ thinkingChars: 0, textChars: 0, toolArgumentChars: 0 });
    expect(events.some(e => e.phase === "streaming")).toBe(false);
  });

  test("non-streaming responses do not claim observed stream statistics", async () => {
    const events: ProviderRequestEvent[] = [];
    const provider = new OpenAICompatibleProvider({ model: "fixture", client: {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } },
    } as any });
    expect((await provider.call(messages, undefined, { onRequestEvent: e => events.push(e) })).text).toBe("answer");
    expect(events.at(-1)!.phase).toBe("completed");
    expect(events.every(e => e.output === undefined)).toBe(true);
  });

  test("distinguishes thinking, text and tool arguments without retaining their content", async () => {
    const events: ProviderRequestEvent[] = [];
    const provider = adapter(async function* () {
      yield frame({});
      yield frame({ reasoning_content: "secret reasoning" });
      yield frame({ content: "ok" });
      yield frame({ tool_calls: [{ index: 0, id: "call1", function: { name: "fixture", arguments: '{"x":' } }] });
      yield frame({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] });
      yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 3 } };
    });
    const chunks = await collect(provider.stream(messages, undefined, { onRequestEvent: e => events.push(e) }));
    const streaming = events.find(e => e.phase === "streaming")!;
    const completed = events.find(e => e.phase === "completed")!;
    expect(completed.output).toMatchObject({ thinkingChars: 16, textChars: 2, toolArgumentChars: 7 });
    expect(completed.output!.firstThinkingMs).toBeGreaterThanOrEqual(0);
    expect(completed.output!.firstTextMs).toBeGreaterThanOrEqual(completed.output!.firstThinkingMs!);
    expect(completed.output!.firstToolCallMs).toBeGreaterThanOrEqual(completed.output!.firstTextMs!);
    expect(streaming.output).toMatchObject({ thinkingChars: 16, textChars: 0, toolArgumentChars: 0 });
    expect(streaming.output!.firstTextMs).toBeUndefined();
    expect(streaming.output).not.toBe(completed.output);
    expect(events.map(e => e.phase).filter((phase, index, phases) => phase !== "streaming" || index === 0 || phase !== phases[index - 1]))
      .toEqual(["requesting", "waiting_output", "streaming", "completed"]);
    expect(JSON.stringify(events)).not.toContain("secret reasoning");
    expect(JSON.stringify(events)).not.toContain('"x"');
    expect(chunks.filter(c => c.type === "tool_call_start")).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 2, outputTokens: 3 } });
  });

  test("failed thinking attempts retain their own counts while retries start fresh", async () => {
    const events: ProviderRequestEvent[] = [];
    let attempt = 0;
    const provider = new RetryProvider(adapter(async function* () {
      if (++attempt === 1) {
        yield frame({ reasoning_content: "old" });
        throw Object.assign(new Error("busy"), { status: 503 });
      }
      yield frame({ content: "new" });
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    }), { maxRetries: 1, initialDelayMs: 1 });
    const chunks = await collect(provider.stream(messages, undefined, { allowThinkingRetry: true, onRequestEvent: e => events.push(e) }));
    expect(events.find(e => e.phase === "failed")).toMatchObject({ attempt: 1, output: { thinkingChars: 3, textChars: 0, toolArgumentChars: 0 } });
    const completed = events.find(e => e.phase === "completed")!;
    expect(completed).toMatchObject({ attempt: 2, output: { thinkingChars: 0, textChars: 3, toolArgumentChars: 0 } });
    expect(completed.output!.firstThinkingMs).toBeUndefined();
    expect(chunks.some(c => c.type === "thinking_reset")).toBe(true);
    expect(attempt).toBe(2);
  });

  test("cancellation records thinking-only progress without inventing visible output", async () => {
    const events: ProviderRequestEvent[] = [];
    const controller = new AbortController();
    const provider = adapter(async function* () {
      yield frame({ reasoning_content: "pending" });
      controller.abort();
      await new Promise(() => {});
    });
    const chunks = await collect(provider.stream(messages, undefined, { signal: controller.signal, onRequestEvent: e => events.push(e) }));
    const failed = events.find(e => e.phase === "failed")!;
    expect(failed).toMatchObject({ reason: "AbortError", output: { thinkingChars: 7, textChars: 0, toolArgumentChars: 0 } });
    expect(failed.output!.firstTextMs).toBeUndefined();
    expect(failed.output!.firstToolCallMs).toBeUndefined();
    expect(events.some(e => e.phase === "completed")).toBe(false);
    expect(chunks).toHaveLength(1);
  });
});

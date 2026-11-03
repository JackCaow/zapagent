import { expect, test } from "bun:test";
import { z } from "zod";
import { OpenAIResponsesProvider } from "../../core/providers/openai-responses.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import type { LLMChunk, Message } from "../../core/types.js";

const text = (value: string, phase = "final_answer") => ({ type: "message", role: "assistant", phase,
  content: [{ type: "output_text", text: value }] });
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-state" };
const fn = (id: string, args = '{"value":"ok"}') => ({ type: "function_call", call_id: id, name: "echo", arguments: args });
const terminal = (output: unknown[]) => ({ type: "response.completed", response: { status: "completed", output,
  usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 40 } } } });
const reply = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "Content-Type": "text/event-stream" } });
const messages: Message[] = [{ role: "system", content: "Project rules" }, { role: "user", content: "hello" }];

test("pins Codex credentials to its backend, strips unsupported controls and resolves fresh credentials on every call", async () => {
  let calls = 0;
  const bodies: any[] = [];
  const provider = new OpenAIResponsesProvider({ model: "account-model", baseURL: "https://untrusted.invalid", apiKey: "wrong-key",
    extraRequestParams: { reasoning_effort: "high", max_output_tokens: 42, temperature: 1, top_p: 1, store: true, stream: false },
    codex: { getCredentials: async () => ({ accessToken: `rotated-${++calls}`, accountId: "acct" }),
      fetch: (async (url, init) => {
        expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer rotated-${calls}`);
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("acct");
        bodies.push(JSON.parse(String(init?.body)));
        return reply([{ type: "response.output_text.delta", delta: "Hello" }, terminal([reasoning, text("Hello")])]);
      }) as typeof fetch } });
  const first = await provider.call(messages);
  expect(first.text).toBe("Hello");
  expect(first.usage).toMatchObject({ inputTokens: 60, outputTokens: 12, cacheReadInputTokens: 40 });
  expect(bodies[0]).toMatchObject({ instructions: "Project rules", input: [{ role: "user", content: "hello" }], store: false, stream: true,
    reasoning: { effort: "high" } });
  for (const key of ["max_output_tokens", "temperature", "top_p"]) expect(bodies[0][key]).toBeUndefined();
  const history = [...messages, { role: "assistant" as const, content: first.text, raw: first.raw }, { role: "user" as const, content: "continue" }];
  await provider.call(history, undefined, { model: "override" });
  expect(calls).toBe(2);
  expect(bodies[1].model).toBe("override");
  expect(bodies[1].input.find((item: any) => item.type === "reasoning")).toEqual(reasoning);
  expect(bodies[1].input.find((item: any) => item.role === "assistant").phase).toBe("final_answer");
  const chat = new OpenAICompatibleProvider({ model: "other", apiKey: "fixture" }).serializeMessages(history);
  expect(JSON.stringify(chat)).not.toContain("encrypted-state");
});

test("Codex withholds complete tool arguments until terminal success and preserves parallel calls", async () => {
  let terminalDelivered = false;
  const stream = new ReadableStream({ start(controller) {
    const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    emit({ type: "response.output_item.added", output_index: 0, item: fn("call_a", "") });
    emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"value":"ok"}' });
    setTimeout(() => { terminalDelivered = true; emit(terminal([fn("call_a"), fn("call_b")])); controller.close(); }, 25);
  } });
  const provider = new OpenAIResponsesProvider({ model: "test", codex: {
    getCredentials: async () => ({ accessToken: "token" }),
    fetch: (async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch,
  } });
  const chunks: LLMChunk[] = [];
  for await (const chunk of provider.stream(messages, [{ name: "echo", description: "echo", parameters: z.object({ value: z.string() }) }])) {
    if (chunk.type.startsWith("tool_call")) expect(terminalDelivered).toBe(true);
    chunks.push(chunk);
  }
  expect(chunks.filter(chunk => chunk.type === "tool_call_start")).toHaveLength(2);
  expect(chunks.at(-1)?.type).toBe("done");
});

test("Codex failed/truncated streams never release a speculative tool call", async () => {
  for (const ending of [null, { type: "response.failed", response: { status: "failed", output: [], error: { message: "failed" } } },
    { type: "response.incomplete", response: { status: "incomplete", output: [fn("call_a")], incomplete_details: { reason: "max_output_tokens" } } }]) {
    const provider = new OpenAIResponsesProvider({ model: "test", codex: { getCredentials: async () => ({ accessToken: "token" }),
      fetch: (async () => reply([{ type: "response.output_item.added", output_index: 0, item: fn("call_a", "") },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"value":"ok"}' }, ...(ending ? [ending] : [])])) as typeof fetch } });
    const chunks: LLMChunk[] = [];
    try { for await (const chunk of provider.stream(messages)) chunks.push(chunk); }
    catch (error) { expect(error).toBeInstanceOf(Error); }
    expect(chunks.filter(chunk => chunk.type.startsWith("tool_call"))).toHaveLength(0);
  }
});

test("Codex call marks malformed JSON and preserves tool results for the next turn", async () => {
  let body: any;
  const provider = new OpenAIResponsesProvider({ model: "test", codex: { getCredentials: async () => ({ accessToken: "token" }),
    fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)); return reply([terminal([fn("call_a", "[1]")])]); }) as typeof fetch } });
  const result = await provider.call(messages);
  expect(result.toolCalls?.[0].argumentParseError).toContain("Malformed");
  await provider.call([...messages, { role: "assistant", content: "", toolCalls: result.toolCalls, raw: result.raw },
    { role: "tool_result", toolCallId: "call_a", content: "invalid arguments" }]);
  expect(body.input.find((item: any) => item.type === "function_call_output")).toEqual({ type: "function_call_output", call_id: "call_a", output: "invalid arguments" });
});

test("Codex request timeout also bounds credential resolution", async () => {
  let fetched = false;
  const provider = new OpenAIResponsesProvider({ model: "test", codex: { getCredentials: () => new Promise(() => {}),
    fetch: (async () => { fetched = true; return reply([]); }) as typeof fetch } });
  await expect(provider.call(messages, undefined, { requestTimeoutMs: 20 })).rejects.toThrow("REQUEST_TIMEOUT");
  expect(fetched).toBe(false);
});


test("Codex resolves effort per final wire model for call/stream and honors explicit default over flat/nested legacy settings", async () => {
  const profiles = { full: { levels: ["low", "max", "ultra"].map(effort => ({ effort })) }, small: { levels: [{ effort: "low" }] }, empty: { levels: [] } };
  const preferences: Record<string, string | null> = { full: "ULTRA", small: "max" };
  const extra: Record<string, unknown> = { reasoning_effort: "max", reasoning: { summary: "auto", effort: "high" } };
  const bodies: any[] = [];
  const provider = new OpenAIResponsesProvider({ model: "full", extraRequestParams: extra, codex: {
    getCredentials: async () => ({ accessToken: "fixture" }), reasoningByModel: profiles, effortByModel: preferences,
    fetch: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return reply([terminal([text("ok")])]); }) as typeof fetch,
  } });
  await provider.call(messages);
  expect(bodies.at(-1).reasoning).toEqual({ effort: "ultra", summary: "auto" });
  for (const model of ["small", "empty"]) {
    for await (const _chunk of provider.stream(messages, undefined, { model })) { /* consume */ }
    expect(bodies.at(-1).reasoning).toEqual({ summary: "auto" });
  }
  preferences.full = null;
  await provider.call(messages);
  expect(bodies.at(-1).reasoning).toEqual({ summary: "auto" });
  delete preferences.full;
  delete extra.reasoning_effort;
  await provider.call(messages);
  expect(bodies.at(-1).reasoning).toEqual({ summary: "auto" }); // nested high unsupported
  extra.model = "small";
  extra.reasoning_effort = "ultra";
  await provider.call(messages, undefined, { model: "full" });
  expect(bodies.at(-1).model).toBe("small");
  expect(bodies.at(-1).reasoning).toEqual({ summary: "auto" });
  delete extra.model;
  await provider.call(messages, undefined, { model: "unknown" });
  expect(bodies.at(-1).reasoning.effort).toBe("ultra"); // unknown profile preserves legacy passthrough
  expect(extra.reasoning).toEqual({ summary: "auto", effort: "high" });
});

import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { z } from "zod";
import { OpenAIResponsesProvider } from "../../core/providers/openai-responses.js";
import { RetryProvider } from "../../core/retry.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { LLMChunk, Message } from "../../core/types.js";

const messages: Message[] = [{ role: "user", content: "hello" }];
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-state" };
const fn = (id = "call_1", args = '{"value":"ok"}') => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "echo", arguments: args, status: "completed" });
const text = (value = "hello", phase = "final_answer") => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", phase,
  content: [{ type: "output_text", text: value, annotations: [] }] });
const completed = (output: unknown[] = [text()]) => ({ id: "resp_1", object: "response", status: "completed", output,
  usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 8 } } });
const terminal = (output?: unknown[]) => ({ type: "response.completed", response: completed(output) });
const tool = { name: "echo", description: "echo", parameters: z.object({ value: z.string().optional() }) };
async function collect(source: AsyncIterable<LLMChunk>) { const chunks: LLMChunk[] = []; for await (const chunk of source) chunks.push(chunk); return chunks; }
function harness(reply: (body: any) => unknown, options: Record<string, unknown> = {}) {
  const requests: { url: string; body: any }[] = [];
  const client = new OpenAI({ apiKey: "fixture", baseURL: "https://fixture.invalid/v1", fetch: (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const result = reply(body);
    return body.stream ? new Response((result as unknown[]).map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } }) : Response.json(result);
  }) as any });
  return { requests, provider: new OpenAIResponsesProvider({ model: "fixture", client, ...options }) };
}

describe("Responses transport", () => {
  test("uses /responses, flattened non-strict tools, stateless reasoning and nested effort", async () => {
    const { provider, requests } = harness(() => completed(), { extraRequestParams: { reasoning_effort: "high", reasoning: { summary: "auto" },
      previous_response_id: "stale", conversation: "stale", store: true, background: true, stream: true, max_tokens: 2 } });
    const response = await provider.call(messages, [tool], { model: "child", maxOutputTokens: 1000 });
    expect(requests[0].url).toBe("https://fixture.invalid/v1/responses");
    expect(requests[0].body).toMatchObject({ model: "child", stream: false, store: false, max_output_tokens: 1000,
      reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"], input: messages,
      tools: [{ type: "function", name: "echo", strict: false, parameters: { type: "object" } }] });
    for (const field of ["messages", "max_tokens", "reasoning_effort", "previous_response_id", "conversation", "background"]) expect(requests[0].body[field]).toBeUndefined();
    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 12, cacheReadInputTokens: 60, providerUsageReported: true });
  });

  test("replays reasoning, message phases and call_id in original order, using current tool arguments", async () => {
    const { provider } = harness(() => completed([text("Checking", "commentary"), reasoning, fn("call_a"), fn("call_b")]));
    const response = await provider.call(messages);
    const assistant: Message = { role: "assistant", content: response.text, raw: response.raw, toolCalls: response.toolCalls };
    const history = [...messages, assistant, ...response.toolCalls!.map(call => ({ role: "tool_result" as const, toolCallId: call.id, content: "done" }))];
    expect(provider.serializeMessages(history)).toEqual([
      messages[0], { role: "assistant", content: "Checking", phase: "commentary" }, reasoning,
      { type: "function_call", call_id: "call_a", name: "echo", arguments: '{"value":"ok"}' },
      { type: "function_call", call_id: "call_b", name: "echo", arguments: '{"value":"ok"}' },
      { type: "function_call_output", call_id: "call_a", output: "done" },
      { type: "function_call_output", call_id: "call_b", output: "done" },
    ]);
    assistant.content = "Edited";
    assistant.toolCalls![0].arguments = { value: "changed" };
    const replay = provider.serializeMessages(history);
    expect(JSON.stringify(replay)).not.toContain("Checking");
    expect(replay.find(item => "role" in item && item.role === "assistant")).toEqual({ role: "assistant", content: "Edited", phase: "commentary" });
    expect(JSON.stringify(replay)).toContain("changed");
    const chat = new OpenAICompatibleProvider({ model: "chat", apiKey: "fixture" }).serializeMessages(history);
    expect(JSON.stringify(chat)).not.toContain("openaiResponses");
    expect(JSON.stringify(chat)).not.toContain("opaque-state");
  });

  test("maps images and tool images, sanitizes text, and supports vision fallback without mutating history", () => {
    const { provider } = harness(() => completed());
    const image = { type: "image" as const, filePath: "/fixture.png", mediaType: "image/png", base64: "YQ==", detail: "high" as const, source: "user" as const };
    const history: Message[] = [{ role: "user", content: "image", contentBlocks: [{ type: "text", text: "look\ud800" }, image] },
      { role: "tool_result", toolCallId: "call_a", content: "image result", contentBlocks: [image] }];
    const wire = provider.serializeMessages(history) as any[];
    expect(wire[0].content).toEqual([{ type: "input_text", text: "look�" }, { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" }]);
    expect(wire[1]).toMatchObject({ type: "function_call_output", call_id: "call_a" });
    expect(wire[2].content[1]).toMatchObject({ type: "input_image" });
    provider.setVisionSupported(false);
    expect(JSON.stringify(provider.serializeMessages(history))).not.toContain("data:image");
    expect(history[0].contentBlocks?.[1]).toBe(image);
    expect(provider.getImageTokenContext()).toMatchObject({ supportsVision: false });
  });

  test("streams summaries and refusal text, then publishes completed parallel calls once", async () => {
    const { provider } = harness(() => [
      { type: "response.reasoning_summary_text.delta", delta: "summary" },
      { type: "response.output_text.delta", delta: "Checking" },
      { type: "response.output_item.added", output_index: 2, item: fn("call_b", "") },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"value":"ok"}' },
      { type: "response.output_item.done", output_index: 2, item: fn("call_b") },
      terminal([text("Checking", "commentary"), reasoning, fn("call_a"), fn("call_b")]),
    ]);
    const chunks = await collect(provider.stream(messages, [tool]));
    expect(chunks[0]).toEqual({ type: "thinking_delta", text: "summary" });
    expect(chunks.filter(chunk => chunk.type === "tool_call_start").map(chunk => chunk.toolCallId)).toEqual(["call_a", "call_b"]);
    expect(chunks.filter(chunk => chunk.type === "tool_call_delta")).toHaveLength(2);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "tool_calls", raw: { openaiResponses: { items: [{ type: "message", length: 8, phase: "commentary" }, reasoning, { type: "function_call", call_id: "call_a" }, { type: "function_call", call_id: "call_b" }] } } });
    const refusal = { ...text(), content: [{ type: "refusal", refusal: "Cannot comply" }] };
    const other = harness(() => [{ type: "response.refusal.delta", delta: "Cannot " }, terminal([refusal])]);
    expect((await collect(other.provider.stream(messages))).filter(chunk => chunk.type === "text_delta").map(chunk => chunk.text).join("")).toBe("Cannot comply");
  });

  for (const end of [
    [], [{ type: "response.failed", response: { ...completed(), status: "failed", error: { message: "upstream failed" } } }],
    [{ type: "error", code: "server_error", message: "upstream failed" }],
    [{ type: "response.incomplete", response: { ...completed(), status: "incomplete", incomplete_details: { reason: "content_filter" } } }],
  ]) test(`rejects unsuccessful/unterminated SSE without exposing executable tools (${JSON.stringify(end).slice(0, 45)})`, async () => {
    const { provider } = harness(() => [{ type: "response.output_item.done", output_index: 0, item: fn() }, ...end]);
    const chunks: LLMChunk[] = [];
    await expect((async () => { for await (const chunk of provider.stream(messages)) chunks.push(chunk); })()).rejects.toThrow();
    expect(chunks).toEqual([]);
  });

  test("output-token truncation requests continuation and discards incomplete calls", async () => {
    const response = { ...completed([text("Partial"), fn()]), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const { provider } = harness(body => body.stream ? [{ type: "response.incomplete", response }] : response);
    expect(await provider.call(messages)).toMatchObject({ text: "Partial", finishReason: "length", toolCalls: undefined });
    const chunks = await collect(provider.stream(messages));
    expect(chunks.some(chunk => chunk.type === "tool_call_start")).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "length" });
  });

  test("does not convert malformed/empty tool arguments to a valid empty object", async () => {
    for (const args of ["", "[]", "null", "{broken"]) {
      const { provider } = harness(body => body.stream ? [terminal([fn("bad", args)])] : completed([fn("bad", args)]));
      expect((await provider.call(messages)).toolCalls?.[0].argumentParseError).toBeDefined();
      const chunks = await collect(provider.stream(messages));
      expect(chunks.find(chunk => chunk.type === "tool_call_delta")).toMatchObject({ partialJson: args || "null" });
    }
  });

  test("rejects unsupported stop sequences before network and reports missing usage honestly", async () => {
    const { provider, requests } = harness(() => ({ ...completed(), usage: null }));
    await expect(provider.call(messages, undefined, { stopSequences: ["STOP"] })).rejects.toThrow("stopSequences");
    expect(requests).toHaveLength(0);
    expect((await provider.call(messages)).usage.providerUsageReported).toBe(false);
  });

  test("raw liveness events keep idle watchdog alive; a silent socket still fails", async () => {
    for (const stall of [false, true]) {
      let aborted = false;
      const provider = new OpenAIResponsesProvider({ model: "fixture", streamIdleMs: 60, client: { responses: { create: async () => ({
        controller: { abort() { aborted = true; } },
        async *[Symbol.asyncIterator]() {
          yield { type: "response.output_text.delta", delta: "hello" };
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, stall ? 180 : 20));
            yield { type: "response.in_progress" };
          }
          yield terminal();
        },
      }) } } as any });
      if (stall) await expect(collect(provider.stream(messages))).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
      else expect((await collect(provider.stream(messages))).at(-1)?.type).toBe("done");
      expect(aborted).toBe(true);
    }
  });

  test("injected SDK retries do not multiply RetryProvider attempts", async () => {
    let attempts = 0;
    const client = new OpenAI({ apiKey: "fixture", maxRetries: 3, fetch: (async () => {
      attempts++;
      return Response.json({ error: { message: "busy" } }, { status: 503 });
    }) as any });
    const provider = new RetryProvider(new OpenAIResponsesProvider({ model: "fixture", client }), { maxRetries: 2, initialDelayMs: 1 });
    await expect(collect(provider.stream(messages))).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(3);
  });

  test("malformed arguments never execute an optional-argument tool", async () => {
    let executions = 0;
    let attempts = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: tool, handler: async () => { executions++; return { success: true, output: "unexpected" }; } });
    const { provider } = harness(() => [terminal(++attempts === 1 ? [fn("bad", "")] : [text("Handled invalid call")])]);
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      conversation: new ConversationManager({ maxMessages: 100 }), systemPrompt: "fixture", maxSteps: 4 });
    expect((await agent.run("echo")).text).toBe("Handled invalid call");
    expect(executions).toBe(0);
  });

  test("buffered tool argument progress clears first-output timeout without early execution", async () => {
    let terminalSent = false;
    const phases: string[] = [];
    const provider = new OpenAIResponsesProvider({ model: "fixture", streamIdleMs: 100, client: { responses: { create: async () => ({
      async *[Symbol.asyncIterator]() {
        // Some compatible servers omit output_item.added. Actual argument
        // bytes must also count as progress, even without a text/thinking delta.
        for (const delta of ['{"value":', '"', 'o', 'k', '"', '}']) {
          await new Promise(resolve => setTimeout(resolve, 15));
          yield { type: "response.function_call_arguments.delta", item_id: "fc_call_1", output_index: 0, delta };
        }
        terminalSent = true;
        yield terminal([fn()]);
      },
    }) } } as any });
    const chunks: LLMChunk[] = [];
    for await (const chunk of provider.stream(messages, [tool], { firstOutputTimeoutMs: 50, onRequestEvent: event => phases.push(event.phase) })) {
      expect(terminalSent).toBe(true);
      chunks.push(chunk);
    }
    expect(chunks.filter(chunk => chunk.type === "tool_call_start")).toHaveLength(1);
    expect(phases).toEqual(["requesting", "waiting_output", "streaming", "completed"]);
  });

  for (const visible of [true, false]) test(`LoopAgent preserves incomplete reasoning and phase on continuation (text=${visible})`, async () => {
    let turns = 0;
    let continuation: any[] = [];
    const { provider } = harness(body => {
      if (++turns === 1) return [{ type: "response.incomplete", response: {
        ...completed([reasoning, ...(visible ? [text("Partial", "commentary")] : [])]),
        status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      } }];
      continuation = body.input;
      return [terminal([text("Resumed")])];
    });
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      conversation: new ConversationManager({ maxMessages: 100 }), systemPrompt: "fixture", maxSteps: 4 });
    expect((await agent.run("continue reasoning")).text).toBe("Resumed");
    expect(continuation.find(item => item.type === "reasoning")).toEqual(reasoning);
    const assistant = continuation.find(item => item.role === "assistant");
    expect(assistant).toEqual(visible ? { role: "assistant", content: "Partial", phase: "commentary" } : undefined);
    expect(turns).toBe(2);
  });

  test("actual SDK streaming drives a complete tool round trip through LoopAgent", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: tool, handler: async ({ value }) => { executions++; return { success: true, output: String(value) }; } });
    const { provider, requests } = harness(body => {
      if (body.input.some((item: any) => item.type === "function_call_output")) {
        expect(body.input.find((item: any) => item.type === "reasoning")).toEqual(reasoning);
        expect(body.input.find((item: any) => item.type === "function_call_output")).toEqual({ type: "function_call_output", call_id: "call_1", output: "[✓ echo · 2 chars]\nok" });
        return [terminal([text("Finished")])];
      }
      return [terminal([reasoning, fn()])];
    });
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, { onApproval: async () => true }),
      conversation, systemPrompt: "fixture", maxSteps: 4 });
    const result = await agent.run("echo ok");
    expect(result.text).toBe("Finished");
    expect(executions).toBe(1);
    expect(requests).toHaveLength(2);
    expect(result.totalUsage).toMatchObject({ inputTokens: 80, outputTokens: 24, cacheReadInputTokens: 120 });
  });
});

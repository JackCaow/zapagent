import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { DYNAMIC_BOUNDARY } from "../../core/prompt-boundary.js";
import type { Message, LLMChunk } from "../../core/types.js";
import type { ToolDefinition } from "../../tools/types.js";

/**
 * Simulate a DeepSeek V4 SSE response: reasoning_content deltas, then a tool
 * call, then finish_reason + usage.  Drive it through the provider's stream()
 * and verify:
 *   1. a `done` chunk emerges carrying `raw.reasoning_content` assembled
 *   2. feeding the resulting Message back through toApiMessage puts
 *      `reasoning_content` on the outgoing wire message alongside tool_calls.
 */
function fakeDeepseekStream() {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "" } }] },
    { choices: [{ index: 0, delta: { content: null, reasoning_content: "The user " } }] },
    { choices: [{ index: 0, delta: { content: null, reasoning_content: "wants a file." } }] },
    { choices: [{ index: 0, delta: { content: null, tool_calls: [
      { index: 0, id: "call_abc", type: "function", function: { name: "read_file", arguments: "" } }
    ] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: "{\"path\":\"/tmp/x\"}" } }
    ] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  // Mimic the OpenAI SDK shape: the provider calls
  // client.chat.completions.create(...) → returns something async-iterable.
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          async function* gen() { for (const c of chunks) yield c; }
          return gen();
        },
      },
    },
  } as any;
  return fakeClient;
}

describe("OpenAICompatibleProvider raw passthrough", () => {
  it("serializes non-streaming tools in stable name order for prompt cache consistency", async () => {
    let capturedBody: any = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedBody = params;
            return {
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        },
      },
    } as any;
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", client: fakeClient });

    await provider.call([{ role: "user", content: "hi" }], [
      tool("zeta"),
      tool("alpha"),
      tool("middle"),
    ]);

    expect(capturedBody.tools.map((t: any) => t.function.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("serializes streaming tools in stable name order for prompt cache consistency", async () => {
    let capturedBody: any = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedBody = params;
            async function* gen() {
              yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
              yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
            }
            return gen();
          },
        },
      },
    } as any;
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", client: fakeClient });

    for await (const _ of provider.stream!([{ role: "user", content: "hi" }], [
      tool("zeta"),
      tool("alpha"),
      tool("middle"),
    ])) { /* drain */ }

    expect(capturedBody.tools.map((t: any) => t.function.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("canonicalizes non-streaming tool schema object keys for prompt cache consistency", async () => {
    let capturedBody: any = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedBody = params;
            return {
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        },
      },
    } as any;
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", client: fakeClient });

    await provider.call([{ role: "user", content: "hi" }], [
      tool("alpha", {
        zLast: true,
        properties: {
          beta: { type: "string", enum: ["z", "a"], description: "B" },
          alpha: { description: "A", type: ["string", "null"] },
          choice: {
            anyOf: [
              { type: "string" },
              { type: "number" },
            ],
          },
        },
        required: ["beta", "alpha"],
        type: "object",
      }),
    ]);

    const schema = capturedBody.tools[0].function.parameters;
    expect(Object.keys(schema)).toEqual(["properties", "required", "type", "zLast"]);
    expect(Object.keys(schema.properties)).toEqual(["alpha", "beta", "choice"]);
    expect(Object.keys(schema.properties.alpha)).toEqual(["description", "type"]);
    expect(schema.properties.alpha.type).toEqual(["null", "string"]);
    expect(schema.properties.beta.enum).toEqual(["a", "z"]);
    expect(schema.properties.choice.anyOf).toEqual([{ type: "number" }, { type: "string" }]);
    expect(schema.required).toEqual(["alpha", "beta"]);
  });

  it("accumulates reasoning_content across deltas and emits it on `done.raw`", async () => {
    const provider = new OpenAICompatibleProvider({
      model: "deepseek-v4-pro",
      client: fakeDeepseekStream(),
      extraRequestParams: { thinking: { type: "enabled" } },
    });

    const events: LLMChunk[] = [];
    for await (const ev of provider.stream!([{ role: "user", content: "hi" }])) {
      events.push(ev);
    }

    const done = events.find(e => e.type === "done");
    expect(done).toBeDefined();
    expect(done && done.type === "done" ? done.raw : undefined)
      .toEqual({ reasoning_content: "The user wants a file." });
  });

  it("emits a zero-usage done chunk when a compatible gateway omits the usage-only final chunk", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async () => {
            async function* gen() {
              yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
              yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            }
            return gen();
          },
        },
      },
    } as any;
    const provider = new OpenAICompatibleProvider({ model: "openai-compatible", client: fakeClient });

    const events: LLMChunk[] = [];
    for await (const ev of provider.stream!([{ role: "user", content: "hi" }])) {
      events.push(ev);
    }

    const done = events.find(e => e.type === "done");
    expect(done).toBeDefined();
    expect(done && done.type === "done" ? done.finishReason : undefined).toBe("stop");
    expect(done && done.type === "done" ? done.usage : undefined)
      .toEqual({ inputTokens: 0, outputTokens: 0, providerUsageReported: false });
  });

  it("captures reasoning_content from non-streaming parseResponse into LLMResponse.raw", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "I need to read the file.",
                tool_calls: [{
                  id: "call_x",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/x" }) },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        },
      },
    } as any;

    const provider = new OpenAICompatibleProvider({ model: "deepseek-v4-pro", client: fakeClient });
    const resp = await provider.call([{ role: "user", content: "hi" }]);

    expect(resp.raw).toEqual({ reasoning_content: "I need to read the file." });
    expect(resp.toolCalls?.[0]?.id).toBe("call_x");
  });

  it("normalizes empty non-streaming tool arguments to an empty object", async () => {
    const provider = new OpenAICompatibleProvider({
      model: "openai-compatible",
      client: nonStreamingToolClient("call_empty", ""),
    });

    const resp = await provider.call([{ role: "user", content: "enter plan mode" }]);

    expect(resp.type).toBe("tool_call");
    expect(resp.toolCalls?.[0]).toMatchObject({
      id: "call_empty",
      name: "enter_plan_mode",
      arguments: {},
    });
    expect(resp.toolCalls?.[0]?.argumentParseError).toBeUndefined();
  });

  it("marks malformed non-streaming tool arguments without throwing", async () => {
    const provider = new OpenAICompatibleProvider({
      model: "openai-compatible",
      client: nonStreamingToolClient("call_bad", "{\"path\":"),
    });

    const resp = await provider.call([{ role: "user", content: "read file" }]);

    expect(resp.type).toBe("tool_call");
    expect(resp.toolCalls?.[0]).toMatchObject({
      id: "call_bad",
      name: "enter_plan_mode",
      arguments: {},
    });
    expect(resp.toolCalls?.[0]?.argumentParseError).toBe("Malformed tool arguments JSON from provider.");
  });

  it("marks non-object non-streaming tool arguments without throwing", async () => {
    const provider = new OpenAICompatibleProvider({
      model: "openai-compatible",
      client: nonStreamingToolClient("call_array", "[]"),
    });

    const resp = await provider.call([{ role: "user", content: "read file" }]);

    expect(resp.type).toBe("tool_call");
    expect(resp.toolCalls?.[0]?.arguments).toEqual({});
    expect(resp.toolCalls?.[0]?.argumentParseError).toBe("Tool arguments JSON must be an object.");
  });

  it("reasoning roundtrip invariant: after an assistant carries raw reasoning, every subsequent assistant gets the key (empty if absent)", () => {
    const provider = new OpenAICompatibleProvider({ model: "deepseek-v4-pro", apiKey: "x" });
    const wire = (provider as any).serializeMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "read X" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "/x" } }],
        raw: { reasoning_content: "reason1" },
      },
      { role: "tool_result", content: "file content", toolCallId: "t1" },
      { role: "assistant", content: "Done reading." },
      { role: "user", content: "next" },
    ]) as any[];

    expect(wire[2].reasoning_content).toBeUndefined();
    expect(wire[4].reasoning_content).toBe("reason1");
    expect(wire[6].reasoning_content).toBe("");
  });

  it("no injection when NO assistant in history ever carried raw (non-thinking providers stay clean)", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
    const wire = (provider as any).serializeMessages([
      { role: "user", content: "list files" },
      {
        role: "assistant", content: "",
        toolCalls: [{ id: "t1", name: "list_directory", arguments: { path: "/" } }],
      },
      { role: "tool_result", content: "ok", toolCallId: "t1" },
      { role: "assistant", content: "Done." },
    ]) as any[];

    // No assistant carried `raw` → invariant doesn't fire anywhere.
    expect(wire[1].reasoning_content).toBeUndefined();
    expect(wire[3].reasoning_content).toBeUndefined();
  });

  it("strips the static/dynamic prompt boundary from OpenAI-compatible system messages", async () => {
    let capturedBody: any = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedBody = params;
            async function* gen() {
              yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
              yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 1 } };
            }
            return gen();
          },
        },
      },
    } as any;
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", client: fakeClient });

    for await (const _ of provider.stream!([
      { role: "system", content: `stable prefix\n\n${DYNAMIC_BOUNDARY}\n\ndynamic suffix` },
      { role: "user", content: "hi" },
    ])) { /* drain */ }

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages[0]).toEqual({
      role: "system",
      content: "stable prefix\n\ndynamic suffix",
    });
    expect(JSON.stringify(capturedBody.messages)).not.toContain(DYNAMIC_BOUNDARY);
  });

  it("strips duplicate dynamic prompt boundaries from OpenAI-compatible system messages", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
    const wire = (provider as any).serializeMessages([
      {
        role: "system",
        content: [
          "stable prefix",
          DYNAMIC_BOUNDARY,
          "dynamic suffix",
          DYNAMIC_BOUNDARY,
          "accidental second suffix",
        ].join("\n\n"),
      },
      { role: "user", content: "hi" },
    ]) as any[];

    expect(wire[0]).toEqual({
      role: "system",
      content: "stable prefix\n\ndynamic suffix\n\naccidental second suffix",
    });
    expect(JSON.stringify(wire)).not.toContain(DYNAMIC_BOUNDARY);
  });

  it("preserves only leading system messages as system-role wire messages", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
    const wire = (provider as any).serializeMessages([
      { role: "system", content: "base system prompt" },
      { role: "system", content: "cacheable support instructions" },
      { role: "user", content: "old user request" },
      { role: "system", content: `late system note${DYNAMIC_BOUNDARY}dynamic suffix` },
      { role: "user", content: "latest user request" },
    ]) as any[];

    expect(wire.map((m) => `${m.role}:${m.content}`)).toEqual([
      "system:base system prompt",
      "system:cacheable support instructions",
      "user:old user request",
      "user:[system]: late system note\n\ndynamic suffix",
      "user:latest user request",
    ]);
    expect(JSON.stringify(wire)).not.toContain(DYNAMIC_BOUNDARY);
  });

  it("preserves valid non-BMP text while sanitizing lone surrogates", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
    const wire = (provider as any).serializeMessages([
      { role: "user", content: "emoji 😀 and extension char 𠮷 stay intact" },
      { role: "assistant", content: "bad high \uD800 and bad low \uDC00" },
    ]) as any[];

    expect(wire[0].content).toBe("emoji 😀 and extension char 𠮷 stay intact");
    expect(wire[1].content).toBe("bad high � and bad low �");
  });

  it("preserves valid non-BMP text inside multimodal text blocks", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
    const wire = (provider as any).serializeMessages([
      {
        role: "user",
        content: "ignored when contentBlocks are present",
        contentBlocks: [
          { type: "text", text: "pasted 😀 text with lone \uD800 surrogate" },
        ],
      },
    ]) as any[];

    expect(wire[0].content[0]).toEqual({
      type: "text",
      text: "pasted 😀 text with lone � surrogate",
    });
  });

  it("spreads msg.raw into serialized assistant+toolCalls wire message", async () => {
    const provider = new OpenAICompatibleProvider({
      model: "deepseek-v4-pro",
      client: fakeDeepseekStream(),
    });

    const msgs: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_abc", name: "read_file", arguments: { path: "/tmp/x" } }],
        raw: { reasoning_content: "The user wants a file." },
      },
      { role: "tool_result", content: "ok", toolCallId: "call_abc" },
    ];

    // Use toApiMessage via a reflective call: the method is private, so we
    // inspect what gets sent by swapping the client with a capturing stub.
    let capturedBody: any = null;
    (provider as any).client = {
      chat: { completions: { create: async (params: any) => {
        capturedBody = params;
        async function* gen() {
          yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        }
        return gen();
      } } },
    };

    const iter = provider.stream!(msgs);
    for await (const _ of iter) { /* drain */ }

    expect(capturedBody).not.toBeNull();
    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBe("The user wants a file.");
    expect(assistantMsg.tool_calls?.[0]?.id).toBe("call_abc");
  });
});

function tool(name: string, rawSchema?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({}),
    ...(rawSchema ? { rawSchema } : {}),
  };
}

function nonStreamingToolClient(id: string, args: string): any {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id,
                type: "function",
                function: { name: "enter_plan_mode", arguments: args },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
      },
    },
  };
}

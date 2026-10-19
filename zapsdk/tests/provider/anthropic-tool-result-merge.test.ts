import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { AnthropicProvider } from "../../core/providers/anthropic.js"
import { DYNAMIC_BOUNDARY } from "../../core/prompt-boundary.js"
import type { Message } from "../../core/types.js"
import type { ToolDefinition } from "../../tools/types.js"

/**
 * Anthropic Messages API requires all tool_result blocks for a single
 * assistant turn to live inside one `role:"user"` message — splitting them
 * into N user messages is non-standard, breaks prompt-cache breakpoints,
 * and is rejected by stricter compatible gateways (Bedrock, Vertex, …).
 *
 * Internally the agent loop appends one tool_result Message per parallel
 * tool call, so the provider must merge consecutive runs back into one wire
 * message before sending. These tests intercept the SDK call to inspect the
 * outgoing message array.
 */
function makeProvider() {
  const captured: { messages?: any[]; system?: unknown; tools?: any[] } = {}
  const fakeClient = {
    messages: {
      create: async (params: any) => {
        captured.messages = params.messages
        captured.system = params.system
        captured.tools = params.tools
        return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }
      },
    },
  } as any
  const provider = new AnthropicProvider({ model: "claude-opus-4-7", client: fakeClient, promptCaching: false })
  return { provider, captured }
}

function makeCachingProvider() {
  const captured: { messages?: any[]; system?: unknown; tools?: any[] } = {}
  const fakeClient = {
    messages: {
      create: async (params: any) => {
        captured.messages = params.messages
        captured.system = params.system
        captured.tools = params.tools
        return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }
      },
    },
  } as any
  const provider = new AnthropicProvider({ model: "claude-opus-4-7", client: fakeClient, promptCaching: true })
  return { provider, captured }
}

function makeStreamingProvider(events: any[]) {
  const fakeClient = {
    messages: {
      stream: async () => {
        const iter = (async function* () {
          for (const event of events) yield event
        })()
        return {
          [Symbol.asyncIterator]() { return iter },
          finalMessage: async () => ({
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: "end_turn",
          }),
        }
      },
    },
  } as any
  return new AnthropicProvider({ model: "claude-opus-4-7", client: fakeClient, promptCaching: false })
}

function makeCapturingStreamingProvider(events: any[]) {
  const captured: { messages?: any[]; system?: unknown } = {}
  const fakeClient = {
    messages: {
      stream: async (params: any) => {
        captured.messages = params.messages
        captured.system = params.system
        const iter = (async function* () {
          for (const event of events) yield event
        })()
        return {
          [Symbol.asyncIterator]() { return iter },
          finalMessage: async () => ({
            content: [{ type: "text", text: "" }],
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: "end_turn",
          }),
        }
      },
    },
  } as any
  const provider = new AnthropicProvider({ model: "claude-opus-4-7", client: fakeClient, promptCaching: false })
  return { provider, captured }
}

describe("AnthropicProvider — tool_result batching", () => {
  it("serializes tools in stable name order for prompt cache consistency", async () => {
    const { provider, captured } = makeCachingProvider()

    await provider.call([{ role: "user", content: "hi" }], [
      tool("zeta"),
      tool("alpha"),
      tool("middle"),
    ])

    expect(captured.tools?.map((t) => t.name)).toEqual(["alpha", "middle", "zeta"])
    expect(captured.tools?.[2]?.cache_control).toEqual({ type: "ephemeral" })
  })

  it("canonicalizes tool schema object keys for prompt cache consistency", async () => {
    const { provider, captured } = makeCachingProvider()

    await provider.call([{ role: "user", content: "hi" }], [
      tool("alpha", {
        zLast: true,
        properties: {
          beta: { type: "string", description: "B" },
          alpha: { description: "A", type: "string" },
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
    ])

    const schema = captured.tools?.[0]?.input_schema
    expect(Object.keys(schema)).toEqual(["properties", "required", "type", "zLast"])
    expect(Object.keys(schema.properties)).toEqual(["alpha", "beta", "choice"])
    expect(Object.keys(schema.properties.alpha)).toEqual(["description", "type"])
    expect(schema.properties.choice.anyOf).toEqual([{ type: "number" }, { type: "string" }])
    expect(schema.required).toEqual(["alpha", "beta"])
  })

  it("merges N consecutive tool_results into one user message with N blocks", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [
        { id: "t1", name: "list_tree", arguments: {} },
        { id: "t2", name: "read_file", arguments: { path: "a" } },
        { id: "t3", name: "read_file", arguments: { path: "b" } },
      ] },
      { role: "tool_result", toolCallId: "t1", content: "tree output" },
      { role: "tool_result", toolCallId: "t2", content: "file a" },
      { role: "tool_result", toolCallId: "t3", content: "file b" },
    ]
    await provider.call(messages)
    const wire = captured.messages!
    // Expected: user(go), assistant(...), user([tool_result*3])
    expect(wire.length).toBe(3)
    expect(wire[2].role).toBe("user")
    expect(Array.isArray(wire[2].content)).toBe(true)
    expect(wire[2].content.length).toBe(3)
    const ids = wire[2].content.map((b: any) => b.tool_use_id)
    expect(ids).toEqual(["t1", "t2", "t3"])
    for (const block of wire[2].content) {
      expect(block.type).toBe("tool_result")
    }
  })

  it("does not merge across a non-tool_result boundary (next user turn)", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: {} }] },
      { role: "tool_result", toolCallId: "t1", content: "r1" },
      { role: "user", content: "follow up" },
      { role: "assistant", content: "", toolCalls: [
        { id: "t2", name: "y", arguments: {} },
        { id: "t3", name: "y", arguments: {} },
      ] },
      { role: "tool_result", toolCallId: "t2", content: "r2" },
      { role: "tool_result", toolCallId: "t3", content: "r3" },
    ]
    await provider.call(messages)
    const wire = captured.messages!
    // assistant, user(t1), user(follow up), assistant, user(t2+t3)
    expect(wire.length).toBe(5)
    expect(wire[1].role).toBe("user"); expect(wire[1].content.length).toBe(1)
    expect(wire[2].role).toBe("user"); expect(wire[2].content).toBe("follow up")
    expect(wire[4].role).toBe("user"); expect(wire[4].content.length).toBe(2)
    expect(wire[4].content.map((b: any) => b.tool_use_id)).toEqual(["t2", "t3"])
  })

  it("preserves a single tool_result's blocks when no neighbors", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: {} }] },
      { role: "tool_result", toolCallId: "t1", content: "only" },
    ]
    await provider.call(messages)
    const wire = captured.messages!
    expect(wire.length).toBe(2)
    expect(wire[1].role).toBe("user")
    expect(wire[1].content.length).toBe(1)
    expect(wire[1].content[0].tool_use_id).toBe("t1")
  })

  it("preserves image contentBlocks inside merged tool_result", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [
        { id: "t1", name: "read_file", arguments: { path: "a.png" } },
        { id: "t2", name: "read_file", arguments: { path: "b.txt" } },
      ] },
      { role: "tool_result", toolCallId: "t1", content: "image stub", contentBlocks: [
        { type: "image", base64: "AAAA", mediaType: "image/png", filePath: "/tmp/a.png", source: "/tmp/a.png" },
      ] },
      { role: "tool_result", toolCallId: "t2", content: "text content" },
    ]
    await provider.call(messages)
    const wire = captured.messages!
    expect(wire.length).toBe(2)
    expect(wire[1].content.length).toBe(2)
    const t1 = wire[1].content[0]
    expect(t1.tool_use_id).toBe("t1")
    expect(Array.isArray(t1.content)).toBe(true)
    expect(t1.content.find((b: any) => b.type === "image")).toBeTruthy()
    const t2 = wire[1].content[1]
    expect(t2.tool_use_id).toBe("t2")
    expect(t2.content).toBe("text content")
  })

  it("skips transient context messages when placing conversation cache breakpoint", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      { role: "user", content: "persistent user request" },
      { role: "user", content: "<memory>volatile per-turn context</memory>", cache: { transient: true } },
    ]

    await provider.call(messages)

    const wire = captured.messages!
    expect(wire.length).toBe(2)
    expect(wire[0].content).toEqual([
      {
        type: "text",
        text: "persistent user request",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(wire[1].content).toBe("<memory>volatile per-turn context</memory>")
    expect(JSON.stringify(wire[1])).not.toContain("zap")
    expect(JSON.stringify(wire[1])).not.toContain("cache_control")
  })

  it("skips current-turn user messages when placing conversation cache breakpoint", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      { role: "user", content: "previous request" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "new per-turn request", cache: { skipBreakpoint: true } },
    ]

    await provider.call(messages)

    const wire = captured.messages!
    expect(wire).toHaveLength(3)
    expect(wire[1].content).toEqual([
      {
        type: "text",
        text: "previous answer",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(wire[2].content).toBe("new per-turn request")
    expect(JSON.stringify(wire[2])).not.toContain("cache_control")
    expect(JSON.stringify(wire[2])).not.toContain("zap")
  })

  it("preserves cache breakpoint skip hints when merging tool_result batches", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      { role: "user", content: "previous request" },
      { role: "assistant", content: "previous answer" },
      { role: "assistant", content: "", toolCalls: [
        { id: "t1", name: "read_file", arguments: { path: "a.txt" } },
        { id: "t2", name: "read_file", arguments: { path: "b.txt" } },
      ] },
      { role: "tool_result", toolCallId: "t1", content: "first", cache: { skipBreakpoint: true } },
      { role: "tool_result", toolCallId: "t2", content: "second" },
    ]

    await provider.call(messages)

    const wire = captured.messages!
    expect(wire).toHaveLength(4)
    expect(JSON.stringify(wire[2])).toContain("cache_control")
    expect(wire[3].role).toBe("user")
    expect(wire[3].content).toHaveLength(2)
    expect(JSON.stringify(wire[3])).not.toContain("cache_control")
    expect(JSON.stringify(wire[3])).not.toContain("zap")
  })

  it("preserves transient cache hints when merging tool_result batches", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      { role: "user", content: "previous request" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: {} }] },
      { role: "tool_result", toolCallId: "t1", content: "volatile result", cache: { transient: true } },
    ]

    await provider.call(messages)

    const wire = captured.messages!
    expect(wire).toHaveLength(3)
    expect(JSON.stringify(wire[1])).toContain("cache_control")
    expect(wire[2].role).toBe("user")
    expect(JSON.stringify(wire[2])).not.toContain("cache_control")
    expect(JSON.stringify(wire[2])).not.toContain("zap")
  })

  it("places cache_control only on the stable system prompt prefix before the dynamic boundary", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "# Stable instructions",
          "Always follow the agent protocol.",
          DYNAMIC_BOUNDARY,
          "# Dynamic environment",
          "Today: 2026-06-30",
        ].join("\n"),
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toEqual([
      {
        type: "text",
        text: "# Stable instructions\nAlways follow the agent protocol.",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "# Dynamic environment\nToday: 2026-06-30",
      },
    ])
    expect(JSON.stringify(captured.system)).not.toContain(DYNAMIC_BOUNDARY)
  })

  it("strips duplicate dynamic boundaries from Anthropic system blocks", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "# Stable instructions",
          DYNAMIC_BOUNDARY,
          "# Dynamic environment",
          DYNAMIC_BOUNDARY,
          "accidental second suffix",
        ].join("\n\n"),
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toEqual([
      {
        type: "text",
        text: "# Stable instructions",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "# Dynamic environment\n\naccidental second suffix",
      },
    ])
    expect(JSON.stringify(captured.system)).not.toContain(DYNAMIC_BOUNDARY)
  })

  it("keeps later leading system messages in the cacheable prefix when an earlier one has a dynamic boundary", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "# Stable instructions",
          DYNAMIC_BOUNDARY,
          "Today: 2026-07-03",
        ].join("\n\n"),
      },
      {
        role: "system",
        content: "# Stable tool guidance",
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toEqual([
      {
        type: "text",
        text: "# Stable instructions\n\n# Stable tool guidance",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "Today: 2026-07-03",
      },
    ])
    expect(JSON.stringify(captured.system)).not.toContain(DYNAMIC_BOUNDARY)
  })

  it("combines multiple system messages for non-streaming requests", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      { role: "system", content: "base system prompt" },
      { role: "system", content: "cacheable support instructions" },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toEqual([
      {
        type: "text",
        text: "base system prompt\n\ncacheable support instructions",
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  it("does not hoist non-leading system messages for non-streaming requests", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "old user request" },
      { role: "system", content: `late system note${DYNAMIC_BOUNDARY}dynamic suffix` },
      { role: "user", content: "latest user request" },
    ]

    await provider.call(messages)

    expect(captured.system).toBe("base system prompt")
    expect(captured.messages?.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:old user request",
      "user:[system]: late system note\n\ndynamic suffix",
      "user:latest user request",
    ])
    expect(JSON.stringify(captured.messages)).not.toContain(DYNAMIC_BOUNDARY)
  })

  it("combines multiple system messages for streaming requests", async () => {
    const { provider, captured } = makeCapturingStreamingProvider([
      { type: "message_stop" },
    ])
    const messages: Message[] = [
      { role: "system", content: "base system prompt" },
      { role: "system", content: "runtime support instructions" },
      { role: "user", content: "hello" },
    ]

    for await (const _chunk of provider.stream(messages)) {
      // drain stream
    }

    expect(captured.system).toBe("base system prompt\n\nruntime support instructions")
  })

  it("does not hoist non-leading system messages for streaming requests", async () => {
    const { provider, captured } = makeCapturingStreamingProvider([
      { type: "message_stop" },
    ])
    const messages: Message[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "old user request" },
      { role: "system", content: `late system note${DYNAMIC_BOUNDARY}dynamic suffix` },
      { role: "user", content: "latest user request" },
    ]

    for await (const _chunk of provider.stream(messages)) {
      // drain stream
    }

    expect(captured.system).toBe("base system prompt")
    expect(captured.messages?.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:old user request",
      "user:[system]: late system note\n\ndynamic suffix",
      "user:latest user request",
    ])
    expect(JSON.stringify(captured.messages)).not.toContain(DYNAMIC_BOUNDARY)
  })

  it("preserves valid non-BMP text while sanitizing lone surrogates", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      { role: "system", content: "rules 😀 bad high \uD800" },
      { role: "user", content: "emoji 😀 and extension char 𠮷 stay; bad low \uDC00" },
      { role: "assistant", content: "assistant 😀 bad high \uD800", toolCalls: [
        { id: "t1", name: "read_file", arguments: { path: "a.txt" } },
      ] },
      {
        role: "tool_result",
        toolCallId: "t1",
        content: "result 😀 bad high \uD800",
        contentBlocks: [
          { type: "text", text: "block 𠮷 bad low \uDC00" },
        ],
      },
    ]

    await provider.call(messages)

    expect(captured.system).toBe("rules 😀 bad high �")
    const wire = captured.messages!
    expect(wire[0].content).toBe("emoji 😀 and extension char 𠮷 stay; bad low �")
    expect(wire[1].content[0]).toEqual({
      type: "text",
      text: "assistant 😀 bad high �",
    })
    expect(wire[2].content[0].content).toEqual([
      { type: "text", text: "result 😀 bad high �" },
      { type: "text", text: "block 𠮷 bad low �" },
    ])
  })

  it("sanitizes cacheable Anthropic system blocks without breaking non-BMP text", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "stable 😀 bad high \uD800",
          DYNAMIC_BOUNDARY,
          "dynamic 𠮷 bad low \uDC00",
        ].join("\n"),
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toEqual([
      {
        type: "text",
        text: "stable 😀 bad high �",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "dynamic 𠮷 bad low �",
      },
    ])
  })

  it("does not cache an empty system prefix before the dynamic boundary", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: `${DYNAMIC_BOUNDARY}\n# Dynamic environment`,
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toEqual([
      {
        type: "text",
        text: "# Dynamic environment",
      },
    ])
    expect(JSON.stringify(captured.system)).not.toContain("cache_control")
  })

  it("places conversation cache breakpoint on the last non-empty content block", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "user",
        content: "",
        contentBlocks: [
          { type: "text", text: "stable text" },
          { type: "text", text: "" },
        ],
      },
    ]

    await provider.call(messages)

    const wire = captured.messages!
    expect(wire[0].content).toEqual([
      {
        type: "text",
        text: "stable text",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "",
      },
    ])
  })

  it("does not place conversation cache_control on image blocks", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "user",
        content: "look",
        contentBlocks: [
          { type: "text", text: "look" },
          { type: "image", base64: "AAAA", mediaType: "image/png", filePath: "/tmp/a.png", source: "/tmp/a.png" },
        ],
      },
    ]

    await provider.call(messages)

    const wire = captured.messages!
    expect(wire[0].content[0]).toEqual({
      type: "text",
      text: "look",
      cache_control: { type: "ephemeral" },
    })
    expect(wire[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    })
  })

  it("skips conversation cache breakpoint when the last message has only images", async () => {
    const { provider, captured } = makeCachingProvider()
    const messages: Message[] = [
      {
        role: "user",
        content: "",
        contentBlocks: [
          { type: "image", base64: "AAAA", mediaType: "image/png", filePath: "/tmp/a.png", source: "/tmp/a.png" },
        ],
      },
    ]

    await provider.call(messages)

    expect(JSON.stringify(captured.messages)).not.toContain("cache_control")
  })

  it("strips the dynamic boundary without cache_control when prompt caching is disabled", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: `stable${DYNAMIC_BOUNDARY}dynamic`,
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toBe("stable\n\ndynamic")
  })

  it("strips duplicate dynamic boundaries without cache_control when prompt caching is disabled", async () => {
    const { provider, captured } = makeProvider()
    const messages: Message[] = [
      {
        role: "system",
        content: `stable${DYNAMIC_BOUNDARY}dynamic${DYNAMIC_BOUNDARY}accidental`,
      },
      { role: "user", content: "hello" },
    ]

    await provider.call(messages)

    expect(captured.system).toBe("stable\n\ndynamic\n\naccidental")
    expect(JSON.stringify(captured.system)).not.toContain(DYNAMIC_BOUNDARY)
  })

  it("preserves Anthropic content block indexes on streamed tool calls", async () => {
    const provider = makeStreamingProvider([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll inspect two files." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "read_a", name: "read_file" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "read_b", name: "read_file" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: `{"path":"b.ts"` } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"path":"a.ts"` } },
      { type: "message_stop" },
    ])

    const chunks: any[] = []
    for await (const chunk of provider.stream([{ role: "user", content: "go" }])) {
      chunks.push(chunk)
    }

    expect(chunks.some((chunk) =>
      chunk.type === "tool_call_start" &&
      chunk.toolCallId === "read_a" &&
      chunk.toolName === "read_file" &&
      chunk.toolCallIndex === 1
    )).toBe(true)
    expect(chunks.some((chunk) =>
      chunk.type === "tool_call_start" &&
      chunk.toolCallId === "read_b" &&
      chunk.toolName === "read_file" &&
      chunk.toolCallIndex === 2
    )).toBe(true)
    expect(chunks.some((chunk) =>
      chunk.type === "tool_call_delta" &&
      chunk.toolCallId === "" &&
      chunk.partialJson === `{"path":"b.ts"` &&
      chunk.toolCallIndex === 2
    )).toBe(true)
    expect(chunks.some((chunk) =>
      chunk.type === "tool_call_delta" &&
      chunk.toolCallId === "" &&
      chunk.partialJson === `{"path":"a.ts"` &&
      chunk.toolCallIndex === 1
    )).toBe(true)
  })
})

function tool(name: string, rawSchema?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({}),
    ...(rawSchema ? { rawSchema } : {}),
  }
}

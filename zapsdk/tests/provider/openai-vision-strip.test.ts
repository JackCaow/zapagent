import { describe, it, expect } from "bun:test";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import type { Message } from "../../core/types.js";

// `serializeMessages` is private; access via cast for white-box testing of the
// strip behavior. The wire shape is the only thing that matters here.
function serialize(provider: OpenAICompatibleProvider, msgs: Message[]) {
  return (provider as unknown as { serializeMessages: (m: Message[]) => Record<string, unknown>[] })
    .serializeMessages(msgs);
}

const sampleImageMessage = (): Message => ({
  role: "user",
  content: "look at this",
  contentBlocks: [
    { type: "text", text: "look at this" },
    {
      type: "image",
      filePath: "/tmp/x.png",
      mediaType: "image/png",
      base64: "AAAA",
      source: "clipboard",
    },
  ],
});

describe("OpenAICompatibleProvider vision stripping", () => {
  const toolResult = (id: string, image: boolean): Message => ({
    role: "tool_result", toolCallId: id, content: `result ${id}`,
    ...(image ? { contentBlocks: [{ type: "image" as const, filePath: "/tmp/x.png",
      mediaType: "image/png", base64: id, source: "tool" as const }] } : {}),
  });
  const toolCalls = (ids: string[]): Message => ({
    role: "assistant", content: "", raw: { reasoning_content: "inspect" },
    toolCalls: ids.map(id => ({ id, name: "read_file", arguments: {} })),
  });

  for (const images of [[true, false], [false, true], [true, true]]) {
    it(`keeps parallel results contiguous with image flags ${images}`, () => {
      const provider = new OpenAICompatibleProvider({ model: "vision", apiKey: "k", supportsVision: true });
      const messages = [toolCalls(["first", "second"]), toolResult("first", images[0]),
        toolResult("second", images[1]), { role: "assistant", content: "done" } as Message];
      const before = JSON.stringify(messages);
      const wire = serialize(provider, messages);
      expect(wire.map(m => m.role)).toEqual(["assistant", "tool", "tool",
        ...images.filter(Boolean).map(() => "user"), "assistant"]);
      expect(wire.slice(1, 3).map(m => m.tool_call_id)).toEqual(["first", "second"]);
      const attachedIds = wire.filter(m => m.role === "user").map(m => (m.content as any[])[1].image_url.url);
      expect(attachedIds).toEqual(images.flatMap((image, i) => image
        ? [`data:image/png;base64,${i === 0 ? "first" : "second"}`] : []));
      expect(wire.at(-1)?.reasoning_content).toBe("");
      expect(JSON.stringify(messages)).toBe(before);
    });
  }

  it("flushes images at each group boundary and at the end of resumed history", () => {
    const provider = new OpenAICompatibleProvider({ model: "vision", apiKey: "k" });
    const wire = serialize(provider, [
      toolCalls(["first", "second"]), toolResult("first", true), toolResult("second", false),
      { role: "user", content: "continue" },
      toolCalls(["third", "fourth"]), toolResult("third", true), toolResult("fourth", false),
    ]);
    expect(wire.map(m => m.role)).toEqual(["assistant", "tool", "tool", "user", "user",
      "assistant", "tool", "tool", "user"]);
    expect(wire[4].content).toBe("continue");
    const pending = new Set<string>();
    for (const message of wire) {
      if (message.role === "tool") pending.delete(message.tool_call_id as string);
      else {
        expect(pending.size).toBe(0);
        for (const call of (message.tool_calls ?? []) as { id: string }[]) pending.add(call.id);
      }
    }
    expect(pending.size).toBe(0);
  });

  it("passes image_url through when supportsVision !== false", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-4o", apiKey: "k" });
    const wire = serialize(provider, [sampleImageMessage()]);
    expect(wire).toHaveLength(1);
    const content = (wire[0] as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "look at this" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toContain("data:image/png;base64,AAAA");
  });

  it("collapses contentBlocks to a flat string with breadcrumb when supportsVision === false", () => {
    const provider = new OpenAICompatibleProvider({
      model: "deepseek-v4-pro",
      apiKey: "k",
      supportsVision: false,
    });
    const wire = serialize(provider, [sampleImageMessage()]);
    expect(wire).toHaveLength(1);
    const content = (wire[0] as any).content;
    expect(typeof content).toBe("string");
    expect(content).toContain("look at this");
    expect(content).toContain("[Referenced image in conversation");
    expect(content).not.toContain("base64");
    expect(content).not.toContain("data:image");
  });

  it("setVisionSupported(false) flips behavior at runtime", () => {
    const provider = new OpenAICompatibleProvider({ model: "deepseek-v4-pro", apiKey: "k" });
    const before = serialize(provider, [sampleImageMessage()]);
    expect(Array.isArray((before[0] as any).content)).toBe(true);

    provider.setVisionSupported(false);
    const after = serialize(provider, [sampleImageMessage()]);
    expect(typeof (after[0] as any).content).toBe("string");
    expect((after[0] as any).content).toContain("[Referenced image");
  });

  it("strips images from tool_result attachments under text-only mode", () => {
    const provider = new OpenAICompatibleProvider({
      model: "deepseek-v4-pro",
      apiKey: "k",
      supportsVision: false,
    });
    const wire = serialize(provider, [
      {
        role: "tool_result",
        toolCallId: "call_42",
        content: "screenshot saved",
        contentBlocks: [
          {
            type: "image",
            filePath: "/tmp/x.png",
            mediaType: "image/png",
            base64: "BBBB",
            source: "tool",
          },
        ],
      },
    ]);
    expect(wire).toHaveLength(1);
    expect((wire[0] as any).role).toBe("tool");
    const content = (wire[0] as any).content as string;
    expect(content).toContain("screenshot saved");
    expect(content).toContain("image attached from tool");
    expect(content).not.toContain("BBBB");
    expect(content).not.toContain("data:image");
  });

  it("tool_result with images still fans out to follow-up user message when vision enabled", () => {
    const provider = new OpenAICompatibleProvider({ model: "gpt-4o", apiKey: "k" });
    const wire = serialize(provider, [
      {
        role: "tool_result",
        toolCallId: "call_42",
        content: "screenshot saved",
        contentBlocks: [
          {
            type: "image",
            filePath: "/tmp/x.png",
            mediaType: "image/png",
            base64: "BBBB",
            source: "tool",
          },
        ],
      },
    ]);
    expect(wire).toHaveLength(2);
    expect((wire[0] as any).role).toBe("tool");
    expect((wire[1] as any).role).toBe("user");
    const followUpContent = (wire[1] as any).content;
    expect(Array.isArray(followUpContent)).toBe(true);
    expect(followUpContent[1].type).toBe("image_url");
  });
});

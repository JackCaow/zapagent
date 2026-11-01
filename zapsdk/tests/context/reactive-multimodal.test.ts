import { describe, expect, it } from "bun:test";
import { ReactiveCompact } from "../../context/reactive-compact.js";
import { TokenCounter } from "../../context/token-counter.js";
import { createUserMessage, type Message } from "../../core/types.js";
import { AnthropicProvider } from "../../core/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";

const image = { type: "image" as const, filePath: "/fixture.png", mediaType: "image/png", source: "fixture", base64: "AA==" };
// Exercise the actual wire serializers without constructing clients or making requests.
const serializers = [
  ["Anthropic", Object.create(AnthropicProvider.prototype)],
  ["Chat Completions", Object.create(OpenAICompatibleProvider.prototype)],
] as const;

function history(old: Message): Message[] {
  return [{ role: "system", content: "system" }, old,
    { role: "assistant", content: "ack" }, { role: "user", content: "continue" }];
}

describe("reactive multimodal wire reduction", () => {
  for (const [name, serializer] of serializers) {
    it(`${name}: shrinks mirrored historical text on the wire without losing images`, () => {
      const old = createUserMessage("HEAD " + "x".repeat(80000) + " TAIL", [image]);
      const messages = history(old), original = structuredClone(messages);
      const result = new ReactiveCompact().compactMessages(messages, new TokenCounter(), "continue");
      const reduced = result.messages[1]!;
      const before = serializer.toApiMessage(old), after = serializer.toApiMessage(reduced);
      expect(result.compacted).toBe(true);
      expect(JSON.stringify(after).length).toBeLessThan(JSON.stringify(before).length);
      expect(after.content[0].text).toBe(reduced.content);
      expect(after.content[0].text).toContain("HEAD");
      expect(after.content[0].text).toContain("TAIL");
      expect(after.content.slice(1)).toEqual(before.content.slice(1));
      expect(result.messages.at(-1)).toEqual(messages.at(-1));
      expect(messages).toEqual(original);
      expect(new ReactiveCompact().compactMessages(result.messages, new TokenCounter(), "continue").compacted).toBe(false);
    });
  }

  it("synchronizes inline microcompaction before estimating a reduction", () => {
    const old = createUserMessage('<file_content path="a">' + "x".repeat(80000) + "</file_content>", [image]);
    const messages = [old, ...[1, 2].map(i => ({ role: "user" as const, content: `<file_content path="${i}">recent</file_content>` })),
      { role: "user" as const, content: "continue" }];
    const result = new ReactiveCompact().compactMessages(messages, new TokenCounter(), "continue");
    expect(result.compacted).toBe(true);
    expect(result.messages[0]!.content).toContain("use read_file");
    expect(result.messages[0]!.contentBlocks![0]).toEqual({ type: "text", text: result.messages[0]!.content });
    expect(result.messages[0]!.contentBlocks![1]).toEqual(image);
  });

  for (const blocks of [
    [{ type: "text" as const, text: "independent evidence" }, image],
    [{ type: "text" as const, text: "x".repeat(80000) }, { type: "text" as const, text: "independent evidence" }, image],
    [image],
  ]) {
    it("does not claim text reduction for independent or image-only blocks", () => {
      const old: Message = { role: "user", content: "x".repeat(80000), contentBlocks: blocks };
      const messages = history(old);
      const result = new ReactiveCompact().compactMessages(messages, new TokenCounter(), "continue");
      expect(result.compacted).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  }

  it("retains the complete protected multimodal request", () => {
    const current = createUserMessage("x".repeat(80000), [image]);
    const result = new ReactiveCompact().compactMessages([current], new TokenCounter(), current.content);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual([current]);
  });
});

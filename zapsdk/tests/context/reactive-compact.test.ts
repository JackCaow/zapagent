import { describe, expect, it } from "bun:test";
import { ReactiveCompact } from "../../context/reactive-compact.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";
import { countCodePoints } from "../../utils/logical-lines.js";

describe("ReactiveCompact", () => {
  it("drops old oversized messages on retry even when history has fewer than 11 messages", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          throw new Error("context length exceeded");
        }
        return {
          type: "text",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const hugeOldMessage = `old oversized context ${"x".repeat(80_000)}`;
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: hugeOldMessage },
      { role: "assistant", content: "assistant 1" },
      { role: "user", content: "user 2" },
      { role: "assistant", content: "assistant 2" },
      { role: "user", content: "user 3" },
      { role: "assistant", content: "assistant 3" },
      { role: "user", content: "latest user" },
    ];

    const result = await new ReactiveCompact().callWithCompaction(provider, messages);

    expect(result.compacted).toBe(true);
    expect(calls).toHaveLength(2);
    const retryMessages = calls[1];
    expect(retryMessages[0]).toEqual({ role: "system", content: "system" });
    expect(retryMessages[1]?.role).toBe("user");
    expect(retryMessages[1]?.content).toContain("earlier messages compacted to fit context limit");
    expect(retryMessages.some((m) => m.content === hugeOldMessage)).toBe(false);
    expect(retryMessages.at(-1)?.content).toBe("latest user");
    expect(totalChars(retryMessages)).toBeLessThan(totalChars(messages));
  });

  it("backs up retry tail to include the assistant for retained tool results", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          throw new Error("prompt too long");
        }
        return {
          type: "text",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: `old ${"x".repeat(80_000)}` },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "run tools" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read_file", arguments: { path: "a.ts" } },
          { id: "t2", name: "read_file", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool_result", toolCallId: "t1", content: "a" },
      { role: "tool_result", toolCallId: "t2", content: "b" },
      { role: "user", content: "latest user" },
    ];

    await new ReactiveCompact().callWithCompaction(provider, messages);

    const retryMessages = calls[1];
    const assistantIndex = retryMessages.findIndex((m) => m.role === "assistant" && m.toolCalls?.length === 2);
    const t1Index = retryMessages.findIndex((m) => m.role === "tool_result" && m.toolCallId === "t1");
    const t2Index = retryMessages.findIndex((m) => m.role === "tool_result" && m.toolCallId === "t2");
    expect(assistantIndex).toBeGreaterThan(0);
    expect(t1Index).toBeGreaterThan(assistantIndex);
    expect(t2Index).toBeGreaterThan(assistantIndex);
  });

  it("preserves all leading system messages on overflow retry", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          throw new Error("context length exceeded");
        }
        return {
          type: "text",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const hugeOldMessage = `old oversized context ${"x".repeat(80_000)}`;
    const messages: Message[] = [
      { role: "system", content: "base system prompt" },
      { role: "system", content: "cacheable support instructions" },
      { role: "user", content: hugeOldMessage },
      { role: "assistant", content: "assistant 1" },
      { role: "user", content: "user 2" },
      { role: "assistant", content: "assistant 2" },
      { role: "user", content: "user 3" },
      { role: "assistant", content: "assistant 3" },
      { role: "user", content: "latest user" },
    ];

    await new ReactiveCompact().callWithCompaction(provider, messages);

    const retryMessages = calls[1];
    expect(retryMessages.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(retryMessages[2]?.role).toBe("user");
    expect(retryMessages[2]?.content).toContain("earlier messages compacted to fit context limit");
    expect(retryMessages.some((m) => m.content === hugeOldMessage)).toBe(false);
    expect(retryMessages.at(-1)?.content).toBe("latest user");
  });

  it("keeps actionable previews from the dropped middle range", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          throw new Error("context length exceeded");
        }
        return {
          type: "text",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const largeToolOutput = `src/cache.ts contains prompt cache hashes\n${"trace line\n".repeat(400)}`;
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "Goal: fix cache diagnostics in src/cache.ts" },
      {
        role: "assistant",
        content: "I will inspect the status command",
        toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "src/cache.ts" } }],
      },
      { role: "tool_result", toolCallId: "t1", content: largeToolOutput },
      { role: "assistant", content: "Found that runtime tools differ from base tools" },
      { role: "user", content: "Decision: prefer effective runtime tool schema hash" },
      { role: "assistant", content: "tail 1" },
      { role: "user", content: "tail 2" },
      { role: "assistant", content: "tail 3" },
      { role: "user", content: "tail 4" },
      { role: "assistant", content: "tail 5" },
      { role: "user", content: "latest user" },
    ];

    await new ReactiveCompact().callWithCompaction(provider, messages);

    const retryMessages = calls[1];
    const summary = retryMessages[1]?.content ?? "";
    expect(summary).toContain("earlier messages compacted to fit context limit");
    expect(summary).toContain("Goal: fix cache diagnostics in src/cache.ts");
    expect(summary).toContain("assistant tools=read_file");
    expect(summary).toContain("tool_result(t1)");
    expect(summary).toContain("Decision: prefer effective runtime tool schema hash");
    expect(retryMessages.at(-1)?.content).toBe("latest user");
    expect(totalChars(retryMessages)).toBeLessThan(totalChars(messages));
  });

  it("shrinks a latest oversized pasted user message before retrying", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          throw new Error("prompt too long");
        }
        return {
          type: "text",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const hugePaste = `BEGIN ${"x".repeat(80_000)} END`;
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "short setup" },
      { role: "assistant", content: "ready" },
      { role: "user", content: hugePaste },
    ];

    await new ReactiveCompact().callWithCompaction(provider, messages);

    const retryMessages = calls[1];
    expect(retryMessages).toHaveLength(messages.length);
    expect(retryMessages[0]).toEqual({ role: "system", content: "system" });
    const retryUser = retryMessages.at(-1);
    expect(retryUser?.role).toBe("user");
    expect(retryUser?.content).toContain("BEGIN");
    expect(retryUser?.content).toContain("END");
    expect(retryUser?.content).toContain("chars compacted to fit context limit");
    expect(retryUser?.content).not.toBe(hugePaste);
    expect(totalChars(retryMessages)).toBeLessThan(totalChars(messages));
  });

  it("does not split non-BMP characters when shrinking an oversized user message", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          throw new Error("prompt too long");
        }
        return {
          type: "text",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const hugePaste = `${"a".repeat(2999)}😀${"x".repeat(12_000)} END`;
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: hugePaste },
    ];

    await new ReactiveCompact().callWithCompaction(provider, messages);

    const retryUser = calls[1]?.at(-1);
    expect(retryUser?.role).toBe("user");
    expect(retryUser?.content).toContain("chars compacted to fit context limit");
    expect(hasUnpairedSurrogate(retryUser?.content ?? "")).toBe(false);
  });

  it("does not shrink non-BMP text that is within the character cap", () => {
    const withinCapPaste = `${"😀".repeat(11_996)} END`;
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: withinCapPaste },
    ];

    const result = new ReactiveCompact().compactMessages(messages);

    expect(result.compacted).toBe(false);
    expect(result.messages.at(-1)?.content).toBe(withinCapPaste);
    expect(countCodePoints(withinCapPaste)).toBeLessThanOrEqual(12_000);
    expect(withinCapPaste.length).toBeGreaterThan(12_000);
  });

  it("reports oversized non-BMP user message compaction by code point", () => {
    const hugePaste = `${"😀".repeat(12_001)} END`;
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: hugePaste },
    ];

    const result = new ReactiveCompact().compactMessages(messages);
    const retryUser = result.messages.at(-1);

    expect(result.compacted).toBe(true);
    expect(retryUser?.role).toBe("user");
    expect(retryUser?.content).toContain("…[12005 chars compacted to fit context limit]…");
    expect(retryUser?.content).not.toContain("24006 chars compacted");
    expect(retryUser?.content).not.toBe(hugePaste);
    expect(hasUnpairedSurrogate(retryUser?.content ?? "")).toBe(false);
    expect(totalChars(result.messages)).toBeLessThan(totalChars(messages));
  });

  it("keeps non-BMP dropped-message previews under the character cap intact", () => {
    const preview = "😀".repeat(200);
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: preview },
      { role: "assistant", content: "dropped assistant" },
      { role: "user", content: "tail 1" },
      { role: "assistant", content: "tail 2" },
      { role: "user", content: "tail 3" },
      { role: "assistant", content: "tail 4" },
      { role: "user", content: "tail 5" },
      { role: "assistant", content: "tail 6" },
    ];

    const result = new ReactiveCompact().compactMessages(messages);
    const summary = result.messages[1]?.content ?? "";

    expect(result.compacted).toBe(true);
    expect(summary).toContain(preview);
    expect(summary).not.toContain("chars omitted");
    expect(hasUnpairedSurrogate(summary)).toBe(false);
  });

  it("does not compact and retry image schema rejections", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages) {
        calls.push(messages);
        throw new Error("400 Bad Request: unknown variant `image_url`, expected `text`");
      },
    };
    const messages: Message[] = [
      { role: "system", content: "system" },
      {
        role: "user",
        content: "see image",
        contentBlocks: [
          { type: "text", text: "see image" },
          { type: "image", filePath: "/tmp/image.png", mediaType: "image/png", base64: "AAAA", source: "test" },
        ],
      },
    ];

    await expect(new ReactiveCompact().callWithCompaction(provider, messages))
      .rejects.toThrow("unknown variant");
    expect(calls).toHaveLength(1);
  });
});

function totalChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + countCodePoints(message.content), 0);
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

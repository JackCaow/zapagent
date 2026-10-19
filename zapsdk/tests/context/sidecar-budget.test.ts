import { describe, expect, it } from "bun:test";
import { TokenCounter } from "../../context/token-counter.js";
import { AutoCompact } from "../../context/autocompact.js";
import { ConversationManager } from "../../memory/conversation.js";
import { buildToolTurn } from "../../core/turn.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import type { Message } from "../../core/types.js";

describe("replayed assistant sidecar budgeting", () => {
  it("counts substantial replay fields without changing the message or cache hints", () => {
    const message: Message = { role: "assistant", content: "ok",
      raw: { reasoning_content: "budget fixture ".repeat(10_000) },
      cache: { skipBreakpoint: true },
    };
    const before = JSON.stringify(message);
    const counter = new TokenCounter();
    expect(counter.countMessage(message)).toBeGreaterThan(40_000);
    expect(counter.countMessageChars(message)).toBeGreaterThan(150_000);
    expect(new AutoCompact({ charThreshold: 100_000 }).shouldCompact([message])).toBe(true);
    expect(JSON.stringify(message)).toBe(before);
    expect(counter.countMessage({ ...message, cache: undefined })).toBe(counter.countMessage(message));
  });

  it("measures opaque nested JSON fields without a provider-name branch", () => {
    const counter = new TokenCounter();
    const message: Message = { role: "assistant", content: "", raw: {
      vendor_payload: { parts: [{ data: "中🚀".repeat(2_000) }] },
    } };
    expect(counter.countMessage(message)).toBeGreaterThan(2_000);
    expect(counter.countMessageChars(message)).toBeGreaterThan(4_000);
  });

  it("leaves non-assistant metadata and image transport bytes out of replay accounting", () => {
    const counter = new TokenCounter();
    const message: Message = { role: "user", content: "image", raw: { local: "x".repeat(50_000) },
      contentBlocks: [{ type: "image", filePath: "/tmp/fixture.png", source: "clipboard",
        mediaType: "image/png", base64: "x".repeat(50_000) }],
    };
    expect(counter.countMessage(message)).toBe(counter.countMessage({ ...message, raw: undefined }));
    expect(counter.countMessageChars(message)).toBe(5);
    expect(counter.countMessage(message)).toBeGreaterThanOrEqual(4096);
    expect(counter.countMessage(message)).toBeLessThan(4120);
  });

  it("does not turn malformed non-JSON metadata into a new budget-time exception", () => {
    const raw: Record<string, unknown> = {};
    raw.self = raw;
    const message: Message = { role: "assistant", content: "ok", raw };
    expect(new TokenCounter().countMessage(message)).toBeGreaterThan(0);
    expect(new AutoCompact().totalChars([message])).toBe(2);
  });

  it("includes replay fields in stored conversation estimates and preserves tool pairing", () => {
    const conversation = new ConversationManager({ maxMessages: 100, maxTokens: 100 });
    const raw = { reasoning_content: "roundtrip text ".repeat(1_000) };
    conversation.add({ role: "user", content: "inspect the file" });
    conversation.commitTurn(buildToolTurn({ text: "", raw, completed: [{
      id: "read-1", name: "read_file", arguments: { path: "file.txt" },
      result: { success: true, output: "contents" },
    }] }));
    expect(conversation.estimatedTokens).toBeGreaterThan(3_000);
    const view = conversation.getMessages();
    expect(view.at(-2)?.toolCalls?.[0].id).toBe("read-1");
    expect(view.at(-2)?.raw).toEqual(raw);
    expect(view.at(-1)?.toolCallId).toBe("read-1");
  });

  it("keeps counted sidecars byte-for-byte intact on the provider wire", async () => {
    let body: any;
    const provider = new OpenAICompatibleProvider({ model: "fixture", client: {
      chat: { completions: { create: async (params: unknown) => {
        body = params;
        return { choices: [{ message: { content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } };
      } } },
    } as any });
    const message: Message = { role: "assistant", content: "", raw: {
      reasoning_content: "opaque roundtrip field ".repeat(1_000),
    }, toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "file.txt" } }] };
    new TokenCounter().countMessage(message);
    await provider.call([message, { role: "tool_result", content: "contents", toolCallId: "read-1" }]);
    expect(body.messages[0].reasoning_content).toBe(message.raw!.reasoning_content);
    expect(body.messages[0].tool_calls[0].id).toBe("read-1");
    expect(body.messages[1].tool_call_id).toBe("read-1");
  });
});

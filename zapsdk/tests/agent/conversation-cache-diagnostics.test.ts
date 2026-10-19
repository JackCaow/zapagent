import { describe, expect, it } from "bun:test";
import { buildConversationCacheDiagnostics } from "../../agent/conversation-cache-diagnostics.js";
import type { Message } from "../../core/types.js";

describe("buildConversationCacheDiagnostics", () => {
  it("separates reusable conversation history from the fresh run tail", () => {
    const messages: Message[] = [
      { role: "system", content: "stable system" },
      { role: "user", content: "old request" },
      { role: "assistant", content: "old response" },
      { role: "user", content: "current request", cache: { skipBreakpoint: true } },
      { role: "user", content: "memory attachment", cache: { transient: true } },
    ];

    const diagnostics = buildConversationCacheDiagnostics(messages);

    expect(diagnostics.prefix.messageCount).toBe(2);
    expect(diagnostics.prefix.messageHashes).toHaveLength(2);
    expect(diagnostics.tail.messageCount).toBe(2);
    expect(diagnostics.prefix.estimatedTokens).toBeGreaterThan(0);
    expect(diagnostics.tail.estimatedTokens).toBeGreaterThan(0);
  });

  it("does not treat cache-placement metadata as provider-visible message bytes", () => {
    const makeMessages = (withHint: boolean): Message[] => [
      {
        role: "user",
        content: "first",
        ...(withHint ? { cache: { skipBreakpoint: true } } : {}),
      },
      { role: "assistant", content: "later eligible message" },
    ];

    const withoutHint = buildConversationCacheDiagnostics(makeMessages(false));
    const withHint = buildConversationCacheDiagnostics(makeMessages(true));

    expect(withHint.prefix.messageCount).toBe(2);
    expect(withHint.prefix.hash).toBe(withoutHint.prefix.hash);
    expect(withHint.prefix.messageHashes).toEqual(withoutHint.prefix.messageHashes);
  });

  it("canonicalizes tool arguments and provider sidecar key order", () => {
    const first: Message[] = [{
      role: "assistant",
      content: "",
      raw: { z: "last", a: "first" },
      toolCalls: [{ id: "tc_1", name: "read_file", arguments: { z: 2, a: 1 } }],
    }];
    const second: Message[] = [{
      role: "assistant",
      content: "",
      raw: { a: "first", z: "last" },
      toolCalls: [{ id: "tc_1", name: "read_file", arguments: { a: 1, z: 2 } }],
    }];

    expect(buildConversationCacheDiagnostics(first).prefix.hash)
      .toBe(buildConversationCacheDiagnostics(second).prefix.hash);
  });

  it("changes only the rewritten message fingerprint when old history mutates", () => {
    const before = buildConversationCacheDiagnostics([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    const after = buildConversationCacheDiagnostics([
      { role: "user", content: "one" },
      { role: "assistant", content: "two changed" },
    ]);

    expect(after.prefix.messageHashes[0]).toBe(before.prefix.messageHashes[0]);
    expect(after.prefix.messageHashes[1]).not.toBe(before.prefix.messageHashes[1]);
    expect(after.prefix.hash).not.toBe(before.prefix.hash);
  });
});

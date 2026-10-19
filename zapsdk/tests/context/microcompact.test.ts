import { describe, expect, it } from "bun:test";
import { Microcompact } from "../../context/microcompact.js";
import type { Message } from "../../core/types.js";

function imageToolResult(id: string, content = "Loaded image image/png"): Message {
  return {
    role: "tool_result",
    toolCallId: id,
    content,
    contentBlocks: [{
      type: "image",
      filePath: "/tmp/image.png",
      mediaType: "image/png",
      base64: "A".repeat(10_000),
      source: "/tmp/image.png",
    }],
  };
}

describe("Microcompact", () => {
  it("drops contentBlocks from old tool results even when the text stub is short", () => {
    const messages: Message[] = [
      imageToolResult("old"),
      imageToolResult("recent"),
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(compacted).toBe(1);
    expect(messages[0]?.content).toContain("image block omitted by microcompact");
    expect(messages[0]?.contentBlocks).toBeUndefined();
    expect(messages[1]?.content).toBe("Loaded image image/png");
    expect(messages[1]?.contentBlocks).toHaveLength(1);
  });

  it("keeps compacted image tool results idempotent", () => {
    const messages: Message[] = [
      imageToolResult("old"),
      { role: "tool_result", toolCallId: "recent", content: "ok" },
    ];
    const microcompact = new Microcompact({ keepRecent: 1 });

    expect(microcompact.compact(messages)).toBe(1);
    const once = messages[0]?.content;
    expect(microcompact.compact(messages)).toBe(0);
    expect(messages[0]?.content).toBe(once);
  });

  it("keeps compacted image tool results idempotent across instances", () => {
    const messages: Message[] = [
      imageToolResult("old"),
      { role: "tool_result", toolCallId: "recent", content: "ok" },
    ];

    expect(new Microcompact({ keepRecent: 1 }).compact(messages)).toBe(1);
    const once = messages[0]?.content;
    expect(once).toContain("zap-microcompact:v1");

    expect(new Microcompact({ keepRecent: 1 }).compact(messages)).toBe(0);
    expect(messages[0]?.content).toBe(once);
  });

  it("continues to head-tail compact old text tool results", () => {
    const content = `start ${"x".repeat(600)} end`;
    const messages: Message[] = [
      { role: "tool_result", toolCallId: "old", content },
      { role: "tool_result", toolCallId: "recent", content: "recent" },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(compacted).toBe(1);
    expect(messages[0]?.content).toContain("chars compacted");
    expect(messages[0]?.content).toContain("start");
    expect(messages[0]?.content).toContain("end");
  });

  it("keeps compacted text tool results idempotent across instances", () => {
    const messages: Message[] = [
      { role: "tool_result", toolCallId: "old", content: `start ${"x".repeat(600)} end` },
      { role: "tool_result", toolCallId: "recent", content: "recent" },
    ];

    expect(new Microcompact({ keepRecent: 1 }).compact(messages)).toBe(1);
    const once = messages[0]?.content;
    expect(once).toContain("zap-microcompact:v1");

    expect(new Microcompact({ keepRecent: 1 }).compact(messages)).toBe(0);
    expect(messages[0]?.content).toBe(once);
  });

  it("does not rewrite legacy compacted tool results", () => {
    const legacyLong = "head …[610 chars compacted]… tail";
    const legacyShort = "head [327 chars]";
    const messages: Message[] = [
      { role: "tool_result", toolCallId: "old-long", content: legacyLong },
      { role: "tool_result", toolCallId: "old-short", content: legacyShort },
      { role: "tool_result", toolCallId: "recent", content: "recent" },
    ];

    expect(new Microcompact({ keepRecent: 1 }).compact(messages)).toBe(0);
    expect(messages[0]?.content).toBe(legacyLong);
    expect(messages[1]?.content).toBe(legacyShort);
  });

  it("does not compact short tool results just because code units exceed the threshold", () => {
    const content = "😀".repeat(100);
    const messages: Message[] = [
      { role: "tool_result", toolCallId: "old", content },
      { role: "tool_result", toolCallId: "recent", content: "recent" },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(content.length).toBeGreaterThan(100);
    expect(compacted).toBe(0);
    expect(messages[0]?.content).toBe(content);
  });

  it("reports compacted tool result sizes by Unicode code point", () => {
    const content = "😀".repeat(260);
    const messages: Message[] = [
      { role: "tool_result", toolCallId: "old", content },
      { role: "tool_result", toolCallId: "recent", content: "recent" },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(compacted).toBe(1);
    expect(messages[0]?.content).toContain("[260 chars]");
    expect(messages[0]?.content).not.toContain("[520 chars]");
    expect(messages[0]?.content).not.toContain("chars compacted");
  });

  it("does not split non-BMP characters when compacting old text tool results", () => {
    const content = nonBmpAtMicrocompactEdges();
    const messages: Message[] = [
      { role: "tool_result", toolCallId: "old", content },
      { role: "tool_result", toolCallId: "recent", content: "recent" },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(compacted).toBe(1);
    expect(messages[0]?.content).toContain("chars compacted");
    expect(hasUnpairedSurrogate(messages[0]?.content ?? "")).toBe(false);
  });

  it("compacts old MCP resource blocks in user messages", () => {
    const oldPayload = `mcp-start ${"x".repeat(900)} mcp-end`;
    const recentPayload = `recent-start ${"y".repeat(900)} recent-end`;
    const messages: Message[] = [
      {
        role: "user",
        content: [
          "inspect resource",
          `<mcp_resource server="docs" uri="file://old" mimeType="text/plain">`,
          oldPayload,
          "</mcp_resource>",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "inspect recent resource",
          `<mcp_resource server="docs" uri="file://recent">`,
          recentPayload,
          "</mcp_resource>",
        ].join("\n"),
      },
    ];
    const microcompact = new Microcompact({ keepRecent: 1 });

    expect(microcompact.compact(messages)).toBe(1);
    expect(messages[0]?.content).toContain('<mcp_resource server="docs" uri="file://old" mimeType="text/plain">');
    expect(messages[0]?.content).toContain("mcp-start");
    expect(messages[0]?.content).toContain("mcp-end");
    expect(messages[0]?.content).toContain("chars compacted; re-read MCP resource for full content");
    expect(messages[0]?.content).not.toContain("x".repeat(500));
    expect(messages[1]?.content).toContain(recentPayload);

    const once = messages[0]?.content;
    expect(microcompact.compact(messages)).toBe(0);
    expect(messages[0]?.content).toBe(once);
  });

  it("does not compact inline context blocks just because code units exceed the threshold", () => {
    const oldPayload = "😀".repeat(498);
    const messages: Message[] = [
      {
        role: "user",
        content: [
          "inspect resource",
          `<file_content path="/tmp/old.txt">`,
          oldPayload,
          "</file_content>",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "inspect recent resource",
          `<file_content path="/tmp/recent.txt">`,
          "recent",
          "</file_content>",
        ].join("\n"),
      },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(oldPayload.length).toBeGreaterThan(500);
    expect(compacted).toBe(0);
    expect(messages[0]?.content).toContain(oldPayload);
    expect(messages[0]?.content).not.toContain("chars compacted");
  });

  it("reports compacted inline context block sizes by Unicode code point", () => {
    const oldPayload = "😀".repeat(520);
    const messages: Message[] = [
      {
        role: "user",
        content: [
          "inspect resource",
          `<file_content path="/tmp/old.txt">`,
          oldPayload,
          "</file_content>",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "inspect recent resource",
          `<file_content path="/tmp/recent.txt">`,
          "recent",
          "</file_content>",
        ].join("\n"),
      },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(compacted).toBe(1);
    expect(messages[0]?.content).toContain("…[522 chars compacted; use read_file tool for full content]…");
    expect(messages[0]?.content).not.toContain("1042 chars compacted");
  });

  it("does not split non-BMP characters when compacting old inline context blocks", () => {
    const oldPayload = nonBmpAtMicrocompactEdges();
    const recentPayload = nonBmpAtMicrocompactEdges();
    const messages: Message[] = [
      {
        role: "user",
        content: [
          "inspect resource",
          `<file_content path="/tmp/old.txt">`,
          oldPayload,
          "</file_content>",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "inspect recent resource",
          `<file_content path="/tmp/recent.txt">`,
          recentPayload,
          "</file_content>",
        ].join("\n"),
      },
    ];

    const compacted = new Microcompact({ keepRecent: 1 }).compact(messages);

    expect(compacted).toBe(1);
    expect(messages[0]?.content).toContain("chars compacted; use read_file tool for full content");
    expect(hasUnpairedSurrogate(messages[0]?.content ?? "")).toBe(false);
    expect(messages[1]?.content).toContain(recentPayload);
  });
});

function nonBmpAtMicrocompactEdges(): string {
  const emoji = "😀";
  return `${"a".repeat(199)}${emoji}${"b".repeat(400)}${emoji}${"c".repeat(199)}`;
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

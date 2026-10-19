import { describe, expect, it } from "bun:test";
import {
  AutoCompact,
  compactSummaryFailureReason,
  headTailPreview,
  sanitizeCompactSummary,
  validateCompactSummary,
} from "../../context/autocompact.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";

describe("headTailPreview", () => {
  it("does not truncate when code units exceed the cap but code points fit", () => {
    const content = "😀".repeat(100);

    expect(content.length).toBeGreaterThan(100);
    expect(headTailPreview(content, 100)).toBe(content);
  });

  it("reports elided preview length by Unicode code point", () => {
    const content = `${"a".repeat(40)}${"😀".repeat(80)}${"z".repeat(40)}`;
    const preview = headTailPreview(content, 100);

    expect(preview).toContain("…[120 chars elided]…");
  });

  it("does not split non-BMP characters at preview boundaries", () => {
    const emoji = "😀";
    const content = `${"a".repeat(19)}${emoji}${"b".repeat(80)}${emoji}${"c".repeat(19)}`;

    const preview = headTailPreview(content, 100);

    expect(preview).toContain("chars elided");
    expect(hasUnpairedSurrogate(preview)).toBe(false);
  });
});

describe("sanitizeCompactSummary", () => {
  it("removes completed analysis scratchpads", () => {
    const summary = sanitizeCompactSummary([
      "<analysis>",
      "private planning notes",
      "</analysis>",
      "",
      "# Primary Request and Intent",
      "- fix the cache issue",
    ].join("\n"));

    expect(summary).toBe("# Primary Request and Intent\n- fix the cache issue");
    expect(summary).not.toContain("private planning notes");
  });

  it("redacts credentials before storing compact summaries", () => {
    const summary = sanitizeCompactSummary([
      "# Primary Request and Intent",
      "- user pasted api_key = sk-live",
      "- curl used Authorization: Bearer token-live",
      "- password: 'pw-live'",
    ].join("\n"));

    expect(summary).toContain("api_key = [REDACTED]");
    expect(summary).toContain("Authorization: Bearer [REDACTED]");
    expect(summary).toContain("password: '[REDACTED]'");
    expect(summary).not.toContain("sk-live");
    expect(summary).not.toContain("token-live");
    expect(summary).not.toContain("pw-live");
  });

  it("removes unterminated analysis scratchpads instead of leaking them", () => {
    const summary = sanitizeCompactSummary([
      "# Primary Request and Intent",
      "- keep this",
      "",
      "<analysis>",
      "private tail",
    ].join("\n"));

    expect(summary).toBe("# Primary Request and Intent\n- keep this");
    expect(summary).not.toContain("private tail");
  });
});

describe("validateCompactSummary", () => {
  it("accepts summaries with every required section", () => {
    const summary = [
      "# Primary Request and Intent",
      "- goal",
      "# All user messages (verbatim)",
      "- message",
      "# Current task status",
      "- status",
      "# Files read / modified",
      "- file",
      "# Commands run",
      "- command",
      "# Key facts discovered",
      "- fact",
      "# Decisions made",
      "- decision",
      "# Errors encountered and their resolution",
      "- none",
      "# Code changes summary",
      "- change",
      "# Next steps",
      "- continue",
    ].join("\n");

    expect(validateCompactSummary(summary)).toEqual({
      ok: true,
      missingHeadings: [],
      emptyHeadings: [],
    });
  });

  it("accepts CR-only compact summaries as logical lines", () => {
    const summary = [
      "# Primary Request and Intent",
      "- goal",
      "# All user messages (verbatim)",
      "- message",
      "# Current task status",
      "- status",
      "# Files read / modified",
      "- file",
      "# Commands run",
      "- command",
      "# Key facts discovered",
      "- fact",
      "# Decisions made",
      "- decision",
      "# Errors encountered and their resolution",
      "- none",
      "# Code changes summary",
      "- change",
      "# Next steps",
      "- continue",
    ].join("\r");

    expect(validateCompactSummary(summary)).toEqual({
      ok: true,
      missingHeadings: [],
      emptyHeadings: [],
    });
    expect(compactSummaryFailureReason(summary)).toBeNull();
  });

  it("accepts common markdown variants of required headings", () => {
    const summary = [
      "# **Primary Request and Intent:**",
      "- goal",
      "# _All user messages (verbatim)_：",
      "- message",
      "# Current task status",
      "- status",
      "# Files read/modified",
      "- file",
      "# Commands run:",
      "- command",
      "# Key facts discovered",
      "- fact",
      "# Decisions made",
      "- decision",
      "# Errors encountered and their resolution",
      "- none",
      "# Code changes summary",
      "- change",
      "# Next steps",
      "- continue",
    ].join("\n");

    expect(validateCompactSummary(summary)).toEqual({
      ok: true,
      missingHeadings: [],
      emptyHeadings: [],
    });
  });

  it("accepts Chinese translations of required headings", () => {
    const summary = [
      "# 主要请求和意图",
      "- 修复缓存命中率问题",
      "# 所有用户消息（原文）",
      "- 用户说继续推进",
      "# 当前任务状态",
      "- 正在优化记忆层",
      "# 读取/修改的文件",
      "- zapsdk/context/autocompact.ts",
      "# 运行的命令",
      "- bun test",
      "# 关键事实",
      "- 中文标题以前无法通过 compact 校验",
      "# 已做决定",
      "- 统一中英文标题归一化",
      "# 错误及解决",
      "- 无",
      "# 代码变更摘要",
      "- 增加中文 heading alias",
      "# 后续步骤",
      "- 运行全量检查",
    ].join("\n");

    expect(validateCompactSummary(summary)).toEqual({
      ok: true,
      missingHeadings: [],
      emptyHeadings: [],
    });
    expect(compactSummaryFailureReason(summary)).toBeNull();
  });

  it("rejects prose summaries that omit required anchors", () => {
    const quality = validateCompactSummary("I fixed some things and should continue.");

    expect(quality.ok).toBe(false);
    expect(quality.missingHeadings).toContain("Primary Request and Intent");
    expect(quality.missingHeadings).toContain("Next steps");
    expect(quality.emptyHeadings).toEqual([]);
  });

  it("rejects summaries whose required sections have no content", () => {
    const summary = [
      "# Primary Request and Intent",
      "- goal",
      "# All user messages (verbatim)",
      "# Current task status",
      "- status",
      "# Files read / modified",
      "- file",
      "# Commands run",
      "- command",
      "# Key facts discovered",
      "- fact",
      "# Decisions made",
      "- decision",
      "# Errors encountered and their resolution",
      "- none",
      "# Code changes summary",
      "- change",
      "# Next steps",
      "",
    ].join("\n");

    const quality = validateCompactSummary(summary);

    expect(quality.ok).toBe(false);
    expect(quality.missingHeadings).toEqual([]);
    expect(quality.emptyHeadings).toEqual([
      "All user messages (verbatim)",
      "Next steps",
    ]);
  });
});

describe("compactSummaryFailureReason", () => {
  it("returns null for usable compact summaries", () => {
    expect(compactSummaryFailureReason(validSummary())).toBeNull();
  });

  it("reports missing required sections without dumping the summary", () => {
    const reason = compactSummaryFailureReason("A short prose summary.");

    expect(reason).toContain("missing required sections: Primary Request and Intent");
    expect(reason).toContain("+7 more");
    expect(reason).not.toContain("A short prose summary");
  });

  it("reports empty required sections separately from missing sections", () => {
    const reason = compactSummaryFailureReason([
      "# Primary Request and Intent",
      "- goal",
      "# All user messages (verbatim)",
      "# Current task status",
      "- status",
      "# Files read / modified",
      "- file",
      "# Commands run",
      "- command",
      "# Key facts discovered",
      "- fact",
      "# Decisions made",
      "- decision",
      "# Errors encountered and their resolution",
      "- none",
      "# Code changes summary",
      "- change",
      "# Next steps",
      "",
    ].join("\n"));

    expect(reason).toBe(
      "summarizer returned an unusable compact summary (empty required sections: All user messages (verbatim), Next steps)",
    );
  });
});

describe("AutoCompact.compact", () => {
  async function captureToolHistory(messages: Message[]): Promise<string> {
    let history = "";
    await new AutoCompact({ charThreshold: 10, keepRecent: 1 }).compact([
      { role: "user", content: "Run the checks" }, ...messages,
      { role: "user", content: "Continue" },
    ], { call: async (input) => {
      history = input[1].content;
      return { type: "text", text: validSummary(), usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    return history;
  }

  it("preserves tool invocations and result references when tool-only turns are summarized", async () => {
    const messages: Message[] = [
      { role: "assistant", content: "", raw: { reasoning_content: "opaque replay only" }, toolCalls: [
        { id: "check-a", name: "bash", arguments: { command: "fixture-check --case alpha" } },
        { id: "check-b", name: "bash", arguments: { command: "fixture-check --case beta" } },
      ] },
      { role: "tool_result", toolCallId: "check-b", content: "FAILED: expected 7, got 9" },
      { role: "tool_result", toolCallId: "check-a", content: "PASS" },
    ];
    const before = JSON.stringify(messages);
    const history = await captureToolHistory(messages);
    expect(history).toContain('"name":"bash"');
    expect(history).toContain("fixture-check --case alpha");
    expect(history).toContain("fixture-check --case beta");
    expect(history).toContain('[tool_result reference]: {"id":"check-b"}\n[tool_result]: FAILED: expected 7, got 9');
    expect(history).toContain('[tool_result reference]: {"id":"check-a"}\n[tool_result]: PASS');
    expect(history).not.toContain("opaque replay only");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("redacts and bounds large tool argument previews before summarization", async () => {
    const history = await captureToolHistory([
      { role: "assistant", content: "", toolCalls: [{ id: "write", name: "write_file", arguments: {
        path: "/tmp/fixture.txt", password: 'fixture-secret"tail-marker', content: "🚀".repeat(20_000),
        authorization: "Bearer fixture-credential",
      } }] },
      { role: "tool_result", toolCallId: "write", content: "written" },
    ]);
    expect(history).toContain("/tmp/fixture.txt");
    expect(history).toContain("[REDACTED]");
    expect(history).toContain("chars elided");
    expect(history).not.toContain("fixture-secret");
    expect(history).not.toContain("tail-marker");
    expect(history).not.toContain("fixture-credential");
    expect(Array.from(history).length).toBeLessThan(6_500);
    expect(hasUnpairedSurrogate(history)).toBe(false);
  });

  it("marks unserializable arguments explicitly while retaining tool identities", async () => {
    const args: Record<string, unknown> = {};
    args.self = args;
    const history = await captureToolHistory([
      { role: "assistant", content: "", toolCalls: [{ id: "custom-1", name: "custom", arguments: args }] },
      { role: "tool_result", toolCallId: "custom-1", content: "result" },
    ]);
    expect(history).toContain('"id":"custom-1","name":"custom"');
    expect(history).toContain("[unserializable arguments]");
    expect(history).toContain('[tool_result reference]: {"id":"custom-1"}');
  });

  const messages: Message[] = [
    { role: "system", content: "stable system prompt" },
    { role: "user", content: "first user message with important instructions" },
    { role: "assistant", content: "first assistant answer" },
    { role: "user", content: "recent user tail" },
  ];

  it("counts auto-compact trigger characters by Unicode code point", () => {
    const compact = new AutoCompact({ charThreshold: 100 });
    const content = "😀".repeat(100);

    expect(content.length).toBeGreaterThan(100);
    expect(compact.totalChars([{ role: "user", content }])).toBe(100);
    expect(compact.shouldCompact([{ role: "user", content }])).toBe(false);
    expect(new AutoCompact({ charThreshold: 99 }).shouldCompact([{ role: "user", content }])).toBe(true);
  });

  it("uses Unicode character counts when choosing the char-budgeted compact tail", async () => {
    let compactInput = "";
    const provider: LLMProvider = {
      call: async (messages) => {
        compactInput = messages[1]?.content ?? "";
        return {
          type: "text",
          text: validSummary(),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const previousTail = "😀".repeat(10);
    const latestTail = "🚀".repeat(10);
    const messages: Message[] = [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "old middle message" },
      { role: "assistant", content: previousTail },
      { role: "user", content: latestTail },
    ];

    const result = await new AutoCompact({ charThreshold: 44, keepRecent: 99 })
      .compact(messages, provider);

    expect(result.summary).not.toBe("");
    expect(compactInput).toContain("old middle message");
    expect(compactInput).not.toContain(previousTail);
    expect(result.messages[1]?.content).toContain("[Context compacted — 1 earlier messages summarized]");
    expect(result.messages.at(-2)?.content).toBe(previousTail);
    expect(result.messages.at(-1)?.content).toBe(latestTail);
  });

  it("uses replayed sidecar size for tail selection while preserving the latest tool turn", async () => {
    const provider: LLMProvider = { call: async () => ({
      type: "text", text: validSummary(), usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    const messages: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "request" }];
    for (const id of ["old", "latest"]) {
      messages.push({ role: "assistant", content: "", raw: { reasoning_content: id.repeat(1_000) },
        toolCalls: [{ id, name: "read_file", arguments: { path: `${id}.txt` } }] },
      { role: "tool_result", content: "read", toolCallId: id });
    }
    messages.push({ role: "user", content: "continue" });
    const before = JSON.stringify(messages);
    const compact = new AutoCompact({ charThreshold: 2_000, keepRecent: 99 });
    expect(compact.shouldCompact(messages)).toBe(true);
    const result = await compact.compact(messages, provider);
    expect(result.summary).not.toBe("");
    expect(result.messages.some((message) => message.toolCalls?.[0].id === "old")).toBe(false);
    const latest = result.messages.findIndex((message) => message.toolCalls?.[0].id === "latest");
    expect(latest).toBeGreaterThan(0);
    expect(result.messages[latest].raw).toEqual(messages[4].raw);
    expect(result.messages[latest + 1].toolCallId).toBe("latest");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("leaves messages unchanged when the summarizer throws", async () => {
    const provider: LLMProvider = {
      call: async () => {
        throw new Error("summarizer unavailable");
      },
    };

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(messages, provider);

    expect(result.summary).toBe("");
    expect(result.messages).toBe(messages);
    expect(result.failureReason).toBe("summarizer failed: summarizer unavailable");
  });

  it("leaves messages unchanged when the summarizer omits required sections", async () => {
    const provider: LLMProvider = {
      call: async () => ({
        type: "text",
        text: "Earlier work was summarized.",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(messages, provider);

    expect(result.summary).toBe("");
    expect(result.messages).toBe(messages);
    expect(result.failureReason).toContain("missing required sections: Primary Request and Intent");
  });

  it("repairs a malformed compact summary before failing the compact pass", async () => {
    const calls: Message[][] = [];
    const provider: LLMProvider = {
      call: async (messages) => {
        calls.push(messages);
        return {
          type: "text",
          text: calls.length === 1
            ? "Earlier work was summarized."
            : validSummary(),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(messages, provider);

    expect(calls.length).toBe(2);
    expect(result.summary).toBe(validSummary());
    expect(result.failureReason).toBeUndefined();
    expect(result.messages).not.toBe(messages);
    expect(result.messages[1]?.content).toContain("[Context compacted");
    expect(calls[1]?.[1]?.content).toContain("missing required sections: Primary Request and Intent");
    expect(calls[1]?.[1]?.content).toContain("first user message with important instructions");
    expect(calls[1]?.[1]?.content).toContain("Previous invalid summary:");
  });

  it("leaves messages unchanged when compact summary repair throws", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      call: async () => {
        calls++;
        if (calls === 2) throw new Error("repair unavailable");
        return {
          type: "text",
          text: "Earlier work was summarized.",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(messages, provider);

    expect(calls).toBe(2);
    expect(result.summary).toBe("");
    expect(result.messages).toBe(messages);
    expect(result.failureReason).toContain("missing required sections: Primary Request and Intent");
    expect(result.failureReason).toContain("repair attempt failed: repair unavailable");
  });

  it("leaves messages unchanged when the summarizer returns empty required sections", async () => {
    const provider: LLMProvider = {
      call: async () => ({
        type: "text",
        text: [
          "# Primary Request and Intent",
          "- goal",
          "# All user messages (verbatim)",
          "# Current task status",
          "- status",
          "# Files read / modified",
          "- file",
          "# Commands run",
          "- command",
          "# Key facts discovered",
          "- fact",
          "# Decisions made",
          "- decision",
          "# Errors encountered and their resolution",
          "- none",
          "# Code changes summary",
          "- change",
          "# Next steps",
          "- continue",
        ].join("\n"),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(messages, provider);

    expect(result.summary).toBe("");
    expect(result.messages).toBe(messages);
    expect(result.failureReason).toContain("empty required sections: All user messages (verbatim)");
  });

  it("redacts compact input before sending history to the summarizer", async () => {
    let compactInput = "";
    const provider: LLMProvider = {
      call: async (messages) => {
        compactInput = messages[1]?.content ?? "";
        return {
          type: "text",
          text: validSummary(),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const sensitiveMessages: Message[] = [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "Authorization: Bearer sk-live\napi_key = sk-other" },
      { role: "assistant", content: "working" },
      { role: "user", content: "recent tail" },
    ];

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(sensitiveMessages, provider);

    expect(result.summary).not.toBe("");
    expect(compactInput).toContain("Authorization: Bearer [REDACTED]");
    expect(compactInput).toContain("api_key = [REDACTED]");
    expect(compactInput).not.toContain("sk-live");
    expect(compactInput).not.toContain("sk-other");
  });

  it("preserves all leading system messages outside the compacted middle", async () => {
    let compactInput = "";
    const provider: LLMProvider = {
      call: async (messages) => {
        compactInput = messages[1]?.content ?? "";
        return {
          type: "text",
          text: validSummary(),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const multiSystemMessages: Message[] = [
      { role: "system", content: "base system prompt" },
      { role: "system", content: "cacheable support instructions" },
      { role: "user", content: "older user work" },
      { role: "assistant", content: "older assistant work" },
      { role: "user", content: "recent tail" },
    ];

    const result = await new AutoCompact({ charThreshold: 10, keepRecent: 1 })
      .compact(multiSystemMessages, provider);

    expect(result.summary).not.toBe("");
    expect(result.messages.slice(0, 2)).toEqual(multiSystemMessages.slice(0, 2));
    expect(result.messages[2]?.role).toBe("user");
    expect(result.messages[2]?.content).toContain("[Context compacted");
    expect(result.messages.at(-1)?.content).toBe("recent tail");
    expect(compactInput).not.toContain("base system prompt");
    expect(compactInput).not.toContain("cacheable support instructions");
    expect(compactInput).toContain("older user work");
  });
});

function validSummary(): string {
  return [
    "# Primary Request and Intent",
    "- goal",
    "# All user messages (verbatim)",
    "- message",
    "# Current task status",
    "- status",
    "# Files read / modified",
    "- file",
    "# Commands run",
    "- command",
    "# Key facts discovered",
    "- fact",
    "# Decisions made",
    "- decision",
    "# Errors encountered and their resolution",
    "- none",
    "# Code changes summary",
    "- change",
    "# Next steps",
    "- continue",
  ].join("\n");
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

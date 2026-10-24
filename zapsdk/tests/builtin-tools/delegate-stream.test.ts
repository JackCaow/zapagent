import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseClaudeLine,
  parseCodexLine,
  makeParserCtx,
  type ParserCtx,
} from "../../builtin-tools/delegate-stream.js";
import type { AgentEvent } from "../../agent/events.js";

function parseFile(file: string, parser: typeof parseClaudeLine): { events: AgentEvent[]; ctx: ParserCtx } {
  const text = readFileSync(join(import.meta.dir, "fixtures", file), "utf8");
  const ctx = makeParserCtx(`da_test_${file}`, []);
  const events: AgentEvent[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    events.push(...parser(raw, ctx));
  }
  return { events, ctx };
}

describe("parseClaudeLine — happy path", () => {
  it("emits sub_agent_started, tool_call, tool_result, sub_agent_finished for claude-simple", () => {
    const { events, ctx } = parseFile("claude-simple.ndjson", parseClaudeLine);

    const types = events.map((e) =>
      e.type === "content_final" ? `${e.type}:${e.kind}` : e.type,
    );
    expect(types[0]).toBe("sub_agent_started");
    expect(types).toContain("content_final:tool_call");
    expect(types).toContain("content_final:tool_result");
    expect(types[types.length - 1]).toBe("sub_agent_finished");

    const finished = events[events.length - 1];
    if (finished.type !== "sub_agent_finished") throw new Error("expected sub_agent_finished");
    expect(finished.success).toBe(true);

    expect(ctx.finalText).toBe("done");
  });

  it("carries path and ids correctly", () => {
    const { events, ctx } = parseFile("claude-simple.ndjson", parseClaudeLine);
    const tc = events.find((e) => e.type === "content_final" && e.kind === "tool_call");
    expect(tc).toBeDefined();
    if (tc?.type !== "content_final" || tc.kind !== "tool_call") throw new Error("bad");
    expect(tc.toolName).toBe("bash");
    expect(tc.id).toBe("toolu_01");
    expect((tc.arguments as { command: string }).command).toBe("echo hi");
    expect(tc.path).toEqual([ctx.subagentId]);

    const started = events[0];
    if (started.type !== "sub_agent_started") throw new Error("bad");
    expect(started.path ?? []).toEqual([]);
  });
});

describe("session id capture", () => {
  it("captures claude session_id from system.init", () => {
    const { ctx } = parseFile("claude-simple.ndjson", parseClaudeLine);
    expect(ctx.sessionId).toBe("490c4b78-d15a-4b35-98e0-6481b744de01");
  });

  it("captures codex thread_id from thread.started", () => {
    const { ctx } = parseFile("codex-simple.ndjson", parseCodexLine);
    expect(ctx.sessionId).toBe("019dcf84-768d-7140-9506-e45eeb857d6e");
  });

  it("leaves sessionId null when no init/thread.started seen", () => {
    const ctx = makeParserCtx("da_no_init", []);
    parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", result: "x" }), ctx);
    expect(ctx.sessionId).toBeNull();
  });
});

describe("parseClaudeLine — thinking blocks", () => {
  it("maps assistant content[].type:thinking to content_final{kind:thinking}", () => {
    const ctx = makeParserCtx("da_claude_think", []);
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Let me reason about this.", signature: "abc" },
        ],
      },
    });
    const events = parseClaudeLine(line, ctx);
    const thinking = events.find((e) => e.type === "content_final" && e.kind === "thinking");
    if (thinking?.type !== "content_final" || thinking.kind !== "thinking") throw new Error("bad");
    expect(thinking.text).toBe("Let me reason about this.");
  });

  it("ignores empty thinking blocks", () => {
    const ctx = makeParserCtx("da_claude_empty_think", []);
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "", signature: "x" }] },
    });
    const events = parseClaudeLine(line, ctx);
    expect(events.find((e) => e.type === "content_final" && e.kind === "thinking")).toBeUndefined();
  });
});

describe("parseClaudeLine — error + malformed", () => {
  it("emits sub_agent_finished{success:false} on error_* result", () => {
    const { events } = parseFile("claude-error.ndjson", parseClaudeLine);
    const finished = events.find((e) => e.type === "sub_agent_finished");
    if (finished?.type !== "sub_agent_finished") throw new Error("expected sub_agent_finished");
    expect(finished.success).toBe(false);
  });

  it("ignores non-JSON lines without throwing", () => {
    const ctx = makeParserCtx("da_claude_garbage", []);
    expect(parseClaudeLine("not json at all", ctx)).toEqual([]);
    expect(parseClaudeLine("{", ctx)).toEqual([]);
    expect(parseClaudeLine("", ctx)).toEqual([]);
  });

  it("ignores unknown event types", () => {
    const ctx = makeParserCtx("da_claude_unk", []);
    expect(parseClaudeLine(JSON.stringify({ type: "completely_made_up" }), ctx)).toEqual([]);
  });

  it("does not double-emit sub_agent_started when multiple init lines arrive", () => {
    const ctx = makeParserCtx("da_claude_dup", []);
    const a = parseClaudeLine(JSON.stringify({ type: "system", subtype: "init" }), ctx);
    const b = parseClaudeLine(JSON.stringify({ type: "system", subtype: "init" }), ctx);
    expect(a.length).toBe(1);
    expect(b.length).toBe(0);
  });
});

describe("parseCodexLine", () => {
  it("maps thread.started → sub_agent_started, item.* → tool_call/tool_result, turn.completed → sub_agent_finished", () => {
    const { events, ctx } = parseFile("codex-simple.ndjson", parseCodexLine);
    const types = events.map((e) =>
      e.type === "content_final" ? `${e.type}:${e.kind}` : e.type,
    );
    expect(types[0]).toBe("sub_agent_started");
    expect(types).toContain("content_final:tool_call");
    expect(types).toContain("content_final:tool_result");
    expect(types[types.length - 1]).toBe("sub_agent_finished");

    const tc = events.find((e) => e.type === "content_final" && e.kind === "tool_call");
    if (tc?.type !== "content_final" || tc.kind !== "tool_call") throw new Error("bad");
    expect(tc.toolName).toBe("bash");
    expect((tc.arguments as { command: string }).command).toBe("/bin/bash -lc 'echo hello world'");

    const tr = events.find((e) => e.type === "content_final" && e.kind === "tool_result");
    if (tr?.type !== "content_final" || tr.kind !== "tool_result") throw new Error("bad");
    expect(tr.id).toBe("item_0");
    expect(tr.result.success).toBe(true);
    expect(tr.result.output).toContain("hello world");

    expect(ctx.finalText).toBe("done");
  });

  it("emits sub_agent_finished{success:false} on error event", () => {
    const { events } = parseFile("codex-error.ndjson", parseCodexLine);
    const finished = events.find((e) => e.type === "sub_agent_finished");
    if (finished?.type !== "sub_agent_finished") throw new Error("expected sub_agent_finished");
    expect(finished.success).toBe(false);
  });

  it("ignores unknown / malformed lines", () => {
    const ctx = makeParserCtx("da_codex_unk", []);
    expect(parseCodexLine("garbage", ctx)).toEqual([]);
    expect(parseCodexLine(JSON.stringify({ type: "no_such_event" }), ctx)).toEqual([]);
  });
});

it("retains Codex structured failure messages for delegate diagnostics", () => {
  const ctx = makeParserCtx("failed-codex", []);
  const events = parseCodexLine(JSON.stringify({type:"turn.failed", error:{message:"TLS connection denied"}}), ctx);
  expect(ctx.error).toBe("TLS connection denied");
  expect(events.some(e => e.type === "sub_agent_finished" && !e.success)).toBe(true);
});

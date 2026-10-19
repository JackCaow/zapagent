import { describe, expect, it } from "bun:test";
import { LoopAgent } from "../../agent/loop.js";
import { createInitialLoopState } from "../../agent/state.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

function largeMessages(count: number, chars: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `m${i} ${"x".repeat(chars)}`,
  }));
}

function structuredSummary(marker = "summary"): string {
  return [
    "# Primary Request and Intent",
    `- ${marker}`,
    "# All user messages (verbatim)",
    "- continue",
    "# Current task status",
    "- auto-compacting",
    "# Files read / modified",
    "- zapsdk/agent/loop.ts",
    "# Commands run",
    "- bun test",
    "# Key facts discovered",
    "- structured summary required",
    "# Decisions made",
    "- reject prose-only summaries",
    "# Errors encountered and their resolution",
    "- none",
    "# Code changes summary",
    "- updated autocompact",
    "# Next steps",
    "- continue",
  ].join("\n");
}

describe("LoopAgent autocompact retry gating", () => {
  it("allows another autocompact after substantial post-compact growth", async () => {
    let summaryCalls = 0;
    const provider: LLMProvider = {
      async call() {
        summaryCalls++;
        return {
          type: "text",
          text: structuredSummary(`summary-${summaryCalls}`),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *stream() {
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry()),
      autoCompactThreshold: 100,
    }) as any;
    const state = createInitialLoopState();
    let messages: Message[] = [
      { role: "system", content: "system" },
      ...largeMessages(14, 30),
    ];
    const getMessages = () => messages;
    const replaceMessages = (next: Message[]) => { messages = next; };

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages)).toBe(true);
    expect(summaryCalls).toBe(1);
    const afterFirst = messages.length;

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages)).toBe(false);
    expect(summaryCalls).toBe(1);
    expect(messages.length).toBe(afterFirst);

    messages = [
      ...messages,
      ...largeMessages(10, 2_000),
    ];

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages)).toBe(true);
    expect(summaryCalls).toBe(2);
  });

  it("passes AbortSignal through autocompact summarizer calls", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const provider: LLMProvider = {
      async call(_messages, _tools, opts) {
        seenSignal = opts?.signal;
        return {
          type: "text",
          text: structuredSummary("signal summary"),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry()),
      autoCompactThreshold: 100,
    }) as any;
    const state = createInitialLoopState();
    let messages: Message[] = [
      { role: "system", content: "system" },
      ...largeMessages(14, 30),
    ];
    const getMessages = () => messages;
    const replaceMessages = (next: Message[]) => { messages = next; };

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages, { signal: controller.signal })).toBe(true);

    expect(seenSignal).toBe(controller.signal);
  });

  it("treats analysis-only autocompact output as a failed compaction", async () => {
    const provider: LLMProvider = {
      async call() {
        return {
          type: "text",
          text: "<analysis>\nprivate only\n</analysis>",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *stream() {
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry()),
      autoCompactThreshold: 100,
    }) as any;
    const state = createInitialLoopState();
    const originalMessages: Message[] = [
      { role: "system", content: "system" },
      ...largeMessages(14, 30),
    ];
    let messages = originalMessages;
    const getMessages = () => messages;
    const replaceMessages = (next: Message[]) => { messages = next; };

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages)).toBe(true);
    expect(state.consecutiveAutoCompactFailures).toBe(1);
    expect(messages).toBe(originalMessages);
  });

  it("treats unstructured autocompact output as a failed compaction", async () => {
    const provider: LLMProvider = {
      async call() {
        return {
          type: "text",
          text: "A short prose summary without the requested sections.",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *stream() {
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry()),
      autoCompactThreshold: 100,
    }) as any;
    const state = createInitialLoopState();
    const originalMessages: Message[] = [
      { role: "system", content: "system" },
      ...largeMessages(14, 30),
    ];
    let messages = originalMessages;
    const getMessages = () => messages;
    const replaceMessages = (next: Message[]) => { messages = next; };

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages)).toBe(true);
    expect(state.consecutiveAutoCompactFailures).toBe(1);
    expect(messages).toBe(originalMessages);
  });

  it("reports the compact summary quality failure reason in observations", async () => {
    const provider: LLMProvider = {
      async call() {
        return {
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
        };
      },
      async *stream() {
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry()),
      autoCompactThreshold: 100,
    }) as any;
    const errors: string[] = [];
    agent.on("observation", (event: any) => {
      if (event.kind !== "autocompact_done" || event.detail?.failed !== true) return;
      errors.push(String(event.detail.error));
    });
    const state = createInitialLoopState();
    const originalMessages: Message[] = [
      { role: "system", content: "system" },
      ...largeMessages(14, 30),
    ];
    let messages = originalMessages;
    const getMessages = () => messages;
    const replaceMessages = (next: Message[]) => { messages = next; };

    expect(await agent.tryAutoCompact(state, getMessages, replaceMessages)).toBe(true);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "summarizer returned an unusable compact summary (empty required sections: All user messages (verbatim))",
    );
    expect(errors[0]).toContain("repair attempt still invalid");
    expect(messages).toBe(originalMessages);
  });
});

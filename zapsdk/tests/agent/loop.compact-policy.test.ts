import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";
import { createInitialLoopState } from "../../agent/state.js";
import { compactBudget } from "../../context/compact-budget.js";
import { buildToolTurn } from "../../core/turn.js";

const compactSummary = () => ["Primary Request and Intent", "All user messages (verbatim)", "Current task status", "Files read / modified", "Commands run",
  "Key facts discovered", "Decisions made", "Errors encountered and their resolution", "Code changes summary", "Next steps"]
  .map(heading => `# ${heading}\n- Preserve P1. Do not publish. Historical read succeeded.`).join("\n");

function seededConversation() {
  const conversation = new ConversationManager({ maxMessages: Infinity, maxTokens: 90000 });
  // Fits the hard limit, but exceeds the 80% proactive threshold.
  for (let i = 0; i < 32; i++) conversation.add({ role: i % 2 ? "assistant" : "user", content: `history ${i}: ${"a ".repeat(1850)}` });
  return conversation;
}

describe("Loop proactive compaction policy", () => {
  for (const enabled of [true, false]) {
    it(`honors auto=${enabled} on a complete request before the first provider call`, async () => {
      let summaries = 0; const observations: any[] = [];
      const conversation = seededConversation();
      const provider: LLMProvider = {
        call: async () => { summaries++; return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: compactSummary() }; },
        async *stream(messages) {
          expect(messages.some(message => message.content === "P1: do not publish; continue the task")).toBe(true);
          yield { type: "text_delta", text: "done" };
          yield { type: "done", usage: { inputTokens: 10, outputTokens: 1 } };
        },
      };
      const registry = new ToolRegistry();
      const limits = compactBudget({ contextWindow: 100000 })!;
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
        contextWindow: 100000, reservedOutputTokens: 8192,
        autoCompactTokenThreshold: limits.compactAt, autoCompactThreshold: limits.compactAt * 4,
        autoCompactEnabled: enabled, maxSteps: 2 });
      agent.on("observation", event => observations.push(event));
      await agent.run("P1: do not publish; continue the task");
      expect(summaries).toBe(enabled ? 1 : 0);
      expect(observations.some(event => event.kind === "autocompact_start")).toBe(enabled);
    });
  }

  for (const auto of [true, false]) it(`never sends a bounded provider view missing the current task (auto=${auto})`, async () => {
    const prompt = "CURRENT_TASK_ANCHOR: preserve the original task through every tool step";
    let requests = 0;
    const conversation = new ConversationManager({ maxTokens: 18000, maxMessages: Infinity, autoCompress: true });
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "observe", description: "observe fixture", parameters: z.object({ step: z.number() }) },
      handler: async () => ({ success: true, output: "a ".repeat(1500) }) });
    const provider: LLMProvider = {
      call: async () => ({ type: "text", text: compactSummary(), usage: { inputTokens: 1, outputTokens: 1 } }),
      async *stream(messages) {
        expect(messages.some(message => message.role === "user" && message.content === prompt)).toBe(true);
        const step = requests++;
        if (step < 13) {
          yield { type: "tool_call_start", toolCallId: `observe-${step}`, toolName: "observe" };
          yield { type: "tool_call_delta", toolCallId: `observe-${step}`, partialJson: JSON.stringify({ step }) };
        } else yield { type: "text_delta", text: "done" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      contextWindow: 20000, reservedOutputTokens: 1000, autoCompactEnabled: auto, maxSteps: 15 });
    const result = await agent.run(prompt);
    expect(result.text).toContain("done");
    expect(requests).toBe(14);
    expect(conversation.getAllMessages().some(message => message.content === prompt)).toBe(true);
  });

  it("auto=false still permits explicit bounded overflow recovery", async () => {
    let calls = 0;
    const provider: LLMProvider = { call: async () => { calls++; return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: compactSummary() }; } };
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      autoCompactEnabled: false, autoCompactThreshold: 100 }) as any;
    let messages: Message[] = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `old ${i} ${"x".repeat(100)}` }));
    expect(await agent.tryAutoCompact(createInitialLoopState(), () => messages, (next: Message[]) => { messages = next; })).toBe(false);
    expect(calls).toBe(0);
    expect(await agent.tryAutoCompact(createInitialLoopState(), () => messages, (next: Message[]) => { messages = next; }, { force: true })).toBe(true);
    expect(calls).toBe(1);
  });

  it("propagates auto=false into the subagent factory", () => {
    let inherited: boolean | undefined;
    const registry = new ToolRegistry();
    new LoopAgent({ provider: { call: async () => ({ type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: "done" }) }, registry,
      executor: new ToolExecutor(registry), autoCompactEnabled: false, subagent: true,
      subagentFactory: args => {
        inherited = args.autoCompactEnabled;
        return { definition: { name: "agent", description: "fixture", parameters: z.object({}) }, handler: async () => ({ success: true, output: "done" }) };
      } });
    expect(inherited).toBe(false);
  });

  it("does not replay an executed tool when a later stream fails with a context error", async () => {
    let executions = 0, turns = 0, summaryCalls = 0;
    let didExecute!: () => void;
    const executed = new Promise<void>(resolve => { didExecute = resolve; });
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "record", description: "record side effect", parameters: z.object({ value: z.string() }) },
      handler: async () => { executions++; didExecute(); return { success: true, output: "recorded once" }; } });
    const provider: LLMProvider = {
      call: async () => { summaryCalls++; return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: compactSummary() }; },
      async *stream() {
        turns++;
        if (turns === 1) {
          yield { type: "tool_call_start", toolCallId: "record-1", toolName: "record" };
          yield { type: "tool_call_delta", toolCallId: "record-1", partialJson: '{"value":"only-once"}' };
          await executed;
          // Irreversible output/tool progress must disable stream replay.
          throw new Error("maximum context length exceeded");
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 1 } };
      },
    };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 2, autoCompactEnabled: false });
    await agent.run("Call record once").catch(() => {});
    expect(executions).toBe(1);
    expect(turns).toBe(1);
    expect(summaryCalls).toBe(0);
  });

  it("does not perform a semantic compact for ordinary network or auth errors", async () => {
    for (const message of ["network connection lost", "HTTP 401 invalid API key"]) {
      let summaries = 0;
      const registry = new ToolRegistry();
      const provider: LLMProvider = { call: async () => { summaries++; throw new Error(message); }, async *stream() { throw new Error(message); } };
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 1 });
      await agent.run("continue").catch(() => {});
      expect(summaries).toBe(0);
    }
  });

  it("rejects concurrent append during Loop compaction without overwriting new input", async () => {
    const registry = new ToolRegistry();
    const conversation = seededConversation();
    const provider: LLMProvider = { call: async () => {
      conversation.add({ role: "user", content: "NEW USER INPUT" });
      return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: compactSummary() };
    } };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      contextWindow: 100000, autoCompactTokenThreshold: 100 }) as any;
    const before = conversation.getAllMessages().length;
    await agent.tryAutoCompact(createInitialLoopState(), () => conversation.getAllMessages(), (next: Message[], revision: number) => {
      if (!conversation.compareAndReplace(next, revision)) throw new Error("revision conflict");
    }, { force: true });
    expect(conversation.getAllMessages()).toHaveLength(before + 1);
    expect(conversation.getAllMessages().at(-1)?.content).toBe("NEW USER INPUT");
  });

  it("keeps a complete tool group in the budgeted candidate", async () => {
    const conversation = seededConversation();
    conversation.commitTurn(buildToolTurn({ text: "", completed: [{ id: "read-a", name: "read_file", arguments: { path: "a.ts" },
      result: { success: true, output: "historical snapshot" } }] }));
    conversation.add({ role: "user", content: "Continue P1" });
    const result = await conversation.compress({ call: async () => ({ type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: compactSummary() }) },
      { contextWindow: 100000, force: true, restoreFiles: false });
    expect(result?.summary).not.toBeUndefined();
    const messages = conversation.getAllMessages();
    const at = messages.findIndex(message => message.toolCalls?.[0]?.id === "read-a");
    expect(at).toBeGreaterThan(0);
    expect(messages[at + 1]?.toolCallId).toBe("read-a");
  });

  for (const auto of [true, false]) it(`stops protected oversized input instead of lossy emergency recovery (auto=${auto})`, async () => {
    let mainRequests = 0, summaries = 0;
    const registry = new ToolRegistry();
    const conversation = new ConversationManager({ maxMessages: Infinity });
    const prompt = "HEAD " + "a ".repeat(20000) + " MUST_KEEP_MIDDLE_CONSTRAINT " + "b ".repeat(20000) + " TAIL";
    const provider: LLMProvider = { call: async () => { summaries++; return { type: "text", text: compactSummary(), usage: { inputTokens: 1, outputTokens: 1 } }; },
      async *stream() { mainRequests++; yield { type: "text_delta", text: "should not be requested" }; } };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      contextWindow: 20000, reservedOutputTokens: 1000, autoCompactEnabled: auto, maxSteps: 2 });
    await expect(agent.run(prompt)).rejects.toThrow("Protected input");
    expect(mainRequests).toBe(0);
    expect(summaries).toBe(0);
    expect(conversation.getAllMessages().find(message => message.content.includes("MUST_KEEP_MIDDLE_CONSTRAINT"))?.content).toBe(prompt);
  });

  for (const auto of [true, false]) it(`protects the current request after an upstream token rejection (auto=${auto})`, async () => {
    let streams = 0, retryCalls = 0;
    const registry = new ToolRegistry();
    const prompt = "HEAD " + "a ".repeat(10000) + " MUST_KEEP_MIDDLE_CONSTRAINT " + "b ".repeat(10000) + " TAIL";
    const provider: LLMProvider = {
      call: async () => { retryCalls++; return { type: "text", text: "not requested", usage: { inputTokens: 1, outputTokens: 1 } }; },
      async *stream(messages) {
        streams++;
        expect(messages.some(message => message.content === prompt)).toBe(true);
        throw new Error("maximum context length exceeded");
      },
    };
    const conversation = new ConversationManager({ maxMessages: Infinity });
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      contextWindow: 100000, reservedOutputTokens: 1000, autoCompactEnabled: auto, maxSteps: 2 });
    await expect(agent.run(prompt)).rejects.toThrow("Protected input");
    expect(streams).toBe(1);
    expect(retryCalls).toBe(0);
    expect(conversation.getAllMessages().some(message => message.content === prompt)).toBe(true);
  });
});

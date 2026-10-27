import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";
import { compactBudget } from "../../context/compact-budget.js";
import { REQUIRED_COMPACT_SUMMARY_HEADINGS } from "../../context/autocompact.js";
import { pruneHistory } from "../fixtures/prune-history.js";

const summary = REQUIRED_COMPACT_SUMMARY_HEADINGS.map(heading => `# ${heading}\n- CURRENT_TASK: preserve P1, no publish.`).join("\n");
function setup(auto: boolean, prune: boolean) {
  const conversation = new ConversationManager({ maxMessages: Infinity });
  const messages = pruneHistory(); messages.pop();
  for (const message of messages) conversation.add(message);
  const observations: any[] = []; let summaries = 0, requests = 0;
  const registry = new ToolRegistry();
  const provider: LLMProvider = {
    call: async () => { summaries++; return { type: "text", text: summary, usage: { inputTokens: 10, outputTokens: 10 } }; },
    async *stream(messages) { requests++; expect(messages.some(m => m.content === "CURRENT_TASK: must preserve P1 and do not publish")).toBe(true);
      yield { type: "text_delta", text: "done" }; yield { type: "done", usage: { inputTokens: 10, outputTokens: 10 } }; },
  };
  const options = { provider, registry, executor: new ToolExecutor(registry), conversation, contextWindow: 20000, reservedOutputTokens: 1000,
    autoCompactTokenThreshold: compactBudget({ contextWindow: 20000, reservedOutputTokens: 1000 })!.compactAt,
    autoCompactEnabled: auto, pruneEnabled: prune, maxSteps: 2 };
  const agent = new LoopAgent(options); agent.on("observation", event => observations.push(event));
  return { agent, options, observations, conversation, counts: () => ({ summaries, requests }) };
}
const input = "CURRENT_TASK: must preserve P1 and do not publish";
describe("Loop prune before semantic summaries", () => {
  for (const auto of [false, true]) for (const prune of [false, true]) {
    it(`honors independent auto=${auto}, prune=${prune}`, async () => {
      const run = setup(auto, prune);
      await run.agent.run(input);
      expect(run.counts()).toEqual({ requests: 1, summaries: auto && !prune ? 1 : 0 });
      expect(run.observations.filter(e => e.kind === "prune_done")).toHaveLength(prune ? 1 : 0);
      expect(run.conversation.getAllMessages().some(m => m.content === input)).toBe(true);
    });
  }
  it("summarizes only when pruning was insufficient", async () => {
    const run = setup(true, true);
    run.conversation.add({ role: "user", content: "non-prunable history " + "x ".repeat(10000) });
    await run.agent.run(input);
    expect(run.observations.findIndex(e => e.kind === "prune_done")).toBeLessThan(run.observations.findIndex(e => e.kind === "autocompact_start"));
    expect(run.counts().summaries).toBe(1);
  });
  it("cancels before candidate commit without running providers", async () => {
    const run = setup(false, true), controller = new AbortController();
    const before = run.conversation.getAllMessages();
    run.agent.on("observation", event => { if (event.type === "observation" && event.kind === "prune_start") controller.abort(); });
    await expect(run.agent.run(input, { signal: controller.signal })).rejects.toThrow();
    expect(run.counts()).toEqual({ requests: 0, summaries: 0 });
    expect(run.conversation.getAllMessages().slice(0, before.length)).toEqual(before);
  });
  for (const mutation of ["append", "clear"]) it(`does not overwrite a concurrent ${mutation}`, async () => {
    const run = setup(false, true);
    run.agent.on("observation", event => {
      if (event.type === "observation" && event.kind === "prune_start") {
        if (mutation === "clear") run.conversation.clear();
        run.conversation.add({ role: "user", content: "NEWER_INPUT" });
      }
    });
    await run.agent.run(input).catch(() => {});
    expect(run.observations.some(e => e.kind === "prune_done")).toBe(false);
    expect(run.conversation.getAllMessages().some(m => m.content === "NEWER_INPUT")).toBe(true);
  });
  it("keeps markers and hysteresis when the Host reconstructs a Loop for the next turn", async () => {
    const run = setup(false, true); await run.agent.run(input);
    const before = run.conversation.getAllMessages();
    const next = new LoopAgent(run.options); const events: any[] = []; next.on("observation", e => events.push(e));
    await next.run(input);
    expect(events.some(e => e.kind === "prune_done")).toBe(false);
    expect(run.conversation.getAllMessages().slice(0, before.length)).toEqual(before);
  });
  it("propagates both toggles and connection identity into child factories", () => {
    let inherited: any;
    const registry = new ToolRegistry();
    new LoopAgent({ provider: { call: async () => { throw new Error("not called"); } }, registry, executor: new ToolExecutor(registry),
      autoCompactEnabled: false, pruneEnabled: true, requestCacheScope: "connection-a", subagent: true,
      subagentFactory: args => { inherited = args; return { definition: { name: "agent", description: "fixture", parameters: z.object({}) }, handler: async () => ({ success: true, output: "ok" }) }; } });
    expect(inherited.autoCompactEnabled).toBe(false); expect(inherited.pruneEnabled).toBe(true); expect(inherited.requestCacheScope).toBe("connection-a");
  });
});

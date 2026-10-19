import { expect, it } from "bun:test";
import { z } from "zod";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { createAgentRuntime } from "../../runtime/factory.js";
import { ConversationManager } from "../../memory/conversation.js";
import { AgentBudget } from "../../agent/budget.js";
import { RequestMeter, BudgetLimitError } from "../../agent/request-meter.js";
import { REQUIRED_COMPACT_SUMMARY_HEADINGS } from "../../context/autocompact.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse, TokenUsage } from "../../core/types.js";
const summary = REQUIRED_COMPACT_SUMMARY_HEADINGS.map(h => `# ${h}\nKeep the observed facts and unfinished fixture work.`).join("\n\n");
const usage = { inputTokens: 2, outputTokens: 1 };
const text = (value = "done"): LLMResponse => ({ type: "text", text: value, usage, finishReason: "stop" });

for (const transport of ["call", "stream", "xml"] as const) {
  for (const scenario of ["tools", "fresh", "turns"] as const) {
    it(`enforces ${scenario} admission across ${transport} dispatch`, async () => {
      const root = await mkdtemp("/tmp/zap-budget-boundary-");
      let calls = 0, handlers = 0;
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "probe", description: "fixture", parameters: z.object({}), readOnly: true },
        handler: async () => { handlers++; return { success: true, output: "observed" }; } });
      const response = (): LLMResponse => {
        calls++;
        if (scenario === "turns") return { ...text("partial"), finishReason: "length" };
        if (scenario === "fresh") return text();
        return transport === "xml" ? text('<tool_call>probe</tool_call>') : {
          type: "tool_call", text: "", toolCalls: [1,2,3].map(n => ({ id: `t${n}`, name: "probe", arguments: {} })), usage,
        };
      };
      const provider: LLMProvider = { async call() { return response(); } };
      if (transport === "stream") provider.stream = async function* () {
        const result = response();
        for (const call of result.toolCalls ?? []) {
          yield { type: "tool_call_start", toolCallId: call.id, toolName: call.name };
          yield { type: "tool_call_delta", toolCallId: call.id, partialJson: "{}" };
          yield { type: "tool_call_end", toolCallId: call.id };
        }
        if (result.text) yield { type: "text_delta", text: result.text };
        yield { type: "done", usage, finishReason: result.finishReason };
      };
      const budgets = scenario === "tools" ? { modelTurns: 10, toolCalls: 0 }
        : scenario === "fresh" ? { modelTurns: 10, freshInputTokens: 1 } : { modelTurns: 1 };
      const runtime = createAgentRuntime({ threadId: `${transport}-${scenario}`, workspace: { root }, subagent: false,
        loopAgent: { provider, registry, executor: new ToolExecutor(registry) }, harnessPolicy: { budgets } });
      try {
        const result = await runtime.runWithOutcome("Run fixture");
        expect(handlers).toBe(0); expect(calls).toBe(scenario === "fresh" ? 0 : 1);
        expect(result.outcome.execution.status).toBe("limited");
        expect(result.outcome.execution.stopReason).toBe("budget");
      } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}

for (const cap of [1, 10]) {
  it(`accounts maintenance before main admission and never restores a denied file (cap=${cap})`, async () => {
    const root = await mkdtemp("/tmp/zap-compact-boundary-");
    const path = root + "/denied.txt", marker = "SYNTHETIC_NEVER_READ";
    await writeFile(path, marker);
    const registry = new ToolRegistry(); let handlers = 0, calls = 0, exposed = false;
    registry.register({ definition: { name: "read_file", description: "fixture", parameters: z.object({ path: z.string() }), permission: "deny", readOnly: true },
      handler: async () => { handlers++; return { success: true, output: marker }; } });
    const executor = new ToolExecutor(registry), denied = await executor.execute("read_file", { path });
    const conversation = new ConversationManager({ maxMessages: 1000, maxTokens: 1000000 });
    conversation.commitTurn({ kind: "tool_turn", text: "read", calls: [{ id: "denied", name: "read_file", arguments: { path }, result: denied }] });
    for (let i = 0; i < 12; i++) conversation.add({ role: i % 2 ? "assistant" : "user", content: "x".repeat(250) });
    const provider: LLMProvider = { async call(messages) {
      calls++; exposed ||= JSON.stringify(messages).includes(marker);
      const compact = messages[0]!.content.includes("You are compacting");
      return { ...text(compact ? summary : "done"), usage: compact ? { inputTokens: 100, outputTokens: 10 } : usage };
    } };
    const budget = new AgentBudget({ maxSteps: cap });
    const runtime = createAgentRuntime({ threadId: "compact", workspace: { root }, subagent: false,
      loopAgent: { provider, registry, executor, conversation, budget, autoCompactThreshold: 1000 } });
    try {
      const result = await runtime.runWithOutcome("Finish fixture");
      expect(handlers).toBe(0); expect(exposed).toBe(false); expect(calls).toBe(cap === 1 ? 1 : 2);
      expect(budget.tokensUsed).toBe(cap === 1 ? 110 : 113);
      expect(result.loopResult.totalUsage).toMatchObject({ inputTokens: cap === 1 ? 100 : 102, outputTokens: cap === 1 ? 10 : 11 });
      expect(result.outcome.execution.status).toBe(cap === 1 ? "limited" : "finished");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
}

it("reserves fresh estimates across concurrent children and does not reset inherited tool caps", async () => {
  const budget = new AgentBudget({ maxSteps: 20 }); budget.constrain({ freshInputTokens: 8, toolCalls: 1 });
  const parent = new RequestMeter(budget, {}, () => {}), child = new RequestMeter(budget, {}, () => {});
  let finish!: () => void;
  const provider: LLMProvider = { async call() { await new Promise<void>(r => { finish = r; }); return text(); } };
  const first = parent.wrap(provider).call([{ role: "user", content: "a" }]);
  await expect(child.wrap(provider).call([{ role: "user", content: "a" }])).rejects.toBeInstanceOf(BudgetLimitError);
  finish(); await first;
  const toolChild = new RequestMeter(budget, {}, () => {});
  expect(parent.admitTool()).toBe(true); expect(toolChild.admitTool()).toBe(false);
});

it("counts failed/absent usage as incomplete and closes capped token admission", async () => {
  const budget = new AgentBudget({ maxTokens: 100 }); const observed: TokenUsage[] = [];
  const meter = new RequestMeter(budget, {}, u => observed.push(u));
  const provider = meter.wrap({ async call() { throw new Error("failed"); } }, "maintenance");
  await expect(provider.call([])).rejects.toThrow("failed");
  expect(observed[0]?.usageIncomplete).toBe(true);
  await expect(provider.call([])).rejects.toBeInstanceOf(BudgetLimitError);
  expect(budget.stepsUsed).toBe(1);
});

it("summary repair consumes its own request and reports every returned usage once", async () => {
  const { AutoCompact } = await import("../../context/autocompact.js");
  const budget = new AgentBudget({ maxSteps: 2 });
  const reports: TokenUsage[] = [];
  const meter = new RequestMeter(budget, {}, u => reports.push(u));
  let calls = 0;
  const provider = meter.wrap({ async call() { calls++; return text(calls === 1 ? "invalid summary" : summary); } }, "maintenance");
  const messages = Array.from({ length: 15 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "assistant" | "user", content: "x".repeat(100) }));
  const result = await new AutoCompact({ charThreshold: 200, keepRecent: 2 }).compact(messages, provider);
  expect(result.summary).toBe(summary); expect(calls).toBe(2); expect(reports).toHaveLength(2);
  expect(budget.snapshot()).toMatchObject({ stepsUsed: 2, tokensUsed: 6 });
  await expect(provider.call([])).rejects.toBeInstanceOf(BudgetLimitError);
});

it("metered fallback preserves image identity and cannot bypass exhausted request caps", async () => {
  const shared = new AgentBudget({ maxSteps: 10 });
  const meter = new RequestMeter(shared, { modelCalls: 1 }, () => {});
  let fallbackCalls = 0;
  const primary = meter.wrap({ async call() { throw new Error("provider unavailable"); } });
  const fallback = meter.wrap({ async call() { fallbackCalls++; return text(); }, getImageTokenContext: () => ({ model: "alias", canonicalModelId: "openai/gpt-4o" }) });
  await expect(primary.call([])).rejects.toThrow("unavailable");
  expect(fallback.getImageTokenContext!().canonicalModelId).toBe("openai/gpt-4o");
  await expect(fallback.call([])).rejects.toBeInstanceOf(BudgetLimitError);
  expect(fallbackCalls).toBe(0);
});


it("handles a provider that synchronously aborts and throws without an orphan rejection", async () => {
  const controller = new AbortController();
  const meter = new RequestMeter(new AgentBudget(), {}, () => {});
  const provider = meter.wrap({ call() { controller.abort(new Error("admission closed")); throw new Error("admission closed"); } });
  await expect(provider.call([], undefined, { signal: controller.signal })).rejects.toThrow("admission closed");
  await new Promise(resolve => setTimeout(resolve, 0));
});

for (const stream of [false, true]) {
  it(`admits only one handler from a three-tool batch (stream=${stream})`, async () => {
    const registry = new ToolRegistry(); let handlers = 0;
    registry.register({ definition: { name: "probe", description: "fixture", parameters: z.object({}), readOnly: true },
      handler: async () => { handlers++; return { success: true, output: "observed" }; } });
    const calls = [1,2,3].map(n => ({ id: `batch${n}`, name: "probe", arguments: {} }));
    const provider: LLMProvider = { async call() { return { type: "tool_call", text: "", toolCalls: calls, usage }; } };
    if (stream) provider.stream = async function* () {
      for (const call of calls) {
        yield { type: "tool_call_start", toolCallId: call.id, toolName: call.name };
        yield { type: "tool_call_delta", toolCallId: call.id, partialJson: "{}" };
        yield { type: "tool_call_end", toolCallId: call.id };
      }
      yield { type: "done", usage };
    };
    const runtime = createAgentRuntime({ threadId: "batch-cap", workspace: { root: process.cwd() }, subagent: false,
      loopAgent: { provider, registry, executor: new ToolExecutor(registry) }, harnessPolicy: { budgets: { toolCalls: 1, modelTurns: 5 } } });
    try {
      const result = await runtime.runWithOutcome("Run the batch");
      expect(handlers).toBe(1); expect(result.loopResult.toolResults).toHaveLength(3);
      expect(result.outcome.execution).toMatchObject({ status: "limited", stopReason: "budget" });
    } finally { await runtime.close(); }
  });
}

it("includes already metered host maintenance in the local token cap without charging twice", async () => {
  const registry = new ToolRegistry(); const budget = new AgentBudget(); budget.chargeTokens(2, 1);
  let calls = 0;
  const runtime = createAgentRuntime({ threadId: "initial-usage", workspace: { root: process.cwd() }, subagent: false,
    loopAgent: { provider: { async call() { calls++; return text(); } }, registry, executor: new ToolExecutor(registry),
      budget, initialUsage: usage, maxTokens: 3 } });
  try {
    const result = await runtime.runWithOutcome("Run fixture");
    expect(calls).toBe(0); expect(budget.tokensUsed).toBe(3);
    expect(result.loopResult.totalUsage).toMatchObject(usage);
    expect(result.outcome.execution).toMatchObject({ status: "limited", stopReason: "budget" });
  } finally { await runtime.close(); }
});

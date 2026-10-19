import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse } from "../../core/types.js";
import { LoopAgent } from "../../agent/loop.js";
import { AgentEventEmitter } from "../../agent/events.js";
import { executeNonStreamingTurn } from "../../agent/nonstreaming-tool-executor.js";
import { RepairBudget } from "../../runtime/repair-budget.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("LoopAgent non-streaming scheduler", () => {
  it("settles started calls before propagating the original repair admission error", async () => {
    const budget = new RepairBudget({ modelCalls: 1, toolCalls: 1, timeoutMs: 1000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let admissionRejected!: () => void;
    const rejection = new Promise<void>((resolve) => { admissionRejected = resolve; });
    let started = false;
    let completed = false;
    let settled = false;
    let blockedRan = false;
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "read", description: "read", readOnly: true, parameters: z.object({ key: z.string() }) },
      handler: async (args) => {
        if (args.key === "blocked") blockedRan = true;
        started = true;
        await gate;
        completed = true;
        return { success: true, output: String(args.key) };
      },
    });
    const executor = new ToolExecutor(registry, {
      admitExecution: () => {
        try { budget.admit("toolCalls"); }
        catch (error) { admissionRejected(); throw error; }
      },
    });
    const completedCalls: string[] = [];
    const emitter = new AgentEventEmitter();
    emitter.on("content_final", (event) => {
      if (event.type === "content_final" && event.kind === "tool_result") completedCalls.push(event.id);
    });
    const pending = executeNonStreamingTurn({ type: "tool_call", text: "", usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ id: "first", name: "read", arguments: { key: "first" } },
        { id: "blocked", name: "read", arguments: { key: "blocked" } }],
    }, { executor, emitter, sessionId: "admission-test" }, 0);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await rejection;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(started).toBe(true);
      expect(settled).toBe(false);
      expect(completed).toBe(false);
      release();
      await expect(pending).rejects.toBe(budget.signal.reason);
      expect(budget.signal.reason).toMatchObject({ code: "REPAIR_TOOL_LIMIT" });
      expect(completed).toBe(true);
      expect(blockedRan).toBe(false);
      expect(completedCalls).toEqual(["first"]);
    } finally { release(); budget.close(); }
  });

  for (const undefinedError of [false, true]) it(`preserves the first observed rejection across a later lifecycle failure (${undefinedError ? "undefined" : "repair budget"})`, async () => {
    const budget = new RepairBudget({ modelCalls: 1, toolCalls: 1, timeoutMs: 1000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let admissionRejected!: () => void;
    const rejection = new Promise<void>((resolve) => { admissionRejected = resolve; });
    let lifecycleFailed = false;
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "read", description: "read", readOnly: true, parameters: z.object({}) },
      handler: async () => { await gate; return { success: true, output: "observed" }; },
    });
    const executor = new ToolExecutor(registry, {
      admitExecution: () => {
        try { budget.admit("toolCalls"); }
        catch (error) { admissionRejected(); throw undefinedError ? undefined : error; }
      },
      onExecutionLifecycle: async (event) => {
        if (event.status === "completed") {
          lifecycleFailed = true;
          throw new Error("later lifecycle failure");
        }
      },
    });
    const pending = executeNonStreamingTurn({ type: "tool_call", text: "", usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ id: "late-failure", name: "read", arguments: {} },
        { id: "early-admission-failure", name: "read", arguments: {} }],
    }, { executor, emitter: new AgentEventEmitter(), sessionId: "admission-order-test" }, 0);
    const outcome = pending.then(() => ({ rejected: false, error: undefined as unknown }),
      (error: unknown) => ({ rejected: true, error }));
    try {
      await rejection;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(lifecycleFailed).toBe(false);
      release();
      const result = await outcome;
      expect(result.rejected).toBe(true);
      expect(result.error).toBe(undefinedError ? undefined : budget.signal.reason);
      expect(lifecycleFailed).toBe(true);
      expect(budget.signal.reason).toMatchObject({ code: "REPAIR_TOOL_LIMIT" });
    } finally { release(); budget.close(); }
  });

  it("runs compatible calls concurrently and preserves result order", async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            type: "tool_call",
            text: "",
            toolCalls: [
              { id: "first", name: "read", arguments: { key: "first" } },
              { id: "second", name: "read", arguments: { key: "second" } },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fallback = setTimeout(release, 100);
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "read",
        description: "read",
        parameters: z.object({ key: z.string() }),
        readOnly: true,
      },
      handler: async (args) => {
        active += 1;
        started += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 2) release();
        await gate;
        active -= 1;
        return { success: true, output: String(args.key) };
      },
    });

    const executor = new ToolExecutor(registry);
    const agent = new LoopAgent({ provider, registry, executor, maxSteps: 3 });
    const result = await agent.run("read both");
    clearTimeout(fallback);

    expect(maxActive).toBe(2);
    expect(result.toolResults.map((item) => item.output)).toEqual(["first", "second"]);
  });

  it("does not let a waiting approval occupy the write lock", async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            type: "tool_call",
            text: "",
            toolCalls: [
              { id: "write", name: "write", arguments: { path: "a" } },
              { id: "read", name: "read", arguments: {} },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return { type: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => { releaseApproval = resolve; });
    let readRanWhileApprovalPending = false;
    let approvalPending = false;
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "write",
        description: "write",
        parameters: z.object({ path: z.string() }),
        permission: "confirm",
        writesPath: (args) => [String(args.path)],
      },
      handler: async () => ({ success: true, output: "wrote" }),
    });
    registry.register({
      definition: {
        name: "read",
        description: "read",
        parameters: z.object({}),
        readOnly: true,
      },
      handler: async () => {
        for (let i = 0; i < 5 && !approvalPending; i++) await Promise.resolve();
        readRanWhileApprovalPending = approvalPending;
        releaseApproval();
        return { success: true, output: "read" };
      },
    });
    const executor = new ToolExecutor(registry, {
      onApproval: async () => {
        approvalPending = true;
        await approval;
        approvalPending = false;
        return true;
      },
    });
    const agent = new LoopAgent({ provider, registry, executor, maxSteps: 3 });
    await agent.run("write and read");
    expect(readRanWhileApprovalPending).toBe(true);
  });
});

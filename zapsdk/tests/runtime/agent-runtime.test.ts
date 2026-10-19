import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { describe, expect, it } from "bun:test";
import {
  AgentEventEmitter,
  type AgentEvent,
  type AgentEventHandler,
  type AgentEventType,
} from "../../agent/events.js";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { StreamIdleTimeoutError } from "../../core/stream-idle.js";
import type { LoopAgentResult, RunOptions } from "../../agent/loop.js";
import {
  AgentRuntime,
  type RuntimeAgentExecutor,
} from "../../runtime/agent-runtime.js";
import {
  InMemoryRuntimeEventStore,
  type RuntimeEventStore,
} from "../../runtime/event-store.js";
import type { RuntimeEvent } from "../../runtime/types.js";
import type { ToolDefinition } from "../../tools/types.js";

class FakeAgent implements RuntimeAgentExecutor {
  private emitter = new AgentEventEmitter();

  constructor(private readonly runImpl: (input: string, options?: RunOptions) => Promise<LoopAgentResult>) {}

  on(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.emitter.on(type, handler);
  }

  off(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.emitter.off(type, handler);
  }

  emit(event: AgentEvent): void {
    this.emitter.emit(event);
  }

  run(input: string, options?: RunOptions): Promise<LoopAgentResult> {
    return this.runImpl(input, options);
  }

  toolDefinitions(): ToolDefinition[] {
    return [];
  }

  effectiveSystemPrompt(): string | undefined {
    return "system";
  }
}

function ids(prefix = "id"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function clock(start = 1_000): () => number {
  let now = start;
  return () => now++;
}

const result: LoopAgentResult = {
  text: "done",
  steps: 1,
  toolResults: [],
  totalUsage: { inputTokens: 4, outputTokens: 2 },
};

describe("AgentRuntime", () => {
  it("wraps one LoopAgent run in ordered Thread/Turn/Item/Run events", async () => {
    let agent!: FakeAgent;
    agent = new FakeAgent(async (input) => {
      agent.emit({ type: "run_started", input });
      agent.emit({ type: "content_final", kind: "text", id: "text-1", text: "done" });
      agent.emit({ type: "run_ended", steps: 1, usage: result.totalUsage });
      return result;
    });
    const store = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({
      threadId: "thread-1",
      agent,
      eventStore: store,
      idFactory: ids(),
      clock: clock(),
    });
    const legacy: AgentEvent[] = [];
    const projected: string[] = [];
    runtime.on("*", (event) => { legacy.push(event); });
    runtime.subscribe({}, (event) => { projected.push(event.payload.type); });

    await expect(runtime.run("hello")).resolves.toMatchObject({ ...result, completion: { status: "completed", success: true } });

    expect(legacy.map((event) => event.type)).toEqual([
      "run_started",
      "content_final",
      "run_ended",
    ]);
    expect(projected).toEqual([
      "turn_started",
      "agent_event",
      "agent_event",
      "agent_event",
      "turn_completed",
    ]);
    const stored = await store.list("thread-1");
    expect(stored.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(stored.every((event) => event.schemaVersion === 3)).toBe(true);
    expect(stored.every((event) =>
      event.schemaVersion === 3 && event.correlationId === event.turnId
    )).toBe(true);
    expect(stored[0]?.schemaVersion === 3 && stored[0].causationId).toBeUndefined();
    expect(stored.slice(1).every((event, index) =>
      event.schemaVersion === 3 && event.causationId === stored[index]?.eventId
    )).toBe(true);
    expect(new Set(stored.map((event) => event.turnId)).size).toBe(1);
    expect(new Set(stored.map((event) => event.runId)).size).toBe(1);
    expect(stored[2]?.toolRunId).toBeUndefined();
    expect(stored.at(-1)?.payload.type).toBe("turn_completed");
    expect(runtime.threadSnapshot().status).toBe("idle");
  });

  it("records cancellation as a terminal runtime fact and rethrows the agent error", async () => {
    const agent = new FakeAgent(async () => { throw new Error("aborted"); });
    const store = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({
      threadId: "thread-cancel",
      agent,
      eventStore: store,
      idFactory: ids(),
      clock: clock(),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(runtime.run("stop", { signal: controller.signal })).rejects.toThrow("aborted");

    const stored = await store.list("thread-cancel");
    expect(stored.map((event) => event.payload.type)).toEqual([
      "turn_started",
      "turn_failed",
    ]);
    const failed = stored.at(-1)?.payload;
    expect(failed?.type).toBe("turn_failed");
    if (failed?.type === "turn_failed") {
      expect(failed.interrupted).toBe(true);
      expect(failed.turn.status).toBe("cancelled");
      expect(failed.run.status).toBe("cancelled");
    }
  });

  it("persists a forced final summary as incomplete rather than successful", async () => {
    const store = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({
      threadId: "thread-incomplete",
      agent: new FakeAgent(async () => ({ ...result, stopped: "max_steps" })),
      eventStore: store,
      idFactory: ids(),
      clock: clock(),
    });

    await runtime.run("finish the build");

    const terminal = (await store.list("thread-incomplete")).at(-1)?.payload;
    expect(terminal?.type).toBe("turn_incomplete");
    if (terminal?.type === "turn_incomplete") {
      expect(terminal.turn.status).toBe("incomplete");
      expect(terminal.run.status).toBe("incomplete");
      expect(terminal.run.success).toBe(false);
      expect(terminal.result.completion.reason).toContain("max_steps");
    }
  });

  it("projects model completion and host evidence as independent terminal facts", async () => {
    const store = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({
      threadId: "thread-evidence",
      agent: new FakeAgent(async () => result),
      eventStore: store,
      idFactory: ids(),
      clock: clock(),
      completionContract: {
        requirements: [{ kind: "command", commandRef: "test", exitCode: 0 }],
      },
      completionEvidence: async () => ({
        commands: [{ commandRef: "test", exitCode: 1, detail: "test failed" }],
      }),
    });

    await runtime.run("verify the change");

    const terminal = (await store.list("thread-evidence")).at(-1)?.payload;
    expect(terminal?.type).toBe("turn_incomplete");
    if (terminal?.type === "turn_incomplete") {
      expect(terminal.result.completion.modelClaimedSuccess).toBe(true);
      expect(terminal.result.completion.evidenceState).toBe("missing");
      expect(terminal.result.completion.requirements.some((requirement) => (
        requirement.kind === "command" && !requirement.satisfied
      ))).toBe(true);
      expect(terminal.result.completion.evidence.some((evidence) => (
        evidence.kind === "command"
        && !evidence.satisfied
        && evidence.detail === "test failed"
      ))).toBe(true);
    }
  });

  it("preserves a terminal event when the optional evidence bridge fails", async () => {
    const store = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({
      threadId: "thread-evidence-bridge-failure",
      agent: new FakeAgent(async () => result),
      eventStore: store,
      idFactory: ids(),
      clock: clock(),
      completionEvidence: async () => {
        throw new Error("state store unavailable");
      },
    });

    await expect(runtime.run("answer normally")).resolves.toMatchObject({ ...result, completion: { status: "completed", success: true } });

    const terminal = (await store.list("thread-evidence-bridge-failure")).at(-1)?.payload;
    expect(terminal?.type).toBe("turn_completed");
    if (terminal?.type === "turn_completed") {
      expect(terminal.result.completion.success).toBe(true);
      expect(terminal.result.completion.infrastructureOutcome).toBe("failed");
      expect(terminal.result.completion.evidence.some((evidence) => (
        evidence.kind === "infrastructure"
        && !evidence.satisfied
        && evidence.detail.includes("state store unavailable")
      ))).toBe(true);
    }
  });

  it("cancels an active turn through the Runtime control plane", async () => {
    const agent = new FakeAgent(async (_input, options) => {
      if (options?.signal?.aborted) throw options.signal.reason;
      return new Promise<LoopAgentResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    });
    const store = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({
      threadId: "thread-runtime-cancel",
      agent,
      eventStore: store,
      idFactory: ids(),
      clock: clock(),
    });

    const running = runtime.run("stop directly");
    while (runtime.threadSnapshot().status !== "running") await Promise.resolve();
    expect(runtime.cancelTurn("host requested stop")).toBe(true);
    await expect(running).rejects.toThrow("host requested stop");
    expect(runtime.cancelTurn()).toBe(false);
    const failed = (await store.list("thread-runtime-cancel")).at(-1)?.payload;
    expect(failed?.type).toBe("turn_failed");
    if (failed?.type === "turn_failed") expect(failed.interrupted).toBe(true);
  });

  it("continues sequence and thread creation time across runtime instances", async () => {
    const store = new InMemoryRuntimeEventStore();
    const sharedIds = ids();
    const first = new AgentRuntime({
      threadId: "thread-resume",
      agent: new FakeAgent(async () => result),
      eventStore: store,
      idFactory: sharedIds,
      clock: clock(100),
    });
    await first.run("one");
    const firstEvents = await store.list("thread-resume");
    const firstStarted = firstEvents[0]?.payload;
    expect(firstStarted?.type).toBe("turn_started");
    const createdAt = firstStarted?.type === "turn_started"
      ? firstStarted.thread.createdAt
      : undefined;

    const second = new AgentRuntime({
      threadId: "thread-resume",
      agent: new FakeAgent(async () => result),
      eventStore: store,
      idFactory: sharedIds,
      clock: clock(10_000),
    });
    await second.run("two");

    const allEvents = await store.list("thread-resume");
    expect(allEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    const secondStarted = allEvents[2]?.payload;
    expect(secondStarted?.type).toBe("turn_started");
    if (secondStarted?.type === "turn_started") {
      expect(secondStarted.thread.createdAt).toBe(createdAt);
    }
  });

  it("reports EventStore failure without changing a successful turn result by default", async () => {
    const errors: string[] = [];
    const failingStore: RuntimeEventStore = {
      append: async (_event: RuntimeEvent) => { throw new Error("disk full"); },
      list: async () => [],
      page: async () => ({ items: [], hasMoreBefore: false, hasMoreAfter: false }),
      listThreads: async () => [],
      latestSequence: async () => 0,
      close: async () => {},
    };
    const runtime = new AgentRuntime({
      threadId: "thread-store-failure",
      agent: new FakeAgent(async () => result),
      eventStore: failingStore,
      onEventStoreError: (error) => { errors.push(error.message); },
    });

    await expect(runtime.run("continue")).resolves.toMatchObject({ ...result, completion: { status: "completed", success: true } });
    expect(errors).toEqual(["disk full"]);
  });
});


describe("AgentRuntime declared completion continuation", () => {
  function setup(contract?: import("../../harness/completion.js").CompletionContract) {
    let calls = 0;
    const provider: LLMProvider = {
      async call() { throw new Error("unexpected forced finish"); },
      async *stream(): AsyncIterable<LLMChunk> {
        calls++;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 5 });
    const runtime = new AgentRuntime({ threadId: "contract-test", agent, completionContract: contract });
    return { runtime, calls: () => calls };
  }

  it("does not continue for a known missing artifact", async () => {
    const { runtime, calls } = setup({ requirements: [{ kind: "artifact", path: "/workspace/report" }] });
    const completed = await runtime.run("write the report");
    expect(calls()).toBe(1);
    expect(completed.stopped).toBeUndefined();
    expect(completed.completion).toMatchObject({ status: "incomplete", success: false, modelClaimedSuccess: true });
  });

  it("does not invent deliverable requirements for a conversation", async () => {
    const { runtime, calls } = setup();
    expect((await runtime.run("hello")).completion?.success).toBe(true);
    expect(calls()).toBe(1);
  });

  it("does not ask the model to resolve an approval requirement", async () => {
    const { runtime, calls } = setup({ requirements: [{ kind: "approval", capability: "network" }] });
    expect((await runtime.run("inspect network")).completion?.status).toBe("incomplete");
    expect(calls()).toBe(1);
  });
});

it("preserves completed LoopAgent usage when a later stream stalls", async () => {
  let calls = 0;
  let executions = 0;
  const provider: LLMProvider = {
    async call() { throw new Error("unexpected fallback"); },
    async *stream(): AsyncIterable<LLMChunk> {
      calls++;
      if (calls === 3) throw new StreamIdleTimeoutError(180_000);
      yield { type: "tool_call_start", toolCallId: `check-${calls}`, toolName: "check" };
      yield { type: "tool_call_delta", toolCallId: `check-${calls}`, partialJson: "{}" };
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 4,
        cacheReadInputTokens: 30, providerUsageReported: true } };
    },
  };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "check", description: "observe state", parameters: z.object({}) },
    handler: async () => ({ success: true, output: `observation ${++executions}` }) });
  const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 5 });
  const runtime = new AgentRuntime({ threadId: "stream-failure-metrics", agent });
  const { loopResult, outcome } = await runtime.runWithOutcome("check state");
  expect(calls).toBe(3);
  expect(executions).toBe(2);
  expect(outcome.execution).toMatchObject({ status: "failed", stopReason: "error",
    error: { message: "stream idle timeout after 180000ms — no chunk received" } });
  expect(loopResult.steps).toBe(2);
  expect(loopResult.toolResults).toHaveLength(2);
  expect(loopResult.totalUsage).toEqual({ inputTokens: 20, outputTokens: 8,
    cacheReadInputTokens: 60, providerUsageReported: true, usageIncomplete: true });
});


describe("AgentRuntime artifact correction", () => {
  it("verifies a real artifact produced during natural execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-contract-"));
    const path = join(directory, "report.txt");
    try {
      let calls = 0;
      const provider: LLMProvider = {
        async call() { throw new Error("unexpected forced finish"); },
        async *stream(): AsyncIterable<LLMChunk> {
          calls++;
          if (calls === 1) {
            yield { type: "tool_call_start", toolCallId: "write", toolName: "write_report" };
            yield { type: "tool_call_delta", toolCallId: "write", partialJson: "{}" };
          } else yield { type: "text_delta", text: "done" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "write_report", description: "write", parameters: z.object({}), writesPath: () => [path] },
        handler: async () => { await writeFile(path, "verified artifact"); return { success: true, output: "written" }; } });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, { cwd: directory }), maxSteps: 5 });
      const runtime = new AgentRuntime({ threadId: "artifact", agent,
        completionContract: { requirements: [{ kind: "artifact", path, requireHash: true }] } });
      const completed = await runtime.run("write report");
      expect(calls).toBe(2);
      expect(completed.completion?.success).toBe(true);
      expect(completed.completion?.ledger.evidence.find(item => item.kind === "artifact")?.sha256).toBeTruthy();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

import { TaskStore } from "../../tasks/store.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { describe, expect, it } from "bun:test";
import { AgentEventEmitter } from "../../agent/events.js";
import type { LoopAgentResult, RunOptions } from "../../agent/loop.js";
import { AgentRuntime } from "../../runtime/agent-runtime.js";
import { classifyExecution, classifyObservedAcceptance, executionExitCode } from "../../runtime/outcome.js";
import { InMemoryRuntimeEventStore, JsonlRuntimeEventStore } from "../../runtime/event-store.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const result: LoopAgentResult = { text: "done", steps: 1, totalUsage: { inputTokens: 2, outputTokens: 1 }, toolResults: [] };
class Executor extends AgentEventEmitter {
  calls = 0;
  constructor(readonly execute: (options?: RunOptions) => Promise<LoopAgentResult> = async () => result) { super(); }
  async run(_input: string, options?: RunOptions) { this.calls++; return this.execute(options); }
  toolDefinitions() { return []; }
  effectiveSystemPrompt() { return undefined; }
}
function setup(agent = new Executor(), eventStore = new InMemoryRuntimeEventStore(), store = new InMemoryRuntimeStateStore()) {
  return { agent, eventStore, store, runtime: new AgentRuntime({ threadId: "outcome-test", agent, eventStore,
    stateTracker: new RuntimeStateTracker({ threadId: "outcome-test", workspaceRoot: "/tmp", store }) }) };
}

describe("execution and acceptance", () => {
  it("keeps finished separate from observed unknown mutations and checks", () => {
    expect(classifyExecution({ attemptId: "a", result }).status).toBe("finished");
    expect(classifyObservedAcceptance("a", result, 1).status).toBe("not_requested");
    expect(classifyObservedAcceptance("a", { ...result, toolResults: [{ success: true, output: "written" }] }, 1)).toMatchObject({ status: "unverified", checks: [] });
  });
  it("prioritizes accepted cancellation over faults, blockers and budget", () => {
    const input = { attemptId: "a", result: { ...result, stopped: "budget" as const }, error: new Error("broken"), cancelled: true };
    expect(classifyExecution(input)).toMatchObject({ status: "cancelled", stopReason: "aborted" });
    expect(executionExitCode(classifyExecution(input))).toBe(130);
    expect(classifyExecution({ ...input, cancelled: false }).status).toBe("failed");
    expect(executionExitCode(classifyExecution({ attemptId: "a", result: input.result }))).toBe(0);
  });
});

describe("outcome terminal protocol", () => {
  it("persists one canonical terminal and projects the same cursor for legacy subscribers", async () => {
    const { runtime, store, eventStore } = setup();
    const old: any[] = [], modern: any[] = [];
    runtime.subscribe({}, event => old.push(event));
    runtime.subscribe({}, event => modern.push(event), 3);
    const { outcome } = await runtime.runWithOutcome("finish");
    expect(outcome.execution.status).toBe("finished");
    expect(outcome.acceptance.status).toBe("not_requested");
    const state = await store.load(runtime.threadId);
    expect(state?.schemaVersion).toBe(3);
    expect(state?.attemptOutcomes[outcome.attemptId]?.publication).toBe("published");
    expect(modern.at(-1).payload.type).toBe("attempt_ended");
    expect(old.at(-1).payload.type).toBe("turn_completed");
    expect(old.at(-1).eventId).toBe(modern.at(-1).eventId);
    expect(old.at(-1).sequence).toBe(modern.at(-1).sequence);
    expect(old.at(-1).schemaVersion).toBe(2);
    expect((await eventStore.list(runtime.threadId)).filter(e => e.payload.type === "attempt_ended")).toHaveLength(1);
    expect(runtime.cancelTurn()).toBe(false);
  });
  it("rejects unsupported and legacy configuration before running", async () => {
    const { runtime, agent } = setup();
    await expect(runtime.runWithOutcome("x", { acceptance: { mode: "required", timing: "inline" } as any })).rejects.toThrow();
    await expect(runtime.run("x", { acceptance: {} } as any)).rejects.toThrow("runWithOutcome");
    const explicit = new AgentRuntime({ threadId: "explicit", agent, completionEvidence: async () => ({}) });
    await expect(explicit.runWithOutcome("x")).rejects.toThrow("legacy completion");
    expect(agent.calls).toBe(0);
  });
  it("locks before asynchronous setup and records provider failures as execution failures", async () => {
    const { runtime } = setup(new Executor(async () => { throw new Error("provider fault"); }));
    const first = runtime.runWithOutcome("x");
    await expect(runtime.run("y")).rejects.toThrow("active turn");
    expect((await first).outcome.execution).toMatchObject({ status: "failed", error: { message: "provider fault" } });
  });
  it("retains completed root-run metrics after a fault without replaying or including child metrics", async () => {
    const usage = { inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 800,
      cacheMissInputTokens: 120, providerUsageReported: true };
    const expectedUsage = { ...usage };
    const agent = new Executor(async () => {
      agent.emit({ type: "run_ended", steps: 3, usage });
      agent.emit({ type: "run_ended", path: ["child"], steps: 99, usage: { inputTokens: 9000, outputTokens: 9000 } });
      usage.inputTokens = 999;
      throw new Error("stream idle timeout");
    });
    const { runtime, store, eventStore } = setup(agent);
    const { loopResult, outcome } = await runtime.runWithOutcome("work then fail");
    expect(agent.calls).toBe(1);
    expect(outcome.execution).toMatchObject({ status: "failed", stopReason: "error" });
    expect(loopResult).toMatchObject({ steps: 3, totalUsage: expectedUsage });
    const saved = (await store.load(runtime.threadId))!.attemptOutcomes[outcome.attemptId]!;
    if (saved.terminalEvent.payload.type !== "attempt_ended") throw new Error("missing persisted terminal");
    expect(saved.terminalEvent.payload.legacyTerminal.run).toMatchObject({ steps: 3, usage: expectedUsage });
    const terminal = (await eventStore.list(runtime.threadId)).findLast(event => event.payload.type === "attempt_ended")!;
    if (terminal.payload.type !== "attempt_ended") throw new Error("missing terminal");
    expect(terminal.payload.legacyTerminal.run).toMatchObject({ steps: 3, usage: expectedUsage });

    const second = await runtime.runWithOutcome("new attempt");
    expect(second.outcome.attemptId).not.toBe(outcome.attemptId);
    expect(agent.calls).toBe(2);
  });
  it("does not carry metrics from a prior attempt into a failure before execution", async () => {
    const agent = new Executor(async () => {
      if (agent.calls === 1) {
        agent.emit({ type: "run_ended", steps: result.steps, usage: result.totalUsage });
        return result;
      }
      throw new Error("failed before first request");
    });
    const { runtime } = setup(agent);
    await runtime.runWithOutcome("first");
    const failed = await runtime.runWithOutcome("second");
    expect(failed.outcome.execution.status).toBe("failed");
    expect(failed.loopResult).toMatchObject({ steps: 0, totalUsage: { inputTokens: 0, outputTokens: 0 } });
  });
  it("does not install an acceptance guard and invokes legacy evidence only once", async () => {
    let evidenceCalls = 0;
    const agent = new Executor(async options => { expect(options?.turnEndGuard).toBeUndefined(); return result; });
    const runtime = new AgentRuntime({ threadId: "legacy", agent,
      completionContract: { id: "artifact", requirements: [{ kind: "artifact", path: "/missing" }] },
      completionEvidence: async () => { evidenceCalls++; return {}; } });
    expect((await runtime.run("x")).completion?.status).toBe("incomplete");
    expect(evidenceCalls).toBe(1);
    expect(agent.calls).toBe(1);
  });
  it("captures cancellation before sealing and rejects it while publishing", async () => {
    let runtime!: AgentRuntime;
    const eventStore = new InMemoryRuntimeEventStore();
    const append = eventStore.append.bind(eventStore);
    eventStore.append = async event => {
      if (event.payload.type === "attempt_ended") expect(runtime.cancelTurn()).toBe(false);
      return append(event);
    };
    ({ runtime } = setup(new Executor(async () => { expect(runtime.cancelTurn()).toBe(true); return result; }), eventStore));
    expect((await runtime.runWithOutcome("x")).outcome.execution.status).toBe("cancelled");
  });
  it("replays a saved outbox after append succeeded but its acknowledgement failed", async () => {
    const eventStore = new InMemoryRuntimeEventStore();
    const append = eventStore.append.bind(eventStore);
    let fail = true;
    eventStore.append = async event => {
      await append(event);
      if (fail && event.payload.type === "attempt_ended") throw new Error("lost acknowledgement");
    };
    const first = setup(new Executor(), eventStore);
    await expect(first.runtime.runWithOutcome("x")).rejects.toMatchObject({ code: "TERMINAL_PUBLICATION_FAILED" });
    const saved = Object.values((await first.store.load(first.runtime.threadId))!.attemptOutcomes)[0]!;
    expect(saved.outcome.execution.status).toBe("finished");
    expect(saved.publication).toBe("pending");
    fail = false;
    const second = setup(new Executor(), eventStore, first.store);
    await second.runtime.runWithOutcome("new user turn");
    const state = (await first.store.load(first.runtime.threadId))!;
    expect(state.attemptOutcomes[saved.outcome.attemptId]!.outcome).toEqual(saved.outcome);
    expect(state.attemptOutcomes[saved.outcome.attemptId]!.publication).toBe("published");
    expect((await eventStore.list(first.runtime.threadId)).filter(event => event.eventId === saved.terminalEventId)).toHaveLength(1);
    expect(first.agent.calls).toBe(1);
    expect(second.agent.calls).toBe(1);
  });
  it("deduplicates durable events after reopening and rejects conflicting IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-outbox-"));
    try {
      const first = setup();
      await first.runtime.runWithOutcome("x");
      const event = (await first.eventStore.list(first.runtime.threadId)).at(-1)!;
      const disk = new JsonlRuntimeEventStore({ directory });
      await disk.append(event); await disk.close();
      const reopened = new JsonlRuntimeEventStore({ directory });
      await reopened.append(event);
      expect(await reopened.list(first.runtime.threadId)).toHaveLength(1);
      await expect(reopened.append({ ...event, timestamp: event.timestamp + 1 })).rejects.toThrow("ID conflict");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

it("does not claim a terminal result if the state write fails", async () => {
  const { runtime, store, eventStore } = setup();
  const update = store.update.bind(store);
  store.update = async (id, updater, options) => update(id, async state => {
    const changed = await updater(state);
    if (changed && Object.keys(changed.attemptOutcomes).length) throw new Error("disk full");
    return changed;
  }, options);
  await expect(runtime.runWithOutcome("x")).rejects.toMatchObject({ code: "OUTCOME_PERSISTENCE_FAILED" });
  expect((await eventStore.list(runtime.threadId)).some(event => event.payload.type === "attempt_ended")).toBe(false);
  expect(runtime.lastOutcome()).toBeUndefined();
});

it("recovers an interrupted attempt without rerunning its model or changing its tools", async () => {
  const { createRuntimeStateSnapshot } = await import("../../runtime/state-types.js");
  const store = new InMemoryRuntimeStateStore();
  const state = createRuntimeStateSnapshot({ threadId: "outcome-test", workspaceRoot: "/tmp", now: 1 });
  state.turns.old = { turnId: "old", threadId: state.threadId, rootRunId: "old-run", resultSchema: "outcome-v1", status: "running", createdAt: 1, updatedAt: 1 };
  state.runs["old-run"] = { runId: "old-run", threadId: state.threadId, turnId: "old", agentType: "root", taskPreview: "old request", status: "running", sequence: 1, createdAt: 1, updatedAt: 1 };
  state.thread.status = "running"; state.thread.activeTurnId = "old";
  await store.update(state.threadId, () => state);
  const next = setup(new Executor(), new InMemoryRuntimeEventStore(), store);
  await next.runtime.initialize();
  const recovered = (await store.load(state.threadId))!.attemptOutcomes["old-run"]!;
  expect(recovered.outcome.execution).toMatchObject({ status: "failed", error: { code: "RUN_INTERRUPTED" } });
  expect(recovered.publication).toBe("published");
  expect(next.agent.calls).toBe(0);
  await expect(store.update(state.threadId, current => {
    current!.attemptOutcomes["old-run"]!.outcome.execution.finalResponse = "changed";
    return current!;
  })).rejects.toThrow("immutable");
});

it("projects schema 3 execution metrics into content-free evaluation traces", async () => {
  const { projectRuntimeEventForTrajectory } = await import("../../evals/trajectory.js");
  const { runtime, eventStore } = setup();
  await runtime.runWithOutcome("secret input");
  const event = (await eventStore.list(runtime.threadId)).at(-1)!;
  const projected = projectRuntimeEventForTrajectory(event);
  expect(projected).toMatchObject({ schemaVersion: 3, executionStatus: "finished", acceptanceStatus: "not_requested", inputTokens: 2, outputTokens: 1 });
  expect(JSON.stringify(projected)).not.toContain("secret input");
  expect(JSON.stringify(projected)).not.toContain('"done"');
});

it("distinguishes malformed acceptance from well-formed unsupported future modes", async () => {
  const { validateObserveConfiguration } = await import("../../runtime/outcome.js");
  const config = { mode: "required", timing: "inline", spec: { id: "spec", revision: 1, subjects: [], checks: [] }, verifiers: [], timeoutMs: 10 };
  try { validateObserveConfiguration(config); throw new Error("expected preflight refusal"); }
  catch (error) { expect(error).toMatchObject({ code: "UNSUPPORTED_ACCEPTANCE_MODE" }); }
  for (const invalid of [{ ...config, timeoutMs: -1 }, { ...config, spec: { ...config.spec, subjects: [{ id: "s", path: "a", expected: "exists" }, { id: "s", path: "b", expected: "exists" }] } }]) {
    try { validateObserveConfiguration(invalid); throw new Error("expected validation failure"); }
    catch (error) { expect(error).toMatchObject({ code: "INVALID_ACCEPTANCE_CONFIG" }); }
  }
});

it("initializes persisted outcomes and publishes pending outbox without a new model turn", async () => {
  const first = setup();
  const append = first.eventStore.append.bind(first.eventStore);
  first.eventStore.append = async event => {
    if (event.payload.type === "attempt_ended") throw new Error("publication unavailable");
    await append(event);
  };
  await expect(first.runtime.runWithOutcome("x")).rejects.toMatchObject({ code: "TERMINAL_PUBLICATION_FAILED" });
  const saved = Object.values((await first.store.load(first.runtime.threadId))!.attemptOutcomes)[0]!;
  first.eventStore.append = append;
  const second = setup(new Executor(), first.eventStore, first.store);
  await Promise.all([second.runtime.initialize(), second.runtime.initialize()]);
  expect(second.agent.calls).toBe(0);
  expect(second.runtime.lastOutcome()).toEqual(saved.outcome);
  expect((await first.store.load(first.runtime.threadId))!.attemptOutcomes[saved.outcome.attemptId]!.publication).toBe("published");
  await second.runtime.initialize();
  expect((await first.eventStore.list(first.runtime.threadId)).filter(event => event.eventId === saved.terminalEventId)).toHaveLength(1);
});

it("retains the fault that races accepted cancellation in persisted audit", async () => {
  let runtime!: AgentRuntime;
  const fixture = setup(new Executor(async () => {
    runtime.cancelTurn();
    throw new Error("aborted", { cause: new Error("provider disconnected") });
  }));
  runtime = fixture.runtime;
  const { outcome } = await runtime.runWithOutcome("cancel");
  expect(outcome.execution).toMatchObject({ status: "cancelled", error: { message: "provider disconnected" } });
  expect(JSON.stringify(await fixture.store.load(runtime.threadId))).toContain("provider disconnected");
  expect(JSON.stringify(await fixture.eventStore.list(runtime.threadId))).toContain("provider disconnected");
  expect(classifyExecution({ attemptId: "a", result, cancelled: true, error: new Error("aborted") }).error).toBeUndefined();
});


for (const disposition of ["stop", "host"] as const) {
  it(`records and settles background task ownership: ${disposition}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-outcome-tasks-"));
    const tasks = new TaskStore({ outputDir: directory });
    try {
      const command = executeCommandTool({ store: tasks, defaultCwd: directory });
      const agent = new Executor(async () => {
        const toolResult = await command.handler({ command: "sleep 30", run_in_background: true }, new AbortController().signal);
        expect(toolResult.success).toBe(true);
        return { ...result, toolResults: [toolResult] };
      });
      const eventStore = new InMemoryRuntimeEventStore();
      const runtime = new AgentRuntime({ threadId: "background", agent, eventStore, backgroundTasks: { store: tasks, disposition } });
      runtime.subscribe({}, event => {
        if (event.payload.type === "attempt_ended") expect(tasks.list({ running: true }).length).toBe(disposition === "stop" ? 0 : 1);
      }, 3);
      const { outcome } = await runtime.runWithOutcome("background");
      expect(outcome.execution.status).toBe("finished");
      expect(outcome.execution.backgroundTasks).toEqual([{ taskId: tasks.list()[0]!.taskId, disposition: disposition === "stop" ? "stopped" : "host_owned" }]);
      expect(tasks.list({ running: true })).toHaveLength(disposition === "stop" ? 0 : 1);
    } finally {
      await tasks.settle(tasks.list({ running: true }).map(task => task.taskId));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

it("refreshes the event cursor when another owner ran between reconnect and execution", async () => {
  const first = setup();
  await first.runtime.initialize();
  const second = setup(new Executor(), first.eventStore, first.store);
  await second.runtime.runWithOutcome("other owner");
  const prior = await first.eventStore.latestSequence(first.runtime.threadId);
  await first.runtime.runWithOutcome("resumed owner");
  const events = await first.eventStore.list(first.runtime.threadId);
  expect(new Set(events.map(event => event.sequence)).size).toBe(events.length);
  expect(events.at(-1)!.sequence).toBeGreaterThan(prior);
});

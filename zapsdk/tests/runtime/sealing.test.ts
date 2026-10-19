import { describe, expect, it } from "bun:test";
import { AgentEventEmitter } from "../../agent/events.js";
import type { LoopAgentResult } from "../../agent/loop.js";
import { AgentRuntime } from "../../runtime/agent-runtime.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import type { SealingProgress } from "../../runtime/sealing.js";

const result: LoopAgentResult = { text: "done", steps: 1, toolResults: [], totalUsage: { inputTokens: 1, outputTokens: 1 } };
class Executor extends AgentEventEmitter {
  calls = 0;
  async run() { this.calls++; return result; }
  toolDefinitions() { return []; }
  effectiveSystemPrompt() { return undefined; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("bounded outcome sealing", () => {
  for (const blockedStage of ["outcome_save", "terminal_append", "ownership_release"] as const) {
    it(`returns a timeout while retaining ownership during ${blockedStage}`, async () => {
      const gate = deferred(), drained = deferred();
      const agent = new Executor();
      const store = new InMemoryRuntimeStateStore();
      const events = new InMemoryRuntimeEventStore();
      const progress: SealingProgress[] = [];
      const update = store.update.bind(store);
      store.update = (id, updater, options) => update(id, async current => {
        const hadOutcomes = Object.keys(current?.attemptOutcomes ?? {}).length > 0;
        const next = await updater(current);
        if (blockedStage === "outcome_save" && next && Object.keys(next.attemptOutcomes).length && !hadOutcomes) {
          await gate.promise;
        }
        return next;
      }, options);
      const append = events.append.bind(events);
      events.append = async event => {
        if (blockedStage === "terminal_append" && event.payload.type === "attempt_ended") await gate.promise;
        await append(event);
      };
      const acquire = store.acquireThreadLease.bind(store);
      store.acquireThreadLease = async (id, owner) => {
        const lease = await acquire(id, owner);
        return { ...lease, async release() {
          if (blockedStage === "ownership_release") await gate.promise;
          await lease.release();
        } };
      };
      const tracker = new RuntimeStateTracker({ threadId: "sealed", workspaceRoot: "/tmp", store });
      const runtime = new AgentRuntime({ threadId: "sealed", agent, stateTracker: tracker, eventStore: events, sealingTimeoutMs: 20,
        onSealingProgress(event) {
          progress.push(event);
          if (event.stage === "ownership_release" && event.status === "completed") drained.resolve();
        } });
      try {
        await expect(runtime.runWithOutcome("write")).rejects.toMatchObject({ code: "OUTCOME_SEALING_TIMEOUT" });
        const timeouts = progress.filter(event => event.status === "timeout");
        expect(timeouts).toHaveLength(1);
        expect(timeouts[0]).toMatchObject({ stage: blockedStage, threadId: "sealed" });
        expect(progress.at(-1)!.totalElapsedMs).toBeGreaterThanOrEqual(10);
        await expect(runtime.runWithOutcome("retry")).rejects.toThrow("active turn");
        await expect(runtime.close()).rejects.toThrow("pending persistence");
        await expect(acquire("sealed", tracker.ownerSnapshot())).rejects.toThrow("owned by runtime");
        if (blockedStage === "outcome_save") expect(runtime.lastOutcome()).toBeUndefined();
        else expect(runtime.lastOutcome()?.execution.status).toBe("finished");
        if (blockedStage !== "ownership_release") expect((await events.list("sealed")).some(event => event.payload.type === "attempt_ended")).toBe(false);
      } finally { gate.resolve(); }
      await drained.promise;
      await tick();
      const saved = Object.values((await store.load("sealed"))!.attemptOutcomes);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.publication).toBe("published");
      const recoveredAgent = new Executor();
      const recovered = new AgentRuntime({ threadId: "sealed", agent: recoveredAgent, eventStore: events,
        stateTracker: new RuntimeStateTracker({ threadId: "sealed", workspaceRoot: "/tmp", store }) });
      await recovered.initialize();
      expect(recovered.lastOutcome()).toEqual(saved[0]!.outcome);
      expect((await events.list("sealed")).filter(event => event.payload.type === "attempt_ended")).toHaveLength(1);
      expect(agent.calls).toBe(1);
      expect(recoveredAgent.calls).toBe(0);
      await runtime.close();
      await recovered.close();
    });
  }

  it("recovers a pending terminal when publication fails after the caller timed out", async () => {
    const gate = deferred(), drained = deferred();
    const store = new InMemoryRuntimeStateStore();
    const events = new InMemoryRuntimeEventStore();
    const append = events.append.bind(events);
    events.append = async event => {
      if (event.payload.type === "attempt_ended") { await gate.promise; throw new Error("storage unavailable"); }
      await append(event);
    };
    const agent = new Executor();
    const runtime = new AgentRuntime({ threadId: "pending", agent, eventStore: events, sealingTimeoutMs: 20,
      stateTracker: new RuntimeStateTracker({ threadId: "pending", workspaceRoot: "/tmp", store }),
      onSealingProgress(event) { if (event.stage === "ownership_release" && event.status === "completed") drained.resolve(); } });
    try { await expect(runtime.runWithOutcome("write")).rejects.toMatchObject({ code: "OUTCOME_SEALING_TIMEOUT" }); }
    finally { gate.resolve(); }
    await drained.promise;
    await tick();
    const saved = Object.values((await store.load("pending"))!.attemptOutcomes)[0]!;
    expect(saved.publication).toBe("pending");
    events.append = append;
    await runtime.initialize();
    expect((await store.load("pending"))!.attemptOutcomes[saved.outcome.attemptId]!.publication).toBe("published");
    expect((await events.list("pending")).filter(event => event.eventId === saved.terminalEventId)).toHaveLength(1);
    expect(agent.calls).toBe(1);
  });

  it("measures successful stages outside persistence and tolerates broken observers", async () => {
    const progress: SealingProgress[] = [];
    const runtime = new AgentRuntime({ threadId: "observed", agent: new Executor(), onSealingProgress(event) {
      progress.push(event);
      throw new Error("observer failed");
    } });
    expect((await runtime.runWithOutcome("write")).outcome.execution.status).toBe("finished");
    expect(progress.filter(event => event.status === "completed").map(event => event.stage)).toEqual([
      "state_flush", "state_load", "outcome_save", "event_flush", "terminal_append", "publication_ack", "ownership_release",
    ]);
    expect(progress.every(event => event.elapsedMs >= 0 && event.totalElapsedMs >= event.elapsedMs)).toBe(true);
  });

  it("does not spend the sealing allowance during model execution", async () => {
    const agent = new Executor();
    agent.run = async () => { await new Promise(resolve => setTimeout(resolve, 40)); return result; };
    const runtime = new AgentRuntime({ threadId: "slow-model", agent, sealingTimeoutMs: 20 });
    expect((await runtime.runWithOutcome("write")).outcome.execution.status).toBe("finished");
  });

  it("detects elapsed deadlines even if synchronous storage blocks timer delivery", async () => {
    const events = new InMemoryRuntimeEventStore();
    const append = events.append.bind(events);
    events.append = async event => {
      if (event.payload.type === "attempt_ended") {
        const until = performance.now() + 30;
        while (performance.now() < until) { /* Simulate a synchronous storage call. */ }
      }
      await append(event);
    };
    const runtime = new AgentRuntime({ threadId: "sync-storage", agent: new Executor(), eventStore: events, sealingTimeoutMs: 10 });
    await expect(runtime.runWithOutcome("write")).rejects.toMatchObject({ code: "OUTCOME_SEALING_TIMEOUT" });
    await tick();
  });

  it("rejects invalid sealing limits before execution", () => {
    for (const sealingTimeoutMs of [0, -1, 0.5, Infinity, NaN, 2_147_483_648]) {
      expect(() => new AgentRuntime({ threadId: "invalid", agent: new Executor(), sealingTimeoutMs })).toThrow("sealingTimeoutMs");
    }
  });

  it("does not turn an over-budget final observer into an on-time result", async () => {
    const runtime = new AgentRuntime({ threadId: "slow-observer", agent: new Executor(), sealingTimeoutMs: 10,
      onSealingProgress(event) {
        if (event.stage === "ownership_release" && event.status === "completed") {
          const until = performance.now() + 30;
          while (performance.now() < until) { /* Delays timer delivery at the last boundary. */ }
        }
      } });
    await expect(runtime.runWithOutcome("write")).rejects.toMatchObject({ code: "OUTCOME_SEALING_TIMEOUT" });
    await runtime.close();
  });
});

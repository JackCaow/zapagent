import { describe, expect, it } from "bun:test";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { InMemoryAgentCoordinatorStateStore } from "../../coordinator/store.js";
import type {
  AgentCoordinatorExecutor,
  AgentCoordinatorResult,
  AgentCoordinatorState,
  AgentCoordinatorStateStore,
} from "../../coordinator/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (caught) {
      error = caught;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw error;
}

describe("AgentCoordinator", () => {
  it("enforces capacity and starts dependency tasks only after success", async () => {
    const gates = new Map<string, Deferred<void>>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const executor: AgentCoordinatorExecutor = {
      execute: async ({ run }) => {
        started.push(run.runId);
        active++;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.set(run.runId, gate);
        await gate.promise;
        active--;
        return { success: true, text: `done ${run.runId}` };
      },
    };
    const coordinator = new AgentCoordinator({
      threadId: "thread-capacity",
      executor,
      maxConcurrency: 2,
      idFactory: ids("run-a", "run-b", "run-c", "run-d"),
    });
    const a = await coordinator.spawn({ task: "a", agentType: "explore" });
    const b = await coordinator.spawn({ task: "b", agentType: "explore" });
    const c = await coordinator.spawn({ task: "c", agentType: "explore" });
    const d = await coordinator.spawn({
      task: "d",
      agentType: "plan",
      dependencies: [a.runId],
    });

    await eventually(() => {
      expect(started).toEqual(["run-a", "run-b"]);
    });
    const before = await coordinator.list();
    expect(before.find((run) => run.runId === c.runId)?.status).toBe("waiting_capacity");
    expect(before.find((run) => run.runId === d.runId)?.status).toBe("waiting_dependency");

    gates.get("run-a")!.resolve();
    await expect(coordinator.wait(a.runId)).resolves.toMatchObject({ success: true });
    await eventually(() => {
      expect(started).toContain("run-c");
    });
    gates.get("run-b")!.resolve();
    await expect(coordinator.wait(b.runId)).resolves.toMatchObject({ success: true });
    gates.get("run-c")!.resolve();
    await expect(coordinator.wait(c.runId)).resolves.toMatchObject({ success: true });
    await eventually(() => {
      expect(started).toContain("run-d");
    });
    gates.get("run-d")!.resolve();
    await expect(coordinator.wait(d.runId)).resolves.toMatchObject({ success: true });
    expect(maxActive).toBe(2);
  });

  it("releases capacity while one Agent waits for approval", async () => {
    const approval = deferred();
    const second = deferred();
    const events: string[] = [];
    const coordinator = new AgentCoordinator({
      threadId: "thread-approval",
      maxConcurrency: 1,
      idFactory: ids("run-first", "run-second"),
      executor: {
        execute: async ({ run, reportStatus }) => {
          events.push(`start:${run.runId}`);
          if (run.runId === "run-first") {
            await reportStatus("waiting_approval", "approval required");
            await approval.promise;
            await reportStatus("running", "approval granted");
          } else {
            await second.promise;
          }
          events.push(`finish:${run.runId}`);
          return { success: true, text: "done" };
        },
      },
    });
    const first = await coordinator.spawn({ task: "first", agentType: "general" });
    await eventually(async () => {
      const run = (await coordinator.list()).find((item) => item.runId === first.runId);
      expect(run?.status).toBe("waiting_approval");
    });
    const other = await coordinator.spawn({ task: "second", agentType: "explore" });
    await eventually(() => { expect(events).toContain("start:run-second"); });

    approval.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).not.toContain("finish:run-first");
    second.resolve();
    await expect(coordinator.wait(other.runId)).resolves.toMatchObject({ success: true });
    await expect(coordinator.wait(first.runId)).resolves.toMatchObject({ success: true });
    expect(events.indexOf("finish:run-second")).toBeLessThan(events.indexOf("finish:run-first"));
  });

  it("delivers steer messages at an explicit waiting-input boundary", async () => {
    const coordinator = new AgentCoordinator({
      threadId: "thread-steer",
      idFactory: ids("run-steer", "message-steer"),
      executor: {
        execute: async ({ reportStatus, waitForMessage }) => {
          await reportStatus("waiting_input", "waiting for direction");
          const message = await waitForMessage();
          await reportStatus("running", "direction received");
          return { success: true, text: `${message.kind}:${message.text}` };
        },
      },
    });
    const run = await coordinator.spawn({ task: "inspect", agentType: "explore" });
    await eventually(async () => {
      expect((await coordinator.list())[0]?.status).toBe("waiting_input");
    });
    await coordinator.steer(run.runId, "focus on parser");

    await expect(coordinator.wait(run.runId)).resolves.toMatchObject({
      success: true,
      text: "steer:focus on parser",
    });
  });

  it("coalesces simultaneous capacity resumptions and leaves capacity for later runs", async () => {
    const resume = deferred(), blocker = deferred();
    const started: string[] = [];
    const coordinator = new AgentCoordinator({
      threadId: "coalesced-capacity", maxConcurrency: 1, idFactory: ids("first", "blocker", "later"),
      executor: {
        execute: async ({ run, reportStatus }) => {
          started.push(run.runId);
          if (run.runId === "first") {
            await reportStatus("waiting_approval");
            await resume.promise;
            await Promise.all([reportStatus("running"), reportStatus("running")]);
          } else if (run.runId === "blocker") await blocker.promise;
          return { success: true, text: "done" };
        },
      },
    });
    const first = await coordinator.spawn({ task: "first", agentType: "general" });
    await eventually(async () => { expect((await coordinator.list())[0]?.status).toBe("waiting_approval"); });
    const second = await coordinator.spawn({ task: "block", agentType: "general" });
    await eventually(() => { expect(started).toContain("blocker"); });
    resume.resolve();
    await new Promise(resolve => setTimeout(resolve, 5));
    blocker.resolve();
    await expect(coordinator.wait(second.runId)).resolves.toMatchObject({ success: true });
    await expect(coordinator.wait(first.runId)).resolves.toMatchObject({ success: true });
    const later = await coordinator.spawn({ task: "later", agentType: "general" });
    await expect(coordinator.wait(later.runId)).resolves.toMatchObject({ success: true });
  });

  it("cancels a child waiting to regain capacity without waiting for the occupying child", async () => {
    const resume = deferred(), blocker = deferred(), resuming = deferred();
    const coordinator = new AgentCoordinator({
      threadId: "cancel-capacity", maxConcurrency: 1, idFactory: ids("first", "blocker", "later"),
      executor: {
        execute: async ({ run, reportStatus }) => {
          if (run.runId === "first") {
            await reportStatus("waiting_approval");
            await resume.promise;
            const pending = Promise.all([reportStatus("running"), reportStatus("running")]);
            resuming.resolve();
            await pending;
          } else if (run.runId === "blocker") await blocker.promise;
          return { success: true, text: "done" };
        },
      },
    });
    const first = await coordinator.spawn({ task: "first", agentType: "general" });
    await eventually(async () => { expect((await coordinator.list())[0]?.status).toBe("waiting_approval"); });
    const second = await coordinator.spawn({ task: "block", agentType: "general" });
    await eventually(async () => {
      expect((await coordinator.list()).find(run => run.runId === second.runId)?.status).toBe("running");
    });
    resume.resolve();
    await resuming.promise;
    await coordinator.cancel(first.runId);
    await expect(coordinator.wait(first.runId)).resolves.toMatchObject({ success: false });
    expect((await coordinator.list()).find(run => run.runId === first.runId)?.status).toBe("cancelled");
    blocker.resolve();
    await coordinator.wait(second.runId);
    const later = await coordinator.spawn({ task: "later", agentType: "general" });
    await expect(coordinator.wait(later.runId)).resolves.toMatchObject({ success: true });
  });

  it("cancels running work idempotently", async () => {
    const coordinator = new AgentCoordinator({
      threadId: "thread-cancel",
      idFactory: ids("run-cancel"),
      executor: {
        execute: async ({ signal }) => new Promise<AgentCoordinatorResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      },
    });
    const run = await coordinator.spawn({ task: "long", agentType: "general" });
    await eventually(async () => {
      expect((await coordinator.list())[0]?.status).toBe("running");
    });
    await coordinator.cancel(run.runId, "stop now");
    await expect(coordinator.wait(run.runId)).resolves.toMatchObject({
      success: false,
      error: "stop now",
    });
    expect((await coordinator.cancel(run.runId)).status).toBe("cancelled");
  });

  it("settles returned failures terminally and blocks dependent work", async () => {
    const store = new InMemoryAgentCoordinatorStateStore();
    let calls = 0;
    const coordinator = new AgentCoordinator({
      threadId: "returned-failure", stateStore: store,
      executor: { execute: async () => {
        calls++;
        return { success: false, text: "completed diagnostic", error: "verification failed",
          workspaceId: "workspace", artifactId: "failed-artifact", changedPaths: ["a.ts"] };
      } },
    });
    const run = await coordinator.spawn({ task: "inspect", agentType: "general" });
    const result = await coordinator.wait(run.runId);
    expect(result).toMatchObject({ success: false, text: "completed diagnostic", error: "verification failed", workspaceId: "workspace" });
    expect(result.artifactId).toBeUndefined();
    expect(result.changedPaths).toBeUndefined();
    expect((await coordinator.list())[0]).toMatchObject({ status: "failed", success: false });
    expect(typeof (await coordinator.list())[0]?.finishedAt).toBe("number");
    const dependent = await coordinator.spawn({ task: "use changes", agentType: "explore", dependencies: [run.runId] });
    expect((await coordinator.wait(dependent.runId)).success).toBe(false);
    expect((await coordinator.list()).find(r => r.runId === dependent.runId)?.status).toBe("blocked");
    expect(calls).toBe(1);
    const state = await store.load("returned-failure");
    expect(state?.tasks[run.runId]?.status).toBe("failed");
  });

  for (const success of [false, true]) {
    it(`cancellation wins over a returned success=${success} without publishing an artifact`, async () => {
      const started = deferred();
      const gate = deferred();
      const store = new InMemoryAgentCoordinatorStateStore();
      const coordinator = new AgentCoordinator({
        threadId: `returned-cancel-${success}`, stateStore: store,
        executor: { execute: async () => {
          started.resolve();
          await gate.promise;
          return { success, text: "partial observations", artifactId: "late-artifact", changedPaths: ["a.ts"] };
        } },
      });
      const run = await coordinator.spawn({ task: "long", agentType: "general" });
      await started.promise;
      await coordinator.cancel(run.runId, "requested stop");
      gate.resolve();
      const result = await coordinator.wait(run.runId);
      expect(result).toMatchObject({ success: false, text: "partial observations", error: "requested stop" });
      expect(result.artifactId).toBeUndefined();
      expect(result.changedPaths).toBeUndefined();
      expect((await coordinator.list())[0]).toMatchObject({ status: "cancelled", success: false });
      expect((await store.load(`returned-cancel-${success}`))?.tasks[run.runId]?.status).toBe("cancelled");
      expect((await coordinator.cancel(run.runId)).status).toBe("cancelled");
    });
  }

  it("honors cancellation while its persistence is pending", async () => {
    const started = deferred();
    const returnResult = deferred();
    const cancellingSaved = deferred();
    const releaseSave = deferred();
    const store = new InMemoryAgentCoordinatorStateStore();
    let signal: AbortSignal | undefined;
    const coordinator = new AgentCoordinator({
      threadId: "cancel-save-race",
      stateStore: {
        load: id => store.load(id),
        save: async state => {
          if (Object.values(state.runs).some(r => r.status === "cancelling")) {
            cancellingSaved.resolve();
            await releaseSave.promise;
          }
          await store.save(state);
        },
      },
      executor: { execute: async context => {
        signal = context.signal;
        started.resolve();
        await returnResult.promise;
        return { success: true, text: "late result", artifactId: "late-artifact" };
      } },
    });
    const run = await coordinator.spawn({ task: "inspect", agentType: "general" });
    await started.promise;
    const cancelling = coordinator.cancel(run.runId, "stop during persistence");
    await cancellingSaved.promise;
    expect(signal?.aborted).toBe(false);
    returnResult.resolve();
    await eventually(async () => expect((await coordinator.list())[0]?.status).toBe("cancelled"));
    releaseSave.resolve();
    await cancelling;
    const result = await coordinator.wait(run.runId);
    expect(result).toMatchObject({ success: false, text: "late result", error: "stop during persistence" });
    expect(result.artifactId).toBeUndefined();
    expect((await store.load("cancel-save-race"))?.tasks[run.runId]?.status).toBe("cancelled");
  });

  it("classifies interrupted persisted work and resumes as a new continuation run", async () => {
    const store = new InMemoryAgentCoordinatorStateStore();
    const never = deferred();
    const first = new AgentCoordinator({
      threadId: "thread-recovery",
      stateStore: store,
      idFactory: ids("run-interrupted"),
      executor: { execute: async () => never.promise as Promise<never> },
    });
    const interrupted = await first.spawn({
      task: "recover me",
      agentType: "general",
      metadata: {
        executorBindingId: "binding-general",
        thoroughness: "very_thorough",
      },
    });
    await eventually(async () => {
      expect((await first.list())[0]?.status).toBe("running");
    });

    let resumedMetadata: Record<string, string | number | boolean> | undefined;
    const recovered = new AgentCoordinator({
      threadId: "thread-recovery",
      stateStore: store,
      idFactory: ids("run-resumed"),
      executor: {
        execute: async ({ metadata }) => {
          resumedMetadata = metadata;
          return { success: true, text: "resumed" };
        },
      },
    });
    expect((await recovered.list())[0]).toMatchObject({
      runId: interrupted.runId,
      status: "blocked",
      success: false,
    });
    const resumed = await recovered.resume(interrupted.runId);
    expect(resumed.runId).toBe("run-resumed");
    await expect(recovered.wait(resumed.runId)).resolves.toMatchObject({
      success: true,
      text: "resumed",
    });
    expect(resumedMetadata).toEqual({
      executorBindingId: "binding-general",
      thoroughness: "very_thorough",
      resumed: true,
    });
  });

  it("recovers after one coordinator state write fails", async () => {
    const delegate = new InMemoryAgentCoordinatorStateStore();
    let saves = 0;
    const store: AgentCoordinatorStateStore = {
      load: (threadId) => delegate.load(threadId),
      save: async (state: AgentCoordinatorState) => {
        saves++;
        if (saves === 2) throw new Error("transient disk failure");
        await delegate.save(state);
      },
    };
    const coordinator = new AgentCoordinator({
      threadId: "thread-persist-recovery",
      stateStore: store,
      idFactory: ids("run-failed", "run-recovered"),
      executor: { execute: async () => ({ success: true, text: "done" }) },
    });

    const first = await coordinator.spawn({ task: "first", agentType: "general" });
    await expect(coordinator.wait(first.runId)).resolves.toMatchObject({
      success: false,
      error: "transient disk failure",
    });
    const second = await coordinator.spawn({ task: "second", agentType: "general" });
    await expect(coordinator.wait(second.runId)).resolves.toMatchObject({
      success: true,
      text: "done",
    });
  });

  it("keeps an artifact run nonterminal until the merge lifecycle completes", async () => {
    const dependentStarted = deferred();
    const coordinator = new AgentCoordinator({
      threadId: "thread-merge",
      idFactory: ids("run-artifact", "run-dependent"),
      executor: {
        execute: async ({ run }) => run.runId === "run-artifact" ? ({
          success: true,
          text: "changed",
          artifactId: "artifact-1",
          workspaceId: "workspace-1",
          changedPaths: ["src/a.ts"],
        }) : dependentStarted.promise.then(() => ({ success: true, text: "observed merged content" })),
      },
    });
    const run = await coordinator.spawn({ task: "edit", agentType: "general" });
    await expect(coordinator.wait(run.runId)).resolves.toMatchObject({ artifactId: "artifact-1" });
    expect((await coordinator.list())[0]?.status).toBe("ready_to_merge");
    const dependent = await coordinator.spawn({
      task: "verify edit",
      agentType: "explore",
      dependencies: [run.runId],
    });
    expect((await coordinator.list()).find((item) => item.runId === dependent.runId)?.status)
      .toBe("waiting_dependency");
    await coordinator.markMerging(run.runId);
    expect((await coordinator.list())[0]?.status).toBe("merging");
    await coordinator.completeMerge(run.runId, true, "merged");
    expect((await coordinator.list())[0]).toMatchObject({ status: "completed", success: true });
    await eventually(async () => {
      expect((await coordinator.list()).find((item) => item.runId === dependent.runId)?.status)
        .toBe("running");
    });
    dependentStarted.resolve();
    await expect(coordinator.wait(dependent.runId)).resolves.toMatchObject({ success: true });
  });
});

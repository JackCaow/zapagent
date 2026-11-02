import { expect, it } from "bun:test";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { InMemoryAgentCoordinatorStateStore } from "../../coordinator/store.js";
import type { AgentCoordinatorExecutorContext } from "../../coordinator/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const started = deferred<AgentCoordinatorExecutorContext>();
  const finish = deferred<void>();
  const store = new InMemoryAgentCoordinatorStateStore();
  const coordinator = new AgentCoordinator({
    threadId: "mailbox", stateStore: store,
    executor: { execute: async context => {
      started.resolve(context);
      await finish.promise;
      return { success: true, text: "done" };
    } },
  });
  const run = await coordinator.spawn({ task: "mock consumer", agentType: "explore" });
  const context = await started.promise;
  return { coordinator, store, run, context, close: async () => {
    finish.resolve();
    await coordinator.wait(run.runId);
  } };
}

it("single-message receive preserves the queued FIFO tail and durable consumption", async () => {
  const f = await fixture();
  try {
    await f.coordinator.steer(f.run.runId, "first");
    await f.coordinator.steer(f.run.runId, "second");
    await f.coordinator.steer(f.run.runId, "third");
    expect((await f.context.waitForMessage()).text).toBe("first");
    const saved = await f.store.load("mailbox");
    expect(saved!.messages.map(m => m.consumedAt !== undefined)).toEqual([true, false, false]);
    expect((await f.context.waitForMessage()).text).toBe("second");
    expect((await f.context.drainMailbox()).map(m => m.text)).toEqual(["third"]);
    expect(await f.context.drainMailbox()).toEqual([]);
  } finally { await f.close(); }
});

it("concurrent receivers claim distinct queued messages in FIFO order", async () => {
  const f = await fixture();
  try {
    await f.coordinator.send({ toRunId: f.run.runId, text: "one" });
    await f.coordinator.send({ toRunId: f.run.runId, text: "two" });
    const results = await Promise.all([f.context.waitForMessage(), f.context.waitForMessage()]);
    expect(results.map(m => m.text)).toEqual(["one", "two"]);
    expect(new Set(results.map(m => m.messageId)).size).toBe(2);
  } finally { await f.close(); }
});

it("pending receivers get distinct messages and cancellation removes a pending receive", async () => {
  const f = await fixture();
  try {
    const first = f.context.waitForMessage();
    const second = f.context.waitForMessage();
    await f.coordinator.send({ toRunId: f.run.runId, text: "one" });
    await f.coordinator.send({ toRunId: f.run.runId, text: "two" });
    expect((await Promise.all([first, second])).map(m => m.text)).toEqual(["one", "two"]);
    const pending = f.context.waitForMessage();
    const rejected = pending.catch(error => error);
    await f.coordinator.cancel(f.run.runId, "stop");
    expect((await rejected).message).toBe("stop");
    await f.coordinator.send({ toRunId: f.run.runId, text: "unconsumed" });
    await expect(f.context.waitForMessage()).rejects.toThrow("stop");
    expect((await f.store.load("mailbox"))!.messages.at(-1)!.consumedAt).toBeUndefined();
  } finally { await f.close(); }
});

it("a receive during send persistence cannot deliver the same message twice", async () => {
  const f = await fixture();
  try {
    const save = f.store.save.bind(f.store);
    const saving = deferred<void>();
    const release = deferred<void>();
    let blocked = false;
    f.store.save = async state => {
      if (!blocked && state.messages.length > 0) {
        blocked = true;
        saving.resolve();
        await release.promise;
      }
      await save(state);
    };
    const sending = f.coordinator.send({ toRunId: f.run.runId, text: "one" });
    await saving.promise;
    const first = f.context.waitForMessage();
    const second = f.context.waitForMessage();
    release.resolve();
    await sending;
    await f.coordinator.send({ toRunId: f.run.runId, text: "two" });
    expect((await Promise.all([first, second])).map(m => m.text)).toEqual(["one", "two"]);
  } finally { await f.close(); }
});

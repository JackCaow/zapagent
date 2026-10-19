import { describe, expect, it } from "bun:test";
import { AgentRunStore } from "../../agent/run-store.js";
import type { AgentRunSnapshot } from "../../agent/run-state.js";

function run(sequence: number, status: AgentRunSnapshot["status"]): AgentRunSnapshot {
  return {
    runId: "run-1",
    toolCallId: "call-1",
    agentType: "explore",
    task: "inspect",
    status,
    sequence,
    createdAt: 1,
    updatedAt: sequence,
  };
}

describe("AgentRunStore", () => {
  it("publishes immutable snapshots and resolves by host tool-call id", () => {
    const store = new AgentRunStore();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    expect(store.apply(run(1, "starting"))).toBe(true);
    expect(store.apply(run(2, "running"))).toBe(true);

    expect(notifications).toBe(2);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getByToolCallId("call-1")?.status).toBe("running");
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.get("run-1"))).toBe(true);
  });

  it("ignores duplicate and out-of-order state events", () => {
    const store = new AgentRunStore();
    store.apply(run(2, "running"));

    expect(store.apply(run(2, "failed"))).toBe(false);
    expect(store.apply(run(1, "starting"))).toBe(false);
    expect(store.get("run-1")?.status).toBe("running");
  });
});

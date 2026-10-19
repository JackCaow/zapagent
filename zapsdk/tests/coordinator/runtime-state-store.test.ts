import { describe, expect, it } from "bun:test";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { RuntimeAgentCoordinatorStateStore } from "../../coordinator/store.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { createRuntimeStateSnapshot } from "../../runtime/state-types.js";

describe("RuntimeAgentCoordinatorStateStore", () => {
  it("persists coordinator state beside other runtime recovery state", async () => {
    const runtimeStateStore = new InMemoryRuntimeStateStore();
    const base = createRuntimeStateSnapshot({
      threadId: "thread-runtime",
      workspaceRoot: "/workspace",
      now: 1_000,
    });
    base.approvals["approval-1"] = {
      approvalId: "approval-1",
      threadId: "thread-runtime",
      toolName: "Bash",
      argumentsHash: "hash",
      status: "pending",
      requestedAt: 1_001,
      updatedAt: 1_001,
    };
    await runtimeStateStore.update("thread-runtime", () => base);
    const coordinator = new AgentCoordinator({
      threadId: "thread-runtime",
      stateStore: new RuntimeAgentCoordinatorStateStore({
        threadId: "thread-runtime",
        workspaceRoot: "/workspace",
        runtimeStateStore,
      }),
      idFactory: () => "run-1",
      executor: { execute: async () => ({ success: true, text: "done" }) },
    });

    const run = await coordinator.spawn({ task: "inspect", agentType: "explore" });
    await expect(coordinator.wait(run.runId)).resolves.toMatchObject({ success: true });

    const stored = await runtimeStateStore.load("thread-runtime");
    expect(stored?.approvals["approval-1"]?.status).toBe("pending");
    expect(stored?.coordinator?.runs[run.runId]?.status).toBe("completed");
    expect(stored?.revision).toBeGreaterThan(1);
  });

  it("creates a runtime snapshot when coordinator is the first writer", async () => {
    const runtimeStateStore = new InMemoryRuntimeStateStore();
    const store = new RuntimeAgentCoordinatorStateStore({
      threadId: "thread-first",
      workspaceRoot: "/repo",
      runtimeStateStore,
      clock: () => 42,
    });
    await store.save({
      schemaVersion: 1,
      threadId: "thread-first",
      revision: 1,
      createdAt: 42,
      updatedAt: 42,
      runs: {},
      tasks: {},
      messages: [],
      results: {},
    });

    expect(await runtimeStateStore.load("thread-first")).toMatchObject({
      schemaVersion: 3,
      workspaceRoot: "/repo",
      coordinator: { revision: 1 },
    });
  });
});

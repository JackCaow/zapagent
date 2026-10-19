import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { recoverInterruptedRuntimeStates } from "../../runtime/state-tracker.js";
import {
  createRuntimeStateSnapshot,
  type RuntimeStateSnapshot,
} from "../../runtime/state-types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function activeState(threadId: string, now = 1_000): RuntimeStateSnapshot {
  const state = createRuntimeStateSnapshot({ threadId, workspaceRoot: "/workspace", now });
  state.owner = { instanceId: "dead-runtime", pid: 999_999, startedAt: now };
  state.thread.status = "running";
  state.thread.activeTurnId = "turn-1";
  state.turns["turn-1"] = {
    turnId: "turn-1",
    threadId,
    rootRunId: "run-root",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  state.runs["run-root"] = {
    runId: "run-root",
    threadId,
    turnId: "turn-1",
    agentType: "root",
    taskPreview: "test",
    status: "running",
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  return state;
}

describe("recoverInterruptedRuntimeStates", () => {
  it("fails interrupted model/tool execution and invalidates pending approval", async () => {
    const store = new InMemoryRuntimeStateStore();
    const state = activeState("thread-execution");
    state.toolRuns["tool-1"] = {
      toolRunId: "tool-1",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-root",
      toolName: "write_file",
      status: "waiting_approval",
      createdAt: 1_001,
      updatedAt: 1_001,
    };
    state.approvals["approval:tool-1"] = {
      approvalId: "approval:tool-1",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-root",
      toolRunId: "tool-1",
      toolName: "write_file",
      argumentsHash: "hash",
      status: "pending",
      requestedAt: 1_001,
      updatedAt: 1_001,
    };
    await store.update(state.threadId, () => state);

    const reports = await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
      isOwnerAlive: () => false,
    });
    const recovered = await store.load(state.threadId);

    expect(reports).toHaveLength(1);
    expect(recovered?.approvals["approval:tool-1"].status).toBe("interrupted");
    expect(recovered?.toolRuns["tool-1"].status).toBe("cancelled");
    expect(recovered?.runs["run-root"].status).toBe("failed");
    expect(recovered?.turns["turn-1"].status).toBe("failed");
    expect(recovered?.thread.status).toBe("idle");
    expect(recovered?.owner).toBeUndefined();
    expect(reports[0].actions.map((action) => action.entityType)).toEqual([
      "approval",
      "tool_run",
      "run",
      "turn",
    ]);
  });

  it("preserves a ready artifact workspace and blocks an interrupted merge", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "zap-recovery-workspace-"));
    tempDirs.push(workspacePath);
    const evidencePath = join(workspacePath, "artifact.txt");
    await writeFile(evidencePath, "preserve me\n", "utf8");
    const store = new InMemoryRuntimeStateStore();
    const state = activeState("thread-merge");
    state.runs["run-agent"] = {
      runId: "run-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      parentRunId: "run-root",
      agentType: "general",
      taskPreview: "edit",
      status: "merging",
      sequence: 4,
      createdAt: 1_010,
      updatedAt: 1_020,
      workspaceId: "ws-agent",
      artifactId: "artifact-agent",
    };
    state.workspaces["ws-agent"] = {
      workspaceId: "ws-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-agent",
      mode: "isolated-git",
      path: workspacePath,
      status: "active",
      acquiredAt: 1_010,
      updatedAt: 1_020,
    };
    state.artifacts["artifact-agent"] = {
      artifactId: "artifact-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-agent",
      workspaceId: "ws-agent",
      workspacePath,
      changedPaths: ["artifact.txt"],
      status: "merging",
      createdAt: 1_015,
      updatedAt: 1_020,
    };
    state.merges["merge-1"] = {
      mergeId: "merge-1",
      threadId: state.threadId,
      turnId: "turn-1",
      artifactIds: ["artifact-agent"],
      status: "running",
      createdAt: 1_020,
      updatedAt: 1_020,
    };
    await store.update(state.threadId, () => state);

    const reports = await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
      isOwnerAlive: () => false,
    });
    const recovered = await store.load(state.threadId);
    const firstRevision = recovered?.revision;

    expect(reports).toHaveLength(1);
    expect(recovered?.merges["merge-1"].status).toBe("interrupted");
    expect(recovered?.artifacts["artifact-agent"].status).toBe("blocked");
    expect(recovered?.runs["run-agent"].status).toBe("blocked");
    expect(recovered?.workspaces["ws-agent"].status).toBe("preserved");
    expect(await readFile(evidencePath, "utf8")).toBe("preserve me\n");

    expect(await recoverInterruptedRuntimeStates(store, {
      clock: () => 3_000,
      isOwnerAlive: () => false,
    })).toEqual([]);
    expect((await store.load(state.threadId))?.revision).toBe(firstRevision);
  });

  it("does not recover state owned by a live Runtime", async () => {
    const store = new InMemoryRuntimeStateStore();
    const state = activeState("thread-live");
    state.owner = { instanceId: "live-runtime", pid: process.pid, startedAt: 1_000 };
    await store.update(state.threadId, () => state);

    const reports = await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
    });

    expect(reports).toEqual([]);
    expect((await store.load(state.threadId))?.turns["turn-1"].status).toBe("running");
    expect((await store.load(state.threadId))?.revision).toBe(1);
  });

  it("clears a stale owner even when every entity was already terminal", async () => {
    const store = new InMemoryRuntimeStateStore();
    const state = createRuntimeStateSnapshot({
      threadId: "thread-stale-owner",
      workspaceRoot: "/workspace",
      now: 1_000,
    });
    state.owner = { instanceId: "dead-runtime", pid: 999_999, startedAt: 1_000 };
    await store.update(state.threadId, () => state);

    const reports = await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
      isOwnerAlive: () => false,
    });

    expect(reports).toEqual([]);
    expect((await store.load(state.threadId))?.owner).toBeUndefined();
  });

  it("closes shared leases without treating the root workspace as an orphan", async () => {
    const store = new InMemoryRuntimeStateStore();
    const state = activeState("thread-readonly");
    state.workspaces["shared:run-root"] = {
      workspaceId: "shared:run-root",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-root",
      mode: "shared-readonly",
      path: "/workspace",
      status: "active",
      acquiredAt: 1_000,
      updatedAt: 1_000,
    };
    await store.update(state.threadId, () => state);

    await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
      isOwnerAlive: () => false,
      pathExists: () => false,
    });

    expect((await store.load(state.threadId))?.workspaces["shared:run-root"].status).toBe("released");
  });

  it("blocks ready artifacts whose isolated workspace has already disappeared", async () => {
    const store = new InMemoryRuntimeStateStore();
    const state = activeState("thread-missing-artifact");
    state.runs["run-agent"] = {
      runId: "run-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      parentRunId: "run-root",
      agentType: "general",
      taskPreview: "edit",
      status: "ready_to_merge",
      sequence: 2,
      createdAt: 1_000,
      updatedAt: 1_010,
      workspaceId: "ws-agent",
      artifactId: "artifact-agent",
    };
    state.workspaces["ws-agent"] = {
      workspaceId: "ws-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-agent",
      mode: "isolated-git",
      path: "/missing/workspace",
      status: "active",
      acquiredAt: 1_000,
      updatedAt: 1_010,
    };
    state.artifacts["artifact-agent"] = {
      artifactId: "artifact-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-agent",
      workspaceId: "ws-agent",
      changedPaths: ["a.txt"],
      status: "ready",
      createdAt: 1_010,
      updatedAt: 1_010,
    };
    await store.update(state.threadId, () => state);

    const reports = await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
      isOwnerAlive: () => false,
      pathExists: () => false,
    });
    const recovered = await store.load(state.threadId);

    expect(recovered?.artifacts["artifact-agent"].status).toBe("blocked");
    expect(recovered?.workspaces["ws-agent"].status).toBe("orphaned");
    expect(reports[0].actions.some((action) => (
      action.disposition === "blocked"
      && action.entityType === "artifact"
      && action.entityId === "artifact-agent"
    ))).toBe(true);
  });

  it("reconciles an interrupted workspace cleanup from filesystem evidence", async () => {
    const existingPath = await mkdtemp(join(tmpdir(), "zap-releasing-present-"));
    tempDirs.push(existingPath);
    const store = new InMemoryRuntimeStateStore();
    const state = activeState("thread-releasing");
    state.workspaces["ws-present"] = {
      workspaceId: "ws-present",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-root",
      mode: "isolated-git",
      path: existingPath,
      status: "releasing",
      acquiredAt: 1_000,
      updatedAt: 1_010,
    };
    state.workspaces["ws-removed"] = {
      workspaceId: "ws-removed",
      threadId: state.threadId,
      turnId: "turn-1",
      runId: "run-root",
      mode: "isolated-git",
      path: join(existingPath, "already-removed"),
      status: "releasing",
      acquiredAt: 1_000,
      updatedAt: 1_010,
    };
    await store.update(state.threadId, () => state);

    await recoverInterruptedRuntimeStates(store, {
      clock: () => 2_000,
      isOwnerAlive: () => false,
    });
    const recovered = await store.load(state.threadId);

    expect(recovered?.workspaces["ws-present"].status).toBe("preserved");
    expect(recovered?.workspaces["ws-removed"].status).toBe("released");
  });
});

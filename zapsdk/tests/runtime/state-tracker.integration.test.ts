import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeCoordinator } from "../../merge/coordinator.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { createRuntimeStateSnapshot } from "../../runtime/state-types.js";
import { WorkspaceManager } from "../../workspace/manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("RuntimeStateTracker lifecycle integration", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("persists workspace, artifact and transactional merge state", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-state-lifecycle-"));
    cleanup.push(root);
    git(root, "init");
    writeFileSync(join(root, "a.txt"), "base\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");

    const stateStore = new InMemoryRuntimeStateStore();
    const state = createRuntimeStateSnapshot({
      threadId: "thread-lifecycle",
      workspaceRoot: root,
      now: 1_000,
    });
    state.thread.status = "running";
    state.thread.activeTurnId = "turn-1";
    state.turns["turn-1"] = {
      turnId: "turn-1",
      threadId: state.threadId,
      rootRunId: "run-root",
      status: "running",
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    state.runs["run-agent"] = {
      runId: "run-agent",
      threadId: state.threadId,
      turnId: "turn-1",
      parentRunId: "run-root",
      agentType: "general",
      taskPreview: "edit a.txt",
      status: "running",
      sequence: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    await stateStore.update(state.threadId, () => state);
    const tracker = new RuntimeStateTracker({
      threadId: state.threadId,
      workspaceRoot: root,
      store: stateStore,
    });
    const manager = new WorkspaceManager({
      root,
      onLifecycle: (event) => tracker.recordWorkspaceEvent(event),
    });
    const coordinator = new MergeCoordinator(manager, {
      onLifecycle: (event) => tracker.recordMergeEvent(event),
    });

    const lease = await manager.acquire("run-agent", true);
    writeFileSync(join(lease.path, "a.txt"), "agent edit\n");
    const artifact = await manager.finalize(lease);
    const result = await coordinator.merge([artifact!.artifactId]);
    await manager.cleanup();
    await tracker.flush();

    expect(result.success).toBe(true);
    const persisted = await stateStore.load(state.threadId);
    expect(persisted?.workspaces[lease.workspaceId].status).toBe("released");
    expect(persisted?.artifacts[artifact!.artifactId]).toMatchObject({
      status: "merged",
      changedPaths: ["a.txt"],
      resultOid: artifact!.resultOid,
    });
    expect(Object.values(persisted?.merges ?? {})).toHaveLength(1);
    expect(Object.values(persisted?.merges ?? {})[0]).toMatchObject({
      status: "completed",
      artifactIds: [artifact!.artifactId],
      changedPaths: ["a.txt"],
    });
  });
});

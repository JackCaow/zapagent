import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRecoveryController } from "../../runtime/recovery-controller.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { WorkspaceManager } from "../../workspace/manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("RuntimeRecoveryController", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function repo(): string {
    const path = mkdtempSync(join(tmpdir(), "zap-recovery-controller-"));
    cleanup.push(path);
    git(path, "init");
    writeFileSync(join(path, "file.txt"), "base\n");
    git(path, "add", "file.txt");
    git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    return path;
  }

  it("resumes a preserved artifact merge and explicitly cleans its batch", async () => {
    const root = repo();
    const store = new InMemoryRuntimeStateStore();
    const tracker = new RuntimeStateTracker({
      threadId: "thread-recovery",
      workspaceRoot: root,
      store,
      instanceId: "runtime-before",
      pid: process.pid,
    });
    await tracker.acquireOwnership();
    const manager = new WorkspaceManager({
      root,
      owner: { threadId: "thread-recovery", instanceId: "runtime-before", pid: process.pid },
      onLifecycle: (event) => tracker.recordWorkspaceEvent(event),
    });
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "file.txt"), "recovered\n");
    const artifact = await manager.finalize(lease);
    await tracker.flush();
    const now = Date.now();
    await store.update("thread-recovery", (state) => {
      if (!state || !artifact) return state ?? null;
      state.coordinator = {
        schemaVersion: 1,
        threadId: "thread-recovery",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        runs: {
          [artifact.runId]: {
            runId: artifact.runId,
            agentType: "general",
            task: "recover merge",
            status: "ready_to_merge",
            sequence: 3,
            createdAt: now,
            updatedAt: now,
            success: true,
            workspaceId: artifact.workspaceId,
            artifactId: artifact.artifactId,
          },
        },
        tasks: {
          [artifact.runId]: {
            runId: artifact.runId,
            dependencies: [],
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
        },
        messages: [],
        results: {
          [artifact.runId]: {
            runId: artifact.runId,
            success: true,
            text: "changed",
            workspaceId: artifact.workspaceId,
            artifactId: artifact.artifactId,
            changedPaths: artifact.changedPaths,
          },
        },
      };
      return state;
    });
    await tracker.releaseOwnership();

    const controller = new RuntimeRecoveryController({
      threadId: "thread-recovery",
      workspaceRoot: root,
      store,
    });
    const merged = await controller.resumeMerge({ artifactIds: [artifact!.artifactId] });

    expect(merged.success).toBe(true);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("recovered\n");
    const recovered = await controller.inspect();
    expect(recovered?.artifacts[artifact!.artifactId].status).toBe("merged");
    expect(recovered?.coordinator?.runs[artifact!.runId]).toMatchObject({
      status: "completed",
      success: true,
    });
    expect(recovered?.coordinator?.tasks[artifact!.runId].status).toBe("succeeded");
    expect(recovered?.coordinator?.results[artifact!.runId]).toMatchObject({
      success: true,
      text: "changed",
    });
    expect((await controller.inspect())?.workspaces[lease.workspaceId].status).toBe("preserved");
    await expect(controller.cleanupBatch({ batchPath: lease.batchPath!, confirm: false }))
      .rejects.toThrow("explicit confirmation");

    await controller.cleanupBatch({ batchPath: lease.batchPath!, confirm: true });
    expect(existsSync(lease.batchPath!)).toBe(false);
    expect((await controller.inspect())?.workspaces[lease.workspaceId].status).toBe("released");
  });

  it("rejects incomplete artifact metadata without touching the root", async () => {
    const root = repo();
    const store = new InMemoryRuntimeStateStore();
    const tracker = new RuntimeStateTracker({
      threadId: "thread-invalid",
      workspaceRoot: root,
      store,
    });
    await tracker.recordWorkspaceEvent({
      type: "workspace_acquired",
      lease: {
        workspaceId: "ws-invalid",
        runId: "run-invalid",
        mode: "isolated-git",
        path: root,
        repoPath: root,
        baseOid: git(root, "rev-parse", "HEAD").trim(),
        batchPath: join(root, "missing-batch"),
      },
      timestamp: Date.now(),
    });
    await store.update("thread-invalid", (state) => {
      if (!state) return null;
      state.workspaces["ws-invalid"].status = "preserved";
      state.artifacts["artifact-invalid"] = {
        artifactId: "artifact-invalid",
        threadId: "thread-invalid",
        runId: "run-invalid",
        workspaceId: "ws-invalid",
        changedPaths: ["file.txt"],
        status: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return state;
    });
    const controller = new RuntimeRecoveryController({
      threadId: "thread-invalid",
      workspaceRoot: root,
      store,
    });

    await expect(controller.resumeMerge({ artifactIds: ["artifact-invalid"] }))
      .rejects.toThrow("missing frozen workspace metadata");
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("base\n");
  });
});

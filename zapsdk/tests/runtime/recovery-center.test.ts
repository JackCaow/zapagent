import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRecoveryCenter } from "../../runtime/recovery-center.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { WorkspaceManager } from "../../workspace/manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("ProjectRecoveryCenter", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test("discovers prior-thread artifacts and drives merge then explicit cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-recovery-center-"));
    cleanup.push(root);
    git(root, "init");
    writeFileSync(join(root, "file.txt"), "base\n");
    git(root, "add", "file.txt");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    const store = new InMemoryRuntimeStateStore();
    const tracker = new RuntimeStateTracker({
      threadId: "prior-thread",
      workspaceRoot: root,
      store,
      instanceId: "prior-runtime",
    });
    await tracker.acquireOwnership();
    const manager = new WorkspaceManager({
      root,
      owner: { threadId: "prior-thread", instanceId: "prior-runtime", pid: process.pid },
      onLifecycle: (event) => tracker.recordWorkspaceEvent(event),
    });
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "file.txt"), "recovered\n");
    const artifact = await manager.finalize(lease);
    await tracker.flush();
    await tracker.releaseOwnership();
    const center = new ProjectRecoveryCenter({ workspaceRoot: root, store });

    const before = await center.refresh();

    expect(before.entries.some((entry) => (
      entry.action === "merge" && entry.artifactIds?.includes(artifact!.artifactId)
    ))).toBe(true);
    expect(before.entries.some((entry) => (
      entry.action === "cleanup" && entry.batchPath === lease.batchPath
    ))).toBe(true);

    const merged = await center.resumeMerge("prior-thread", [artifact!.artifactId]);
    expect(merged.success).toBe(true);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("recovered\n");

    await expect(center.cleanupBatch("prior-thread", lease.batchPath!, false))
      .rejects.toThrow("explicit confirmation");
    await center.cleanupBatch("prior-thread", lease.batchPath!, true);
    expect(existsSync(lease.batchPath!)).toBe(false);

    const after = await center.refresh();
    expect(after.entries.some((entry) => entry.action === "merge")).toBe(false);
    expect(after.entries.some((entry) => entry.action === "cleanup")).toBe(false);
  });

  test("supports an empty recovery inventory outside a Git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-recovery-nongit-"));
    cleanup.push(root);
    const center = new ProjectRecoveryCenter({
      workspaceRoot: root,
      store: new InMemoryRuntimeStateStore(),
    });

    const snapshot = await center.refresh();

    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.retention.tempRoot).not.toBe("unavailable");
    expect(snapshot.retention.skipped).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceManager } from "../../workspace/manager.js";
import { MergeCoordinator } from "../../merge/coordinator.js";
import { RuntimeRecoveryController } from "../../runtime/recovery-controller.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { COPY_MERGE_JOURNAL, operationOid, recoverCopyMerge, writeCopyMergeJournal, type CopyMergeJournal } from "../../merge/copy-transaction.js";
import { WorkspaceRetentionManager } from "../../workspace/retention.js";
import { removeOwnedCopyTree } from "../../workspace/copy.js";

describe("non-Git writing workspaces", () => {
  const roots: string[] = [];
  const managers: WorkspaceManager[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.cleanup();
    for (const root of roots.splice(0)) await removeOwnedCopyTree(root);
  });
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "zap-copy-test-"));
    roots.push(root);
    writeFileSync(join(root, "a"), "base-a");
    writeFileSync(join(root, "b"), "base-b");
    const manager = new WorkspaceManager({ root });
    managers.push(manager);
    return { root, manager };
  }

  it("excludes Python environments from source snapshots and artifacts while preserving the parent's environment", async () => {
    const { root, manager } = setup();
    const makeEnvironment = (base: string) => {
      mkdirSync(join(base, "bin"), { recursive: true });
      writeFileSync(join(base, "pyvenv.cfg"), "home = /host/python\n");
      symlinkSync(process.execPath, join(base, "bin", "python"));
    };
    makeEnvironment(join(root, ".venv"));
    const lease = await manager.acquire("venv", true);
    expect(existsSync(join(lease.path, ".venv"))).toBe(false);
    makeEnvironment(join(lease.path, "custom-env"));
    writeFileSync(join(lease.path, "requirements.txt"), "packaging==24.2\n");
    const artifact = (await manager.finalize(lease))!;
    expect(artifact.changedPaths).toEqual(["requirements.txt"]);
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
    expect(existsSync(join(root, ".venv", "bin", "python"))).toBe(true);
    expect(existsSync(join(lease.path, "custom-env", "bin", "python"))).toBe(true);
    expect(existsSync(join(root, "custom-env"))).toBe(false);
  });

  it("retries initialization after concurrent failures without retaining partial batches", async () => {
    const { root, manager } = setup();
    symlinkSync(process.execPath, join(root, "unsafe"));
    const failed = await Promise.allSettled([manager.acquire("first", true), manager.acquire("second", true)]);
    expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
    rmSync(join(root, "unsafe"));
    const lease = await manager.acquire("retry", true);
    expect(readFileSync(join(lease.path, "a"), "utf8")).toBe("base-a");
    expect(readdirSync(resolve(lease.batchPath!, "..")).filter(name => name.startsWith("batch-"))).toHaveLength(1);
  });

  it("does not delete an excluded --copies environment when merging a parent directory deletion", async () => {
    const { root, manager } = setup();
    mkdirSync(join(root, "project", ".venv"), { recursive: true });
    writeFileSync(join(root, "project", ".venv", "pyvenv.cfg"), "home = python\n");
    writeFileSync(join(root, "project", "main.py"), "pass\n");
    const lease = await manager.acquire("delete", true);
    rmSync(join(lease.path, "project"), { recursive: true });
    const artifact = (await manager.finalize(lease))!;
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(false);
    expect(existsSync(join(root, "project", ".venv", "pyvenv.cfg"))).toBe(true);
    expect(existsSync(join(root, "project", "main.py"))).toBe(true);
  });

  it("does not let a symlink masquerade as a virtual environment marker", async () => {
    const { root, manager } = setup();
    mkdirSync(join(root, "fake-env"));
    symlinkSync(process.execPath, join(root, "fake-env", "pyvenv.cfg"));
    await expect(manager.acquire("unsafe-marker", true)).rejects.toThrow("copy workspace");
  });

  it("isolates siblings and merges frozen binary, deletion, directory and executable edits", async () => {
    const { root, manager } = setup();
    writeFileSync(join(root, ".env"), "private");
    const first = await manager.acquire("first", true);
    const second = await manager.acquire("second", true);
    expect(first.mode).toBe("isolated-copy");
    expect(existsSync(join(first.path, ".env"))).toBe(false);
    const bytes = Buffer.from([0, 255, 1, 128]);
    writeFileSync(join(first.path, "a"), bytes);
    chmodSync(join(first.path, "a"), 0o755);
    rmSync(join(second.path, "b"));
    mkdirSync(join(second.path, "empty"));
    mkdirSync(join(second.path, "dir"));
    writeFileSync(join(second.path, "dir", "new"), "new file");
    expect(readFileSync(join(second.path, "a"), "utf8")).toBe("base-a");
    expect(readFileSync(join(root, "a"), "utf8")).toBe("base-a");
    const a = (await manager.finalize(first))!;
    const b = (await manager.finalize(second))!;
    writeFileSync(join(first.path, "a"), "changed after finalization");
    const tracked: string[] = [];
    const result = await new MergeCoordinator(manager, { onTrackEdit: async (paths) => { tracked.push(...paths); } })
      .merge([a.artifactId, b.artifactId]);
    expect(result.success).toBe(true);
    expect(readFileSync(join(root, "a"))).toEqual(bytes);
    if (process.platform !== "win32") expect(statSync(join(root, "a")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(root, "b"))).toBe(false);
    expect(statSync(join(root, "empty")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "dir", "new"), "utf8")).toBe("new file");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("private");
    expect(tracked).toContain(join(manager.rootRepoPath(), "a"));
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith(".zap-copy-merge-"))).toBe(false);
  });

  it("composes sibling additions to the same new directory", async () => {
    const { root, manager } = setup();
    const ids: string[] = [];
    for (const name of ["first", "second"]) {
      const lease = await manager.acquire(name, true);
      mkdirSync(join(lease.path, "new"));
      writeFileSync(join(lease.path, "new", name), name);
      ids.push((await manager.finalize(lease))!.artifactId);
    }
    expect((await new MergeCoordinator(manager).merge(ids)).success).toBe(true);
    expect(readdirSync(join(root, "new")).sort()).toEqual(["first", "second"]);
  });

  it("accepts a complete subtree deletion and directory-to-file replacement within one artifact", async () => {
    const { root, manager } = setup();
    for (const name of ["replace", "remove"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "child"), "before");
    }
    const lease = await manager.acquire("writer", true);
    rmSync(join(lease.path, "replace"), { recursive: true });
    rmSync(join(lease.path, "remove"), { recursive: true });
    writeFileSync(join(lease.path, "replace"), "now a file");
    const artifact = (await manager.finalize(lease))!;
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
    expect(readFileSync(join(root, "replace"), "utf8")).toBe("now a file");
    expect(existsSync(join(root, "remove"))).toBe(false);
  });

  it("accepts identical sibling subtree deletions but rejects deletion versus child edit", async () => {
    const { root, manager } = setup();
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "file"), "before");
    const artifacts: string[] = [];
    for (const name of ["first", "second", "third"]) {
      const lease = await manager.acquire(name, true);
      if (name === "third") writeFileSync(join(lease.path, "dir", "file"), "competing edit");
      else rmSync(join(lease.path, "dir"), { recursive: true });
      artifacts.push((await manager.finalize(lease))!.artifactId);
    }
    const coordinator = new MergeCoordinator(manager);
    expect((await coordinator.merge([artifacts[0], artifacts[2]])).success).toBe(false);
    expect(readFileSync(join(root, "dir", "file"), "utf8")).toBe("before");
    expect((await coordinator.merge(artifacts.slice(0, 2))).success).toBe(true);
    expect(existsSync(join(root, "dir"))).toBe(false);
  });

  it("treats prototype-like filenames as file data during creation and deletion", async () => {
    const { root, manager } = setup();
    writeFileSync(join(root, "constructor"), "remove me");
    const lease = await manager.acquire("writer", true);
    rmSync(join(lease.path, "constructor"));
    writeFileSync(join(lease.path, "__proto__"), "created");
    writeFileSync(join(lease.path, "toString"), "also created");
    const artifact = (await manager.finalize(lease))!;
    const result = await new MergeCoordinator(manager).merge([artifact.artifactId]);
    expect(result.success).toBe(true);
    expect(result.changedPaths).toEqual(["__proto__", "constructor", "toString"]);
    expect(readFileSync(join(root, "__proto__"), "utf8")).toBe("created");
    expect(readFileSync(join(root, "toString"), "utf8")).toBe("also created");
    expect(existsSync(join(root, "constructor"))).toBe(false);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("base-a");
  });

  for (const beforeMode of [0o755, 0o555]) {
    it(`installs file changes before restoring read-only directory permissions (${beforeMode.toString(8)})`, async () => {
      if (process.platform === "win32") return;
      const { root, manager } = setup();
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "dir", "file"), "before");
      chmodSync(join(root, "dir"), beforeMode);
      const lease = await manager.acquire("writer", true);
      chmodSync(join(lease.path, "dir"), 0o755);
      writeFileSync(join(lease.path, "dir", "file"), "after");
      chmodSync(join(lease.path, "dir"), 0o555);
      const artifact = (await manager.finalize(lease))!;
      const result = await new MergeCoordinator(manager).merge([artifact.artifactId]);
      expect(result.success).toBe(true);
      expect(readFileSync(join(root, "dir", "file"), "utf8")).toBe("after");
      expect(statSync(join(root, "dir")).mode & 0o777).toBe(0o555);
      await manager.cleanup();
      expect(existsSync(lease.batchPath!)).toBe(false);
    });
  }

  it("cleans unreadable owned directories without following links into external directories", async () => {
    if (process.platform === "win32") return;
    const { root, manager } = setup();
    const lease = await manager.acquire("writer", true);
    mkdirSync(join(lease.path, "locked"));
    writeFileSync(join(lease.path, "locked", "file"), "discard");
    chmodSync(join(lease.path, "locked"), 0);
    symlinkSync(root, join(lease.path, "external"));
    await manager.cleanup();
    expect(existsSync(lease.batchPath!)).toBe(false);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("base-a");
  });

  it("moves read-only directory results and backups across parents without losing their final modes", async () => {
    if (process.platform === "win32") return;
    const { root, manager } = setup();
    mkdirSync(join(root, "replace"));
    writeFileSync(join(root, "replace", "old"), "original");
    chmodSync(join(root, "replace"), 0o555);
    const lease = await manager.acquire("writer", true);
    await removeOwnedCopyTree(join(lease.path, "replace"));
    writeFileSync(join(lease.path, "replace"), "replacement file");
    mkdirSync(join(lease.path, "new"));
    writeFileSync(join(lease.path, "new", "child"), "new content");
    chmodSync(join(lease.path, "new"), 0o555);
    const artifact = (await manager.finalize(lease))!;
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
    expect(readFileSync(join(root, "replace"), "utf8")).toBe("replacement file");
    expect(readFileSync(join(root, "new", "child"), "utf8")).toBe("new content");
    expect(statSync(join(root, "new")).mode & 0o777).toBe(0o555);
    await manager.cleanup();
    expect(existsSync(lease.batchPath!)).toBe(false);
  });

  it("rejects competing siblings without applying an earlier nonconflicting edit", async () => {
    const { root, manager } = setup();
    const ids: string[] = [];
    for (const name of ["first", "second"]) {
      const lease = await manager.acquire(name, true);
      writeFileSync(join(lease.path, "a"), name);
      if (name === "first") writeFileSync(join(lease.path, "b"), name);
      ids.push((await manager.finalize(lease))!.artifactId);
    }
    const result = await new MergeCoordinator(manager).merge(ids);
    expect(result.success).toBe(false);
    expect(result.conflicts).toContain("a");
    expect(readFileSync(join(root, "a"), "utf8")).toBe("base-a");
    expect(readFileSync(join(root, "b"), "utf8")).toBe("base-b");
  });

  it("rechecks root drift after the tracking callback", async () => {
    const { root, manager } = setup();
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "a"), "agent");
    const artifact = (await manager.finalize(lease))!;
    const result = await new MergeCoordinator(manager, {
      onTrackEdit: async () => { writeFileSync(join(root, "a"), "user"); },
    }).merge([artifact.artifactId]);
    expect(result.success).toBe(false);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("user");
  });

  it("rejects directory removal when the root acquired a new child", async () => {
    const { root, manager } = setup();
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "base"), "base");
    const lease = await manager.acquire("writer", true);
    rmSync(join(lease.path, "dir"), { recursive: true });
    const artifact = (await manager.finalize(lease))!;
    writeFileSync(join(root, "dir", "user"), "keep");
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(false);
    expect(readFileSync(join(root, "dir", "user"), "utf8")).toBe("keep");
  });

  it("does not delete excluded secrets inside a removed directory", async () => {
    const { root, manager } = setup();
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", ".env"), "keep");
    const lease = await manager.acquire("writer", true);
    rmSync(join(lease.path, "dir"), { recursive: true });
    const artifact = (await manager.finalize(lease))!;
    await expect(new MergeCoordinator(manager).merge([artifact.artifactId])).rejects.toThrow("Unsafe copy workspace path");
    expect(readFileSync(join(root, "dir", ".env"), "utf8")).toBe("keep");
  });

  it("validates frozen content and does not trust caller-mutated artifact metadata", async () => {
    const { root, manager } = setup();
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "a"), "agent");
    const artifact = (await manager.finalize(lease))!;
    artifact.changedPaths.push("../outside");
    expect(manager.getArtifact(artifact.artifactId)!.changedPaths).toEqual(["a"]);
    writeFileSync(join(manager.copyArtifactPath(artifact), "a"), "tampered");
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(false);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("base-a");
  });

  it("supports safe internal symlinks and rejects escape links", async () => {
    if (process.platform === "win32") return;
    const { root, manager } = setup();
    symlinkSync("a", join(root, "link"));
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "a"), "agent");
    const artifact = (await manager.finalize(lease))!;
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
    expect(readFileSync(join(root, "link"), "utf8")).toBe("agent");
    symlinkSync(root, join(lease.path, "escape"));
    await expect(manager.finalize(lease)).rejects.toThrow("Symlink escapes");
  });

  it("supports missing Git without changing the caller PATH or root repository", () => {
    const { root } = setup();
    const script = `import {WorkspaceManager} from ${JSON.stringify(resolve("zapsdk/workspace/manager.ts"))};
      const manager = new WorkspaceManager({root:process.argv[1]});
      try { console.log((await manager.acquire("no-git",true)).mode); } finally {await manager.cleanup();}`;
    const output = execFileSync(process.execPath, ["-e", script, root], {
      env: { ...process.env, PATH: root }, encoding: "utf8", timeout: 15_000,
    });
    expect(output.trim()).toBe("isolated-copy");
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  it("recovers persisted copy artifacts through the host controller and cleans the batch", async () => {
    const { root } = setup();
    const store = new InMemoryRuntimeStateStore();
    const threadId = "copy-recovery";
    const tracker = new RuntimeStateTracker({ threadId, workspaceRoot: root, store });
    await tracker.acquireOwnership();
    const manager = new WorkspaceManager({ root,
      owner: { threadId, instanceId: "before", pid: process.pid },
      onLifecycle: (event) => tracker.recordWorkspaceEvent(event),
    });
    managers.push(manager);
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "a"), "recovered");
    const artifact = (await manager.finalize(lease))!;
    await tracker.releaseOwnership();
    const controller = new RuntimeRecoveryController({ threadId, workspaceRoot: root, store });
    expect((await controller.resumeMerge({ artifactIds: [artifact.artifactId] })).success).toBe(true);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("recovered");
    expect((await controller.inspect())!.artifacts[artifact.artifactId].mode).toBe("isolated-copy");
    await controller.cleanupBatch({ batchPath: lease.batchPath!, confirm: true });
    expect(existsSync(lease.batchPath!)).toBe(false);
  });

  it("rejects in-tree temp roots before snapshot recursion", async () => {
    const { root } = setup();
    const manager = new WorkspaceManager({ root, tempRoot: join(root, "workspaces") });
    managers.push(manager);
    await expect(manager.acquire("writer", true)).rejects.toThrow("outside the source");
    expect(existsSync(join(root, "workspaces"))).toBe(false);
  });

  async function interruptedMerge(state: "applying" | "committed" = "applying") {
    const { root, manager } = setup();
    const lease = await manager.acquire("writer", true);
    writeFileSync(join(lease.path, "a"), "agent");
    const artifact = (await manager.finalize(lease))!;
    const realRoot = manager.rootRepoPath();
    const transaction = join(realRoot, `.zap-copy-merge-${randomUUID()}`);
    mkdirSync(transaction);
    const journal: CopyMergeJournal = { version: 1, root: realRoot, transaction, artifactIds: [artifact.artifactId], state,
      operations: [{ path: "a", modeOnly: false, before: await operationOid(join(realRoot, "a"), false),
        after: await operationOid(join(manager.copyArtifactPath(artifact), "a"), false) }] };
    await writeCopyMergeJournal(lease.batchPath!, journal);
    renameSync(join(realRoot, "a"), join(transaction, "old-0"));
    cpSync(join(manager.copyArtifactPath(artifact), "a"), join(realRoot, "a"));
    return { root, manager, lease, artifact, transaction, journal };
  }

  it("rolls back an interrupted install and retries the merge through a hydrated manager", async () => {
    const { root, manager, lease, artifact, transaction } = await interruptedMerge();
    await expect(manager.cleanup()).rejects.toThrow("recovery is pending");
    const restored = new WorkspaceManager({ root });
    managers.push(restored);
    await restored.hydrate({ leases: [lease], artifacts: [artifact] });
    expect((await new MergeCoordinator(restored).merge([artifact.artifactId])).success).toBe(true);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("agent");
    expect(existsSync(transaction)).toBe(false);
    expect(existsSync(join(lease.batchPath!, COPY_MERGE_JOURNAL))).toBe(false);
  });

  it("preserves both user changes and originals when interrupted recovery has a conflict", async () => {
    const { root, manager, lease, artifact, transaction } = await interruptedMerge();
    writeFileSync(join(root, "a"), "user after interruption");
    await expect(new MergeCoordinator(manager).merge([artifact.artifactId])).rejects.toThrow("conflicting recovery evidence");
    expect(readFileSync(join(root, "a"), "utf8")).toBe("user after interruption");
    expect(readFileSync(join(transaction, "old-0"), "utf8")).toBe("base-a");
    // Resolve the conflict for fixture cleanup; production must retain it.
    writeFileSync(join(root, "a"), "agent");
    await recoverCopyMerge(manager.rootRepoPath(), lease.batchPath!);
  });

  it("recovers the window after backup rename but before result installation", async () => {
    const { root, manager, lease, transaction } = await interruptedMerge();
    rmSync(join(root, "a"));
    await recoverCopyMerge(manager.rootRepoPath(), lease.batchPath!);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("base-a");
    expect(existsSync(transaction)).toBe(false);
  });

  it("finishes cleanup of a durably committed merge without undoing it", async () => {
    const { root, manager, lease, artifact, transaction } = await interruptedMerge("committed");
    expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("agent");
    expect(existsSync(transaction)).toBe(false);
    expect(existsSync(join(lease.batchPath!, COPY_MERGE_JOURNAL))).toBe(false);
  });

  it("retention protects a dead owner's interrupted merge even at zero quota", async () => {
    const { root, manager, lease } = await interruptedMerge();
    const report = await new WorkspaceRetentionManager({ workspaceRoot: root,
      policy: { ttlMs: 0, maxBatches: 0, maxBytes: 0 }, isProcessAlive: () => false,
    }).sweep();
    expect(report.removed).toEqual([]);
    expect(report.batches.find((batch) => batch.path === lease.batchPath)?.protected).toBe(true);
    await recoverCopyMerge(manager.rootRepoPath(), lease.batchPath!);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../workspace/manager.js";
import { WORKSPACE_BATCH_MARKER_FILE } from "../../workspace/marker.js";
import { MergeCoordinator } from "../../merge/coordinator.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("isolated Agent workspace merge", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function repo(): string {
    const path = mkdtempSync(join(tmpdir(), "zap-workspace-test-"));
    cleanup.push(path);
    git(path, "init");
    writeFileSync(join(path, "a.txt"), "base-a\n");
    writeFileSync(join(path, "b.txt"), "base-b\n");
    git(path, "add", "-A");
    git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    return path;
  }

  for (const format of ["staged", "committed", "version4", "split"]) {
    it(`preserves explicitly tracked ignored files (${format}) without collecting ignored neighbors`, async () => {
      const root = repo();
      writeFileSync(join(root, ".gitignore"), "*.generated\n");
      git(root, "add", ".gitignore");
      git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ignore generated files");
      const manager = new WorkspaceManager({ root });
      try {
        const lease = await manager.acquire(format, true);
        const names = ["space name.generated", ...(process.platform === "win32" ? [] : [":(glob)literal.generated", "line\nbreak.generated"])];
        for (const name of [...names, "noise.generated"]) writeFileSync(join(lease.path, name), `content of ${name}\n`);
        git(lease.path, "--literal-pathspecs", "add", "-f", "--", ...names);
        if (format === "committed") git(lease.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "explicit generated files");
        if (format === "version4") git(lease.path, "update-index", "--index-version", "4");
        if (format === "split") git(lease.path, "update-index", "--split-index");
        const artifact = (await manager.finalize(lease))!;
        expect(artifact.changedPaths.sort()).toEqual([...names].sort());
        expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
        for (const name of names) expect(readFileSync(join(root, name), "utf8")).toBe(`content of ${name}\n`);
        expect(existsSync(join(root, "noise.generated"))).toBe(false);
      } finally { await manager.cleanup(); }
    });
  }

  it("honors removal of tracking for an ignored baseline file", async () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), "a.txt\n");
    git(root, "add", ".gitignore");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ignore tracked fixture");
    const manager = new WorkspaceManager({ root });
    try {
      const lease = await manager.acquire("untrack", true);
      git(lease.path, "rm", "--cached", "a.txt");
      const artifact = (await manager.finalize(lease))!;
      expect(artifact.changedPaths).toEqual(["a.txt"]);
      expect(git(artifact.repoPath!, "ls-tree", "HEAD", "a.txt")).toBe("");
      expect(readFileSync(join(lease.path, "a.txt"), "utf8")).toBe("base-a\n");
    } finally { await manager.cleanup(); }
  });

  it("preserves an unchanged uninitialized submodule from the trusted baseline", async () => {
    const root = repo();
    const oid = git(root, "rev-parse", "HEAD").trim();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${oid},vendor`);
    mkdirSync(join(root, "vendor"));
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "submodule fixture");
    const manager = new WorkspaceManager({ root });
    try {
      const lease = await manager.acquire("uninitialized-submodule", true);
      const artifact = (await manager.finalize(lease))!;
      expect(artifact.changedPaths).toEqual([]);
      expect(git(artifact.repoPath!, "ls-tree", "HEAD", "vendor")).toBe(`160000 commit ${oid}\tvendor\n`);
      expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
      expect(git(root, "ls-files", "--stage", "vendor")).toContain(`160000 ${oid}`);
    } finally { await manager.cleanup(); }
  });

  it("respects ignored neighbors when a tracked file is replaced by a directory", async () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), ".env\n*.generated\n");
    git(root, "add", ".gitignore");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ignore local files");
    const manager = new WorkspaceManager({ root });
    try {
      const lease = await manager.acquire("directory-replacement", true);
      rmSync(join(lease.path, "a.txt"));
      mkdirSync(join(lease.path, "a.txt"));
      for (const name of ["source.txt", ".env", "noise.generated"]) {
        writeFileSync(join(lease.path, "a.txt", name), `fixture ${name}\n`);
      }
      const artifact = (await manager.finalize(lease))!;
      expect(artifact.changedPaths.sort()).toEqual(["a.txt", "a.txt/source.txt"]);
      expect(git(artifact.repoPath!, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("noise.generated");
      expect(git(artifact.repoPath!, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".env");
    } finally { await manager.cleanup(); }
  });

  it("captures dirty root state and atomically merges non-conflicting artifacts", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "dirty root snapshot\n");
    const manager = new WorkspaceManager({ root });
    const first = await manager.acquire("first", true);
    const second = await manager.acquire("second", true);
    expect(readFileSync(join(first.path, "a.txt"), "utf8")).toBe("dirty root snapshot\n");

    writeFileSync(join(first.path, "a.txt"), "agent a\n");
    writeFileSync(join(second.path, "b.txt"), "agent b\n");
    const artifactA = await manager.finalize(first);
    const artifactB = await manager.finalize(second);
    const merged = await new MergeCoordinator(manager).merge([
      artifactA!.artifactId,
      artifactB!.artifactId,
    ]);

    expect(merged.success).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("agent a\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("agent b\n");
    await manager.cleanup();
  });

  it("leaves the root untouched when artifacts conflict", async () => {
    const root = repo();
    const manager = new WorkspaceManager({ root });
    const first = await manager.acquire("first", true);
    const second = await manager.acquire("second", true);
    writeFileSync(join(first.path, "a.txt"), "first\n");
    writeFileSync(join(second.path, "a.txt"), "second\n");
    const artifactA = await manager.finalize(first);
    const artifactB = await manager.finalize(second);

    const merged = await new MergeCoordinator(manager).merge([
      artifactA!.artifactId,
      artifactB!.artifactId,
    ]);
    expect(merged.success).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("base-a\n");
    await manager.cleanup();
  });

  it("blocks stale artifacts when the root drifts", async () => {
    const root = repo();
    const manager = new WorkspaceManager({ root });
    const lease = await manager.acquire("first", true);
    writeFileSync(join(lease.path, "a.txt"), "agent\n");
    const artifact = await manager.finalize(lease);
    writeFileSync(join(root, "a.txt"), "user changed while agent ran\n");

    const merged = await new MergeCoordinator(manager).merge([artifact!.artifactId]);
    expect(merged.success).toBe(false);
    expect(merged.conflicts).toEqual(["a.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("user changed while agent ran\n");
    await manager.cleanup();
  });

  it("does not misreport a completed root patch as merge_failed when terminal persistence fails", async () => {
    const root = repo();
    const manager = new WorkspaceManager({ root });
    const lease = await manager.acquire("first", true);
    writeFileSync(join(lease.path, "a.txt"), "agent\n");
    const artifact = await manager.finalize(lease);
    const lifecycle: string[] = [];
    const coordinator = new MergeCoordinator(manager, {
      onLifecycle: (event) => {
        lifecycle.push(event.type);
        if (event.type === "merge_completed") throw new Error("state disk unavailable");
      },
    });

    await expect(coordinator.merge([artifact!.artifactId])).rejects.toThrow("state disk unavailable");

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("agent\n");
    expect(lifecycle).toEqual(["merge_started", "merge_completed"]);
    await manager.cleanup();
  });

  it("hydrates a preserved batch and resumes its merge after a runtime restart", async () => {
    const root = repo();
    const firstRuntime = new WorkspaceManager({
      root,
      owner: { threadId: "thread-recovery", instanceId: "runtime-before", pid: 999_999 },
    });
    const lease = await firstRuntime.acquire("writer", true);
    writeFileSync(join(lease.path, "a.txt"), "recovered agent edit\n");
    const artifact = await firstRuntime.finalize(lease);
    expect(artifact).not.toBeNull();
    expect(lease.batchPath).toBeDefined();
    expect(statSync(join(lease.batchPath!, WORKSPACE_BATCH_MARKER_FILE)).mode & 0o777).toBe(0o600);

    const recoveredRuntime = new WorkspaceManager({
      root,
      owner: { threadId: "thread-recovery", instanceId: "runtime-after", pid: process.pid },
    });
    await recoveredRuntime.hydrate({ leases: [lease], artifacts: [artifact!] });
    const merged = await new MergeCoordinator(recoveredRuntime).merge([artifact!.artifactId]);

    expect(merged.success).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("recovered agent edit\n");
    await recoveredRuntime.cleanup();
    expect(existsSync(lease.batchPath!)).toBe(false);
  });

  it("rejects hydration by a different thread and preserves the evidence", async () => {
    const root = repo();
    const firstRuntime = new WorkspaceManager({
      root,
      owner: { threadId: "thread-owner", instanceId: "runtime-before", pid: 999_999 },
    });
    const lease = await firstRuntime.acquire("writer", true);
    writeFileSync(join(lease.path, "a.txt"), "unmerged agent edit\n");
    const artifact = await firstRuntime.finalize(lease);
    const foreignRuntime = new WorkspaceManager({
      root,
      owner: { threadId: "thread-foreign", instanceId: "runtime-after", pid: process.pid },
    });

    await expect(foreignRuntime.hydrate({ leases: [lease], artifacts: [artifact!] }))
      .rejects.toThrow("marker does not match");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("base-a\n");
    expect(existsSync(lease.batchPath!)).toBe(true);
    await firstRuntime.cleanup();
  });

  it("persists cleanup intent before deleting a workspace batch", async () => {
    const root = repo();
    let rejectCleanup = true;
    const manager = new WorkspaceManager({
      root,
      onLifecycle: (event) => {
        if (event.type === "workspace_cleanup_started" && rejectCleanup) {
          throw new Error("state disk unavailable");
        }
      },
    });
    const lease = await manager.acquire("writer", true);

    await expect(manager.cleanup()).rejects.toThrow("state disk unavailable");
    expect(existsSync(lease.batchPath!)).toBe(true);

    rejectCleanup = false;
    await manager.cleanup();
    expect(existsSync(lease.batchPath!)).toBe(false);
  });

  it("rejects a batch whose owner marker no longer matches its directory", async () => {
    const root = repo();
    const manager = new WorkspaceManager({
      root,
      owner: { threadId: "thread-marker", instanceId: "runtime-before", pid: process.pid },
    });
    const lease = await manager.acquire("writer", true);
    const markerPath = join(lease.batchPath!, WORKSPACE_BATCH_MARKER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { batchId: string };
    marker.batchId = "batch-tampered";
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    const recovered = new WorkspaceManager({
      root,
      owner: { threadId: "thread-marker", instanceId: "runtime-after", pid: process.pid },
    });

    await expect(recovered.hydrate({ leases: [lease], artifacts: [] }))
      .rejects.toThrow("marker does not match");
    expect(existsSync(lease.batchPath!)).toBe(true);
    await manager.cleanup();
  });
});

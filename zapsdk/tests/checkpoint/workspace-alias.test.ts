import { expect, it } from "bun:test";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "../../checkpoint/index.js";
import { writeFileTool } from "../../builtin-tools/filesystem.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

(process.platform === "win32" ? it.skip : it)("writes and rewinds through a workspace alias while rejecting outside targets", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "zap-checkpoint-alias-"));
  try {
    const base = await realpath(fixture);
    const target = join(base, "project");
    const cwd = join(base, "alias");
    const outside = join(base, "outside");
    await mkdir(target);
    await mkdir(outside);
    await symlink(target, cwd);
    await symlink(outside, join(target, "escape"));
    await writeFile(join(target, "existing.txt"), "original");
    await writeFile(join(outside, "keep.txt"), "KEEP");
    const checkpoint = new CheckpointManager({
      sessionId: "alias", cwd, config: { blobDir: join(base, "blobs") },
    });
    const registry = new ToolRegistry();
    registry.register(writeFileTool({ defaultCwd: cwd }));
    const executor = new ToolExecutor(registry, { checkpointMode: "before-write",
      cwd, onApproval: async () => true,
      onTrackEdit: (paths, options) => checkpoint.trackEdits(paths, options),
    });

    const edited = await executor.execute("write_file", { path: "existing.txt", content: "changed" });
    expect(edited.success).toBe(true);
    const created = await executor.execute("write_file", { path: join(target, ".scratch/new.txt"), content: "new" });
    expect(created.success).toBe(true);
    expect(await readFile(join(target, "existing.txt"), "utf8")).toBe("changed");
    expect(await readFile(join(target, ".scratch/new.txt"), "utf8")).toBe("new");

    for (const path of [join(outside, "keep.txt"), "escape/keep.txt"]) {
      const denied = await executor.execute("write_file", { path, content: "overwrite" });
      expect(denied.success).toBe(false);
      expect(denied.failure?.code).toBe("CHECKPOINT_REQUIRED");
    }
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("KEEP");
    await expect(checkpoint.trackEdits(["../project/existing.txt"], { required: true })).rejects.toThrow("outside workspace");
    await expect(checkpoint.trackEdits([target], { required: true })).rejects.toThrow("outside workspace");

    const snapshot = await checkpoint.makeSnapshot(0);
    expect(Object.keys(snapshot!.trackedFiles).sort()).toEqual([".scratch/new.txt", "existing.txt"]);
    const rewound = await checkpoint.rewind(snapshot!.id);
    expect(rewound.failed).toEqual([]);
    expect(await readFile(join(target, "existing.txt"), "utf8")).toBe("original");
    expect(await access(join(target, ".scratch/new.txt")).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

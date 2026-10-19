import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rm } from "node:fs/promises";
import { writeWorkspaceBatchMarker } from "../../workspace/marker.js";
import { WorkspaceRetentionManager } from "../../workspace/retention.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-retention-")));
  cleanup.push(root);
  const workspaceRoot = join(root, "workspace");
  const tempRoot = join(root, "managed");
  mkdirSync(workspaceRoot);
  mkdirSync(tempRoot);
  return { root, workspaceRoot, tempRoot };
}

async function createBatch(input: {
  workspaceRoot: string;
  tempRoot: string;
  name: string;
  createdAt: number;
  pid?: number;
  bytes?: number;
}): Promise<string> {
  const path = join(input.tempRoot, input.name);
  mkdirSync(path);
  await writeWorkspaceBatchMarker(path, {
    schemaVersion: 1,
    batchId: basename(path),
    threadId: `thread-${input.name}`,
    instanceId: `instance-${input.name}`,
    pid: input.pid ?? 999_999,
    workspaceRoot: input.workspaceRoot,
    repoRoot: input.workspaceRoot,
    rootRelative: "",
    createdAt: input.createdAt,
  });
  writeFileSync(join(path, "payload.bin"), Buffer.alloc(input.bytes ?? 16));
  return path;
}

describe("WorkspaceRetentionManager", () => {
  test("removes expired ownerless batches and reports reclaimed usage", async () => {
    const { workspaceRoot, tempRoot } = await fixture();
    const now = 10_000;
    const batch = await createBatch({
      workspaceRoot,
      tempRoot,
      name: "batch-expired",
      createdAt: 1_000,
    });
    const manager = new WorkspaceRetentionManager({
      workspaceRoot,
      tempRoot,
      clock: () => now,
      isProcessAlive: () => false,
      policy: { ttlMs: 5_000, maxBytes: 1_000_000, maxBatches: 10 },
    });

    const report = await manager.sweep();

    expect(report.beforeBatches).toBe(1);
    expect(report.afterBatches).toBe(0);
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]?.path).toBe(batch);
    expect(report.removed[0]?.reason).toBe("ttl");
  });

  test("never removes protected or live-owner batches even when quota remains exceeded", async () => {
    const { workspaceRoot, tempRoot } = await fixture();
    const protectedBatch = await createBatch({
      workspaceRoot,
      tempRoot,
      name: "batch-protected",
      createdAt: 1,
    });
    const liveBatch = await createBatch({
      workspaceRoot,
      tempRoot,
      name: "batch-live",
      createdAt: 2,
      pid: 42,
    });
    const manager = new WorkspaceRetentionManager({
      workspaceRoot,
      tempRoot,
      clock: () => 100_000,
      isProcessAlive: (pid) => pid === 42,
      protectedBatchPaths: () => [protectedBatch],
      policy: { ttlMs: 0, maxBytes: 0, maxBatches: 0 },
    });

    const report = await manager.sweep();

    expect(report.removed).toHaveLength(0);
    expect(report.afterBatches).toBe(2);
    expect(report.overQuota).toBe(true);
    expect(report.batches.find((item) => item.path === protectedBatch)?.protected).toBe(true);
    expect(report.batches.find((item) => item.path === liveBatch)?.ownerAlive).toBe(true);
  });

  test("enforces batch quota by removing the oldest eligible batches first", async () => {
    const { workspaceRoot, tempRoot } = await fixture();
    const oldest = await createBatch({
      workspaceRoot,
      tempRoot,
      name: "batch-oldest",
      createdAt: 1_000,
    });
    await createBatch({
      workspaceRoot,
      tempRoot,
      name: "batch-newest",
      createdAt: 2_000,
    });
    const manager = new WorkspaceRetentionManager({
      workspaceRoot,
      tempRoot,
      clock: () => 3_000,
      isProcessAlive: () => false,
      policy: { ttlMs: 100_000, maxBytes: 1_000_000, maxBatches: 1 },
    });

    const report = await manager.sweep();

    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]?.path).toBe(oldest);
    expect(report.removed[0]?.reason).toBe("quota");
    expect(report.afterBatches).toBe(1);
  });

  test("skips unsafe batch-shaped entries instead of recursively deleting them", async () => {
    const { root, workspaceRoot, tempRoot } = await fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    const link = join(tempRoot, "batch-link");
    symlinkSync(outside, link);
    const invalid = join(tempRoot, "batch-invalid");
    mkdirSync(invalid);
    writeFileSync(join(invalid, "keep.txt"), "keep");
    const manager = new WorkspaceRetentionManager({
      workspaceRoot,
      tempRoot,
      clock: () => 100_000,
      isProcessAlive: () => false,
      policy: { ttlMs: 0, maxBytes: 0, maxBatches: 0 },
    });

    const report = await manager.sweep();

    expect(report.removed).toHaveLength(0);
    expect(report.skipped.map((item) => item.path)).toContain(link);
    expect(report.skipped.map((item) => item.path)).toContain(invalid);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonRuntimeStateStore,
  RuntimeStateRevisionConflictError,
  RuntimeStateStoreCorruptionError,
  RuntimeThreadLeaseConflictError,
} from "../../runtime/state-store.js";
import { createRuntimeStateSnapshot } from "../../runtime/state-types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempStore(): Promise<JsonRuntimeStateStore> {
  const root = await mkdtemp(join(tmpdir(), "zap-runtime-state-"));
  tempDirs.push(root);
  return new JsonRuntimeStateStore({ directory: join(root, "state") });
}

describe("JsonRuntimeStateStore", () => {
  it("serializes concurrent updates and atomically reloads the latest revision", async () => {
    const store = await tempStore();
    const threadId = "thread/unsafe";

    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.update(threadId, (current) => {
        const state = current ?? createRuntimeStateSnapshot({
          threadId,
          workspaceRoot: "/workspace",
          now: 1_000,
        });
        state.thread.updatedAt = 1_001 + index;
        state.updatedAt = 1_001 + index;
        return state;
      })
    )));

    const reloaded = new JsonRuntimeStateStore({ directory: store.directory });
    const state = await reloaded.load(threadId);
    expect(state?.revision).toBe(12);
    expect(state?.thread.updatedAt).toBe(1_012);
    expect(store.filePath(threadId)).not.toContain(threadId);
    if (process.platform !== "win32") {
      expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(store.filePath(threadId))).mode & 0o777).toBe(0o600);
    }
  });

  it("does not create a new revision for a no-op recovery update", async () => {
    const store = await tempStore();
    await store.update("thread", () => createRuntimeStateSnapshot({
      threadId: "thread",
      workspaceRoot: "/workspace",
      now: 1_000,
    }));

    const unchanged = await store.update("thread", () => null);

    expect(unchanged?.revision).toBe(1);
    expect((await store.load("thread"))?.revision).toBe(1);
  });

  it("rejects corrupt snapshots instead of silently resetting control state", async () => {
    const store = await tempStore();
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.filePath("thread"), "{not-json\n", "utf8");

    await expect(store.load("thread")).rejects.toBeInstanceOf(RuntimeStateStoreCorruptionError);
  });

  it("loads schema v1 snapshots as v3 without losing durable state", async () => {
    const store = await tempStore();
    const state = createRuntimeStateSnapshot({
      threadId: "legacy-thread",
      workspaceRoot: "/workspace",
      now: 1_000,
    });
    state.approvals["approval-1"] = {
      approvalId: "approval-1",
      threadId: "legacy-thread",
      toolName: "Bash",
      argumentsHash: "hash",
      status: "pending",
      requestedAt: 1_001,
      updatedAt: 1_001,
    };
    const legacy = { ...state, schemaVersion: 1 };
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.filePath("legacy-thread"), `${JSON.stringify(legacy)}\n`, "utf8");

    const migrated = await store.load("legacy-thread");

    expect(migrated?.schemaVersion).toBe(3);
    expect(migrated?.attemptOutcomes).toEqual({});
    expect(migrated?.revision).toBe(0);
    expect(migrated?.approvals["approval-1"]?.status).toBe("pending");
    expect(migrated?.coordinator).toBeUndefined();
    expect(JSON.parse(await readFile(store.filePath("legacy-thread"), "utf8")).schemaVersion).toBe(1);
  });

  it("enforces one cross-process writer lease per thread", async () => {
    const first = await tempStore();
    const second = new JsonRuntimeStateStore({ directory: first.directory });
    const ownerA = { instanceId: "runtime-a", pid: process.pid, startedAt: 1_000 };
    const ownerB = { instanceId: "runtime-b", pid: process.pid, startedAt: 1_001 };
    const leaseA = await first.acquireThreadLease("thread", ownerA);

    await expect(first.acquireThreadLease("thread", ownerA))
      .rejects.toBeInstanceOf(RuntimeThreadLeaseConflictError);
    await expect(second.acquireThreadLease("thread", ownerB))
      .rejects.toBeInstanceOf(RuntimeThreadLeaseConflictError);
    await expect(second.update("thread", () => createRuntimeStateSnapshot({
      threadId: "thread",
      workspaceRoot: "/workspace",
      now: 1_000,
    }))).rejects.toBeInstanceOf(RuntimeThreadLeaseConflictError);

    await leaseA.release();
    const leaseB = await second.acquireThreadLease("thread", ownerB);
    await leaseB.release();
  });

  it("takes over a stale writer lease whose process is gone", async () => {
    const store = await tempStore();
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.leasePath("thread"), JSON.stringify({
      instanceId: "dead-runtime",
      pid: 999_999,
      startedAt: 1_000,
    }), "utf8");

    const lease = await store.acquireThreadLease("thread", {
      instanceId: "replacement-runtime",
      pid: process.pid,
      startedAt: 2_000,
    });

    expect(lease.owner.instanceId).toBe("replacement-runtime");
    await lease.release();
  });

  it("rejects stale compare-and-swap revisions", async () => {
    const store = await tempStore();
    await store.update("thread", () => createRuntimeStateSnapshot({
      threadId: "thread",
      workspaceRoot: "/workspace",
      now: 1_000,
    }));

    await expect(store.update("thread", (state) => state!, { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(RuntimeStateRevisionConflictError);
    expect((await store.load("thread"))?.revision).toBe(1);
  });
});

it("backs up schema v2 before upgrading under a thread lease", async () => {
  const store = await tempStore();
  const { attemptOutcomes: _, ...base } = createRuntimeStateSnapshot({ threadId: "v2", workspaceRoot: "/tmp", now: 1 });
  const raw = JSON.stringify({ ...base, schemaVersion: 2 });
  await mkdir(store.directory, { recursive: true });
  await writeFile(store.filePath("v2"), raw);
  const lease = await store.acquireThreadLease("v2", { instanceId: "upgrade", pid: process.pid, startedAt: Date.now() });
  try {
    await store.update("v2", current => current!);
    expect((await store.load("v2"))?.attemptOutcomes).toEqual({});
    const backup = `${store.filePath("v2")}.v2.backup`;
    expect(await readFile(backup, "utf8")).toBe(raw);
    if (process.platform !== "win32") expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.filePath("v2"), "utf8")).schemaVersion).toBe(3);
  } finally { await lease.release(); }
});

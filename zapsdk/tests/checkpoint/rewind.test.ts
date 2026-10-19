// zapsdk/checkpoint/rewind.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BlobStore } from "../../checkpoint/blob-store.js";
import { SnapshotStore } from "../../checkpoint/snapshot-store.js";
import { trackEdit } from "../../checkpoint/track-edit.js";
import { rewindDryRun, rewind } from "../../checkpoint/rewind.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zap-rewind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function takeSnapshot(snaps: SnapshotStore, sessionId: string, turnStartIndex: number) {
  return snaps.commitSnapshot({
    sessionId, turnStartIndex, timestamp: new Date().toISOString(),
  });
}

describe("rewind", () => {
  let cwd: string;
  let blobDir: string;
  let blobs: BlobStore;
  let snaps: SnapshotStore;
  const sessionId = "sess-1";

  beforeEach(() => {
    cwd = makeTmpDir();
    blobDir = makeTmpDir();
    blobs = new BlobStore(blobDir);
    snaps = new SnapshotStore({ maxSnapshots: 10 });
  });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { rmSync(blobDir, { recursive: true, force: true }); } catch {}
  });

  it("rewinds a modified file to its pre-edit content", async () => {
    const p = join(cwd, "a.ts");
    writeFileSync(p, "v1");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const snap = await takeSnapshot(snaps, sessionId, 0);
    writeFileSync(p, "v2 (bad edit)");

    const result = await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });
    expect(result.succeeded).toContain("a.ts");
    expect(result.failed).toHaveLength(0);
    expect(readFileSync(p, "utf-8")).toBe("v1");
  });

  it("rewinds absent backup by unlinking the currently existing file", async () => {
    const p = join(cwd, "new.ts");
    // File absent at trackEdit time
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const snap = await takeSnapshot(snaps, sessionId, 0);
    writeFileSync(p, "newly created");

    await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });
    expect(existsSync(p)).toBe(false);
  });

  it("restores POSIX mode", async () => {
    if (process.platform === "win32") return; // chmod n/a
    const p = join(cwd, "run.sh");
    writeFileSync(p, "#!/bin/sh", { mode: 0o755 });
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const snap = await takeSnapshot(snaps, sessionId, 0);
    writeFileSync(p, "changed", { mode: 0o644 });

    await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });

  it("restores the target and forward branch without undoing older turns", async () => {
    // Turn 1: a.ts becomes a-v2 and must survive a rewind to turn 2.
    const a = join(cwd, "a.ts"); writeFileSync(a, "a-v1");
    await trackEdit({ absPath: a, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    writeFileSync(a, "a-v2");
    await takeSnapshot(snaps, sessionId, 0);

    // Turn 2 (target): b.ts changes and must return to b-v1.
    const b = join(cwd, "b.ts"); writeFileSync(b, "b-v1");
    await trackEdit({ absPath: b, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    writeFileSync(b, "b-v2");
    const s2 = await takeSnapshot(snaps, sessionId, 2);

    // Turn 3 (forward branch): c.ts must also be restored.
    const c = join(cwd, "c.ts"); writeFileSync(c, "c-v1");
    await trackEdit({ absPath: c, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    writeFileSync(c, "c-v2");
    await takeSnapshot(snaps, sessionId, 4);

    await rewind({ snapshotId: s2!.id, cwd, blobs, snaps });
    expect(readFileSync(a, "utf-8")).toBe("a-v2");
    expect(readFileSync(b, "utf-8")).toBe("b-v1");
    expect(readFileSync(c, "utf-8")).toBe("c-v1");
  });

  it("throws on unknown snapshot id", async () => {
    await expect(rewind({ snapshotId: "nonexistent", cwd, blobs, snaps }))
      .rejects.toThrow();
  });

  it("clears pendingBackups after rewind", async () => {
    const p = join(cwd, "a.ts"); writeFileSync(p, "v1");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const snap = await takeSnapshot(snaps, sessionId, 0);
    // New pending after the snapshot
    writeFileSync(p, "v2");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    expect(Object.keys(snaps.getPending(sessionId))).toHaveLength(1);

    await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });
    expect(snaps.getPending(sessionId)).toEqual({});
  });

  it("drops target and forward snapshots from the index (CCB-style fork)", async () => {
    // Three turns, three snapshots, strictly increasing turnStartIndex.
    const a = join(cwd, "a.ts"); writeFileSync(a, "v1");
    await trackEdit({ absPath: a, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const s1 = await takeSnapshot(snaps, sessionId, 2);
    writeFileSync(a, "v2");
    await trackEdit({ absPath: a, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const s2 = await takeSnapshot(snaps, sessionId, 5);
    writeFileSync(a, "v3");
    await trackEdit({ absPath: a, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const s3 = await takeSnapshot(snaps, sessionId, 9);

    expect(snaps.listSnapshots(sessionId)).toHaveLength(3);

    // Rewind to s2 — both s2 (target, inclusive) and s3 (forward) drop out.
    await rewind({ snapshotId: s2!.id, cwd, blobs, snaps });
    const remaining = snaps.listSnapshots(sessionId).map(s => s.id);
    expect(remaining).toEqual([s1!.id]);
    expect(snaps.getById(s2!.id)).toBeNull();
    expect(snaps.getById(s3!.id)).toBeNull();
  });

  it("keeps target snapshot in the index when some files fail to restore", async () => {
    // Two files in the snapshot; second one becomes un-restorable by being
    // replaced with a directory at its target path (rename + atomicWrite
    // will fail with EISDIR / ENOTEMPTY).
    const a = join(cwd, "a.ts"); writeFileSync(a, "ORIG_A");
    const b = join(cwd, "b.ts"); writeFileSync(b, "ORIG_B");
    await trackEdit({ absPath: a, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    await trackEdit({ absPath: b, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const snap = await takeSnapshot(snaps, sessionId, 0);

    // Mutate both, then sabotage b.ts so the rewind write fails for it.
    writeFileSync(a, "EDIT_A");
    rmSync(b);
    mkdirSync(b);  // b.ts is now a directory — atomicWrite rename will EISDIR

    const result = await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });
    expect(result.failed.length).toBeGreaterThan(0)
    // Preflight is all-or-nothing: a.ts must not be rewound before b.ts is
    // rejected as a directory.
    expect(readFileSync(a, "utf-8")).toBe("EDIT_A")
    // The target snapshot must still be reachable so the user can retry
    // after fixing whatever made the write fail.
    expect(snaps.getById(snap!.id)).not.toBeNull()
    expect(snaps.listSnapshots(sessionId).map(s => s.id)).toContain(snap!.id)
  });

  it("rolls file changes back when the coupled journal commit fails", async () => {
    const p = join(cwd, "a.ts");
    writeFileSync(p, "ORIGINAL");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const snap = await takeSnapshot(snaps, sessionId, 0);
    writeFileSync(p, "EDITED");

    const result = await rewind({
      snapshotId: snap!.id,
      cwd,
      blobs,
      snaps,
      finalize: () => { throw new Error("journal unavailable"); },
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([
      { path: "<session-journal>", error: "journal unavailable" },
    ]);
    expect(readFileSync(p, "utf-8")).toBe("EDITED");
    expect(snaps.getById(snap!.id)).not.toBeNull();
  });

  it("does not apply snapshot paths that escape cwd", async () => {
    const outside = makeTmpDir();
    try {
      const outsideFile = join(outside, "outside.ts");
      writeFileSync(outsideFile, "KEEP");
      snaps.addPending(sessionId, "../outside.ts", { kind: "absent" });
      const snap = await takeSnapshot(snaps, sessionId, 0);

      const result = await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toEqual([
        { path: "../outside.ts", error: "checkpoint path is outside the project cwd" },
      ]);
      expect(readFileSync(outsideFile, "utf-8")).toBe("KEEP");
      expect(snaps.getById(snap!.id)).not.toBeNull();
    } finally {
      try { rmSync(outside, { recursive: true, force: true }); } catch {}
    }
  });

  it("does not follow a directory symlink outside cwd", async () => {
    if (process.platform === "win32") return;
    const outside = makeTmpDir();
    try {
      const victim = join(outside, "victim.ts");
      writeFileSync(victim, "KEEP");
      symlinkSync(outside, join(cwd, "link"));
      const errors: any[] = [];
      await trackEdit({
        absPath: join(cwd, "link", "victim.ts"),
        sessionId, cwd, blobs, snaps, maxFileBytes: 1000,
        onError: (error) => errors.push(error),
      });
      expect(snaps.getPending(sessionId)).toEqual({});
      expect(errors.at(-1)?.reason).toBe("track-edit-skipped-link");
      expect(readFileSync(victim, "utf-8")).toBe("KEEP");
    } finally {
      try { rmSync(outside, { recursive: true, force: true }); } catch {}
    }
  });

  it("rolls the current file back when chmod fails after publication", async () => {
    if (process.platform === "win32") return;
    const p = join(cwd, "mode.ts");
    writeFileSync(p, "EDITED");
    const blob = await blobs.write(Buffer.from("ORIGINAL"));
    snaps.addPending(sessionId, "mode.ts", { kind: "present", blob, mode: -1 });
    const snap = await takeSnapshot(snaps, sessionId, 0);

    const result = await rewind({ snapshotId: snap!.id, cwd, blobs, snaps });
    expect(result.failed).toHaveLength(1);
    expect(readFileSync(p, "utf-8")).toBe("EDITED");
    expect(snaps.getById(snap!.id)).not.toBeNull();
  });

  describe("rewindDryRun", () => {
    it("computes insertions/deletions for text file", async () => {
      const p = join(cwd, "a.ts");
      writeFileSync(p, "line1\nline2\n");
      await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
      const snap = await takeSnapshot(snaps, sessionId, 0);
      writeFileSync(p, "line1\nline2\nline3\nline4\n");

      const stats = await rewindDryRun({ snapshotId: snap!.id, cwd, blobs, snaps });
      expect(stats.filesChanged).toHaveLength(1);
      expect(stats.filesChanged[0].insertions).toBe(0);
      expect(stats.filesChanged[0].deletions).toBe(2);
    });

    it("returns zero when file matches snapshot", async () => {
      const p = join(cwd, "a.ts");
      writeFileSync(p, "same");
      await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
      const snap = await takeSnapshot(snaps, sessionId, 0);

      const stats = await rewindDryRun({ snapshotId: snap!.id, cwd, blobs, snaps });
      expect(stats.filesChanged).toHaveLength(0);
    });
  });
});

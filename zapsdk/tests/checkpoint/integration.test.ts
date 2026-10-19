// zapsdk/checkpoint/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager } from "../../checkpoint/index.js";
import { resolveProjectDataSegment } from "../../utils/project-paths.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zap-ckp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CheckpointManager (integration)", () => {
  let cwd: string;
  let blobDir: string;
  let mgr: CheckpointManager;
  const sessionId = "sess-int";
  let jsonlEntries: any[];

  beforeEach(() => {
    cwd = makeTmpDir();
    blobDir = makeTmpDir();
    jsonlEntries = [];
    mgr = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
      writeJsonlEntry: (entry) => { jsonlEntries.push(entry); },
    });
  });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { rmSync(blobDir, { recursive: true, force: true }); } catch {}
  });

  it("happy path: trackEdit → makeSnapshot → rewind", async () => {
    const a = join(cwd, "a.ts");
    writeFileSync(a, "v1");

    // Turn 1
    await mgr.trackEdits([a]);
    const snap1 = await mgr.makeSnapshot(0);
    expect(snap1).not.toBeNull();
    writeFileSync(a, "v2 bad");

    // Turn 2
    await mgr.trackEdits([a]);
    const snap2 = await mgr.makeSnapshot(2);
    writeFileSync(a, "v3 worse");

    // Rewind to snap1 (restores to v1)
    const result = await mgr.rewind(snap1!.id);
    expect(result.failed).toHaveLength(0);
    expect(readFileSync(a, "utf-8")).toBe("v1");

    // JSONL entries written
    expect(jsonlEntries.filter(e => e.type === "snapshot")).toHaveLength(2);
  });

  it("listSnapshots returns session snapshots in order", async () => {
    const p = join(cwd, "x.ts");
    writeFileSync(p, "1");
    await mgr.trackEdits([p]);
    await mgr.makeSnapshot(0);
    writeFileSync(p, "2");
    await mgr.trackEdits([p]);
    await mgr.makeSnapshot(2);
    expect(mgr.listSnapshots()).toHaveLength(2);
  });

  it("hydrateFromJsonl rebuilds state", async () => {
    const p = join(cwd, "x.ts");
    writeFileSync(p, "x");
    await mgr.trackEdits([p]);
    const snap = await mgr.makeSnapshot(0);

    // New manager, hydrate
    const mgr2 = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    });
    mgr2.hydrateFromJsonl(
      jsonlEntries.filter(e => e.type === "snapshot")
    );
    expect(mgr2.listSnapshots().map(s => s.id)).toEqual([snap!.id]);
  });

  it("defaults checkpoint blobs to the project data directory", async () => {
    const previousDataDir = process.env.ZAPCODE_DATA_DIR;
    const dataDir = makeTmpDir();
    try {
      process.env.ZAPCODE_DATA_DIR = dataDir;
      const scoped = new CheckpointManager({
        sessionId, cwd,
        config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10 },
      });

      const p = join(cwd, "scoped.ts");
      writeFileSync(p, "before");
      await scoped.trackEdits([p]);
      const snap = await scoped.makeSnapshot(0);
      const backup = snap?.trackedFiles["scoped.ts"];
      expect(backup?.kind).toBe("present");

      const sha = backup?.kind === "present" ? backup.blob.sha256 : "";
      const expectedBlob = join(
        dataDir,
        "projects",
        resolveProjectDataSegment(cwd),
        "snapshots",
        "blobs",
        sha.slice(0, 2),
        sha.slice(2),
      );
      expect(existsSync(expectedBlob)).toBe(true);
    } finally {
      if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR;
      else process.env.ZAPCODE_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("disabled mode: trackEdits/makeSnapshot become no-ops", async () => {
    const disabled = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: false, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    });
    const p = join(cwd, "y.ts"); writeFileSync(p, "y");
    await disabled.trackEdits([p]);
    const snap = await disabled.makeSnapshot(0);
    expect(snap).toBeNull();
    expect(disabled.listSnapshots()).toHaveLength(0);
  });

  it("updateConfig toggles enabled and maxFileBytes without rebuilding the manager", async () => {
    const errors: any[] = [];
    const configurable = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: false, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
      onError: (e) => errors.push(e),
    });
    const p = join(cwd, "configurable.ts");
    writeFileSync(p, "before");

    await configurable.trackEdits([p]);
    expect(await configurable.makeSnapshot(0)).toBeNull();

    configurable.updateConfig({ enabled: true, maxFileBytes: 2 });
    await configurable.trackEdits([p]);
    expect(await configurable.makeSnapshot(1)).toBeNull();
    expect(errors.at(-1)?.reason).toBe("track-edit-skipped-large");

    configurable.updateConfig({ maxFileBytes: 1_000_000 });
    await configurable.trackEdits([p]);
    const snap = await configurable.makeSnapshot(2);
    expect(snap).not.toBeNull();
    expect(configurable.listSnapshots()).toHaveLength(1);
  });

  it("updateConfig prunes existing snapshots when maxSnapshots shrinks", async () => {
    for (let i = 0; i < 3; i++) {
      const p = join(cwd, `shrink-${i}.ts`);
      writeFileSync(p, `v${i}`);
      await mgr.trackEdits([p]);
      await mgr.makeSnapshot(i);
    }
    expect(mgr.listSnapshots()).toHaveLength(3);

    mgr.updateConfig({ maxSnapshots: 1 });

    const snapshots = mgr.listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(Object.keys(snapshots[0].trackedFiles)).toEqual(["shrink-2.ts"]);
  });

  it("updateConfig switches blobDir while preserving old blobs as rewind fallbacks", async () => {
    const firstBlobDir = makeTmpDir();
    const secondBlobDir = makeTmpDir();
    try {
      const configurable = new CheckpointManager({
        sessionId, cwd,
        config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir: firstBlobDir },
      });
      const p = join(cwd, "blob-switch.ts");
      writeFileSync(p, "before");
      await configurable.trackEdits([p]);
      const snap = await configurable.makeSnapshot(0);
      expect(snap).not.toBeNull();

      configurable.updateConfig({ blobDir: secondBlobDir });
      writeFileSync(p, "after");

      const result = await configurable.rewind(snap!.id);

      expect(result.failed).toHaveLength(0);
      expect(readFileSync(p, "utf-8")).toBe("before");
      expect(configurable.getDiagnostics().blobDir).toBe(secondBlobDir);
    } finally {
      try { rmSync(firstBlobDir, { recursive: true, force: true }); } catch {}
      try { rmSync(secondBlobDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("trackEdits skips paths that resolve outside cwd", async () => {
    const outside = makeTmpDir();
    try {
      const p = join(outside, "outside.ts");
      writeFileSync(p, "outside");
      const errors: any[] = [];
      const guarded = new CheckpointManager({
        sessionId, cwd,
        config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
        onError: (e) => errors.push(e),
      });

      await guarded.trackEdits([p]);
      const snap = await guarded.makeSnapshot(0);

      expect(snap).toBeNull();
      expect(guarded.getDiagnostics().pendingCount).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toBe("track-edit-skipped-outside-cwd");
      expect(errors[0].path).toBe(p);
    } finally {
      try { rmSync(outside, { recursive: true, force: true }); } catch {}
    }
  });

  it("hydrateFromJsonl drops unsafe tracked paths", async () => {
    const errors: any[] = [];
    const guarded = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
      onError: (e) => errors.push(e),
    });

    guarded.hydrateFromJsonl([
      {
        type: "snapshot",
        snapshot: {
          id: "snap-unsafe",
          sessionId,
          turnStartIndex: 0,
          timestamp: new Date().toISOString(),
          parentId: null,
          trackedFiles: {
            "safe.ts": { kind: "absent" },
            "../outside.ts": { kind: "absent" },
          },
        },
      },
    ] as any);

    const list = guarded.listSnapshots();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0].trackedFiles)).toEqual(["safe.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("snapshot-jsonl-skipped-path");
    expect(errors[0].path).toBe("../outside.ts");
  });

  it("hydrateFromJsonl rejects symlink escapes and malformed blob metadata", () => {
    if (process.platform === "win32") return;
    const outside = makeTmpDir();
    try {
      symlinkSync(outside, join(cwd, "link"));
      const errors: any[] = [];
      const guarded = new CheckpointManager({
        sessionId, cwd,
        config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
        onError: (error) => errors.push(error),
      });
      guarded.hydrateFromJsonl([{
        type: "snapshot",
        snapshot: {
          id: "unsafe",
          sessionId,
          turnStartIndex: 0,
          timestamp: new Date().toISOString(),
          parentId: null,
          trackedFiles: {
            "link/victim.ts": { kind: "absent" },
            "safe.ts": { kind: "present", blob: { sha256: "../../escape", size: 1 }, mode: 0o644 },
          },
        },
      }] as any);

      expect(guarded.listSnapshots()).toEqual([]);
      expect(errors.map(error => error.path).sort()).toEqual(["link/victim.ts", "safe.ts"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rewind fork: target + forward dropped; hydrate replays same result", async () => {
    const p = join(cwd, "x.ts");
    // 3 turns → 3 snapshots at turnStartIndex 0, 2, 5
    writeFileSync(p, "v1");
    await mgr.trackEdits([p]);
    const s1 = await mgr.makeSnapshot(0);
    writeFileSync(p, "v2");
    await mgr.trackEdits([p]);
    const s2 = await mgr.makeSnapshot(2);
    writeFileSync(p, "v3");
    await mgr.trackEdits([p]);
    const s3 = await mgr.makeSnapshot(5);
    expect(mgr.listSnapshots()).toHaveLength(3);

    // Rewind to s2: s2 and s3 drop out of the index.
    await mgr.rewind(s2!.id);
    expect(mgr.listSnapshots().map(s => s.id)).toEqual([s1!.id]);

    // Simulate: the rewind-marker the App would append to JSONL after
    // calling mgr.rewind. Combined with the pre-existing snapshot entries,
    // this is what hydrateFromJsonl would see on /load.
    jsonlEntries.push({
      type: "rewind-marker",
      sessionId,
      targetTurnStartIndex: s2!.turnStartIndex,
      snapshotId: s2!.id,
    });

    const mgr2 = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    });
    mgr2.hydrateFromJsonl(jsonlEntries as any);
    // After marker-aware hydrate: same result as in-memory truncation.
    expect(mgr2.listSnapshots().map(s => s.id)).toEqual([s1!.id]);
  });

  it("FIFO eviction after maxSnapshots exceeded", async () => {
    const small = new CheckpointManager({
      sessionId, cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 2, blobDir },
    });
    for (let i = 0; i < 3; i++) {
      const p = join(cwd, `f${i}.ts`); writeFileSync(p, `v${i}`);
      await small.trackEdits([p]);
      await small.makeSnapshot(i);
    }
    expect(small.listSnapshots()).toHaveLength(2);
  });

  it("setSessionId: new snapshots commit under the updated id", async () => {
    const p = join(cwd, "x.ts");
    writeFileSync(p, "v1");
    await mgr.trackEdits([p]);
    await mgr.makeSnapshot(0);
    expect(mgr.listSnapshots()).toHaveLength(1);

    // Simulate the writer rotating (e.g. /new). listSnapshots() filters by
    // the new id and ignores the old in-memory entries.
    mgr.setSessionId("sess-int-2");
    expect(mgr.getSessionId()).toBe("sess-int-2");
    expect(mgr.listSnapshots()).toHaveLength(0);

    // New work under the new id commits cleanly + survives a fresh manager
    // hydrating from the carried JSONL.
    writeFileSync(p, "v2");
    await mgr.trackEdits([p]);
    const snap2 = await mgr.makeSnapshot(0);
    expect(snap2?.sessionId).toBe("sess-int-2");
    expect(mgr.listSnapshots()).toHaveLength(1);
  });

  it("hydrateFromJsonl remapToCurrentSession surfaces historical entries", async () => {
    // First "session" produces snapshots tagged sess-A.
    const p = join(cwd, "x.ts");
    writeFileSync(p, "v1");
    await mgr.trackEdits([p]);
    const snapA = await mgr.makeSnapshot(0);
    expect(snapA?.sessionId).toBe(sessionId);

    // Fresh manager labelled sess-B (the "fork on resume" case).
    const mgr2 = new CheckpointManager({
      sessionId: "sess-B", cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    });
    // Plain hydrate: snapshot stays under sess-A, not visible from sess-B.
    mgr2.hydrateFromJsonl(jsonlEntries as any);
    expect(mgr2.listSnapshots()).toHaveLength(0);

    // Remap hydrate: same entries appear under sess-B.
    const mgr3 = new CheckpointManager({
      sessionId: "sess-B", cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    });
    mgr3.hydrateFromJsonl(jsonlEntries as any, { remapToCurrentSession: true });
    const restored = mgr3.listSnapshots();
    expect(restored).toHaveLength(1);
    expect(restored[0].sessionId).toBe("sess-B");
    // Identity (uuid) preserved so rewind() can still find it.
    expect(restored[0].id).toBe(snapA!.id);
  });

  it("hydrateFromJsonl remap applies to rewind-markers too", async () => {
    // 2 snapshots in sess-A, with a rewind-marker truncating the latter.
    const p = join(cwd, "x.ts");
    writeFileSync(p, "v1");
    await mgr.trackEdits([p]);
    const s1 = await mgr.makeSnapshot(0);
    writeFileSync(p, "v2");
    await mgr.trackEdits([p]);
    const s2 = await mgr.makeSnapshot(2);
    jsonlEntries.push({
      type: "rewind-marker",
      sessionId,
      targetTurnStartIndex: s2!.turnStartIndex,
      snapshotId: s2!.id,
    });

    // Remap into sess-B: both snapshots get sessionId=sess-B, then the
    // rewind-marker prunes s2 under sess-B (not sess-A which would no-op).
    const mgr2 = new CheckpointManager({
      sessionId: "sess-B", cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    });
    mgr2.hydrateFromJsonl(jsonlEntries as any, { remapToCurrentSession: true });
    expect(mgr2.listSnapshots().map(s => s.id)).toEqual([s1!.id]);
  });
});

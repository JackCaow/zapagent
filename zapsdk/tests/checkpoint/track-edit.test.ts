// zapsdk/checkpoint/track-edit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BlobStore } from "../../checkpoint/blob-store.js";
import { SnapshotStore } from "../../checkpoint/snapshot-store.js";
import { trackEdit } from "../../checkpoint/track-edit.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zap-track-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("trackEdit", () => {
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

  it("records present backup with mode and blob ref for an existing file", async () => {
    const p = join(cwd, "a.ts");
    writeFileSync(p, "hello", { mode: 0o644 });
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const pending = snaps.getPending(sessionId);
    expect(pending["a.ts"]?.kind).toBe("present");
    const b = pending["a.ts"] as any;
    expect(b.blob.size).toBe(5);
    expect(b.mode & 0o777).toBe(0o644);
    // Blob actually written
    const read = await blobs.read(b.blob.sha256);
    expect(read.toString()).toBe("hello");
  });

  it("records absent backup when file does not exist", async () => {
    const p = join(cwd, "missing.ts");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    expect(snaps.getPending(sessionId)["missing.ts"]?.kind).toBe("absent");
  });

  it("second trackEdit of same path within same turn does not overwrite", async () => {
    const p = join(cwd, "a.ts");
    writeFileSync(p, "first");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    writeFileSync(p, "second");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const first = snaps.getPending(sessionId)["a.ts"];
    expect((first as any).blob).toBeDefined();
    const read = await blobs.read((first as any).blob.sha256);
    expect(read.toString()).toBe("first"); // original preserved
  });

  it("skips tracking for files over maxFileBytes", async () => {
    const p = join(cwd, "big.bin");
    writeFileSync(p, Buffer.alloc(2000));
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    expect(snaps.getPending(sessionId)["big.bin"]).toBeUndefined();
  });

  it("invokes onError for large-file skip with size + limit", async () => {
    const p = join(cwd, "big.bin");
    writeFileSync(p, Buffer.alloc(2000));
    const errors: any[] = [];
    await trackEdit({
      absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000,
      onError: (e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("track-edit-skipped-large");
    expect(errors[0].path).toBe("big.bin");
    expect(errors[0].size).toBe(2000);
    expect(errors[0].limit).toBe(1000);
  });

  it("uses posix-style relative paths", async () => {
    const sub = join(cwd, "sub");
    mkdirSync(sub);
    const p = join(sub, "nested.ts");
    writeFileSync(p, "x");
    await trackEdit({ absPath: p, sessionId, cwd, blobs, snaps, maxFileBytes: 1000 });
    const keys = Object.keys(snaps.getPending(sessionId));
    expect(keys[0]).toBe("sub/nested.ts"); // forward slash even on Windows
  });

  it("skips paths that resolve outside cwd", async () => {
    const outside = makeTmpDir();
    try {
      const p = join(outside, "outside.ts");
      writeFileSync(p, "do not track");
      const errors: any[] = [];
      await trackEdit({
        absPath: p,
        sessionId,
        cwd,
        blobs,
        snaps,
        maxFileBytes: 1000,
        onError: (e) => errors.push(e),
      });
      expect(snaps.getPending(sessionId)).toEqual({});
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toBe("track-edit-skipped-outside-cwd");
      expect(errors[0].path).toBe(p);
    } finally {
      try { rmSync(outside, { recursive: true, force: true }); } catch {}
    }
  });
});

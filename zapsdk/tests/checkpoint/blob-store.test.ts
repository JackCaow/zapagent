// zapsdk/checkpoint/blob-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BlobStore } from "../../checkpoint/blob-store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zap-blob-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("BlobStore", () => {
  let dir: string;
  let store: BlobStore;
  beforeEach(() => {
    dir = makeTmpDir();
    store = new BlobStore(dir);
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("writes a new blob and returns its BlobRef", async () => {
    const content = Buffer.from("hello world");
    const ref = await store.write(content);
    expect(ref.sha256).toHaveLength(64);
    expect(ref.size).toBe(11);
  });

  it("read returns original content", async () => {
    const content = Buffer.from("hello");
    const ref = await store.write(content);
    const read = await store.read(ref.sha256);
    expect(read.toString()).toBe("hello");
  });

  it("reads from fallback roots without writing new blobs there", async () => {
    const legacyDir = makeTmpDir();
    try {
      const legacyStore = new BlobStore(legacyDir);
      const ref = await legacyStore.write(Buffer.from("old snapshot"));

      const primary = new BlobStore(dir, { fallbackRoots: [legacyDir] });
      expect(await primary.has(ref.sha256)).toBe(true);
      expect((await primary.read(ref.sha256)).toString()).toBe("old snapshot");

      const newRef = await primary.write(Buffer.from("new snapshot"));
      expect(existsSync(join(dir, newRef.sha256.slice(0, 2), newRef.sha256.slice(2)))).toBe(true);
      expect(existsSync(join(legacyDir, newRef.sha256.slice(0, 2), newRef.sha256.slice(2)))).toBe(false);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("write is idempotent — same hash = no re-write", async () => {
    const content = Buffer.from("same");
    const ref1 = await store.write(content);
    const ref2 = await store.write(content);
    expect(ref1.sha256).toBe(ref2.sha256);
  });

  it("read of missing blob throws", async () => {
    await expect(store.read("a".repeat(64))).rejects.toThrow();
  });

  it("rejects malformed hashes instead of resolving them as paths", async () => {
    await expect(store.read("../../outside")).rejects.toThrow("invalid sha256");
  });

  it("rejects a blob whose persisted content no longer matches its hash", async () => {
    const ref = await store.write(Buffer.from("original"));
    writeFileSync(join(dir, ref.sha256.slice(0, 2), ref.sha256.slice(2)), "corrupt");
    await expect(store.read(ref.sha256)).rejects.toThrow("hash mismatch on read");
  });

  it("stores blob in sharded directory (2-char prefix)", async () => {
    const ref = await store.write(Buffer.from("x"));
    const prefix = ref.sha256.slice(0, 2);
    const rest = ref.sha256.slice(2);
    const content = readFileSync(join(dir, prefix, rest));
    expect(content.toString()).toBe("x");
  });

  it("stores checkpoint blobs with owner-only file and directory permissions", async () => {
    if (process.platform === "win32") return;
    const ref = await store.write(Buffer.from("secret source snapshot"));
    const prefix = ref.sha256.slice(0, 2);
    const rest = ref.sha256.slice(2);
    const shardDir = join(dir, prefix);
    const blobPath = join(shardDir, rest);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(shardDir).mode & 0o777).toBe(0o700);
    expect(statSync(blobPath).mode & 0o777).toBe(0o600);
  });

  it("tightens permissions when an existing blob is reused", async () => {
    if (process.platform === "win32") return;
    const content = Buffer.from("old broad blob");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const shardDir = join(dir, sha256.slice(0, 2));
    const blobPath = join(shardDir, sha256.slice(2));
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(blobPath, content, { mode: 0o666 });
    chmodSync(dir, 0o777);
    chmodSync(shardDir, 0o777);
    chmodSync(blobPath, 0o666);

    const ref = await store.write(content);

    expect(ref.sha256).toBe(sha256);
    expect(readFileSync(blobPath)).toEqual(content);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(shardDir).mode & 0o777).toBe(0o700);
    expect(statSync(blobPath).mode & 0o777).toBe(0o600);
  });

  it("handles empty content", async () => {
    const ref = await store.write(Buffer.from(""));
    expect(ref.size).toBe(0);
    const read = await store.read(ref.sha256);
    expect(read.length).toBe(0);
  });
});

// zapsdk/checkpoint/blob-store.ts
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { BlobRef } from "./types.js";
import { writeFileAtomic, writeFileAtomicSync } from "../utils/atomic-write.js";

export class BlobStore {
  private readonly fallbackRoots: string[];

  constructor(
    private readonly root: string,
    options: { fallbackRoots?: string[] } = {},
  ) {
    this.fallbackRoots = (options.fallbackRoots ?? []).filter((r) => r !== root);
  }

  private pathFor(root: string, sha256: string): { dir: string; full: string } {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("BlobStore: invalid sha256");
    }
    const dir = join(root, sha256.slice(0, 2));
    const full = join(dir, sha256.slice(2));
    return { dir, full };
  }

  private async tightenDirs(dir: string): Promise<void> {
    if (process.platform === "win32") return;
    try { await chmod(this.root, 0o700); } catch {}
    try { await chmod(dir, 0o700); } catch {}
  }

  async write(content: Buffer): Promise<BlobRef> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const size = content.byteLength;
    const { dir, full } = this.pathFor(this.root, sha256);

    // Short-circuit: already exists
    try {
      const s = await stat(full);
      if (s.isFile()) {
        if (process.platform !== "win32") {
          try { await chmod(full, 0o600); } catch {}
        }
        await this.tightenDirs(dir);
        return { sha256, size };
      }
    } catch {}

    // Atomic write: checkpoint blobs can contain source files and secrets, so
    // persist them owner-only and tighten the sharded directory as well.
    await mkdir(dir, { recursive: true });
    await this.tightenDirs(dir);
    await writeFileAtomic(full, content, { mode: 0o600 });
    // Double-check hash of what we wrote (防 fs 残缺返回)
    const verify = await readFile(full);
    const verifyHash = createHash("sha256").update(verify).digest("hex");
    if (verifyHash !== sha256) {
      throw new Error(`BlobStore: hash mismatch on verify (${sha256} vs ${verifyHash})`);
    }

    return { sha256, size };
  }

  async read(sha256: string): Promise<Buffer> {
    const roots = [this.root, ...this.fallbackRoots];
    let lastError: unknown;
    for (const root of roots) {
      const { full } = this.pathFor(root, sha256);
      try {
        const content = await readFile(full);
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== sha256) throw new Error(`BlobStore: hash mismatch on read (${sha256} vs ${actual})`);
        return content;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`blob not found: ${sha256}`);
  }

  /** Materialize a fork's references locally before its independent GC can run. */
  importLocal(sha256: string): void {
    for (const root of [this.root, ...this.fallbackRoots]) {
      const source = this.pathFor(root, sha256);
      let content: Buffer;
      try { content = readFileSync(source.full); } catch { continue; }
      if (createHash("sha256").update(content).digest("hex") !== sha256) continue;
      if (root === this.root) return;
      const destination = this.pathFor(this.root, sha256);
      mkdirSync(destination.dir, { recursive: true, mode: 0o700 });
      writeFileAtomicSync(destination.full, content);
      if (process.platform !== "win32") { chmodSync(this.root, 0o700); chmodSync(destination.dir, 0o700); }
      return;
    }
    throw new Error(`checkpoint blob unavailable: ${sha256}`);
  }

  async has(sha256: string): Promise<boolean> {
    for (const root of [this.root, ...this.fallbackRoots]) {
      try {
        const s = await stat(this.pathFor(root, sha256).full);
        if (s.isFile()) return true;
      } catch {}
    }
    return false;
  }
}

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-write.js";
import type { Snapshot } from "./types.js";

/** Session-private storage: a fork copies its referenced blobs before publishing
 * its own index. GC never traverses another session or the legacy shared store. */
export class CheckpointArchive {
  readonly root: string;
  readonly blobs: string;
  constructor(base: string, readonly sessionId: string) {
    this.root = CheckpointArchive.rootFor(base, sessionId);
    this.blobs = join(this.root, "blobs");
  }
  static rootFor(base: string, sessionId: string): string {
    return join(base, "sessions", createHash("sha256").update(sessionId).digest("hex"));
  }
  load(): { snapshots: Snapshot[]; activeId?: string } | undefined {
    try {
      const value = JSON.parse(readFileSync(join(this.root, "index.json"), "utf8"));
      if (value.version !== 1 || value.sessionId !== this.sessionId || !Array.isArray(value.snapshots)) return;
      return { snapshots: value.snapshots, activeId: typeof value.activeId === "string" ? value.activeId : undefined };
    } catch { return; }
  }
  save(snapshots: Snapshot[], activeId?: string): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    writeFileAtomicSync(join(this.root, "index.json"), JSON.stringify({ version: 1, sessionId: this.sessionId, snapshots, activeId }));
  }
  collect(snapshots: Snapshot[]): void {
    const referenced = new Set(snapshots.flatMap(snapshot => Object.values(snapshot.trackedFiles)
      .flatMap(backup => backup.kind === "present" ? [backup.blob.sha256] : [])));
    let shards: string[];
    try { shards = readdirSync(this.blobs); } catch { return; }
    for (const shard of shards) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue;
      const directory = join(this.blobs, shard);
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) continue;
      for (const leaf of readdirSync(directory)) {
        if (!/^[a-f0-9]{62}$/.test(leaf) || referenced.has(shard + leaf)) continue;
        const path = join(directory, leaf);
        if (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) unlinkSync(path);
      }
    }
  }
}

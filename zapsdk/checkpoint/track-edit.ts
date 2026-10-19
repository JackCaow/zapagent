// zapsdk/checkpoint/track-edit.ts
import { readFile, stat } from "node:fs/promises";
import type { BlobStore } from "./blob-store.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { FileBackup } from "./types.js";
import type { CheckpointError } from "./index.js";
import { checkpointSkipReason, resolveCheckpointPath } from "./paths.js";

export interface TrackEditOpts {
  absPath: string;
  sessionId: string;
  cwd: string;
  blobs: BlobStore;
  snaps: SnapshotStore;
  maxFileBytes: number;
  /** Surface recoverable failures (large files, read errors) instead of
   *  console.warn. Without this hook the issues are silently dropped on
   *  the floor — Ink swallows stderr so the user has no clue why /rewind
   *  is missing entries. */
  onError?: (err: CheckpointError) => void;
}

export async function trackEdit(opts: TrackEditOpts): Promise<void> {
  const { absPath, sessionId, cwd, blobs, snaps, maxFileBytes, onError } = opts;
  const skipped = checkpointSkipReason(cwd, absPath);
  if (skipped) {
    onError?.({ reason: skipped === "outside_workspace" ? "track-edit-skipped-outside-cwd"
      : skipped === "directory" ? "track-edit-skipped-directory" : "track-edit-skipped-link", path: absPath, message: skipped });
    return;
  }
  const resolved = resolveCheckpointPath(cwd, absPath);
  if (!resolved) {
    onError?.({
      reason: "track-edit-skipped-outside-cwd",
      path: absPath,
      message: "checkpoint path resolved outside the project cwd",
    });
    return;
  }
  const rel = resolved.rel;

  // Fast path: already pending this turn
  if (rel in snaps.getPending(sessionId)) return;

  let backup: FileBackup;
  try {
    const s = await stat(resolved.abs);
    if (!s.isFile()) return; // directories/symlinks to non-files — skip
    if (s.size > maxFileBytes) {
      onError?.({
        reason: "track-edit-skipped-large",
        path: rel,
        size: s.size,
        limit: maxFileBytes,
      });
      return;
    }
    const content = await readFile(resolved.abs);
    if (content.byteLength > maxFileBytes) {
      onError?.({ reason: "track-edit-skipped-large", path: rel, size: content.byteLength, limit: maxFileBytes });
      return;
    }
    const ref = await blobs.write(content);
    backup = { kind: "present", blob: ref, mode: s.mode & 0o777 };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      backup = { kind: "absent" };
    } else {
      onError?.({
        reason: "track-edit-failed",
        path: rel,
        message: err?.message ?? String(err),
      });
      return; // conservative: don't block the tool
    }
  }

  snaps.addPending(sessionId, rel, backup);
}

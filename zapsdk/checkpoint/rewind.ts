// zapsdk/checkpoint/rewind.ts
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { diffLines } from "diff";
import type { BlobStore } from "./blob-store.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { CheckpointSkip, DiffStats, RewindMode, RewindResult } from "./types.js";
import { checkpointSkipReason, resolveCheckpointPath } from "./paths.js";

export interface RewindOpts {
  snapshotId: string;
  mode?: RewindMode;
  cwd: string;
  blobs: BlobStore;
  snaps: SnapshotStore;
  /** Commit coupled host state (normally the durable session rewind marker)
   *  after file writes but before the snapshot index is truncated. Throwing
   *  rolls every applied file back to its pre-rewind state. */
  finalize?: () => void | Promise<void>;
}

type CurrentFileState =
  | { kind: "absent" }
  | { kind: "present"; content: Buffer; mode: number };

type PlannedRestore = {
  rel: string;
  abs: string;
  desired: { kind: "absent" } | { kind: "present"; content: Buffer; mode: number };
  current: CurrentFileState;
};

async function atomicWrite(
  abs: string,
  content: Buffer,
  validatePath?: () => void,
): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  validatePath?.();
  const tmp = `${abs}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content);
    validatePath?.();
    await rename(tmp, abs);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

function validatePlannedPath(cwd: string, plan: Pick<PlannedRestore, "rel" | "abs">): void {
  const current = resolveCheckpointPath(cwd, plan.rel);
  if (!current || current.rel !== plan.rel || current.abs !== plan.abs || checkpointSkipReason(cwd, plan.rel)) {
    throw new Error("checkpoint path changed or escaped the project cwd");
  }
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) return true;
  }
  return false;
}

function skippedFrom(snaps: SnapshotStore, id: string): CheckpointSkip[] {
  const target = snaps.getById(id);
  if (!target) return [];
  const points = snaps.listSnapshots(target.sessionId);
  const skipped = new Map<string, CheckpointSkip>();
  for (const point of points.slice(points.findIndex(point => point.id === id))) {
    for (const value of point.skippedFiles ?? []) skipped.set(value.path, value);
  }
  return [...skipped.values()];
}

export async function rewindDryRun(opts: RewindOpts): Promise<DiffStats> {
  const { snapshotId, cwd, blobs, snaps } = opts;
  const target = snaps.getById(snapshotId);
  if (!target) throw new Error(`snapshot not found: ${snapshotId}`);

  const resolved = snaps.resolveBackupsFrom(snapshotId);
  const filesChanged: DiffStats["filesChanged"] = [];
  const skippedFiles: CheckpointSkip[] = skippedFrom(snaps, snapshotId);
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const [rel, backup] of resolved) {
    const skip = checkpointSkipReason(cwd, rel);
    if (skip === "symlink" || skip === "hardlink") { skippedFiles.push({ path: rel, reason: skip }); continue; }
    const resolvedPath = resolveCheckpointPath(cwd, rel);
    if (!resolvedPath || resolvedPath.rel !== rel) {
      filesChanged.push({ path: rel, insertions: 0, deletions: 0 });
      continue;
    }
    const abs = resolvedPath.abs;
    const exists = existsSync(abs);

    if (backup.kind === "absent") {
      if (exists) {
        // Will be deleted — count current content's lines as deletions
        const cur = await readFile(abs);
        if (looksBinary(cur)) {
          filesChanged.push({ path: rel, insertions: 0, deletions: 0, binary: true });
        } else {
          const lines = cur.toString("utf-8").split("\n").length;
          filesChanged.push({ path: rel, insertions: 0, deletions: lines });
          totalDeletions += lines;
        }
      }
      continue;
    }

    // backup.kind === "present"
    const desiredBuf = await blobs.read(backup.blob.sha256);
    if (!exists) {
      // Will be created — count desired content's lines as insertions
      if (looksBinary(desiredBuf)) {
        filesChanged.push({ path: rel, insertions: 0, deletions: 0, binary: true });
      } else {
        const lines = desiredBuf.toString("utf-8").split("\n").length;
        filesChanged.push({ path: rel, insertions: lines, deletions: 0 });
        totalInsertions += lines;
      }
      continue;
    }

    const curBuf = await readFile(abs);
    if (curBuf.equals(desiredBuf)) {
      if (process.platform !== "win32" && (statSync(abs).mode & 0o777) !== backup.mode) filesChanged.push({ path: rel, insertions: 0, deletions: 0 });
      continue;
    }

    if (looksBinary(desiredBuf) || looksBinary(curBuf)) {
      filesChanged.push({ path: rel, insertions: 0, deletions: 0, binary: true });
      continue;
    }

    let ins = 0, del = 0;
    for (const part of diffLines(curBuf.toString("utf-8"), desiredBuf.toString("utf-8"))) {
      const lineCount = part.count ?? 0;
      if (part.added) ins += lineCount;
      else if (part.removed) del += lineCount;
    }
    filesChanged.push({ path: rel, insertions: ins, deletions: del });
    totalInsertions += ins;
    totalDeletions += del;
  }

  return { filesChanged, totalInsertions, totalDeletions, ...(skippedFiles.length ? { skippedFiles } : {}) };
}

export async function rewind(opts: RewindOpts): Promise<RewindResult> {
  const { snapshotId, cwd, blobs, snaps, finalize, mode = "both" } = opts;
  const target = snaps.getById(snapshotId);
  if (!target) throw new Error(`snapshot not found: ${snapshotId}`);

  const resolved = snaps.resolveBackupsFrom(snapshotId);
  const succeeded: string[] = [];
  const failed: RewindResult["failed"] = [];
  const planned: PlannedRestore[] = [];
  const skipped: CheckpointSkip[] = skippedFrom(snaps, snapshotId);
  if (mode === "conversation") {
    await finalize?.();
    snaps.clearPending(target.sessionId);
    snaps.truncateSnapshotsFromId(target.sessionId, target.id);
    return { snapshotId, succeeded, failed };
  }

  // Phase 1: resolve and read EVERYTHING before the first mutation. This
  // catches unsafe paths, missing blobs, directories/symlinks at file paths,
  // and unreadable current files without leaving a half-rewound workspace.
  for (const [rel, backup] of resolved) {
    const skip = checkpointSkipReason(cwd, rel);
    if (skip === "symlink" || skip === "hardlink") { skipped.push({ path: rel, reason: skip }); continue; }
    const resolvedPath = resolveCheckpointPath(cwd, rel);
    if (!resolvedPath || resolvedPath.rel !== rel) {
      failed.push({ path: rel, error: "checkpoint path is outside the project cwd" });
      continue;
    }
    const abs = resolvedPath.abs;
    try {
      let current: CurrentFileState;
      try {
        const currentStat = await lstat(abs);
        if (!currentStat.isFile()) {
          throw new Error("current checkpoint path is not a regular file");
        }
        current = {
          kind: "present",
          content: await readFile(abs),
          mode: currentStat.mode & 0o777,
        };
      } catch (err: any) {
        if (err?.code === "ENOENT") current = { kind: "absent" };
        else throw err;
      }

      const desired = backup.kind === "absent"
        ? { kind: "absent" as const }
        : {
            kind: "present" as const,
            content: await blobs.read(backup.blob.sha256),
            mode: backup.mode,
          };
      planned.push({ rel, abs, desired, current });
    } catch (err: any) {
      failed.push({ path: rel, error: err?.message ?? String(err) });
    }
  }

  if (failed.length > 0) return { snapshotId, succeeded, failed };

  const applied: PlannedRestore[] = [];
  const restoreCurrentState = async (plan: PlannedRestore): Promise<void> => {
    const validatePath = () => validatePlannedPath(cwd, plan);
    if (plan.current.kind === "absent") {
      validatePath();
      try { await unlink(plan.abs); } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
      return;
    }
    await atomicWrite(plan.abs, plan.current.content, validatePath);
    if (process.platform !== "win32") await chmod(plan.abs, plan.current.mode);
  };

  const rollbackApplied = async (): Promise<void> => {
    for (const plan of [...applied].reverse()) {
      try {
        await restoreCurrentState(plan);
      } catch (err: any) {
        failed.push({
          path: plan.rel,
          error: `rollback failed: ${err?.message ?? String(err)}`,
        });
      }
    }
    succeeded.length = 0;
  };

  // Phase 2: apply, with compensating rollback for the narrow class of
  // failures that can still happen after preflight (disk full, file locks,
  // permissions changing concurrently, or durable journal failure).
  for (const plan of planned) {
    try {
      const validatePath = () => validatePlannedPath(cwd, plan);
      if (plan.desired.kind === "absent") {
        validatePath();
        try { await unlink(plan.abs); } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
        applied.push(plan);
      } else {
        await atomicWrite(plan.abs, plan.desired.content, validatePath);
        // Publication already mutated the destination. Record it before chmod
        // so a mode failure rolls this file back as part of the transaction.
        applied.push(plan);
        if (process.platform !== "win32") await chmod(plan.abs, plan.desired.mode);
      }
      succeeded.push(plan.rel);
    } catch (err: any) {
      failed.push({ path: plan.rel, error: err?.message ?? String(err) });
      await rollbackApplied();
      return { snapshotId, succeeded, failed };
    }
  }

  if (finalize) {
    try {
      await finalize();
    } catch (err: any) {
      failed.push({ path: "<session-journal>", error: err?.message ?? String(err) });
      await rollbackApplied();
      return { snapshotId, succeeded, failed };
    }
  }

  snaps.clearPending(target.sessionId);
  // CCB-aligned fork semantics: drop the target snapshot and every later one
  // from the index. The "forward branch" disappears from /rewind's list so
  // users can't re-select a snapshot whose turn no longer exists in the
  // conversation. Managed storage subsequently collects unreferenced blobs.
  //
  // Reaching here means file writes and the coupled host commit both
  // succeeded. Failure paths above retain the target snapshot for retry and
  // compensate every file already changed.
  if (mode !== "code") snaps.truncateSnapshotsFromId(target.sessionId, target.id);
  return { snapshotId, succeeded, failed, ...(skipped.length ? { skipped } : {}) };
}

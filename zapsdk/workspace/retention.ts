import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { workspaceContext } from "./context.js";
import { COPY_MERGE_JOURNAL } from "../merge/copy-transaction.js";
import { removeOwnedCopyTree } from "./copy.js";
import {
  readWorkspaceBatchMarker,
  validateWorkspaceBatchBoundary,
  type WorkspaceBatchMarker,
} from "./marker.js";

export interface WorkspaceRetentionPolicy {
  ttlMs: number;
  maxBytes: number;
  maxBatches: number;
}

export const DEFAULT_WORKSPACE_RETENTION_POLICY: WorkspaceRetentionPolicy = {
  ttlMs: 7 * 24 * 60 * 60_000,
  maxBytes: 5 * 1024 * 1024 * 1024,
  maxBatches: 64,
};

export interface WorkspaceBatchUsage {
  path: string;
  marker: WorkspaceBatchMarker;
  bytes: number;
  ageMs: number;
  protected: boolean;
  ownerAlive: boolean;
}

export interface WorkspaceRetentionRemoval {
  path: string;
  threadId: string;
  bytes: number;
  reason: "ttl" | "quota";
}

export interface WorkspaceRetentionSkip {
  path: string;
  reason: string;
}

export interface WorkspaceRetentionReport {
  tempRoot: string;
  policy: WorkspaceRetentionPolicy;
  scannedAt: number;
  beforeBytes: number;
  beforeBatches: number;
  afterBytes: number;
  afterBatches: number;
  overQuota: boolean;
  batches: WorkspaceBatchUsage[];
  removed: WorkspaceRetentionRemoval[];
  skipped: WorkspaceRetentionSkip[];
}

export interface WorkspaceRetentionManagerOptions {
  workspaceRoot: string;
  tempRoot?: string;
  policy?: Partial<WorkspaceRetentionPolicy>;
  protectedBatchPaths?: () => Iterable<string> | Promise<Iterable<string>>;
  clock?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export class WorkspaceRetentionManager {
  readonly workspaceRoot: string;
  readonly policy: WorkspaceRetentionPolicy;

  private readonly tempRoot?: string;
  private readonly protectedBatchPaths?: WorkspaceRetentionManagerOptions["protectedBatchPaths"];
  private readonly clock: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: WorkspaceRetentionManagerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.tempRoot = options.tempRoot ? resolve(options.tempRoot) : undefined;
    this.policy = validatePolicy({
      ...DEFAULT_WORKSPACE_RETENTION_POLICY,
      ...options.policy,
    });
    this.protectedBatchPaths = options.protectedBatchPaths;
    this.clock = options.clock ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? processAlive;
  }

  async inspect(): Promise<WorkspaceRetentionReport> {
    return this.run(false);
  }

  async sweep(): Promise<WorkspaceRetentionReport> {
    return this.run(true);
  }

  private async run(removeEligible: boolean): Promise<WorkspaceRetentionReport> {
    const scannedAt = this.clock();
    const tempRoot = await resolveWorkspaceTempRoot(this.workspaceRoot, this.tempRoot);
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const realTempRoot = await realpath(tempRoot);
    const realWorkspaceRoot = await realpath(this.workspaceRoot);
    const protectedPaths = new Set<string>();
    for (const path of await this.protectedBatchPaths?.() ?? []) {
      try {
        protectedPaths.add(await realpath(resolve(path)));
      } catch {
        // Missing persisted paths are not filesystem resources to protect.
      }
    }

    const batches: WorkspaceBatchUsage[] = [];
    const skipped: WorkspaceRetentionSkip[] = [];
    for (const entry of await readdir(realTempRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith("batch-")) continue;
      const candidate = join(realTempRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        skipped.push({ path: candidate, reason: "batch entry is not a real directory" });
        continue;
      }
      try {
        const path = await validateWorkspaceBatchBoundary(candidate, realTempRoot);
        const marker = await readWorkspaceBatchMarker(path);
        if (marker.batchId !== entry.name || await realpath(marker.workspaceRoot) !== realWorkspaceRoot) {
          skipped.push({ path, reason: "workspace marker identity mismatch" });
          continue;
        }
        const bytes = await directoryBytes(path);
        batches.push({
          path,
          marker,
          bytes,
          ageMs: Math.max(0, scannedAt - marker.createdAt),
          protected: protectedPaths.has(path) || await lstat(join(path, COPY_MERGE_JOURNAL)).then(
            () => true,
            (error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
              throw error;
            },
          ),
          ownerAlive: this.isProcessAlive(marker.pid),
        });
      } catch (error) {
        skipped.push({
          path: candidate,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    batches.sort((left, right) => left.marker.createdAt - right.marker.createdAt);
    const beforeBytes = batches.reduce((sum, batch) => sum + batch.bytes, 0);
    const removals = new Map<string, WorkspaceRetentionRemoval>();
    const eligible = batches.filter((batch) => !batch.protected && !batch.ownerAlive);
    for (const batch of eligible) {
      if (batch.ageMs < this.policy.ttlMs) continue;
      removals.set(batch.path, removalOf(batch, "ttl"));
    }

    let afterBytes = beforeBytes - [...removals.values()].reduce((sum, item) => sum + item.bytes, 0);
    let afterBatches = batches.length - removals.size;
    for (const batch of eligible) {
      if (afterBytes <= this.policy.maxBytes && afterBatches <= this.policy.maxBatches) break;
      if (removals.has(batch.path)) continue;
      removals.set(batch.path, removalOf(batch, "quota"));
      afterBytes -= batch.bytes;
      afterBatches -= 1;
    }

    const removed: WorkspaceRetentionRemoval[] = [];
    if (removeEligible) {
      for (const removal of removals.values()) {
        try {
          // Revalidate immediately before deletion. This ensures an altered
          // marker or path swap cannot widen the recursive remove boundary.
          const path = await validateWorkspaceBatchBoundary(removal.path, realTempRoot);
          const marker = await readWorkspaceBatchMarker(path);
          if (marker.threadId !== removal.threadId || marker.batchId !== path.slice(realTempRoot.length + 1)) {
            skipped.push({ path, reason: "workspace marker changed before removal" });
            continue;
          }
          await removeOwnedCopyTree(path);
          removed.push(removal);
        } catch (error) {
          skipped.push({
            path: removal.path,
            reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const removedPaths = new Set(removed.map((item) => item.path));
      afterBytes = beforeBytes - removed.reduce((sum, item) => sum + item.bytes, 0);
      afterBatches = batches.filter((batch) => !removedPaths.has(batch.path)).length;
    } else {
      afterBytes = beforeBytes;
      afterBatches = batches.length;
    }

    return {
      tempRoot: realTempRoot,
      policy: { ...this.policy },
      scannedAt,
      beforeBytes,
      beforeBatches: batches.length,
      afterBytes,
      afterBatches,
      overQuota: afterBytes > this.policy.maxBytes || afterBatches > this.policy.maxBatches,
      batches,
      removed,
      skipped,
    };
  }
}

export async function resolveWorkspaceTempRoot(
  workspaceRoot: string,
  override?: string,
): Promise<string> {
  if (override) return resolve(override);
  return (await workspaceContext(workspaceRoot)).workspaceTempRoot;
}

function validatePolicy(policy: WorkspaceRetentionPolicy): WorkspaceRetentionPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Workspace retention ${name} must be a non-negative safe integer`);
    }
  }
  return policy;
}

function removalOf(
  batch: WorkspaceBatchUsage,
  reason: WorkspaceRetentionRemoval["reason"],
): WorkspaceRetentionRemoval {
  return {
    path: batch.path,
    threadId: batch.marker.threadId,
    bytes: batch.bytes,
    reason,
  };
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      bytes += info.size;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  return bytes;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

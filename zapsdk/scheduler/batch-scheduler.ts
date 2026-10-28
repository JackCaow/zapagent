import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ResourceClaim } from "../tools/effects.js";

export type ToolRunStatus =
  | "waiting_dependency"
  | "waiting_capacity"
  | "starting"
  | "running"
  | "completed"
  | "failed";

export interface BatchSchedulerOptions {
  maxConcurrent?: number;
  onStatus?: (id: string, status: ToolRunStatus) => void;
}

interface PendingTask<T> {
  id: string;
  sequence: number;
  claims: ResourceClaim[];
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface ActiveTask {
  id: string;
  claims: ResourceClaim[];
}

function fsPath(key: string): string | undefined {
  if (!key.startsWith("fs:")) return undefined;
  const path = key.slice(3);
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const contains = (rel: string) => rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return contains(leftToRight) || contains(rightToLeft);
}

function claimKeysOverlap(left: string, right: string): boolean {
  if (left === "global:unknown" || right === "global:unknown") return true;
  if (left === right) return true;

  const leftFs = fsPath(left);
  const rightFs = fsPath(right);
  if (leftFs && rightFs) return pathsOverlap(leftFs, rightFs);

  if (left.startsWith("external:") && right.startsWith("external:")) {
    const leftParts = left.split(":");
    const rightParts = right.split(":");
    if (leftParts[1] !== rightParts[1]) return false;
    const leftResource = leftParts.slice(2).join(":");
    const rightResource = rightParts.slice(2).join(":");
    return leftResource === "*" || rightResource === "*" || leftResource === rightResource;
  }
  return false;
}

export function resourceClaimsConflict(
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (!claimKeysOverlap(a.key, b.key)) continue;
      if (a.mode === "exclusive" || b.mode === "exclusive") return true;
    }
  }
  return false;
}

/** Fair, dependency-aware scheduler for one model batch. Conflicting earlier
 * calls keep priority, while unrelated calls may pass them and run in parallel. */
export class ToolBatchScheduler {
  private maxConcurrent: number;
  private onStatus?: BatchSchedulerOptions["onStatus"];
  private pending: PendingTask<unknown>[] = [];
  private active = new Map<number, ActiveTask>();
  private nextSequence = 0;

  constructor(options: BatchSchedulerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? Number.MAX_SAFE_INTEGER);
    this.onStatus = options.onStatus;
  }

  schedule<T>(
    id: string,
    claims: readonly ResourceClaim[],
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));

    return new Promise<T>((resolveTask, rejectTask) => {
      const task: PendingTask<T> = {
        id,
        sequence: this.nextSequence++,
        claims: [...claims],
        run,
        resolve: resolveTask,
        reject: rejectTask,
        signal,
      };
      if (signal) {
        task.abortListener = () => {
          const index = this.pending.indexOf(task as PendingTask<unknown>);
          if (index < 0) return;
          this.pending.splice(index, 1);
          rejectTask(new Error("aborted"));
          this.pump();
        };
        signal.addEventListener("abort", task.abortListener, { once: true });
      }
      this.pending.push(task as PendingTask<unknown>);
      this.pump();
    });
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private pump(): void {
    if (this.active.size >= this.maxConcurrent) {
      for (const task of this.pending) this.onStatus?.(task.id, "waiting_capacity");
      return;
    }

    let started = false;
    for (let index = 0; index < this.pending.length;) {
      if (this.active.size >= this.maxConcurrent) break;
      const task = this.pending[index];
      const conflictsActive = [...this.active.values()]
        .some((active) => resourceClaimsConflict(task.claims, active.claims));
      const conflictsEarlier = this.pending
        .slice(0, index)
        .some((earlier) => resourceClaimsConflict(task.claims, earlier.claims));
      if (conflictsActive || conflictsEarlier) {
        this.onStatus?.(task.id, "waiting_dependency");
        index += 1;
        continue;
      }

      this.pending.splice(index, 1);
      if (task.signal && task.abortListener) {
        task.signal.removeEventListener("abort", task.abortListener);
      }
      this.active.set(task.sequence, { id: task.id, claims: task.claims });
      this.onStatus?.(task.id, "starting");
      started = true;
      void this.runTask(task);
    }

    if (!started && this.active.size >= this.maxConcurrent) {
      for (const task of this.pending) this.onStatus?.(task.id, "waiting_capacity");
    }
  }

  private async runTask(task: PendingTask<unknown>): Promise<void> {
    this.onStatus?.(task.id, "running");
    try {
      const result = await task.run();
      this.onStatus?.(task.id, "completed");
      task.resolve(result);
    } catch (err) {
      this.onStatus?.(task.id, "failed");
      task.reject(err);
    } finally {
      this.active.delete(task.sequence);
      this.pump();
    }
  }
}

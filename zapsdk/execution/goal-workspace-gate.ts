import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { ToolBatchScheduler } from "../scheduler/batch-scheduler.js";
import type { ToolResult } from "../tools/types.js";
import type { ToolAuthorization, WorkspaceExecutionGate } from "../tools/executor.js";

function canonicalDirectory(path: string): { root: string; device: bigint; inode: bigint } {
  if (!isAbsolute(path)) throw new Error("Goal workspace must be absolute");
  const root = realpathSync(path);
  const stat = statSync(root, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Goal workspace must be a directory");
  return { root, device: stat.dev, inode: stat.ino };
}
function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/** In-process coordination only. One instance must be shared by the Host and
 * every executor, including all child-agent executors. This does not fence
 * independently spawned processes, external clients, or process crashes. */
export class GoalWorkspaceGate implements WorkspaceExecutionGate {
  private readonly scheduler = new ToolBatchScheduler();
  private readonly poisoned = new Set<string>();
  private readonly ownership = new AsyncLocalStorage<{ active: boolean; root: string }>();

  private poison(root: string): void { this.poisoned.add(root); }
  private assertHealthy(root: string): void {
    if ([...this.poisoned].some(other => overlaps(root, other))) throw new Error("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
  }

  markUnconfirmed(): void {
    const owner = this.ownership.getStore();
    if (!owner?.active) throw new Error("Goal workspace uncertainty has no active owner");
    this.poison(owner.root);
  }

  /** The caller must settle only when all effects and descendants have ceased.
   * Exceptions or cancellation poison the workspace until the owning Goal is
   * explicitly reconciled by its durable Host lifecycle. */
  async withExclusiveWorkspace<T>(workspace: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // A nested acquisition can deadlock even for different roots: two owners
    // could each wait for the other's lock. Do not treat an async descendant
    // as a fresh owner while its enclosing Host action still holds a lease.
    if (this.ownership.getStore()?.active) throw new Error("GOAL_WORKSPACE_REENTRANT_LOCK");
    const identity = canonicalDirectory(workspace);
    const root = identity.root;
    return this.scheduler.schedule(randomUUID(), [{ key: `fs:${root}`, mode: "exclusive" }], async () => {
      this.assertHealthy(root);
      if (signal?.aborted) throw new Error("aborted");
      // The path may be a symlink or a directory replaced while waiting.
      // Never execute under a lock for an identity other than the one queued.
      const current = canonicalDirectory(workspace);
      if (current.root !== root || current.device !== identity.device || current.inode !== identity.inode) {
        throw new Error("GOAL_WORKSPACE_IDENTITY_CHANGED");
      }
      const owner = { active: true, root };
      return this.ownership.run(owner, async () => {
        try {
          const value = await action();
          if (signal?.aborted) { this.poison(root); throw new Error("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED"); }
          this.assertHealthy(root);
          return value;
        } catch (error) {
          this.poison(root);
          throw error;
        } finally { owner.active = false; }
      });
    }, signal);
  }

  authorize<T>(workspace: string, action: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withExclusiveWorkspace(workspace, async () => action(), signal);
  }

  async execute(workspace: string, authorization: ToolAuthorization, action: () => Promise<ToolResult>, signal?: AbortSignal): Promise<ToolResult> {
    if (["agent", "delegate_agent", "merge_agent_artifacts"].includes(authorization.name)) {
      return { success: false, output: "", error: "Goal workspace gate does not yet support agent orchestration" };
    }
    return this.withExclusiveWorkspace(workspace, async () => {
      const result = await action();
      if (signal?.aborted || ["CANCELLED", "DEADLINE_EXCEEDED"].includes(result.failure?.code ?? "")
        || (authorization.effects.process.length > 0 && result.runtime?.processSeal?.state !== "sealed")) {
        throw new Error("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
      }
      return result;
    }, signal);
  }

}

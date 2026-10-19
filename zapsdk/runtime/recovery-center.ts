import { resolve } from "node:path";
import {
  WorkspaceRetentionManager,
  type WorkspaceRetentionPolicy,
  type WorkspaceRetentionReport,
} from "../workspace/retention.js";
import { RuntimeRecoveryController } from "./recovery-controller.js";
import type { RuntimeStateStore } from "./state-store.js";
import { recoverInterruptedRuntimeStates } from "./state-tracker.js";
import type { RuntimeStateSnapshot } from "./state-types.js";

export type RecoveryCenterEntryKind = "artifacts" | "workspace" | "notice";
export type RecoveryCenterAction = "merge" | "cleanup" | "none";

export interface RecoveryCenterEntry {
  id: string;
  threadId: string;
  kind: RecoveryCenterEntryKind;
  action: RecoveryCenterAction;
  status: string;
  title: string;
  detail: string;
  artifactIds?: string[];
  batchPath?: string;
}

export interface RecoveryCenterSnapshot {
  refreshedAt: number;
  states: RuntimeStateSnapshot[];
  entries: RecoveryCenterEntry[];
  retention: WorkspaceRetentionReport;
}

export interface ProjectRecoveryCenterOptions {
  workspaceRoot: string;
  store: RuntimeStateStore;
  retention?: Partial<WorkspaceRetentionPolicy>;
  onTrackEdit?: (paths: string[]) => Promise<void>;
  clock?: () => number;
}

/** Project-wide recovery facade used by TUI and future hosts. It intentionally
 * operates across threads because a new task must recover prior task ids. */
export class ProjectRecoveryCenter {
  readonly workspaceRoot: string;
  readonly store: RuntimeStateStore;

  private readonly retention?: Partial<WorkspaceRetentionPolicy>;
  private readonly onTrackEdit?: (paths: string[]) => Promise<void>;
  private readonly clock: () => number;

  constructor(options: ProjectRecoveryCenterOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.store = options.store;
    this.retention = options.retention;
    this.onTrackEdit = options.onTrackEdit;
    this.clock = options.clock ?? Date.now;
  }

  async refresh(): Promise<RecoveryCenterSnapshot> {
    await recoverInterruptedRuntimeStates(this.store, { clock: this.clock });
    const states = (await this.store.list())
      .filter((state) => resolve(state.workspaceRoot) === this.workspaceRoot)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const retentionManager = this.retentionManager(states);
    let retention: WorkspaceRetentionReport;
    try {
      retention = await retentionManager.inspect();
    } catch (error) {
      retention = {
        tempRoot: "unavailable",
        policy: { ...retentionManager.policy },
        scannedAt: this.clock(),
        beforeBytes: 0,
        beforeBatches: 0,
        afterBytes: 0,
        afterBatches: 0,
        overQuota: false,
        batches: [],
        removed: [],
        skipped: [{
          path: this.workspaceRoot,
          reason: error instanceof Error ? error.message : String(error),
        }],
      };
    }
    return {
      refreshedAt: this.clock(),
      states,
      entries: buildRecoveryEntries(states, retention),
      retention,
    };
  }

  async resumeMerge(threadId: string, artifactIds: string[]) {
    const controller = this.controller(threadId);
    await controller.recoverInterrupted();
    return controller.resumeMerge({ artifactIds });
  }

  async cleanupBatch(threadId: string, batchPath: string, confirm: boolean): Promise<void> {
    const controller = this.controller(threadId);
    await controller.recoverInterrupted();
    await controller.cleanupBatch({ batchPath, confirm });
  }

  async sweepRetention(confirm: boolean): Promise<WorkspaceRetentionReport> {
    if (confirm !== true) throw new Error("Workspace retention sweep requires explicit confirmation");
    const states = (await this.store.list())
      .filter((state) => resolve(state.workspaceRoot) === this.workspaceRoot);
    return this.retentionManager(states).sweep();
  }

  private controller(threadId: string): RuntimeRecoveryController {
    return new RuntimeRecoveryController({
      threadId,
      workspaceRoot: this.workspaceRoot,
      store: this.store,
      onTrackEdit: this.onTrackEdit,
      clock: this.clock,
    });
  }

  private retentionManager(states: RuntimeStateSnapshot[]): WorkspaceRetentionManager {
    return new WorkspaceRetentionManager({
      workspaceRoot: this.workspaceRoot,
      policy: this.retention,
      protectedBatchPaths: () => protectedWorkspaceBatchPaths(states, this.workspaceRoot),
      clock: this.clock,
    });
  }
}

export function protectedWorkspaceBatchPaths(
  states: RuntimeStateSnapshot[],
  workspaceRoot: string,
): string[] {
  const expectedRoot = resolve(workspaceRoot);
  const protectedPaths = new Set<string>();
  for (const state of states) {
    if (resolve(state.workspaceRoot) !== expectedRoot) continue;
    const artifactWorkspaceIds = new Set(Object.values(state.artifacts)
      .filter((artifact) => (
        artifact.status === "ready"
        || artifact.status === "merging"
        || artifact.status === "blocked"
      ))
      .map((artifact) => artifact.workspaceId));
    for (const workspace of Object.values(state.workspaces)) {
      if (!workspace.batchPath) continue;
      if (artifactWorkspaceIds.has(workspace.workspaceId)
        || workspace.status === "active"
        || workspace.status === "preserved"
        || workspace.status === "acquiring"
        || workspace.status === "releasing") {
        protectedPaths.add(workspace.batchPath);
      }
    }
  }
  return [...protectedPaths];
}

function buildRecoveryEntries(
  states: RuntimeStateSnapshot[],
  retention: WorkspaceRetentionReport,
): RecoveryCenterEntry[] {
  const entries: RecoveryCenterEntry[] = [];
  const batchPathById = new Map(retention.batches.map((batch) => [batch.marker.batchId, batch.path]));
  const onDisk = new Set(retention.batches.map((batch) => batch.path));
  const diskPath = (path: string) => batchPathById.get(path.split(/[\\/]/).pop() ?? "") ?? path;
  for (const state of states) {
    const threadLabel = state.threadId.slice(0, 8);
    const artifactsByBatch = new Map<string, string[]>();
    for (const artifact of Object.values(state.artifacts)) {
      if (artifact.status !== "ready" && artifact.status !== "blocked") continue;
      const workspace = state.workspaces[artifact.workspaceId];
      if (!workspace?.batchPath) continue;
      const existing = artifactsByBatch.get(workspace.batchPath) ?? [];
      existing.push(artifact.artifactId);
      artifactsByBatch.set(workspace.batchPath, existing);
    }
    for (const [batchPath, artifactIds] of artifactsByBatch) {
      const exists = onDisk.has(diskPath(batchPath));
      entries.push({
        id: `artifacts:${state.threadId}:${batchPath}`,
        threadId: state.threadId,
        kind: "artifacts",
        action: exists ? "merge" : "none",
        status: exists ? "ready" : "missing",
        title: `${threadLabel} · ${artifactIds.length} artifact${artifactIds.length === 1 ? "" : "s"}`,
        detail: exists
          ? "preserved changes are ready to merge"
          : "workspace evidence is missing; merge is unavailable",
        artifactIds,
        batchPath,
      });
    }

    const batches = new Map<string, Array<(typeof state.workspaces)[string]>>();
    for (const workspace of Object.values(state.workspaces)) {
      if (!workspace.batchPath || workspace.status === "released") continue;
      const existing = batches.get(workspace.batchPath) ?? [];
      existing.push(workspace);
      batches.set(workspace.batchPath, existing);
    }
    for (const [batchPath, workspaces] of batches) {
      const exists = onDisk.has(diskPath(batchPath));
      const cleanable = exists && workspaces.every((workspace) => (
        (workspace.mode === "isolated-git" || workspace.mode === "isolated-copy")
        && Boolean(workspace.path && workspace.repoPath && workspace.baseOid)
      ));
      entries.push({
        id: `workspace:${state.threadId}:${batchPath}`,
        threadId: state.threadId,
        kind: "workspace",
        action: cleanable ? "cleanup" : "none",
        status: workspaces.map((workspace) => workspace.status).join(","),
        title: `${threadLabel} · workspace batch`,
        detail: exists
          ? `${workspaces.length} lease${workspaces.length === 1 ? "" : "s"}; cleanup discards preserved files`
          : "batch no longer exists on disk",
        batchPath,
      });
    }

    for (const action of state.recovery?.actions ?? []) {
      if (action.entityType === "workspace" || action.entityType === "artifact") continue;
      entries.push({
        id: `notice:${state.threadId}:${action.entityType}:${action.entityId}`,
        threadId: state.threadId,
        kind: "notice",
        action: "none",
        status: action.disposition,
        title: `${threadLabel} · ${action.entityType} ${action.entityId.slice(0, 16)}`,
        detail: action.reason,
      });
    }
  }
  return entries;
}

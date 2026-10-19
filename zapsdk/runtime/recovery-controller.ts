import { MergeCoordinator } from "../merge/coordinator.js";
import { WorkspaceManager } from "../workspace/manager.js";
import type { AgentArtifact, MergeResult, WorkspaceLease } from "../workspace/types.js";
import type { RuntimeStateStore } from "./state-store.js";
import { RuntimeStateTracker } from "./state-tracker.js";
import type {
  PersistedArtifactState,
  PersistedWorkspaceState,
  RuntimeRecoveryReport,
  RuntimeStateSnapshot,
} from "./state-types.js";

export interface RuntimeRecoveryControllerOptions {
  threadId: string;
  workspaceRoot: string;
  store: RuntimeStateStore;
  onTrackEdit?: (paths: string[]) => Promise<void>;
  clock?: () => number;
}

export interface ResumeRecoveredMergeInput {
  artifactIds: string[];
}

export interface CleanupRecoveredBatchInput {
  batchPath: string;
  confirm: boolean;
}

export class RuntimeRecoveryDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRecoveryDataError";
  }
}

/** Host-facing recovery operations. Every mutation holds the same per-thread
 * writer lease as AgentRuntime and revalidates the on-disk workspace marker
 * before a preserved artifact is merged or removed. */
export class RuntimeRecoveryController {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly store: RuntimeStateStore;

  private readonly onTrackEdit?: (paths: string[]) => Promise<void>;
  private readonly clock?: () => number;

  constructor(options: RuntimeRecoveryControllerOptions) {
    this.threadId = options.threadId;
    this.workspaceRoot = options.workspaceRoot;
    this.store = options.store;
    this.onTrackEdit = options.onTrackEdit;
    this.clock = options.clock;
  }

  inspect(): Promise<RuntimeStateSnapshot | undefined> {
    return this.store.load(this.threadId);
  }

  async recoverInterrupted(): Promise<RuntimeRecoveryReport[]> {
    const tracker = this.createTracker();
    return tracker.prepareRecovery();
  }

  async resumeMerge(input: ResumeRecoveredMergeInput): Promise<MergeResult> {
    const artifactIds = [...new Set(input.artifactIds)];
    if (artifactIds.length === 0) {
      throw new RuntimeRecoveryDataError("At least one artifact is required to resume a merge");
    }
    return this.withOwnership(async (tracker) => {
      const state = await this.requireState();
      const artifacts = artifactIds.map((artifactId) => {
        const artifact = state.artifacts[artifactId];
        if (!artifact) throw new RuntimeRecoveryDataError(`Unknown artifact: ${artifactId}`);
        if (artifact.status !== "ready" && artifact.status !== "blocked") {
          throw new RuntimeRecoveryDataError(
            `Artifact ${artifactId} cannot be resumed from status ${artifact.status}`,
          );
        }
        return artifactFromState(artifact);
      });
      const leases = artifacts.map((artifact) => {
        const workspace = state.workspaces[artifact.workspaceId];
        if (!workspace) {
          throw new RuntimeRecoveryDataError(
            `Artifact ${artifact.artifactId} has no persisted workspace`,
          );
        }
        if (workspace.status !== "preserved" && workspace.status !== "active") {
          throw new RuntimeRecoveryDataError(
            `Workspace ${workspace.workspaceId} cannot be resumed from status ${workspace.status}`,
          );
        }
        return leaseFromState(workspace);
      });
      assertOneBatch(leases);

      const manager = this.createWorkspaceManager(tracker);
      await manager.hydrate({ leases, artifacts });
      const coordinator = new MergeCoordinator(manager, {
        onTrackEdit: this.onTrackEdit,
        onLifecycle: (event) => tracker.recordMergeEvent(event),
      });
      const result = await coordinator.merge(artifactIds);
      await tracker.flush();
      return result;
    });
  }

  async cleanupBatch(input: CleanupRecoveredBatchInput): Promise<void> {
    if (input.confirm !== true) {
      throw new RuntimeRecoveryDataError("Recovered workspace cleanup requires explicit confirmation");
    }
    await this.withOwnership(async (tracker) => {
      const state = await this.requireState();
      const workspaceStates = Object.values(state.workspaces).filter((workspace) => (
        workspace.batchPath === input.batchPath && workspace.status !== "released"
      ));
      if (workspaceStates.length === 0) {
        throw new RuntimeRecoveryDataError(`No recoverable workspace batch: ${input.batchPath}`);
      }
      const leases = workspaceStates.map(leaseFromState);
      assertOneBatch(leases);
      const manager = this.createWorkspaceManager(tracker);
      await manager.hydrate({ leases, artifacts: [] });
      await manager.cleanup();
      await tracker.flush();
    });
  }

  private createTracker(): RuntimeStateTracker {
    return new RuntimeStateTracker({
      threadId: this.threadId,
      workspaceRoot: this.workspaceRoot,
      store: this.store,
      clock: this.clock,
    });
  }

  private createWorkspaceManager(tracker: RuntimeStateTracker): WorkspaceManager {
    const owner = tracker.ownerSnapshot();
    return new WorkspaceManager({
      root: this.workspaceRoot,
      owner: {
        threadId: this.threadId,
        instanceId: owner.instanceId,
        pid: owner.pid,
      },
      onLifecycle: (event) => tracker.recordWorkspaceEvent(event),
    });
  }

  private async requireState(): Promise<RuntimeStateSnapshot> {
    const state = await this.store.load(this.threadId);
    if (!state) throw new RuntimeRecoveryDataError(`No runtime state for thread ${this.threadId}`);
    if (state.workspaceRoot !== this.workspaceRoot) {
      throw new RuntimeRecoveryDataError("Runtime state belongs to a different workspace root");
    }
    return state;
  }

  private async withOwnership<T>(
    operation: (tracker: RuntimeStateTracker) => Promise<T>,
  ): Promise<T> {
    const tracker = this.createTracker();
    await tracker.prepareRecovery();
    await tracker.acquireOwnership();
    try {
      return await operation(tracker);
    } finally {
      await tracker.releaseOwnership();
    }
  }
}

function leaseFromState(workspace: PersistedWorkspaceState): WorkspaceLease {
  if ((workspace.mode !== "isolated-git" && workspace.mode !== "isolated-copy")
    || !workspace.path
    || !workspace.repoPath
    || !workspace.baseOid
    || !workspace.batchPath) {
    throw new RuntimeRecoveryDataError(
      `Workspace ${workspace.workspaceId} is missing isolated lease metadata`,
    );
  }
  return {
    workspaceId: workspace.workspaceId,
    runId: workspace.runId,
    mode: workspace.mode,
    path: workspace.path,
    repoPath: workspace.repoPath,
    baseOid: workspace.baseOid,
    batchPath: workspace.batchPath,
  };
}

function artifactFromState(artifact: PersistedArtifactState): AgentArtifact {
  if (!artifact.workspacePath
    || !artifact.repoPath
    || !artifact.baseOid
    || !artifact.resultOid
    || !artifact.diffStat) {
    throw new RuntimeRecoveryDataError(
      `Artifact ${artifact.artifactId} is missing frozen workspace metadata`,
    );
  }
  return {
    artifactId: artifact.artifactId,
    mode: artifact.mode,
    runId: artifact.runId,
    workspaceId: artifact.workspaceId,
    workspacePath: artifact.workspacePath,
    repoPath: artifact.repoPath,
    baseOid: artifact.baseOid,
    resultOid: artifact.resultOid,
    changedPaths: [...artifact.changedPaths],
    diffStat: { ...artifact.diffStat },
  };
}

function assertOneBatch(leases: WorkspaceLease[]): void {
  const batchPath = leases[0]?.batchPath;
  if (!batchPath || leases.some((lease) => lease.batchPath !== batchPath)) {
    throw new RuntimeRecoveryDataError("Recovered workspaces must belong to one batch");
  }
}

export type WorkspaceMode = "shared-readonly" | "isolated-git" | "isolated-copy";

export interface WorkspaceLease {
  workspaceId: string;
  runId: string;
  mode: WorkspaceMode;
  path: string;
  repoPath?: string;
  baseOid?: string;
  batchPath?: string;
}

export interface AgentArtifact {
  /** Absent in legacy persisted artifacts, which always use Git objects. */
  mode?: "isolated-git" | "isolated-copy";
  artifactId: string;
  runId: string;
  workspaceId: string;
  workspacePath: string;
  repoPath: string;
  baseOid: string;
  resultOid: string;
  changedPaths: string[];
  diffStat: {
    additions: number;
    deletions: number;
    files: number;
  };
}

export interface MergeResult {
  success: boolean;
  artifactIds: string[];
  changedPaths: string[];
  conflicts?: string[];
  error?: string;
}

export type WorkspaceLifecycleEvent =
  | { type: "workspace_acquire_started"; lease: WorkspaceLease; timestamp: number }
  | { type: "workspace_acquired"; lease: WorkspaceLease; timestamp: number }
  | { type: "workspace_hydrated"; lease: WorkspaceLease; timestamp: number }
  | { type: "workspace_cleanup_started"; lease: WorkspaceLease; timestamp: number }
  | { type: "workspace_acquire_failed"; lease: WorkspaceLease; error: string; timestamp: number }
  | { type: "artifact_created"; lease: WorkspaceLease; artifact: AgentArtifact; timestamp: number }
  | { type: "workspace_released"; lease: WorkspaceLease; timestamp: number };

export type WorkspaceLifecycleHandler = (
  event: WorkspaceLifecycleEvent,
) => void | Promise<void>;

export type WorkspaceMode = "shared-readonly" | "isolated-git" | "isolated-copy";

/** Host-recorded identity, never accepted from model tool arguments. */
export interface PrivateGitBinding {
  directory: string;
  device: string;
  inode: string;
}

export interface WorkspaceLease {
  workspaceId: string;
  runId: string;
  mode: WorkspaceMode;
  path: string;
  repoPath?: string;
  baseOid?: string;
  batchPath?: string;
  /** Host-owned raw source-link baseline, outside every writable clone. */
  sourceLinksHash?: string;
  /** Host-created private metadata, excluded from delivered file artifacts. */
  privateGit?: PrivateGitBinding;
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
  /** Private commit history is retained as evidence, never applied to the source repository. */
  privateGitHistory?: { repository: string; treeHash: string };
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

import type { PersistedAttemptOutcome } from "./outcome-state.js";
import type { AgentRunStatus } from "../agent/run-state.js";
import type { AgentCoordinatorState } from "../coordinator/types.js";
import type { TokenUsage } from "../core/types.js";
import type { WorkspaceMode } from "../workspace/types.js";
import type { ToolResult } from "../tools/types.js";
import type { ThreadStatus, TurnStatus } from "./types.js";

export const LEGACY_RUNTIME_STATE_SCHEMA_VERSION = 1 as const;
export const RUNTIME_STATE_SCHEMA_VERSION = 3 as const;

export type RuntimeStateSchemaVersion =
  | typeof LEGACY_RUNTIME_STATE_SCHEMA_VERSION
  | 2
  | typeof RUNTIME_STATE_SCHEMA_VERSION;
export type ToolRunStateStatus =
  | "scheduled"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type ApprovalStateStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "failed"
  | "interrupted";
export type WorkspaceStateStatus =
  | "acquiring"
  | "active"
  | "releasing"
  | "released"
  | "orphaned"
  | "preserved"
  | "failed";
export type ArtifactStateStatus = "ready" | "merging" | "merged" | "blocked" | "discarded";
export type MergeStateStatus = "running" | "completed" | "blocked" | "failed" | "interrupted";
export type RecoveryDisposition = "resumable" | "needs_user" | "cleanup_only" | "failed" | "blocked";

export interface RuntimeOwnerState {
  instanceId: string;
  pid: number;
  startedAt: number;
}

export interface PersistedThreadState {
  threadId: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  activeTurnId?: string;
}

export interface PersistedTurnState {
  turnId: string;
  threadId: string;
  rootRunId: string;
  resultSchema?: "outcome-v1";
  status: TurnStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface PersistedRunState {
  runId: string;
  threadId: string;
  turnId: string;
  parentRunId?: string;
  toolCallId?: string;
  agentType: string;
  taskPreview: string;
  status: AgentRunStatus;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  statusDetail?: string;
  success?: boolean;
  steps?: number;
  usage?: TokenUsage;
  workspaceId?: string;
  artifactId?: string;
}

export interface PersistedToolRunState {
  toolRunId: string;
  threadId: string;
  turnId: string;
  runId: string;
  toolName: string;
  status: ToolRunStateStatus;
  /** Invocation identity for matching a successful retry, without storing arguments. */
  argumentsHash?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  /** Checkpoint and write fingerprints are durable audit evidence, not model
   * context. They allow recovery/rewind UI to distinguish safe from uncovered
   * mutations after a process restart. */
  checkpoint?: NonNullable<ToolResult["runtime"]>["checkpoint"];
  writeEvidence?: NonNullable<ToolResult["runtime"]>["writeEvidence"];
  execution?: NonNullable<ToolResult["runtime"]>["execution"];
  failure?: ToolResult["failure"];
}

export interface PersistedApprovalState {
  approvalId: string;
  threadId: string;
  turnId?: string;
  runId?: string;
  toolRunId?: string;
  toolName: string;
  argumentsHash: string;
  status: ApprovalStateStatus;
  requestedAt: number;
  updatedAt: number;
  resolvedAt?: number;
  error?: string;
}

export interface PersistedWorkspaceState {
  workspaceId: string;
  threadId: string;
  turnId?: string;
  runId: string;
  mode: WorkspaceMode;
  path: string;
  repoPath?: string;
  baseOid?: string;
  batchPath?: string;
  status: WorkspaceStateStatus;
  acquiredAt: number;
  updatedAt: number;
  releasedAt?: number;
  error?: string;
}

export interface PersistedArtifactState {
  mode?: "isolated-git" | "isolated-copy";
  artifactId: string;
  threadId: string;
  turnId?: string;
  runId: string;
  workspaceId: string;
  workspacePath?: string;
  repoPath?: string;
  baseOid?: string;
  resultOid?: string;
  changedPaths: string[];
  diffStat?: { additions: number; deletions: number; files: number };
  status: ArtifactStateStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedMergeState {
  mergeId: string;
  threadId: string;
  turnId?: string;
  artifactIds: string[];
  status: MergeStateStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  changedPaths?: string[];
  conflicts?: string[];
  error?: string;
}

export interface RuntimeRecoveryAction {
  disposition: RecoveryDisposition;
  entityType: "turn" | "run" | "tool_run" | "approval" | "workspace" | "artifact" | "merge";
  entityId: string;
  reason: string;
}

export interface RuntimeRecoveryReport {
  threadId: string;
  detectedAt: number;
  actions: RuntimeRecoveryAction[];
}

export interface RuntimeStateSnapshot {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  threadId: string;
  workspaceRoot: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Present only while this thread has an active turn. Recovery must not
   * classify the snapshot while the owning process is still alive. */
  owner?: RuntimeOwnerState;
  thread: PersistedThreadState;
  turns: Record<string, PersistedTurnState>;
  runs: Record<string, PersistedRunState>;
  toolRuns: Record<string, PersistedToolRunState>;
  approvals: Record<string, PersistedApprovalState>;
  workspaces: Record<string, PersistedWorkspaceState>;
  artifacts: Record<string, PersistedArtifactState>;
  merges: Record<string, PersistedMergeState>;
  /** Durable scheduler, dependency graph, mailbox, and Agent result state. */
  coordinator?: AgentCoordinatorState;
  attemptOutcomes: Record<string, PersistedAttemptOutcome>;
  recovery?: RuntimeRecoveryReport;
}

export type LegacyRuntimeStateSnapshot = Omit<
  RuntimeStateSnapshot,
  "schemaVersion" | "coordinator" | "attemptOutcomes"
> & {
  schemaVersion: typeof LEGACY_RUNTIME_STATE_SCHEMA_VERSION;
};

export type RuntimeStateSnapshotV2 = Omit<RuntimeStateSnapshot, "schemaVersion" | "attemptOutcomes"> & { schemaVersion: 2 };

export function createRuntimeStateSnapshot(input: {
  threadId: string;
  workspaceRoot: string;
  now: number;
}): RuntimeStateSnapshot {
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    thread: {
      threadId: input.threadId,
      status: "idle",
      createdAt: input.now,
      updatedAt: input.now,
    },
    turns: {},
    runs: {},
    toolRuns: {},
    approvals: {},
    workspaces: {},
    artifacts: {},
    merges: {},
    attemptOutcomes: {},
  };
}

// zapsdk/checkpoint/types.ts

export type BlobRef = {
  sha256: string;   // 64 hex chars
  size: number;     // bytes
};

export type FileBackup =
  | { kind: "present"; blob: BlobRef; mode: number }
  | { kind: "absent" };

export type RewindMode = "both" | "conversation" | "code";
export type CheckpointSkip = { path: string; reason: string };

export type Snapshot = {
  id: string;                               // snapshot uuid
  turnStartIndex: number;                   // index of this turn's first message; truncateAfter(turnStartIndex) reverts the whole turn (session system prompt kept)
  /** Legacy pre-turn journal row count. Kept so existing session files remain
   *  readable; it was historically (and incorrectly) also used as a UI index. */
  logIndex?: number;
  /** Persisted conversation-row count at turn start. Rewind markers use this
   *  value when reconstructing the fork from JSONL. */
  journalLogIndex?: number;
  /** In-memory transcript row count at turn start. UI rewind uses this value;
   *  it intentionally includes dividers and excludes merged stream chunks. */
  uiLogIndex?: number;
  sessionId: string;
  timestamp: string;                        // ISO 8601
  kind?: "turn";
  blobSessionId?: string;
  prompt?: string;
  skippedFiles?: CheckpointSkip[];
  fileTrackingEnabled?: boolean;
  trackedFiles: Record<string, FileBackup>; // 相对 cwd 的 posix 路径
  parentId: string | null;                  // 上一个 snapshot id，形成链
};

export type SnapshotIndex = {
  sessionId: string;
  snapshots: string[];       // 有序 snapshot id
  snapshotSequence: number;  // 单调递增（含淘汰的）
};

export type DiffStats = {
  filesChanged: Array<{
    path: string;
    insertions: number;
    deletions: number;
    binary?: boolean;
  }>;
  skippedFiles?: CheckpointSkip[];
  totalInsertions: number;
  totalDeletions: number;
};

export type RewindResult = {
  snapshotId: string;
  succeeded: string[];   // 成功恢复的 paths
  failed: Array<{ path: string; error: string }>;
  skipped?: CheckpointSkip[];
};

/** Coverage of the declared file paths only, not undeclared subprocess writes. */
export type CheckpointCoverage = {
  covered: boolean;
  uncoveredPaths: string[];
};

/** Host description of a tracker, not a grant or a promise of path coverage. */
export interface CheckpointCoverageFacts {
  scope: "workspace";
  root: string;
  enabled: boolean;
  maxFileBytes: number;
}

export interface CheckpointEditTracker {
  (paths: string[], options?: { required: boolean }): Promise<void | CheckpointCoverage>;
  readonly describeCoverage?: () => Readonly<CheckpointCoverageFacts>;
}

export type CheckpointConfig = {
  enabled: boolean;
  maxFileBytes: number;     // default 10 * 1024 * 1024
  maxSnapshots: number;     // default 100
  /** Opt-in session-private durable indexes and safe per-session blob GC. */
  managedStorage?: boolean;
  /** Expire private recovery points when their session is next accessed. */
  retentionDays?: number; // default 30
  maxStorageBytes?: number; // session-private unique blob budget, default 512 MiB
  blobDir?: string;         // default ~/.zapcode/projects/<project-id>/snapshots/blobs
};

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  maxFileBytes: 10 * 1024 * 1024,
  maxSnapshots: 100,
};

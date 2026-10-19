import type { RuntimeEvent } from "../runtime/types.js";

export const REAL_REPO_TASK_SCHEMA_VERSION = 1 as const;
export const TRAJECTORY_SCHEMA_VERSION = 1 as const;
export const REAL_REPO_CORPUS_SCHEMA_VERSION = 1 as const;
export const REAL_REPO_REPORT_SCHEMA_VERSION = 2 as const;

export type RealRepoCachePhase = "cold" | "warm" | "post_compact";
export type RealRepoSessionProfile = "short" | "long";

export interface RealRepoSessionScenario {
  profile: RealRepoSessionProfile;
  /** Minimum number of messages that the executor must exercise. */
  minimumMessages?: number;
  /** Require loading and continuing an existing persisted session. */
  resume?: boolean;
  /** Require compaction before the measured continuation. */
  compactBeforeRun?: boolean;
}

export interface RealRepoTaskManifest {
  schemaVersion: typeof REAL_REPO_TASK_SCHEMA_VERSION;
  id: string;
  title: string;
  repository: {
    url: string;
    commit: string;
  };
  prompt: string;
  /** Local execution is intentionally restricted to reviewed manifests.
   * Untrusted repository setup belongs in the future container runner. */
  execution: {
    mode: "local_trusted";
    setup?: string[];
    timeoutMs?: number;
  };
  grader: {
    commands: string[];
    forbiddenPaths?: string[];
    requiredPaths?: string[];
    minChangedFiles?: number;
    maxChangedFiles?: number;
    /** Efficiency gates. A configured gate fails closed when the executor
     * omits its corresponding metric. */
    maxSteps?: number;
    maxToolCalls?: number;
    maxFreshInputTokens?: number;
    /** Minimum provider-reported cache read share, from 0 to 1. */
    minCacheHitRate?: number;
  };
  tags?: string[];
}

export type TrajectoryEntryKind =
  | "attempt_started"
  | "runtime_event"
  | "setup_command"
  | "validation_command"
  | "workspace_snapshot"
  | "attempt_completed";

export interface TrajectoryEntry {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  sequence: number;
  timestamp: number;
  attemptId: string;
  taskId: string;
  kind: TrajectoryEntryKind;
  data: Record<string, string | number | boolean | null | string[]>;
}

export interface BenchmarkCommandResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface RealRepoGradeResult {
  passed: boolean;
  changedPaths: string[];
  commands: BenchmarkCommandResult[];
  forbiddenPathHits: string[];
  missingRequiredPaths: string[];
  failures: string[];
}

export interface RealRepoAttemptMetrics {
  durationMs: number;
  changedFileCount: number;
  validationPassRate: number;
  runtimeEventCount: number;
  steps?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  cacheHitRate?: number;
  cacheWriteChurnRate?: number;
  sessionMessages?: number;
  sessionResumed?: boolean;
  compactOccurred?: boolean;
}

export interface RealRepoTaskExecutionContext {
  task: RealRepoTaskManifest;
  cwd: string;
  cachePhase: RealRepoCachePhase;
  session?: RealRepoSessionScenario;
  signal: AbortSignal;
  recordRuntimeEvent(event: RuntimeEvent): void;
}

export interface RealRepoTaskExecutionResult {
  steps?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  sessionMessages?: number;
  sessionResumed?: boolean;
  compactOccurred?: boolean;
}

export interface RealRepoTaskExecutor {
  readonly isolation: "subprocess";
  execute(context: RealRepoTaskExecutionContext): Promise<RealRepoTaskExecutionResult>;
}

export interface RealRepoAttemptResult {
  attemptId: string;
  taskId: string;
  repositoryUrl: string;
  cachePhase: RealRepoCachePhase;
  session?: RealRepoSessionScenario;
  passed: boolean;
  sourceCommit: string;
  grade: RealRepoGradeResult;
  metrics: RealRepoAttemptMetrics;
  trajectory: TrajectoryEntry[];
  trajectoryPath?: string;
  error?: string;
}

export interface RealRepoCorpusTask {
  manifestPath: string;
  sourcePath?: string;
  attempts?: number;
  cachePhase?: RealRepoCachePhase;
  session?: RealRepoSessionScenario;
}

export interface RealRepoRegressionThresholds {
  minPassRate?: number;
  maxPassRateDrop?: number;
  maxMedianDurationIncreaseRatio?: number;
  maxMedianTokensIncreaseRatio?: number;
  minAttempts?: number;
  minRepositories?: number;
  requiredCachePhases?: RealRepoCachePhase[];
  minWarmCacheHitRateMedian?: number;
  minWarmCacheHitRateP10?: number;
  maxCacheWriteChurnRate?: number;
  /** Stable-operation write churn. Cold starts are reported but excluded
   * because a true cold prefix must be written by definition. */
  maxWarmCacheWriteChurnRate?: number;
  minProviderCacheAccountingCoverage?: number;
  minShortSessionAttempts?: number;
  minLongSessionAttempts?: number;
  minHundredMessageAttempts?: number;
  minResumedAttempts?: number;
  minPostCompactAttempts?: number;
}

export interface RealRepoCorpusManifest {
  schemaVersion: typeof REAL_REPO_CORPUS_SCHEMA_VERSION;
  id: string;
  tasks: RealRepoCorpusTask[];
  maxConcurrency?: number;
  thresholds?: RealRepoRegressionThresholds;
}

export interface RealRepoTaskSummary {
  taskId: string;
  attempts: number;
  passed: number;
  passRate: number;
  medianDurationMs: number;
  medianTokens?: number;
}

export interface RealRepoCachePhaseSummary {
  phase: RealRepoCachePhase;
  attempts: number;
  providerCacheAccountingCoverage: number;
  cacheHitRateSamples: number;
  medianCacheHitRate?: number;
  p10CacheHitRate?: number;
  cacheWriteChurnRate?: number;
}

export interface RealRepoScenarioCoverage {
  repositories: number;
  shortSessionAttempts: number;
  longSessionAttempts: number;
  hundredMessageAttempts: number;
  resumedAttempts: number;
  postCompactAttempts: number;
}

export interface RealRepoBenchmarkReport {
  schemaVersion: typeof REAL_REPO_REPORT_SCHEMA_VERSION;
  corpusId: string;
  createdAt: number;
  attempts: RealRepoAttemptResult[];
  tasks: RealRepoTaskSummary[];
  aggregate: {
    attempts: number;
    passed: number;
    passRate: number;
    medianDurationMs: number;
    p95DurationMs: number;
    medianTokens?: number;
    providerCacheAccountingCoverage: number;
    cacheWriteChurnRate?: number;
    cachePhases: RealRepoCachePhaseSummary[];
    scenarioCoverage: RealRepoScenarioCoverage;
  };
  regression: {
    passed: boolean;
    failures: string[];
  };
}

export interface RealRepoResolvedTask {
  task: RealRepoTaskManifest;
  sourcePath: string;
  attempts?: number;
  cachePhase?: RealRepoCachePhase;
  session?: RealRepoSessionScenario;
}

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runRealRepoTask } from "./runner.js";
import type { RuntimeBenchmarkExecutor } from "./runtime-executor.js";
import {
  REAL_REPO_CORPUS_SCHEMA_VERSION,
  REAL_REPO_REPORT_SCHEMA_VERSION,
  type RealRepoAttemptResult,
  type RealRepoBenchmarkReport,
  type RealRepoCachePhase,
  type RealRepoCachePhaseSummary,
  type RealRepoCorpusManifest,
  type RealRepoRegressionThresholds,
  type RealRepoResolvedTask,
  type RealRepoScenarioCoverage,
  type RealRepoTaskSummary,
} from "./types.js";

const CACHE_PHASES: RealRepoCachePhase[] = ["cold", "warm", "post_compact"];

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function totalTokens(attempt: RealRepoAttemptResult): number | undefined {
  const values = [
    attempt.metrics.inputTokens,
    attempt.metrics.outputTokens,
    attempt.metrics.cacheReadTokens,
    attempt.metrics.cacheWriteTokens,
  ].filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function taskSummaries(attempts: RealRepoAttemptResult[]): RealRepoTaskSummary[] {
  const ids = [...new Set(attempts.map((attempt) => attempt.taskId))].sort();
  return ids.map((taskId) => {
    const selected = attempts.filter((attempt) => attempt.taskId === taskId);
    const passed = selected.filter((attempt) => attempt.passed).length;
    const tokens = selected.flatMap((attempt) => {
      const value = totalTokens(attempt);
      return value === undefined ? [] : [value];
    });
    return {
      taskId,
      attempts: selected.length,
      passed,
      passRate: selected.length === 0 ? 0 : passed / selected.length,
      medianDurationMs: median(selected.map((attempt) => attempt.metrics.durationMs)),
      ...(tokens.length > 0 ? { medianTokens: median(tokens) } : {}),
    };
  });
}

function hasProviderCacheAccounting(attempt: RealRepoAttemptResult): boolean {
  return attempt.metrics.inputTokens !== undefined
    && attempt.metrics.cacheReadTokens !== undefined
    && (
      attempt.metrics.cacheWriteTokens !== undefined
      || attempt.metrics.cacheMissTokens !== undefined
    );
}

function cacheWriteChurnRate(attempts: RealRepoAttemptResult[]): number | undefined {
  let promptTokens = 0;
  let writeTokens = 0;
  for (const attempt of attempts) {
    if (!hasProviderCacheAccounting(attempt)) continue;
    if (attempt.metrics.cacheWriteTokens !== undefined) {
      promptTokens += attempt.metrics.inputTokens!
        + attempt.metrics.cacheReadTokens!
        + attempt.metrics.cacheWriteTokens;
      writeTokens += attempt.metrics.cacheWriteTokens;
    } else {
      promptTokens += attempt.metrics.cacheReadTokens! + attempt.metrics.cacheMissTokens!;
      writeTokens += attempt.metrics.cacheMissTokens!;
    }
  }
  return promptTokens > 0 ? writeTokens / promptTokens : undefined;
}

function cachePhaseSummaries(attempts: RealRepoAttemptResult[]): RealRepoCachePhaseSummary[] {
  return CACHE_PHASES.map((phase) => {
    const selected = attempts.filter((attempt) => attempt.cachePhase === phase);
    const accounted = selected.filter(hasProviderCacheAccounting).length;
    const hitRates = selected.flatMap((attempt) => (
      attempt.metrics.cacheHitRate === undefined ? [] : [attempt.metrics.cacheHitRate]
    ));
    const churn = cacheWriteChurnRate(selected);
    return {
      phase,
      attempts: selected.length,
      providerCacheAccountingCoverage: selected.length === 0 ? 0 : accounted / selected.length,
      cacheHitRateSamples: hitRates.length,
      ...(hitRates.length > 0 ? {
        medianCacheHitRate: median(hitRates),
        p10CacheHitRate: percentile(hitRates, 0.1),
      } : {}),
      ...(churn === undefined ? {} : { cacheWriteChurnRate: churn }),
    };
  });
}

function scenarioSatisfied(attempt: RealRepoAttemptResult): boolean {
  const scenario = attempt.session;
  if (!scenario || attempt.metrics.sessionMessages === undefined) return false;
  if (scenario.minimumMessages !== undefined && attempt.metrics.sessionMessages < scenario.minimumMessages) return false;
  if (scenario.resume && attempt.metrics.sessionResumed !== true) return false;
  if (scenario.compactBeforeRun && attempt.metrics.compactOccurred !== true) return false;
  return true;
}

function scenarioCoverage(attempts: RealRepoAttemptResult[]): RealRepoScenarioCoverage {
  return {
    repositories: new Set(attempts.map((attempt) => attempt.repositoryUrl).filter(Boolean)).size,
    shortSessionAttempts: attempts.filter((attempt) => (
      attempt.session?.profile === "short" && scenarioSatisfied(attempt)
    )).length,
    longSessionAttempts: attempts.filter((attempt) => (
      attempt.session?.profile === "long" && scenarioSatisfied(attempt)
    )).length,
    hundredMessageAttempts: attempts.filter((attempt) => (attempt.metrics.sessionMessages ?? 0) >= 100).length,
    resumedAttempts: attempts.filter((attempt) => attempt.metrics.sessionResumed === true).length,
    postCompactAttempts: attempts.filter((attempt) => (
      attempt.cachePhase === "post_compact" && attempt.metrics.compactOccurred === true
    )).length,
  };
}

function validateThresholds(thresholds: RealRepoRegressionThresholds | undefined): void {
  if (!thresholds) return;
  for (const key of [
    "minPassRate",
    "maxPassRateDrop",
    "minWarmCacheHitRateMedian",
    "minWarmCacheHitRateP10",
    "maxCacheWriteChurnRate",
    "maxWarmCacheWriteChurnRate",
    "minProviderCacheAccountingCoverage",
  ] as const) {
    const value = thresholds[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`Real-repo threshold ${key} must be between 0 and 1`);
    }
  }
  for (const key of ["maxMedianDurationIncreaseRatio", "maxMedianTokensIncreaseRatio"] as const) {
    const value = thresholds[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Real-repo threshold ${key} must be non-negative`);
    }
  }
  for (const key of [
    "minAttempts",
    "minRepositories",
    "minShortSessionAttempts",
    "minLongSessionAttempts",
    "minHundredMessageAttempts",
    "minResumedAttempts",
    "minPostCompactAttempts",
  ] as const) {
    const value = thresholds[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Real-repo threshold ${key} must be a non-negative safe integer`);
    }
  }
  for (const phase of thresholds.requiredCachePhases ?? []) {
    if (!CACHE_PHASES.includes(phase)) throw new Error(`Unsupported real-repo cache phase: ${phase}`);
  }
}

export function evaluateRegression(input: {
  aggregate: RealRepoBenchmarkReport["aggregate"];
  thresholds?: RealRepoRegressionThresholds;
  baseline?: RealRepoBenchmarkReport;
}): RealRepoBenchmarkReport["regression"] {
  const failures: string[] = [];
  const thresholds = input.thresholds ?? {};
  if (thresholds.minPassRate !== undefined && input.aggregate.passRate < thresholds.minPassRate) {
    failures.push(`pass rate ${input.aggregate.passRate.toFixed(3)} is below ${thresholds.minPassRate.toFixed(3)}`);
  }
  if (input.baseline && thresholds.maxPassRateDrop !== undefined) {
    const drop = input.baseline.aggregate.passRate - input.aggregate.passRate;
    if (drop > thresholds.maxPassRateDrop) failures.push(`pass rate dropped by ${drop.toFixed(3)}`);
  }
  if (input.baseline && thresholds.maxMedianDurationIncreaseRatio !== undefined
    && input.baseline.aggregate.medianDurationMs > 0) {
    const ratio = input.aggregate.medianDurationMs / input.baseline.aggregate.medianDurationMs - 1;
    if (ratio > thresholds.maxMedianDurationIncreaseRatio) failures.push(`median duration increased by ${(ratio * 100).toFixed(1)}%`);
  }
  if (input.baseline && thresholds.maxMedianTokensIncreaseRatio !== undefined
    && input.baseline.aggregate.medianTokens && input.aggregate.medianTokens !== undefined) {
    const ratio = input.aggregate.medianTokens / input.baseline.aggregate.medianTokens - 1;
    if (ratio > thresholds.maxMedianTokensIncreaseRatio) failures.push(`median tokens increased by ${(ratio * 100).toFixed(1)}%`);
  }
  if (thresholds.minAttempts !== undefined && input.aggregate.attempts < thresholds.minAttempts) {
    failures.push(`trajectory count ${input.aggregate.attempts} is below ${thresholds.minAttempts}`);
  }
  if (thresholds.minRepositories !== undefined
    && input.aggregate.scenarioCoverage.repositories < thresholds.minRepositories) {
    failures.push(
      `repository count ${input.aggregate.scenarioCoverage.repositories} is below ${thresholds.minRepositories}`,
    );
  }
  for (const phase of thresholds.requiredCachePhases ?? []) {
    const summary = input.aggregate.cachePhases.find((value) => value.phase === phase);
    if (!summary || summary.attempts === 0) failures.push(`cache phase ${phase} has no trajectories`);
  }
  const warm = input.aggregate.cachePhases.find((value) => value.phase === "warm");
  if (thresholds.minWarmCacheHitRateMedian !== undefined) {
    if (warm?.medianCacheHitRate === undefined) {
      failures.push("warm cache median gate has no provider cache samples");
    } else if (warm.medianCacheHitRate < thresholds.minWarmCacheHitRateMedian) {
      failures.push(
        `warm cache median ${(warm.medianCacheHitRate * 100).toFixed(2)}% is below `
        + `${(thresholds.minWarmCacheHitRateMedian * 100).toFixed(2)}%`,
      );
    }
  }
  if (thresholds.minWarmCacheHitRateP10 !== undefined) {
    if (warm?.p10CacheHitRate === undefined) {
      failures.push("warm cache P10 gate has no provider cache samples");
    } else if (warm.p10CacheHitRate < thresholds.minWarmCacheHitRateP10) {
      failures.push(
        `warm cache P10 ${(warm.p10CacheHitRate * 100).toFixed(2)}% is below `
        + `${(thresholds.minWarmCacheHitRateP10 * 100).toFixed(2)}%`,
      );
    }
  }
  if (thresholds.maxCacheWriteChurnRate !== undefined) {
    if (input.aggregate.cacheWriteChurnRate === undefined) {
      failures.push("cache write churn gate has no provider cache samples");
    } else if (input.aggregate.cacheWriteChurnRate > thresholds.maxCacheWriteChurnRate) {
      failures.push(
        `cache write churn ${(input.aggregate.cacheWriteChurnRate * 100).toFixed(2)}% exceeds `
        + `${(thresholds.maxCacheWriteChurnRate * 100).toFixed(2)}%`,
      );
    }
  }
  if (thresholds.maxWarmCacheWriteChurnRate !== undefined) {
    if (warm?.cacheWriteChurnRate === undefined) {
      failures.push("warm cache write churn gate has no provider cache samples");
    } else if (warm.cacheWriteChurnRate > thresholds.maxWarmCacheWriteChurnRate) {
      failures.push(
        `warm cache write churn ${(warm.cacheWriteChurnRate * 100).toFixed(2)}% exceeds `
        + `${(thresholds.maxWarmCacheWriteChurnRate * 100).toFixed(2)}%`,
      );
    }
  }
  if (thresholds.minProviderCacheAccountingCoverage !== undefined
    && input.aggregate.providerCacheAccountingCoverage < thresholds.minProviderCacheAccountingCoverage) {
    failures.push(
      `provider cache accounting coverage ${(input.aggregate.providerCacheAccountingCoverage * 100).toFixed(2)}% is below `
      + `${(thresholds.minProviderCacheAccountingCoverage * 100).toFixed(2)}%`,
    );
  }
  const coverageGates = [
    ["minShortSessionAttempts", "shortSessionAttempts", "short-session trajectories"],
    ["minLongSessionAttempts", "longSessionAttempts", "long-session trajectories"],
    ["minHundredMessageAttempts", "hundredMessageAttempts", "100+ message trajectories"],
    ["minResumedAttempts", "resumedAttempts", "resumed trajectories"],
    ["minPostCompactAttempts", "postCompactAttempts", "post-compact trajectories"],
  ] as const;
  for (const [thresholdKey, coverageKey, label] of coverageGates) {
    const minimum = thresholds[thresholdKey];
    if (minimum !== undefined && input.aggregate.scenarioCoverage[coverageKey] < minimum) {
      failures.push(`${label} ${input.aggregate.scenarioCoverage[coverageKey]} is below ${minimum}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export async function runRealRepoCorpus(input: {
  corpus: RealRepoCorpusManifest;
  tasks: RealRepoResolvedTask[];
  outputDirectory: string;
  executor: RuntimeBenchmarkExecutor;
  baseline?: RealRepoBenchmarkReport;
  signal?: AbortSignal;
  clock?: () => number;
  /** Previously checkpointed attempts from this exact corpus. Matching jobs
   * are skipped; mismatches fail closed instead of contaminating a report. */
  resumeAttempts?: RealRepoAttemptResult[];
  onAttempt?: (attempt: RealRepoAttemptResult, completed: number, total: number) => void | Promise<void>;
}): Promise<RealRepoBenchmarkReport> {
  if (input.corpus.schemaVersion !== REAL_REPO_CORPUS_SCHEMA_VERSION) throw new Error("Unsupported real-repo corpus schema");
  if (!input.corpus.id.trim()) throw new Error("Real-repo corpus id is required");
  if (input.tasks.length === 0) throw new Error("Real-repo corpus requires at least one task");
  validateThresholds(input.corpus.thresholds);
  if (input.corpus.maxConcurrency !== undefined && (
    !Number.isSafeInteger(input.corpus.maxConcurrency) || input.corpus.maxConcurrency < 1
  )) {
    throw new Error("Real-repo corpus maxConcurrency must be a positive safe integer");
  }
  for (const resolvedTask of input.tasks) {
    if (resolvedTask.attempts !== undefined && (
      !Number.isSafeInteger(resolvedTask.attempts) || resolvedTask.attempts < 1
    )) {
      throw new Error("Real-repo task attempts must be a positive safe integer");
    }
  }
  const jobs = input.tasks.flatMap((resolvedTask, taskIndex) => Array.from(
    { length: resolvedTask.attempts ?? 1 },
    (_, index) => ({
      ...resolvedTask,
      taskIndex,
      index,
      attemptId: `${resolvedTask.task.id}-${taskIndex + 1}-${index + 1}`,
    }),
  ));
  const jobsByAttemptId = new Map(jobs.map((job) => [job.attemptId, job]));
  const resumed = input.resumeAttempts ?? [];
  const resumedIds = new Set<string>();
  for (const attempt of resumed) {
    if (resumedIds.has(attempt.attemptId)) {
      throw new Error(`Duplicate resumed real-repo attempt: ${attempt.attemptId}`);
    }
    resumedIds.add(attempt.attemptId);
    const job = jobsByAttemptId.get(attempt.attemptId);
    if (!job
      || attempt.taskId !== job.task.id
      || attempt.repositoryUrl !== job.task.repository.url
      || attempt.sourceCommit !== job.task.repository.commit
      || attempt.cachePhase !== (job.cachePhase ?? "warm")) {
      throw new Error(`Resumed real-repo attempt does not match corpus job: ${attempt.attemptId}`);
    }
  }
  const attempts: RealRepoAttemptResult[] = [...resumed];
  const pendingJobs = jobs.filter((job) => !resumedIds.has(job.attemptId));
  let cursor = 0;
  const workerCount = pendingJobs.length === 0
    ? 0
    : Math.max(1, Math.min(input.corpus.maxConcurrency ?? 1, pendingJobs.length));
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    while (cursor < pendingJobs.length) {
      const job = pendingJobs[cursor++];
      if (!job) return;
      const attempt = await runRealRepoTask({
        task: job.task,
        sourcePath: job.sourcePath,
        outputDirectory: input.outputDirectory,
        executor: input.executor,
        attemptId: job.attemptId,
        cachePhase: job.cachePhase,
        session: job.session,
        signal: input.signal,
        workspaceKey: `worker-${workerIndex + 1}`,
      });
      attempts.push(attempt);
      await input.onAttempt?.(attempt, attempts.length, jobs.length);
    }
  });
  await Promise.all(workers);
  attempts.sort((left, right) => left.taskId.localeCompare(right.taskId) || left.attemptId.localeCompare(right.attemptId));
  const tasks = taskSummaries(attempts);
  const passed = attempts.filter((attempt) => attempt.passed).length;
  const durations = attempts.map((attempt) => attempt.metrics.durationMs);
  const tokens = attempts.flatMap((attempt) => {
    const value = totalTokens(attempt);
    return value === undefined ? [] : [value];
  });
  const aggregateChurn = cacheWriteChurnRate(attempts);
  const aggregate: RealRepoBenchmarkReport["aggregate"] = {
    attempts: attempts.length,
    passed,
    passRate: attempts.length === 0 ? 0 : passed / attempts.length,
    medianDurationMs: median(durations),
    p95DurationMs: percentile(durations, 0.95),
    ...(tokens.length > 0 ? { medianTokens: median(tokens) } : {}),
    providerCacheAccountingCoverage: attempts.length === 0
      ? 0
      : attempts.filter(hasProviderCacheAccounting).length / attempts.length,
    ...(aggregateChurn === undefined
      ? {}
      : { cacheWriteChurnRate: aggregateChurn }),
    cachePhases: cachePhaseSummaries(attempts),
    scenarioCoverage: scenarioCoverage(attempts),
  };
  return {
    schemaVersion: REAL_REPO_REPORT_SCHEMA_VERSION,
    corpusId: input.corpus.id,
    createdAt: (input.clock ?? Date.now)(),
    attempts,
    tasks,
    aggregate,
    regression: evaluateRegression({ aggregate, thresholds: input.corpus.thresholds, baseline: input.baseline }),
  };
}

export async function writeRealRepoReport(path: string, report: RealRepoBenchmarkReport): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.${process.pid}.tmp`;
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, absolute);
  if (process.platform !== "win32") await chmod(absolute, 0o600);
}

export async function readRealRepoReport(path: string): Promise<RealRepoBenchmarkReport> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  const report = value as Omit<Partial<RealRepoBenchmarkReport>, "schemaVersion" | "aggregate" | "attempts"> & {
    schemaVersion?: number;
    aggregate?: RealRepoBenchmarkReport["aggregate"];
    attempts?: RealRepoAttemptResult[];
  };
  if ((report.schemaVersion !== 1 && report.schemaVersion !== REAL_REPO_REPORT_SCHEMA_VERSION)
    || !report.aggregate || !Array.isArray(report.attempts)) {
    throw new Error(`Invalid real-repo benchmark report: ${path}`);
  }
  if (report.schemaVersion === REAL_REPO_REPORT_SCHEMA_VERSION) {
    if (!Array.isArray(report.aggregate.cachePhases) || !report.aggregate.scenarioCoverage) {
      throw new Error(`Invalid real-repo benchmark report: ${path}`);
    }
    return report as RealRepoBenchmarkReport;
  }
  const attempts = report.attempts.map((attempt) => ({
    ...attempt,
    repositoryUrl: typeof attempt.repositoryUrl === "string" ? attempt.repositoryUrl : "",
    cachePhase: CACHE_PHASES.includes(attempt.cachePhase) ? attempt.cachePhase : "warm" as const,
  }));
  const churn = cacheWriteChurnRate(attempts);
  return {
    ...(report as Omit<RealRepoBenchmarkReport, "schemaVersion" | "attempts" | "aggregate">),
    schemaVersion: REAL_REPO_REPORT_SCHEMA_VERSION,
    attempts,
    aggregate: {
      ...report.aggregate,
      providerCacheAccountingCoverage: attempts.length === 0
        ? 0
        : attempts.filter(hasProviderCacheAccounting).length / attempts.length,
      ...(churn === undefined ? {} : { cacheWriteChurnRate: churn }),
      cachePhases: cachePhaseSummaries(attempts),
      scenarioCoverage: scenarioCoverage(attempts),
    },
  };
}

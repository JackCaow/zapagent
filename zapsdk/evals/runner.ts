import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBenchmarkCommand, runBenchmarkProcess } from "./command.js";
import { computeCacheUsageStats } from "../agent/cache-metrics.js";
import { gradeRealRepoTask } from "./grader.js";
import { RuntimeBenchmarkExecutor } from "./runtime-executor.js";
import { TrajectoryRecorder } from "./trajectory.js";
import {
  REAL_REPO_TASK_SCHEMA_VERSION,
  type BenchmarkCommandResult,
  type RealRepoAttemptResult,
  type RealRepoCachePhase,
  type RealRepoSessionScenario,
  type RealRepoTaskManifest,
} from "./types.js";

function validateTask(task: RealRepoTaskManifest): void {
  if (task.schemaVersion !== REAL_REPO_TASK_SCHEMA_VERSION) {
    throw new Error(`Unsupported real-repo task schema: ${task.schemaVersion}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(task.id)) {
    throw new Error("Real-repo task id must be a filesystem-safe identifier");
  }
  if (!/^[0-9a-f]{40}$/i.test(task.repository.commit)) {
    throw new Error(`Task ${task.id} requires a full pinned commit`);
  }
  if (!task.prompt.trim()) throw new Error(`Task ${task.id} prompt is required`);
  if (task.execution.mode !== "local_trusted") {
    throw new Error(`Task ${task.id} requires a supported execution mode`);
  }
  if (task.grader.commands.length === 0) {
    throw new Error(`Task ${task.id} requires at least one validation command`);
  }
  for (const key of ["maxSteps", "maxToolCalls", "maxFreshInputTokens"] as const) {
    const value = task.grader[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Task ${task.id} grader.${key} must be a non-negative safe integer`);
    }
  }
  const minCacheHitRate = task.grader.minCacheHitRate;
  if (minCacheHitRate !== undefined && (
    !Number.isFinite(minCacheHitRate) || minCacheHitRate < 0 || minCacheHitRate > 1
  )) {
    throw new Error(`Task ${task.id} grader.minCacheHitRate must be between 0 and 1`);
  }
}

function cacheHitRate(
  metrics: Awaited<ReturnType<RuntimeBenchmarkExecutor["execute"]>>,
): number | undefined {
  if (metrics.cacheReadTokens !== undefined && metrics.cacheMissTokens !== undefined) {
    const total = metrics.cacheReadTokens + metrics.cacheMissTokens;
    return total > 0 ? metrics.cacheReadTokens / total : undefined;
  }
  if (
    metrics.inputTokens === undefined ||
    metrics.cacheReadTokens === undefined ||
    metrics.cacheWriteTokens === undefined
  ) return undefined;
  return computeCacheUsageStats({
    inputTokens: metrics.inputTokens,
    cacheReadInputTokens: metrics.cacheReadTokens,
    cacheCreationInputTokens: metrics.cacheWriteTokens,
  }).cacheHitRatio ?? undefined;
}

function cacheWriteChurnRate(
  metrics: Awaited<ReturnType<RuntimeBenchmarkExecutor["execute"]>>,
): number | undefined {
  if (metrics.cacheWriteTokens === undefined
    && metrics.cacheReadTokens !== undefined
    && metrics.cacheMissTokens !== undefined) {
    const total = metrics.cacheReadTokens + metrics.cacheMissTokens;
    return total > 0 ? metrics.cacheMissTokens / total : undefined;
  }
  if (
    metrics.inputTokens === undefined ||
    metrics.cacheReadTokens === undefined ||
    metrics.cacheWriteTokens === undefined
  ) return undefined;
  return computeCacheUsageStats({
    inputTokens: metrics.inputTokens,
    cacheReadInputTokens: metrics.cacheReadTokens,
    cacheCreationInputTokens: metrics.cacheWriteTokens,
  }).cacheWriteRatio ?? undefined;
}

function validateSessionScenario(session: RealRepoSessionScenario | undefined): void {
  if (!session) return;
  if (session.profile !== "short" && session.profile !== "long") {
    throw new Error("Real-repo session profile must be short or long");
  }
  if (session.minimumMessages !== undefined && (
    !Number.isSafeInteger(session.minimumMessages) || session.minimumMessages < 0
  )) {
    throw new Error("Real-repo session minimumMessages must be a non-negative safe integer");
  }
  if (session.resume !== undefined && typeof session.resume !== "boolean") {
    throw new Error("Real-repo session resume must be a boolean");
  }
  if (session.compactBeforeRun !== undefined && typeof session.compactBeforeRun !== "boolean") {
    throw new Error("Real-repo session compactBeforeRun must be a boolean");
  }
}

function applyEfficiencyGates(
  task: RealRepoTaskManifest,
  grade: Awaited<ReturnType<typeof gradeRealRepoTask>>,
  metrics: Awaited<ReturnType<RuntimeBenchmarkExecutor["execute"]>>,
  session?: RealRepoSessionScenario,
): typeof grade {
  const failures = [...grade.failures];
  const gates = [
    ["maxSteps", "steps", "steps"],
    ["maxToolCalls", "toolCalls", "tool calls"],
    ["maxFreshInputTokens", "inputTokens", "fresh input tokens"],
  ] as const;
  for (const [gateName, metricName, label] of gates) {
    const limit = task.grader[gateName];
    if (limit === undefined) continue;
    const actual = metrics[metricName];
    if (actual === undefined) {
      failures.push(`${gateName} gate requires executor metric ${metricName}`);
    } else if (actual > limit) {
      failures.push(`${label} ${actual} exceeds ${gateName}=${limit}`);
    }
  }
  const minimumCacheHitRate = task.grader.minCacheHitRate;
  if (minimumCacheHitRate !== undefined) {
    const actual = cacheHitRate(metrics);
    if (actual === undefined) {
      failures.push(
        "minCacheHitRate gate requires executor metrics inputTokens, cacheReadTokens, and cacheWriteTokens or cacheMissTokens",
      );
    } else if (actual < minimumCacheHitRate) {
      failures.push(
        `cache hit rate ${(actual * 100).toFixed(2)}% is below ` +
        `minCacheHitRate=${(minimumCacheHitRate * 100).toFixed(2)}%`,
      );
    }
  }
  if (session?.minimumMessages !== undefined) {
    if (metrics.sessionMessages === undefined) {
      failures.push("session scenario requires executor metric sessionMessages");
    } else if (metrics.sessionMessages < session.minimumMessages) {
      failures.push(
        `session messages ${metrics.sessionMessages} is below minimumMessages=${session.minimumMessages}`,
      );
    }
  }
  if (session?.resume && metrics.sessionResumed !== true) {
    failures.push("session resume scenario requires executor metric sessionResumed=true");
  }
  if (session?.compactBeforeRun && metrics.compactOccurred !== true) {
    failures.push("post-compact scenario requires executor metric compactOccurred=true");
  }
  return { ...grade, passed: grade.passed && failures.length === 0, failures };
}

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<BenchmarkCommandResult> {
  const result = await runBenchmarkProcess({
    executable: "git",
    args,
    cwd,
    timeoutMs: 60_000,
    signal,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || result.command);
  return result;
}

export async function runRealRepoTask(input: {
  task: RealRepoTaskManifest;
  sourcePath: string;
  outputDirectory: string;
  executor: RuntimeBenchmarkExecutor;
  attemptId?: string;
  cachePhase?: RealRepoCachePhase;
  session?: RealRepoSessionScenario;
  signal?: AbortSignal;
  keepWorkspace?: boolean;
  /** Stable, runner-owned worktree slot. Reusing a slot keeps cwd-dependent
   * prompt prefixes stable across warm attempts without sharing file state. */
  workspaceKey?: string;
}): Promise<RealRepoAttemptResult> {
  validateTask(input.task);
  validateSessionScenario(input.session);
  const cachePhase = input.cachePhase ?? "warm";
  if (cachePhase !== "cold" && cachePhase !== "warm" && cachePhase !== "post_compact") {
    throw new Error(`Unsupported real-repo cache phase: ${cachePhase}`);
  }
  if (cachePhase === "post_compact" && input.session?.compactBeforeRun !== true) {
    throw new Error("post_compact benchmark attempts require session.compactBeforeRun=true");
  }
  if (!(input.executor instanceof RuntimeBenchmarkExecutor)) {
    throw new Error("Real-repo benchmarks require RuntimeBenchmarkExecutor subprocess isolation");
  }
  const attemptId = input.attemptId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(attemptId)) {
    throw new Error("Real-repo attempt id must be a filesystem-safe identifier");
  }
  if (input.workspaceKey !== undefined
    && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.workspaceKey)) {
    throw new Error("Real-repo workspace key must be a filesystem-safe identifier");
  }
  const recorder = new TrajectoryRecorder(attemptId, input.task.id);
  const root = resolve(input.outputDirectory);
  const workspace = join(root, "workspaces", input.workspaceKey ?? attemptId);
  const trajectoryPath = join(root, "trajectories", `${attemptId}.jsonl`);
  const controller = new AbortController();
  let deadlineExpired = false;
  const forwardAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(
    () => {
      deadlineExpired = true;
      controller.abort(new Error("real-repo task timeout"));
    },
    input.task.execution.timeoutMs ?? 15 * 60_000,
  );
  const startedAt = performance.now();
  let runtimeEventCount = 0;
  let sourceCommit = input.task.repository.commit;
  let executionResult: Awaited<ReturnType<RuntimeBenchmarkExecutor["execute"]>> = {};
  let executionError: string | undefined;
  let workspaceCreated = false;
  recorder.record("attempt_started", {
    repository: input.task.repository.url,
    commit: input.task.repository.commit,
    cachePhase,
    sessionProfile: input.session?.profile ?? null,
    promptHash: createHash("sha256").update(input.task.prompt).digest("hex"),
  });
  try {
    await mkdir(join(root, "workspaces"), { recursive: true, mode: 0o700 });
    if (input.workspaceKey) {
      await runGit(["worktree", "remove", "--force", workspace], resolve(input.sourcePath))
        .catch(() => rm(workspace, { recursive: true, force: true }));
      await runGit(["worktree", "prune"], resolve(input.sourcePath));
    }
    await runGit(
      ["worktree", "add", "--detach", workspace, input.task.repository.commit],
      resolve(input.sourcePath),
      controller.signal,
    );
    workspaceCreated = true;
    const rev = await runBenchmarkCommand({
      command: "git rev-parse HEAD",
      cwd: workspace,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    if (rev.exitCode !== 0) throw new Error(rev.stderr || "Unable to resolve benchmark commit");
    sourceCommit = rev.stdout.trim();
    if (!sourceCommit.startsWith(input.task.repository.commit)) {
      throw new Error(`Benchmark commit mismatch: expected ${input.task.repository.commit}, found ${sourceCommit}`);
    }
    for (const command of input.task.execution.setup ?? []) {
      const result = await runBenchmarkCommand({
        command,
        cwd: workspace,
        timeoutMs: input.task.execution.timeoutMs ?? 15 * 60_000,
        signal: controller.signal,
      });
      recorder.record("setup_command", commandData(result));
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`Benchmark setup failed: ${command}`);
      }
    }
    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("benchmark aborted");
      }
      executionResult = await input.executor.execute({
        task: input.task,
        cwd: workspace,
        cachePhase,
        session: input.session,
        signal: controller.signal,
        recordRuntimeEvent: (event) => {
          runtimeEventCount++;
          recorder.recordRuntimeEvent(event);
        },
      });
    } catch (error) {
      executionError = deadlineExpired
        ? "real-repo task timeout"
        : error instanceof Error ? error.message : String(error);
    }
    const correctnessGrade = await gradeRealRepoTask({
      task: input.task,
      cwd: workspace,
      signal: controller.signal,
      onCommand: (result) => { recorder.record("validation_command", commandData(result)); },
    });
    const grade = applyEfficiencyGates(input.task, correctnessGrade, executionResult, input.session);
    const measuredCacheHitRate = cacheHitRate(executionResult);
    const measuredCacheWriteChurnRate = cacheWriteChurnRate(executionResult);
    recorder.record("workspace_snapshot", {
      changedPaths: grade.changedPaths,
      changedFileCount: grade.changedPaths.length,
    });
    const passed = grade.passed && executionError === undefined;
    const durationMs = performance.now() - startedAt;
    recorder.record("attempt_completed", {
      passed,
      durationMs,
      changedFileCount: grade.changedPaths.length,
      failureCount: grade.failures.length + (executionError ? 1 : 0),
    });
    await recorder.writeJsonl(trajectoryPath);
    return {
      attemptId,
      taskId: input.task.id,
      repositoryUrl: input.task.repository.url,
      cachePhase,
      ...(input.session ? { session: input.session } : {}),
      passed,
      sourceCommit,
      grade,
      metrics: {
        durationMs,
        changedFileCount: grade.changedPaths.length,
        validationPassRate: grade.commands.length === 0
          ? 1
          : grade.commands.filter((result) => result.exitCode === 0 && !result.timedOut).length
            / grade.commands.length,
        runtimeEventCount,
        ...executionResult,
        ...(measuredCacheHitRate === undefined ? {} : { cacheHitRate: measuredCacheHitRate }),
        ...(measuredCacheWriteChurnRate === undefined
          ? {}
          : { cacheWriteChurnRate: measuredCacheWriteChurnRate }),
      },
      trajectory: recorder.snapshot(),
      trajectoryPath,
      error: executionError,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", forwardAbort);
    if (workspaceCreated && !input.keepWorkspace) {
      await runGit(["worktree", "remove", "--force", workspace], resolve(input.sourcePath))
        .catch(() => rm(workspace, { recursive: true, force: true }));
    }
  }
}

function commandData(result: BenchmarkCommandResult) {
  return {
    command: result.command,
    exitCode: result.exitCode ?? -1,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
  };
}

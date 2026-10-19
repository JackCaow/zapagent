import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmarkProcess } from "../../evals/command.js";
import {
  evaluateRegression,
  readRealRepoReport,
  runRealRepoCorpus,
  writeRealRepoReport,
} from "../../evals/corpus.js";
import { RuntimeBenchmarkExecutor } from "../../evals/runtime-executor.js";
import type {
  RealRepoBenchmarkReport,
  RealRepoCorpusManifest,
  RealRepoRegressionThresholds,
  RealRepoTaskManifest,
} from "../../evals/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runBenchmarkProcess({ executable: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zap-corpus-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await git(source, ["init"]);
  await writeFile(join(source, "value.txt"), "old\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "user.name=Eval", "-c", "user.email=eval@example.invalid", "commit", "-m", "base"]);
  return { root, source, commit: await git(source, ["rev-parse", "HEAD"]) };
}

function task(id: string, commit: string, prompt = "replace value"): RealRepoTaskManifest {
  return {
    schemaVersion: 1,
    id,
    title: id,
    repository: { url: "https://example.invalid/repo.git", commit },
    prompt,
    execution: { mode: "local_trusted", timeoutMs: 30_000 },
    grader: {
      commands: ["test \"$(cat value.txt)\" = new"],
      requiredPaths: ["value.txt"],
      maxChangedFiles: 1,
    },
  };
}

function executor(): RuntimeBenchmarkExecutor {
  return new RuntimeBenchmarkExecutor({
    executable: process.execPath,
    args: [join(import.meta.dir, "fixtures", "runtime-benchmark-worker.ts")],
  });
}

describe("real repository corpus", () => {
  it("runs repeated isolated attempts and writes a regression-gated report", async () => {
    const data = await fixture();
    const corpus: RealRepoCorpusManifest = {
      schemaVersion: 1,
      id: "smoke-corpus",
      tasks: [{ manifestPath: "unused", attempts: 2 }],
      maxConcurrency: 2,
      thresholds: { minPassRate: 1, maxPassRateDrop: 0 },
    };
    const report = await runRealRepoCorpus({
      corpus,
      tasks: [{ task: task("task-a", data.commit), sourcePath: data.source, attempts: 2 }],
      outputDirectory: join(data.root, "out"),
      executor: executor(),
      clock: () => 123,
    });

    expect(report.aggregate).toMatchObject({ attempts: 2, passed: 2, passRate: 1, medianTokens: 15 });
    expect(report.aggregate.providerCacheAccountingCoverage).toBe(0);
    expect(report.aggregate.cachePhases.find((phase) => phase.phase === "warm")?.attempts).toBe(2);
    expect(report.aggregate.scenarioCoverage.repositories).toBe(1);
    expect(report.attempts.map((attempt) => attempt.attemptId))
      .toEqual(["task-a-1-1", "task-a-1-2"]);
    expect(new Set(report.attempts.map((attempt) => attempt.trajectoryPath)).size).toBe(2);
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]).toMatchObject({ taskId: "task-a", attempts: 2, passRate: 1 });
    expect(report.regression).toEqual({ passed: true, failures: [] });
    expect(await readFile(join(data.source, "value.txt"), "utf8")).toBe("old\n");

    const reportPath = join(data.root, "reports", "report.json");
    await writeRealRepoReport(reportPath, report);
    expect((await readRealRepoReport(reportPath)).corpusId).toBe("smoke-corpus");
    if (process.platform !== "win32") expect((await stat(reportPath)).mode & 0o777).toBe(0o600);

    const legacyPath = join(data.root, "reports", "legacy-report.json");
    const {
      providerCacheAccountingCoverage: _coverage,
      cacheWriteChurnRate: _churn,
      cachePhases: _phases,
      scenarioCoverage: _scenarios,
      ...legacyAggregate
    } = report.aggregate;
    const legacyAttempts = report.attempts.map((attempt) => {
      const {
        repositoryUrl: _repositoryUrl,
        cachePhase: _cachePhase,
        session: _session,
        ...legacyAttempt
      } = attempt;
      return legacyAttempt;
    });
    await writeFile(legacyPath, JSON.stringify({
      ...report,
      schemaVersion: 1,
      aggregate: legacyAggregate,
      attempts: legacyAttempts,
    }));
    const upgraded = await readRealRepoReport(legacyPath);
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.attempts[0]?.cachePhase).toBe("warm");
    expect(upgraded.aggregate.cachePhases.find((phase) => phase.phase === "warm")?.attempts).toBe(2);
  });

  it("resumes exact checkpointed jobs without executing or duplicating them", async () => {
    const data = await fixture();
    const corpus: RealRepoCorpusManifest = {
      schemaVersion: 1,
      id: "resume-corpus",
      tasks: [{ manifestPath: "unused", attempts: 2 }],
      maxConcurrency: 2,
    };
    const tasks = [{ task: task("task-a", data.commit), sourcePath: data.source, attempts: 2 }];
    const checkpoints: string[] = [];
    const initial = await runRealRepoCorpus({
      corpus,
      tasks,
      outputDirectory: join(data.root, "initial"),
      executor: executor(),
      onAttempt: (attempt) => { checkpoints.push(attempt.attemptId); },
    });

    let resumedExecutions = 0;
    const resumed = await runRealRepoCorpus({
      corpus,
      tasks,
      outputDirectory: join(data.root, "resumed"),
      executor: executor(),
      resumeAttempts: initial.attempts,
      onAttempt: () => { resumedExecutions++; },
    });

    expect(checkpoints.sort()).toEqual(["task-a-1-1", "task-a-1-2"]);
    expect(resumedExecutions).toBe(0);
    expect(resumed.aggregate.attempts).toBe(2);
    expect(resumed.attempts.map((attempt) => attempt.attemptId))
      .toEqual(initial.attempts.map((attempt) => attempt.attemptId));

    const contaminated = { ...initial.attempts[0]!, sourceCommit: "0".repeat(40) };
    await expect(runRealRepoCorpus({
      corpus,
      tasks,
      outputDirectory: join(data.root, "invalid-resume"),
      executor: executor(),
      resumeAttempts: [contaminated],
    })).rejects.toThrow("does not match corpus job");
  });

  it("fails the gate when pass rate or baseline efficiency regresses", async () => {
    const data = await fixture();
    const baseline = await runRealRepoCorpus({
      corpus: { schemaVersion: 1, id: "baseline", tasks: [{ manifestPath: "unused" }] },
      tasks: [{ task: task("task-a", data.commit, "replace value __baseline__"), sourcePath: data.source }],
      outputDirectory: join(data.root, "baseline"),
      executor: executor(),
    });
    const current = await runRealRepoCorpus({
      corpus: {
        schemaVersion: 1,
        id: "current",
        tasks: [{ manifestPath: "unused" }],
        thresholds: { minPassRate: 1, maxPassRateDrop: 0, maxMedianTokensIncreaseRatio: 0.1 },
      },
      tasks: [{ task: task("task-a", data.commit, "__noop__"), sourcePath: data.source }],
      outputDirectory: join(data.root, "current"),
      executor: executor(),
      baseline,
    });

    expect(current.regression.passed).toBe(false);
    expect(current.regression.failures.join("\n")).toContain("pass rate");
    expect(current.regression.failures.join("\n")).toContain("median tokens");
  });

  it("reports cold, warm, and post-compact session coverage from executor evidence", async () => {
    const data = await fixture();
    const corpus: RealRepoCorpusManifest = {
      schemaVersion: 1,
      id: "phase-corpus",
      tasks: [{ manifestPath: "unused" }],
    };
    const report = await runRealRepoCorpus({
      corpus,
      tasks: [
        {
          task: task("task-a", data.commit),
          sourcePath: data.source,
          cachePhase: "cold",
          session: { profile: "short", minimumMessages: 5 },
        },
        {
          task: task("task-a", data.commit),
          sourcePath: data.source,
          cachePhase: "warm",
          session: { profile: "long", minimumMessages: 100, resume: true },
        },
        {
          task: task("task-a", data.commit),
          sourcePath: data.source,
          cachePhase: "post_compact",
          session: {
            profile: "long",
            minimumMessages: 100,
            resume: true,
            compactBeforeRun: true,
          },
        },
      ],
      outputDirectory: join(data.root, "phases"),
      executor: executor(),
    });

    expect(report.aggregate.cachePhases.map(({ phase, attempts }) => ({ phase, attempts }))).toEqual([
      { phase: "cold", attempts: 1 },
      { phase: "warm", attempts: 1 },
      { phase: "post_compact", attempts: 1 },
    ]);
    expect(report.aggregate.scenarioCoverage).toEqual({
      repositories: 1,
      shortSessionAttempts: 1,
      longSessionAttempts: 2,
      hundredMessageAttempts: 2,
      resumedAttempts: 2,
      postCompactAttempts: 1,
    });
  });

  it("enforces the commercial cache distribution and coverage gates", () => {
    const aggregate: RealRepoBenchmarkReport["aggregate"] = {
      attempts: 100,
      passed: 100,
      passRate: 1,
      medianDurationMs: 1,
      p95DurationMs: 2,
      providerCacheAccountingCoverage: 0.99,
      cacheWriteChurnRate: 0.05,
      cachePhases: [
        {
          phase: "cold",
          attempts: 10,
          providerCacheAccountingCoverage: 1,
          cacheHitRateSamples: 10,
          medianCacheHitRate: 0.1,
          p10CacheHitRate: 0,
          cacheWriteChurnRate: 0.4,
        },
        {
          phase: "warm",
          attempts: 80,
          providerCacheAccountingCoverage: 1,
          cacheHitRateSamples: 80,
          medianCacheHitRate: 0.9,
          p10CacheHitRate: 0.8,
          cacheWriteChurnRate: 0.01,
        },
        {
          phase: "post_compact",
          attempts: 10,
          providerCacheAccountingCoverage: 0.9,
          cacheHitRateSamples: 9,
          medianCacheHitRate: 0.85,
          p10CacheHitRate: 0.8,
          cacheWriteChurnRate: 0.04,
        },
      ],
      scenarioCoverage: {
        repositories: 3,
        shortSessionAttempts: 20,
        longSessionAttempts: 80,
        hundredMessageAttempts: 20,
        resumedAttempts: 20,
        postCompactAttempts: 10,
      },
    };
    const thresholds: RealRepoRegressionThresholds = {
      minAttempts: 100,
      minRepositories: 3,
      requiredCachePhases: ["cold", "warm", "post_compact"],
      minWarmCacheHitRateMedian: 0.9,
      minWarmCacheHitRateP10: 0.8,
      maxCacheWriteChurnRate: 0.05,
      minProviderCacheAccountingCoverage: 0.99,
      minShortSessionAttempts: 1,
      minLongSessionAttempts: 1,
      minHundredMessageAttempts: 1,
      minResumedAttempts: 1,
      minPostCompactAttempts: 1,
    };

    expect(evaluateRegression({ aggregate, thresholds })).toEqual({ passed: true, failures: [] });

    const failing: RealRepoBenchmarkReport["aggregate"] = {
      ...aggregate,
      attempts: 99,
      providerCacheAccountingCoverage: 0.98,
      cacheWriteChurnRate: 0.051,
      cachePhases: aggregate.cachePhases.map((phase) => phase.phase === "warm"
        ? { ...phase, medianCacheHitRate: 0.89, p10CacheHitRate: 0.79 }
        : phase),
      scenarioCoverage: {
        repositories: 1,
        shortSessionAttempts: 0,
        longSessionAttempts: 0,
        hundredMessageAttempts: 0,
        resumedAttempts: 0,
        postCompactAttempts: 0,
      },
    };
    const result = evaluateRegression({ aggregate: failing, thresholds });
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("trajectory count 99");
    expect(result.failures.join("\n")).toContain("warm cache median 89.00%");
    expect(result.failures.join("\n")).toContain("warm cache P10 79.00%");
    expect(result.failures.join("\n")).toContain("cache write churn 5.10%");
    expect(result.failures.join("\n")).toContain("accounting coverage 98.00%");
    expect(result.failures.join("\n")).toContain("post-compact trajectories 0");
  });
});

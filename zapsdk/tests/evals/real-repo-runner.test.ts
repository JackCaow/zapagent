import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeBenchmarkExecutor,
  runBenchmarkProcess,
  runRealRepoTask,
  type RealRepoTaskManifest,
} from "../../evals/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runBenchmarkProcess({
    executable: "git",
    args,
    cwd,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repositoryFixture(): Promise<{ source: string; output: string; commit: string }> {
  const root = await mkdtemp(join(tmpdir(), "zap-real-repo-eval-"));
  roots.push(root);
  const source = join(root, "source");
  const output = join(root, "output");
  await mkdir(join(source, "src"), { recursive: true });
  await git(source, ["init"]);
  await writeFile(join(source, "src", "value.txt"), "broken\n", "utf8");
  await git(source, ["add", "."]);
  await git(source, [
    "-c", "user.name=Zap Eval", "-c", "user.email=eval@example.invalid",
    "commit", "-m", "fixture",
  ]);
  const commit = await git(source, ["rev-parse", "HEAD"]);
  return { source, output, commit };
}

function task(commit: string): RealRepoTaskManifest {
  return {
    schemaVersion: 1,
    id: "replace-broken-value",
    title: "Replace a broken value",
    repository: { url: "https://example.invalid/fixture.git", commit },
    prompt: "SECRET_USER_PROMPT: replace broken with fixed",
    execution: { mode: "local_trusted", timeoutMs: 30_000 },
    grader: {
      commands: ["node -e \"const fs=require('fs');if(fs.readFileSync('src/value.txt','utf8').trim()!=='fixed')process.exit(1)\""],
      requiredPaths: ["src/value.txt"],
      forbiddenPaths: ["secrets/**"],
      minChangedFiles: 1,
      maxChangedFiles: 1,
    },
    tags: ["micro", "bugfix"],
  };
}

function executor(): RuntimeBenchmarkExecutor {
  return new RuntimeBenchmarkExecutor({
    executable: process.execPath,
    args: [join(import.meta.dir, "fixtures", "runtime-benchmark-worker.ts")],
  });
}

describe("real repository trajectory benchmark", () => {
  it("runs against a pinned isolated worktree and writes a sanitized trajectory", async () => {
    const fixture = await repositoryFixture();
    const result = await runRealRepoTask({
      task: task(fixture.commit),
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      attemptId: "attempt-success",
      executor: executor(),
    });

    expect(result.passed).toBe(true);
    expect(result.sourceCommit).toBe(fixture.commit);
    expect(result.grade.changedPaths).toEqual(["src/value.txt"]);
    expect(result.metrics).toMatchObject({
      changedFileCount: 1,
      validationPassRate: 1,
      runtimeEventCount: 1,
      steps: 3,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      cacheHitRate: 0.9,
      cacheWriteChurnRate: 0,
    });
    expect(result.repositoryUrl).toBe("https://example.invalid/fixture.git");
    expect(result.cachePhase).toBe("warm");
    const trajectory = await readFile(result.trajectoryPath!, "utf8");
    expect(trajectory).not.toContain("SECRET_USER_PROMPT");
    expect(trajectory).not.toContain("SECRET_RUNTIME_TASK");
    expect(trajectory).not.toContain("SECRET_RUNTIME_MESSAGE");
    expect(trajectory).toContain('"kind":"runtime_event"');
    if (process.platform !== "win32") {
      expect((await stat(result.trajectoryPath!)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(fixture.source, "src", "value.txt"), "utf8")).toBe("broken\n");
  });

  it("fails closed when trajectory efficiency exceeds or omits configured gates", async () => {
    const fixture = await repositoryFixture();
    const overBudget = task(fixture.commit);
    overBudget.grader.maxSteps = 2;
    overBudget.grader.maxToolCalls = 1;
    overBudget.grader.maxFreshInputTokens = 9;
    overBudget.grader.minCacheHitRate = 0.95;
    const result = await runRealRepoTask({
      task: overBudget,
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      attemptId: "attempt-over-budget",
      executor: executor(),
    });

    expect(result.passed).toBe(false);
    expect(result.grade.failures).toContain("steps 3 exceeds maxSteps=2");
    expect(result.grade.failures).toContain("tool calls 2 exceeds maxToolCalls=1");
    expect(result.grade.failures).toContain("fresh input tokens 10 exceeds maxFreshInputTokens=9");
    expect(result.grade.failures).toContain("cache hit rate 90.00% is below minCacheHitRate=95.00%");

    const missingMetric = task(fixture.commit);
    missingMetric.prompt = "__noop__";
    missingMetric.grader.maxSteps = 2;
    missingMetric.grader.minCacheHitRate = 0.9;
    const missing = await runRealRepoTask({
      task: missingMetric,
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      attemptId: "attempt-missing-metric",
      executor: executor(),
    });
    expect(missing.passed).toBe(false);
    expect(missing.grade.failures).toContain("maxSteps gate requires executor metric steps");
    expect(missing.grade.failures).toContain(
      "minCacheHitRate gate requires executor metrics inputTokens, cacheReadTokens, and cacheWriteTokens or cacheMissTokens",
    );
  });

  it("fails deterministically on forbidden scope and executor errors", async () => {
    const fixture = await repositoryFixture();
    const manifest = task(fixture.commit);
    manifest.grader.maxChangedFiles = 2;
    manifest.prompt = "__forbidden__";
    const result = await runRealRepoTask({
      task: manifest,
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      attemptId: "attempt-failure",
      executor: executor(),
    });

    expect(result.passed).toBe(false);
    expect(result.error).toBe("agent crashed");
    expect(result.grade.forbiddenPathHits).toEqual(["secrets/leak.txt"]);
    expect(result.grade.missingRequiredPaths).toEqual(["src/value.txt"]);
    expect(result.grade.failures.join("\n")).toContain("forbidden paths changed");
  });

  it("requires measured evidence for resume and post-compact session scenarios", async () => {
    const fixture = await repositoryFixture();
    const session = {
      profile: "long" as const,
      minimumMessages: 100,
      resume: true,
      compactBeforeRun: true,
    };
    const result = await runRealRepoTask({
      task: task(fixture.commit),
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      attemptId: "attempt-post-compact",
      cachePhase: "post_compact",
      session,
      executor: executor(),
    });

    expect(result.passed).toBe(true);
    expect(result.cachePhase).toBe("post_compact");
    expect(result.session).toEqual(session);
    expect(result.metrics).toMatchObject({
      sessionMessages: 100,
      sessionResumed: true,
      compactOccurred: true,
    });

    await expect(runRealRepoTask({
      task: task(fixture.commit),
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      cachePhase: "post_compact",
      executor: executor(),
    })).rejects.toThrow("compactBeforeRun=true");
  });

  it("rejects abbreviated commits before creating a workspace", async () => {
    const fixture = await repositoryFixture();
    const manifest = task(fixture.commit);
    manifest.repository.commit = fixture.commit.slice(0, 8);

    await expect(runRealRepoTask({
      task: manifest,
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      executor: executor(),
    })).rejects.toThrow("full pinned commit");
  });

  it("rejects cache hit rate gates outside the 0..1 range", async () => {
    const fixture = await repositoryFixture();
    const manifest = task(fixture.commit);
    manifest.grader.minCacheHitRate = 1.01;

    await expect(runRealRepoTask({
      task: manifest,
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      executor: executor(),
    })).rejects.toThrow("minCacheHitRate must be between 0 and 1");
  });

  it("rejects task and attempt ids that could escape the output directory", async () => {
    const data = await repositoryFixture();
    const valid = task(data.commit);
    await expect(runRealRepoTask({
      task: { ...valid, id: "../escape" },
      sourcePath: data.source,
      outputDirectory: data.output,
      executor: executor(),
    })).rejects.toThrow("filesystem-safe");
    await expect(runRealRepoTask({
      task: valid,
      attemptId: "../escape",
      sourcePath: data.source,
      outputDirectory: data.output,
      executor: executor(),
    })).rejects.toThrow("filesystem-safe");
  });

  it("returns after the task deadline even when the executor ignores abort", async () => {
    const fixture = await repositoryFixture();
    const manifest = task(fixture.commit);
    // The deadline intentionally covers worktree setup too. Leave enough
    // room for a cold git worktree on loaded CI runners so this test reaches
    // the executor that ignores cancellation rather than timing out during
    // fixture preparation.
    manifest.execution.timeoutMs = 1_000;
    manifest.prompt = "__hang__";
    const startedAt = performance.now();

    const result = await runRealRepoTask({
      task: manifest,
      sourcePath: fixture.source,
      outputDirectory: fixture.output,
      attemptId: "attempt-timeout",
      executor: executor(),
      keepWorkspace: true,
    });

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(result.passed).toBe(false);
    expect(result.error).toBe("real-repo task timeout");
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const lateSideEffect = join(
      fixture.output,
      "workspaces",
      "attempt-timeout",
      "late-side-effect.txt",
    );
    expect(await stat(lateSideEffect).then(() => true).catch(() => false)).toBe(false);
  });

  it("hard-kills a benchmark process that ignores the timeout signal", async () => {
    const fixture = await repositoryFixture();
    const result = await runBenchmarkProcess({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      cwd: fixture.source,
      timeoutMs: 20,
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(3_000);
  });
});

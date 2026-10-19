import { runBenchmarkCommand } from "./command.js";
import type {
  BenchmarkCommandResult,
  RealRepoGradeResult,
  RealRepoTaskManifest,
} from "./types.js";

function regexForPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(path: string, pattern: string): boolean {
  return regexForPattern(pattern.replace(/^\.\//, "")).test(path);
}

async function gitLines(cwd: string, command: string): Promise<string[]> {
  const result = await runBenchmarkCommand({ command, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to inspect benchmark workspace: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function changedRepositoryPaths(cwd: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitLines(cwd, "git diff --name-only HEAD"),
    gitLines(cwd, "git ls-files --others --exclude-standard"),
  ]);
  return [...new Set([...tracked, ...untracked])].sort();
}

export async function gradeRealRepoTask(input: {
  task: RealRepoTaskManifest;
  cwd: string;
  signal?: AbortSignal;
  onCommand?: (result: BenchmarkCommandResult) => void;
}): Promise<RealRepoGradeResult> {
  const changedPaths = await changedRepositoryPaths(input.cwd);
  const forbiddenPathHits = changedPaths.filter((path) =>
    input.task.grader.forbiddenPaths?.some((pattern) => matchesPattern(path, pattern))
  );
  const missingRequiredPaths = (input.task.grader.requiredPaths ?? []).filter((pattern) =>
    !changedPaths.some((path) => matchesPattern(path, pattern))
  );
  const commands: BenchmarkCommandResult[] = [];
  for (const command of input.task.grader.commands) {
    const result = await runBenchmarkCommand({
      command,
      cwd: input.cwd,
      timeoutMs: input.task.execution.timeoutMs ?? 15 * 60_000,
      signal: input.signal,
    });
    commands.push(result);
    input.onCommand?.(result);
  }
  const failures: string[] = [];
  if (forbiddenPathHits.length > 0) {
    failures.push(`forbidden paths changed: ${forbiddenPathHits.join(", ")}`);
  }
  if (missingRequiredPaths.length > 0) {
    failures.push(`required path patterns not changed: ${missingRequiredPaths.join(", ")}`);
  }
  if (input.task.grader.minChangedFiles !== undefined
    && changedPaths.length < input.task.grader.minChangedFiles) {
    failures.push(`changed ${changedPaths.length} files, expected at least ${input.task.grader.minChangedFiles}`);
  }
  if (input.task.grader.maxChangedFiles !== undefined
    && changedPaths.length > input.task.grader.maxChangedFiles) {
    failures.push(`changed ${changedPaths.length} files, expected at most ${input.task.grader.maxChangedFiles}`);
  }
  for (const result of commands) {
    if (result.exitCode !== 0 || result.timedOut) {
      failures.push(`validation failed: ${result.command} (exit ${result.exitCode ?? "signal"})`);
    }
  }
  return {
    passed: failures.length === 0,
    changedPaths,
    commands,
    forbiddenPathHits,
    missingRequiredPaths,
    failures,
  };
}

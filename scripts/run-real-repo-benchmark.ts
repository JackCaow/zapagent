#!/usr/bin/env bun
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  readRealRepoReport,
  RuntimeBenchmarkExecutor,
  runRealRepoCorpus,
  writeRealRepoReport,
  type RealRepoBenchmarkReport,
  type RealRepoAttemptResult,
  type RealRepoCorpusManifest,
  type RealRepoResolvedTask,
  type RealRepoTaskManifest,
} from "../zapsdk/evals/index.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]!] : []);
}

function usage(): never {
  console.error("Usage: bun run benchmark:real-repo --corpus <corpus.json> --executor <executable> [--executor-arg <arg>] --output <dir> [--baseline <report.json>] [--resume]");
  process.exit(2);
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

const args = process.argv.slice(2);
const corpusArg = valueAfter(args, "--corpus");
const executorArg = valueAfter(args, "--executor");
const outputArg = valueAfter(args, "--output");
if (!corpusArg || !executorArg || !outputArg) usage();
const corpusPath = resolve(corpusArg);
const corpus = await jsonFile<RealRepoCorpusManifest>(corpusPath);
const corpusDirectory = dirname(corpusPath);
const tasks: RealRepoResolvedTask[] = await Promise.all(corpus.tasks.map(async (entry) => {
  const manifestPath = resolve(corpusDirectory, entry.manifestPath);
  const task = await jsonFile<RealRepoTaskManifest>(manifestPath);
  if (!entry.sourcePath) throw new Error(`Corpus task ${entry.manifestPath} requires sourcePath for local_trusted execution`);
  return {
    task,
    sourcePath: resolve(corpusDirectory, entry.sourcePath),
    attempts: entry.attempts,
    cachePhase: entry.cachePhase,
    session: entry.session,
  };
}));
const executor = new RuntimeBenchmarkExecutor({
  executable: resolve(executorArg),
  args: valuesAfter(args, "--executor-arg"),
});
const baselineArg = valueAfter(args, "--baseline");
const baseline: RealRepoBenchmarkReport | undefined = baselineArg
  ? await readRealRepoReport(resolve(baselineArg))
  : undefined;
const outputDirectory = resolve(outputArg);
const attemptDirectory = join(outputDirectory, "attempts");
const resumeAttempts = args.includes("--resume")
  ? await readCheckpointAttempts(attemptDirectory)
  : [];
const report = await runRealRepoCorpus({
  corpus,
  tasks,
  outputDirectory,
  executor,
  baseline,
  resumeAttempts,
  onAttempt: async (attempt, completed, total) => {
    await writeCheckpointAttempt(attemptDirectory, attempt);
    process.stderr.write(`[benchmark] checkpoint ${completed}/${total}: ${attempt.attemptId}\n`);
  },
});
const reportPath = resolve(outputDirectory, "report.json");
await writeRealRepoReport(reportPath, report);
console.log(JSON.stringify({
  reportPath,
  corpusId: report.corpusId,
  passRate: report.aggregate.passRate,
  attempts: report.aggregate.attempts,
  providerCacheAccountingCoverage: report.aggregate.providerCacheAccountingCoverage,
  cacheWriteChurnRate: report.aggregate.cacheWriteChurnRate,
  cachePhases: report.aggregate.cachePhases,
  scenarioCoverage: report.aggregate.scenarioCoverage,
  regressionPassed: report.regression.passed,
  failures: report.regression.failures,
}));
if (!report.regression.passed) process.exit(1);

async function readCheckpointAttempts(directory: string): Promise<RealRepoAttemptResult[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => (
    JSON.parse(await readFile(join(directory, name), "utf8")) as RealRepoAttemptResult
  )));
}

async function writeCheckpointAttempt(directory: string, attempt: RealRepoAttemptResult): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, `${attempt.attemptId}.json`);
  const temporary = `${finalPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(attempt)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, finalPath);
  if (process.platform !== "win32") await chmod(finalPath, 0o600);
}

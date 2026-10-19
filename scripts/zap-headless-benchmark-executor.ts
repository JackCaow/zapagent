#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Message, TokenUsage } from "../zapsdk/core/types.js";
import type {
  RealRepoCachePhase,
  RealRepoSessionScenario,
  RealRepoTaskExecutionResult,
  RealRepoTaskManifest,
} from "../zapsdk/evals/types.js";

const EXECUTOR_PROTOCOL_VERSION = 1;
const DEFAULT_MODEL = "deepseek-v4-flash";

interface BenchmarkRequest {
  version: number;
  cwd: string;
  task: RealRepoTaskManifest;
  cachePhase: RealRepoCachePhase;
  session?: RealRepoSessionScenario;
}

interface HeadlessInitRecord {
  type: "system";
  subtype: "init";
  sessionId: string;
  resumedFrom: string | null;
}

interface HeadlessContextRecord {
  type: "context";
  step: number;
  messageCount: number;
}

interface HeadlessObservationRecord {
  type: "observation";
  kind: string;
  detail?: { failed?: boolean } | null;
}

interface HeadlessResultRecord {
  type: "result";
  ok: boolean;
  turns: number;
  usage: TokenUsage;
  toolCalls: unknown[];
  stopReason: string;
  error?: string | null;
}

type HeadlessRecord =
  | HeadlessInitRecord
  | HeadlessContextRecord
  | HeadlessObservationRecord
  | HeadlessResultRecord
  | { type: string; [key: string]: unknown };

interface PreparedSession {
  sourceSessionId?: string;
  compactOccurred: boolean;
}

const COMPACT_FIXTURE_SUMMARY = `# Primary Request and Intent
- Continue a deterministic repository benchmark task.

# All user messages (verbatim)
- "Inspect the repository benchmark fixture."

# Current task status
- The fixture history is ready for a measured continuation.

# Files read / modified
- _(none captured)_

# Commands run
- _(none captured)_

# Key facts discovered
- The benchmark seed is deterministic.

# Decisions made
- Preserve the stable prompt prefix across the measured continuation.

# Errors encountered and their resolution
- _(none captured)_

# Code changes summary
- _(none captured)_

# Next steps
- Execute the current benchmark prompt and validate the requested file.`;

function optionalMetric(target: RealRepoTaskExecutionResult, key: keyof RealRepoTaskExecutionResult, value: unknown): void {
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    (target as Record<string, unknown>)[key] = value;
  }
}

/** Convert Zap's public stream-json contract into the benchmark protocol.
 * Provider cache fields remain absent when the provider omitted them; absence
 * is evidence for the accounting-coverage gate and must never become zero. */
export function parseHeadlessBenchmarkStream(input: {
  stdout: string;
  sourceSessionId?: string;
  compactPrepared?: boolean;
}): RealRepoTaskExecutionResult {
  let init: HeadlessInitRecord | undefined;
  let final: HeadlessResultRecord | undefined;
  let maxMessageCount = 0;
  let compactObserved = false;

  for (const rawLine of input.stdout.split(/\r?\n/u)) {
    if (!rawLine.trim()) continue;
    let record: HeadlessRecord;
    try {
      record = JSON.parse(rawLine) as HeadlessRecord;
    } catch {
      throw new Error("zap headless emitted non-JSON stdout");
    }
    if (record.type === "system" && record.subtype === "init") {
      init = record as HeadlessInitRecord;
    } else if (record.type === "context") {
      const context = record as HeadlessContextRecord;
      if (Number.isSafeInteger(context.messageCount) && context.messageCount >= 0) {
        maxMessageCount = Math.max(maxMessageCount, context.messageCount);
      }
    } else if (record.type === "observation") {
      const observation = record as HeadlessObservationRecord;
      if (observation.kind === "autocompact_done" && observation.detail?.failed !== true) {
        compactObserved = true;
      }
    } else if (record.type === "result") {
      if (final) throw new Error("zap headless emitted more than one result record");
      final = record as HeadlessResultRecord;
    }
  }

  if (!init) throw new Error("zap headless emitted no init record");
  if (!final) throw new Error("zap headless emitted no result record");
  if (final.stopReason === "error" || final.stopReason === "permission_denied" || final.error) {
    throw new Error(final.error || `zap headless stopped with ${final.stopReason}`);
  }

  const output: RealRepoTaskExecutionResult = {};
  optionalMetric(output, "steps", final.turns);
  optionalMetric(output, "toolCalls", Array.isArray(final.toolCalls) ? final.toolCalls.length : undefined);
  optionalMetric(output, "sessionMessages", maxMessageCount);

  const usage = final.usage;
  if (usage?.providerUsageReported !== false) {
    optionalMetric(output, "inputTokens", usage?.inputTokens);
    optionalMetric(output, "outputTokens", usage?.outputTokens);
    if (Object.prototype.hasOwnProperty.call(usage ?? {}, "cacheReadInputTokens")) {
      optionalMetric(output, "cacheReadTokens", usage.cacheReadInputTokens);
    }
    if (Object.prototype.hasOwnProperty.call(usage ?? {}, "cacheCreationInputTokens")) {
      optionalMetric(output, "cacheWriteTokens", usage.cacheCreationInputTokens);
    }
    if (Object.prototype.hasOwnProperty.call(usage ?? {}, "cacheMissInputTokens")) {
      optionalMetric(output, "cacheMissTokens", usage.cacheMissInputTokens);
    }
  }

  if (input.sourceSessionId) {
    output.sessionResumed = init.resumedFrom === input.sourceSessionId;
  }
  output.compactOccurred = input.compactPrepared === true || compactObserved;
  return output;
}

function fixtureMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => index % 2 === 0
    ? { role: "user", content: `Benchmark history request ${Math.floor(index / 2) + 1}.` }
    : { role: "assistant", content: `Benchmark history response ${Math.floor(index / 2) + 1}.` }) as Message[];
}

export async function compactFixtureMessages(messages: Message[]): Promise<Message[]> {
  const { ConversationManager } = await import("../zapsdk/memory/conversation.js");
  const conversation = new ConversationManager({
    maxMessages: Number.POSITIVE_INFINITY,
    autoCompress: false,
  });
  for (const message of messages) conversation.add(message);
  const provider = {
    call: async () => ({
      type: "text" as const,
      text: COMPACT_FIXTURE_SUMMARY,
      usage: { inputTokens: 0, outputTokens: 0, providerUsageReported: false },
    }),
  };
  const result = await conversation.compress(provider as never, {
    force: true,
    targetTokens: 64,
  });
  if (!result || result.before <= result.after) {
    throw new Error("benchmark compact fixture did not reduce the session");
  }
  return conversation.getAllMessages();
}

async function prepareSession(scenario: RealRepoSessionScenario | undefined): Promise<PreparedSession> {
  if (!scenario?.resume) {
    if (scenario?.compactBeforeRun) {
      throw new Error("compactBeforeRun requires a resumed benchmark session");
    }
    return { compactOccurred: false };
  }

  const requestedCount = Math.max(
    scenario.minimumMessages ?? (scenario.profile === "long" ? 20 : 4),
    scenario.compactBeforeRun ? 100 : 2,
  );
  const evenCount = requestedCount % 2 === 0 ? requestedCount : requestedCount + 1;
  let messages = fixtureMessages(evenCount);
  let compactOccurred = false;
  if (scenario.compactBeforeRun) {
    messages = await compactFixtureMessages(messages);
    compactOccurred = true;
  }

  const { __test } = await import("../src/session.js");
  const sourceSessionId = randomUUID();
  const writer = new __test.SessionWriter({
    sessionId: sourceSessionId,
    registerExitHandler: false,
  });
  try {
    for (const message of messages) {
      if (message.role === "user") writer.appendLog("user", message.content);
      else if (message.role === "assistant") writer.appendLog("agent", message.content);
    }
    writer.finalize();
  } finally {
    writer.dispose();
  }
  return { sourceSessionId, compactOccurred };
}

async function copyRuntimeConfig(targetDataDir: string): Promise<void> {
  const sourceDataDir = process.env.ZAPCODE_DATA_DIR || join(homedir(), ".zapcode");
  const sourceConfig = join(sourceDataDir, "config.json");
  const targetConfig = join(targetDataDir, "config.json");
  await copyFile(sourceConfig, targetConfig);
  if (process.platform !== "win32") await chmod(targetConfig, 0o600);
}

async function executeRequest(request: BenchmarkRequest): Promise<RealRepoTaskExecutionResult> {
  if (request.version !== EXECUTOR_PROTOCOL_VERSION) {
    throw new Error(`unsupported benchmark executor protocol ${request.version}`);
  }
  if (resolve(request.cwd) !== process.cwd()) {
    process.chdir(request.cwd);
  }

  const dataDir = await mkdtemp(join(tmpdir(), "zap-benchmark-data-"));
  if (process.platform !== "win32") await chmod(dataDir, 0o700);
  try {
    await copyRuntimeConfig(dataDir);
    process.env.ZAPCODE_DATA_DIR = dataDir;
    const prepared = await prepareSession(request.session);
    const maxTurns = request.task.grader.maxSteps ?? 12;
    const command = [
      process.execPath,
      "run",
      resolve(import.meta.dir, "../src/index.tsx"),
      "-p",
      request.task.prompt,
      "--cwd",
      request.cwd,
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--max-turns",
      String(maxTurns),
      "--model",
      process.env.ZAP_BENCHMARK_MODEL || DEFAULT_MODEL,
      "--no-devtools",
    ];
    if (prepared.sourceSessionId) command.push("--session-id", prepared.sourceSessionId);
    if (request.cachePhase === "cold") {
      command.push(
        "--system-prompt-prepend",
        `Benchmark cold-cache nonce: ${randomUUID()}`,
      );
    }

    const child = spawn(command[0]!, command.slice(1), {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
    });
    const terminate = () => { child.kill("SIGTERM"); };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", resolveExit);
      }),
    ]).finally(() => {
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
    });
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `zap headless exited with code ${exitCode}`);
    }
    return parseHeadlessBenchmarkStream({
      stdout,
      sourceSessionId: prepared.sourceSessionId,
      compactPrepared: prepared.compactOccurred,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += chunk.toString();
  return output;
}

async function main(): Promise<void> {
  const requestText = await readStream(process.stdin);
  const request = JSON.parse(requestText) as BenchmarkRequest;
  try {
    const result = await executeRequest(request);
    process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();

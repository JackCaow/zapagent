import { runBenchmarkProcess } from "./command.js";
import type {
  RealRepoTaskExecutionContext,
  RealRepoTaskExecutionResult,
  RealRepoTaskExecutor,
} from "./types.js";
import type { RuntimeEvent } from "../runtime/types.js";

const EXECUTOR_PROTOCOL_VERSION = 1 as const;
const MAX_EXECUTOR_OUTPUT_BYTES = 16_000_000;

export interface RuntimeBenchmarkExecutorOptions {
  executable: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

interface ExecutorRecord {
  type?: unknown;
  event?: unknown;
  result?: unknown;
  error?: unknown;
}

function executionResult(value: unknown): RealRepoTaskExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark executor returned an invalid result record");
  }
  const output: RealRepoTaskExecutionResult = {};
  for (const key of [
    "steps",
    "toolCalls",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheMissTokens",
    "sessionMessages",
  ] as const) {
    const metric = (value as Record<string, unknown>)[key];
    if (metric === undefined) continue;
    if (!Number.isSafeInteger(metric) || (metric as number) < 0) {
      throw new Error(`benchmark executor ${key} must be a non-negative safe integer`);
    }
    output[key] = metric as number;
  }
  for (const key of ["sessionResumed", "compactOccurred"] as const) {
    const metric = (value as Record<string, unknown>)[key];
    if (metric === undefined) continue;
    if (typeof metric !== "boolean") {
      throw new Error(`benchmark executor ${key} must be a boolean`);
    }
    output[key] = metric;
  }
  return output;
}

function runtimeEvent(value: unknown): RuntimeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark executor returned an invalid runtime event");
  }
  const event = value as Partial<RuntimeEvent>;
  if ((event.schemaVersion !== 1 && event.schemaVersion !== 2 && event.schemaVersion !== 3)
    || typeof event.eventId !== "string"
    || !Number.isSafeInteger(event.sequence)
    || typeof event.threadId !== "string"
    || !event.payload
    || typeof event.payload !== "object") {
    throw new Error("benchmark executor returned an invalid runtime event");
  }
  return value as RuntimeEvent;
}

/** Runs the benchmark agent behind an OS-process boundary. The child reads
 * one request object from stdin and emits JSONL records on stdout:
 * `{type:"runtime_event",event}` followed by `{type:"result",result}`.
 * Killing this process boundary stops executor side effects before grading. */
export class RuntimeBenchmarkExecutor implements RealRepoTaskExecutor {
  readonly isolation = "subprocess" as const;

  constructor(private readonly options: RuntimeBenchmarkExecutorOptions) {
    if (!options.executable.trim()) throw new Error("benchmark executor executable is required");
  }

  async execute(context: RealRepoTaskExecutionContext): Promise<RealRepoTaskExecutionResult> {
    const result = await runBenchmarkProcess({
      executable: this.options.executable,
      args: this.options.args ?? [],
      cwd: context.cwd,
      timeoutMs: context.task.execution.timeoutMs ?? 15 * 60_000,
      signal: context.signal,
      killGraceMs: 250,
      maxCaptureBytes: MAX_EXECUTOR_OUTPUT_BYTES,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdin: `${JSON.stringify({
        version: EXECUTOR_PROTOCOL_VERSION,
        task: context.task,
        cwd: context.cwd,
        cachePhase: context.cachePhase,
        session: context.session,
      })}\n`,
    });
    if (result.timedOut || context.signal.aborted) {
      throw context.signal.reason ?? new Error("real-repo task timeout");
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `benchmark executor exited with code ${result.exitCode}`);
    }
    let finalResult: RealRepoTaskExecutionResult | undefined;
    for (const line of result.stdout.split(/\r?\n/u).filter((value) => value.trim())) {
      let record: ExecutorRecord;
      try {
        record = JSON.parse(line) as ExecutorRecord;
      } catch {
        throw new Error("benchmark executor emitted non-JSON stdout");
      }
      if (record.type === "runtime_event") {
        context.recordRuntimeEvent(runtimeEvent(record.event));
      } else if (record.type === "result") {
        if (finalResult) throw new Error("benchmark executor emitted more than one result record");
        finalResult = executionResult(record.result);
      } else if (record.type === "error") {
        throw new Error(typeof record.error === "string" ? record.error : "benchmark executor failed");
      } else {
        throw new Error("benchmark executor emitted an unknown record type");
      }
    }
    if (!finalResult) throw new Error("benchmark executor emitted no result record");
    return finalResult;
  }
}

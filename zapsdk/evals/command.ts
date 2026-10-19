import { spawn, spawnSync } from "node:child_process";
import type { BenchmarkCommandResult } from "./types.js";

const DEFAULT_MAX_CAPTURE_BYTES = 1_000_000;

function boundedAppend(current: string, chunk: Buffer, maxBytes: number): string {
  const remaining = maxBytes - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  return current + chunk.subarray(0, remaining).toString("utf8");
}

export async function runBenchmarkCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<BenchmarkCommandResult> {
  const shell = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL ?? "/bin/sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", input.command]
    : ["-lc", input.command];
  return runBenchmarkProcess({
    executable: shell,
    args,
    displayCommand: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

export async function runBenchmarkProcess(input: {
  executable: string;
  args: string[];
  displayCommand?: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  maxCaptureBytes?: number;
}): Promise<BenchmarkCommandResult> {
  const startedAt = performance.now();
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdin.end(input.stdin);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const maxCaptureBytes = input.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = boundedAppend(stdout, chunk, maxCaptureBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = boundedAppend(stderr, chunk, maxCaptureBytes);
  });
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else if (process.platform === "win32" && signal === "SIGKILL" && child.pid) {
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill(signal);
      }
    } catch {
      // Process already exited.
    }
  };
  const abort = () => {
    kill("SIGTERM");
    hardKill ??= setTimeout(() => kill("SIGKILL"), input.killGraceMs ?? 2_000);
  };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, input.timeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => {
    clearTimeout(timer);
    if (hardKill) clearTimeout(hardKill);
    input.signal?.removeEventListener("abort", abort);
  });
  return {
    command: input.displayCommand ?? [input.executable, ...input.args].join(" "),
    exitCode,
    durationMs: performance.now() - startedAt,
    timedOut,
    stdout,
    stderr,
  };
}

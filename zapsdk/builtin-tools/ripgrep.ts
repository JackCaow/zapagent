import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExecutionProcessBroker } from "../execution/types.js";
import { terminateProcessTreeWithGrace } from "../execution/process.js";

// Lazy ripgrep resolution — do NOT spawn at module load.
let _rgBin: string | null | undefined = undefined;
export function getRgBin(): string | null {
  if (_rgBin !== undefined) return _rgBin;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    if (rgPath && existsSync(rgPath)) return (_rgBin = rgPath);
  } catch {}
  _rgBin = findExecutable(process.platform === "win32" ? "rg.exe" : "rg");
  return _rgBin;
}

function findExecutable(name: string): string | null {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === "win32" && !name.includes(".")
        ? `${name}${extension.toLowerCase()}`
        : name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

/** Match hidden source files too, but keep dependency/VCS directories out of
 * both tools. --no-require-git applies ignore files in non-repository projects. */
export const RIPGREP_SCOPE_ARGS = ["--no-config", "--hidden", "--no-require-git",
  "--glob=!**/.git/**", "--glob=!**/node_modules/**"];

export type SearchStopReason = "result_limit" | "output_limit" | "traversal_limit";
export interface RipgrepRun {
  unavailable?: boolean;
  error?: string;
  stderr: string;
  stopped?: SearchStopReason;
}

/** Bounded record streaming through the supplied execution capability. Only
 * ENOENT permits a JS fallback; policy denials and failed searches stay errors. */
export async function runRipgrepRecords(executable: string, args: string[], options: {
  process: ExecutionProcessBroker;
  cwd: string;
  signal?: AbortSignal;
  separator: "\n" | "\0";
  onRecord: (record: string) => SearchStopReason | undefined;
  timeoutMs?: number;
  maxRecordBytes?: number;
}): Promise<RipgrepRun> {
  if (options.signal?.aborted) return { error: "aborted", stderr: "" };
  let child;
  try { child = options.process.spawnCommand(executable, args, { cwd: options.cwd }); }
  catch (error) { return spawnFailure(error); }
  return new Promise(resolve => {
    let pending = "";
    let stderr = "";
    let error: string | undefined;
    let unavailable = false;
    let stopped: SearchStopReason | undefined;
    const stop = () => terminateProcessTreeWithGrace(child);
    const consume = (record: string) => {
      if (error || stopped || !record) return;
      try { stopped = options.onRecord(record); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
      if (stopped || error) stop();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (error || stopped) return;
      pending += chunk;
      let end: number;
      while (!error && !stopped && (end = pending.indexOf(options.separator)) >= 0) {
        const record = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(record) > (options.maxRecordBytes ?? 2_000_000)) {
          stopped = "output_limit";
          stop();
        } else consume(record);
      }
      if (!error && !stopped && Buffer.byteLength(pending) > (options.maxRecordBytes ?? 2_000_000)) {
        stopped = "output_limit";
        pending = "";
        stop();
      }
    });
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 8192); });
    child.once("error", e => {
      const failure = spawnFailure(e);
      error = failure.error;
      unavailable = failure.unavailable ?? false;
    });
    const onAbort = () => { error = "aborted"; stop(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeout = setTimeout(() => { error = "Search timed out"; stop(); }, options.timeoutMs ?? 30_000);
    timeout.unref();
    child.once("close", code => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      // A limit can race with a real traversal failure. Only a signal-based
      // exit from our own stop may be treated as a successful partial search.
      if (!unavailable && !error && code !== 0 && code !== 1 && !(stopped && code === null)) {
        error = `ripgrep exited with code ${code}: ${stderr.trim() || "no diagnostic output"}`;
      }
      if (!error && !stopped && !unavailable && pending) {
        // Text can end without a newline; NUL-delimited paths cannot. A tail
        // left after a failed process must never become a fabricated filename.
        if (options.separator === "\0") error = "ripgrep returned an unterminated NUL-delimited record";
        else consume(pending);
      }
      resolve({ error, unavailable, stderr: stderr.trim(), stopped });
    });
  });
}

function spawnFailure(error: unknown): RipgrepRun {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { unavailable: true, stderr: "" };
  return { error: error instanceof Error ? error.message : String(error), stderr: "" };
}

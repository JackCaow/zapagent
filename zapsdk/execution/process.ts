import { spawn, type ChildProcess } from "node:child_process";
import { localExecutionShell } from "./shell.js";
import { readProcessTable, snapshotDescendants } from "./process-tree.js";
import type {
  ExecutionProcessBroker,
  SandboxCommandOptions,
  SandboxExecutionContext,
} from "./types.js";

/** Broker-owned process launcher. Tool adapters receive this capability
 * instead of a command wrapper, so prepared commands cannot accidentally be
 * launched outside the OS sandbox. */
export class DefaultExecutionProcessBroker implements ExecutionProcessBroker {
  private readonly children = new Set<ChildProcess>();
  private _spawnCount = 0;
  private _sandboxedSpawnCount = 0;

  constructor(
    private readonly sandbox: SandboxExecutionContext | undefined,
    private readonly signal?: AbortSignal,
  ) {}

  get spawnCount(): number { return this._spawnCount; }
  get sandboxedSpawnCount(): number { return this._sandboxedSpawnCount; }

  spawnCommand(
    executable: string,
    args: string[],
    options: SandboxCommandOptions,
  ): ChildProcess {
    const prepared = this.sandbox?.prepareCommand(executable, args, options);
    return this.launch(
      prepared?.executable ?? executable,
      prepared?.args ?? args,
      options,
      prepared?.env ?? { ...process.env, ...options.environment },
      prepared?.release,
      prepared !== undefined,
    );
  }

  spawnShell(command: string, options: SandboxCommandOptions): ChildProcess {
    const prepared = this.sandbox?.prepareShell(command, options);
    if (prepared) {
      return this.launch(
        prepared.executable,
        prepared.args,
        options,
        prepared.env,
        prepared.release,
        true,
      );
    }
    const { executable, argsPrefix } = localExecutionShell();
    const args = [...argsPrefix, command];
    return this.launch(executable, args, options, { ...process.env, ...options.environment }, undefined, false);
  }

  private launch(
    executable: string,
    args: string[],
    options: SandboxCommandOptions,
    env: NodeJS.ProcessEnv,
    release: (() => void) | undefined,
    sandboxed: boolean,
  ): ChildProcess {
    if (this.signal?.aborted) {
      release?.();
      throw new Error("aborted");
    }
    this._spawnCount += 1;
    if (sandboxed) this._sandboxedSpawnCount += 1;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env,
        // The Windows AppContainer bootstrap forwards its standard handles to
        // CreateProcess. Give it a real stdin handle instead of NUL, then close
        // our writer immediately so commands that read stdin observe EOF.
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
      });
      child.stdin?.end();
    } catch (error) {
      release?.();
      throw error;
    }
    this.children.add(child);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.children.delete(child);
      this.signal?.removeEventListener("abort", onAbort);
      release?.();
    };
    const onAbort = () => terminateProcessTreeWithGrace(child);
    this.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", cleanup);
    child.once("error", cleanup);
    return child;
  }
}

/** Compatibility launcher for direct Tool.handler() calls in SDK embeddings
 * and isolated tests. Production calls receive a broker-owned instance. */
export function createLocalProcessBroker(signal?: AbortSignal): ExecutionProcessBroker {
  return new DefaultExecutionProcessBroker(undefined, signal);
}

const terminatingDescendants = new WeakMap<object, Map<number, string>>();

export function terminateProcessTree(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  signal: NodeJS.Signals,
): boolean {
  // Wrappers can create another process group. Snapshot ancestry before TERM
  // exits the leader, then retain identities for escalation after reparenting.
  let descendants = new Map<number, string>();
  if (process.platform !== "win32" && child.pid) {
    descendants = snapshotDescendants(
      child.exitCode === null && child.signalCode === null ? child.pid : undefined,
      readProcessTable(), terminatingDescendants.get(child) ?? new Map(),
    );
    terminatingDescendants.set(child, descendants);
  }
  let delivered = false;
  const killChild = () => child.exitCode === null && child.signalCode === null && child.kill(signal);
  try {
    if (process.platform === "win32" || !child.pid) delivered = killChild();
    // The group can outlive its leader and keep stdout/stderr open. A leader's
    // exit must not suppress escalation to surviving descendants.
    else delivered = process.kill(-child.pid, signal);
  } catch {
    try { delivered = killChild(); } catch {}
  }
  for (const pid of descendants.keys()) {
    try { delivered = process.kill(pid, signal) || delivered; } catch { /* Already exited. */ }
  }
  return delivered;
}

export function terminateProcessTreeWithGrace(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  graceMs = 1000,
): void {
  terminateProcessTree(child, "SIGTERM");
  const force = setTimeout(() => terminateProcessTree(child, "SIGKILL"), graceMs);
  force.unref();
}

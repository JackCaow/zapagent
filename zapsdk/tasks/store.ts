import { spawnSync } from "node:child_process"
import { chmodSync, constants, closeSync, createWriteStream, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync, type WriteStream } from "node:fs"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { getAppDataDir } from "../utils/platform.js"
import { resolveProjectDataSegment } from "../utils/project-paths.js"
import { pathConverter } from "../utils/path.js"
import { createLocalProcessBroker, terminateProcessTree } from "../execution/process.js"
import type {
  Task,
  TaskSnapshot,
  SpawnShellOptions,
  TaskExitedEvent,
  TaskStartedEvent,
} from "./types.js"

/** Hard ceiling on a single task's captured output, in bytes. Matches the
 *  5 GiB cap CCB enforces. Exceeded → SIGKILL the child, write a marker line. */
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024

export interface TaskStoreOptions {
  /** Override the directory where per-task `<taskId>.log` files land.
   *  Defaults to `<getAppDataDir()>/projects/<project-id>/tasks/outputs`. */
  outputDir?: string
  /** Project cwd used to derive `<project-id>` when outputDir is not supplied.
   *  Defaults to `process.cwd()` for backwards compatibility. */
  projectCwd?: string
  /** Override the per-task output cap. */
  maxOutputBytes?: number
}

/** Typed listener helpers — TS doesn't infer event payloads on the base
 *  EventEmitter, so we narrow `on`/`emit` per event name. */
export interface TaskStoreEvents {
  started: (e: TaskStartedEvent) => void
  exited: (e: TaskExitedEvent) => void
}

/**
 * In-process registry for long-running background tasks (today: shell;
 * tomorrow: agent / workflow / etc.). One TaskStore is shared across every
 * tool that wants to spawn or manage tasks — bash with run_in_background,
 * the monitor tool, and any future task_list / task_kill tools all read
 * from the same map.
 *
 * Lifecycle is **session-scoped on purpose**: when zap exits, `stopAll()`
 * kills every live child. We don't persist tasks across restarts — same
 * choice CCB and Claude Code make. The alternative (detached + rehydrate)
 * has a long tail of edge cases (orphaned files, pid reuse, lost stdout
 * pipes) that aren't worth the complexity given how rarely people want a
 * task to outlive its parent agent.
 */
export class TaskStore extends EventEmitter {
  /** Ephemeral registry identity for matching Host lifecycle facts, not an access token. */
  readonly instanceId = randomBytes(16).toString("hex")
  private tasks = new Map<string, Task>()
  private observedExits = new Set<string>()

  /** A terminal result delivered through task_status or a notification needs no second wake-up. */
  observeExit(taskId: string): void {
    if (this.tasks.get(taskId)?.exitedAt !== undefined) this.observedExits.add(taskId)
  }

  hasObservedExit(taskId: string): boolean { return this.observedExits.has(taskId) }
  private streams = new Map<string, WriteStream>()
  private byteCounts = new Map<string, number>()
  private outputIdentities = new Map<string, { dev: number; ino: number }>()
  private readonly outputDir: string
  private readonly maxOutputBytes: number

  constructor(options: TaskStoreOptions = {}) {
    super()
    const projectCwd = options.projectCwd ?? process.cwd()
    this.outputDir = options.outputDir ?? join(
      getAppDataDir(),
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tasks",
      "outputs",
    )
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  /** Type-narrowed event subscription. */
  override on<E extends keyof TaskStoreEvents>(event: E, listener: TaskStoreEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  /** Type-narrowed event emission (internal — callers shouldn't emit). */
  override emit<E extends keyof TaskStoreEvents>(event: E, payload: Parameters<TaskStoreEvents[E]>[0]): boolean {
    return super.emit(event, payload)
  }

  /** Spawn a background shell command. Returns a snapshot immediately;
   *  the live `ChildProcess` is held internally. Throws when spawn fails
   *  before getting a pid (rare — usually a malformed shell invocation). */
  spawnShell(opts: SpawnShellOptions): TaskSnapshot {
    this.ensureDir()
    const taskId = this.newId()
    const outputFile = join(this.outputDir, `${taskId}.log`)
    const command = pathConverter.sanitizeDevNull(opts.command)
    const description = (opts.description ?? command.slice(0, 60)).trim() || command.slice(0, 60)

    // Touch the file synchronously so callers can `existsSync(outputFile)`
    // right after spawn returns. createWriteStream's fd open is async on Bun
    // and isn't guaranteed to have hit disk before the snapshot is returned.
    writeFileSync(outputFile, "", { flag: "a", mode: 0o600 })
    chmodSync(outputFile, 0o600)
    const identity = lstatSync(outputFile)
    if (!identity.isFile()) throw new Error("Task output must be a regular file")
    const out = createWriteStream(outputFile, { flags: "a", mode: 0o600 })
    out.on("error", () => {})

    const processBroker = opts.process ?? createLocalProcessBroker()
    let child
    try {
      child = processBroker.spawnShell(command, {
        cwd: opts.cwd ?? process.cwd(),
        background: true,
        preserveEnvironment: opts.preserveEnvironment,
      })
    } catch (error) {
      try { out.end() } catch {}
      throw error
    }
    if (!child.pid) {
      try { out.end() } catch {}
      throw new Error(`Failed to spawn command: ${command}`)
    }

    const task: Task = {
      taskId,
      kind: "shell",
      command,
      description,
      outputFile,
      pid: child.pid,
      startedAt: Date.now(),
      ownerAgentId: opts.ownerAgentId,
      sessionId: opts.sessionId,
      child,
    }
    this.tasks.set(taskId, task)
    this.outputIdentities.set(taskId, { dev: identity.dev, ino: identity.ino })
    this.streams.set(taskId, out)
    this.byteCounts.set(taskId, 0)

    let outputBytes = 0
    let outputLimitExceeded = false
    const taskOutputLimit = Math.min(this.maxOutputBytes, opts.maxOutputBytes ?? this.maxOutputBytes)
    let finalizing = false
    const finalize = (code: number | null, sig: NodeJS.Signals | null) => {
      if (finalizing || task.exitedAt !== undefined) return
      finalizing = true
      task.exitCode = code
      task.signal = sig
      const complete = () => {
        if (task.exitedAt !== undefined) return
        task.exitedAt = Date.now()
        this.streams.delete(taskId)
        this.emit("exited", {
          taskId,
          exitCode: code,
          signal: sig,
          outputBytes: this.byteCounts.get(taskId) ?? 0,
        })
      }
      try {
        if (out.destroyed) complete()
        else {
          out.once("error", complete)
          out.end(complete)
        }
      } catch {
        complete()
      }
    }
    // Child `close` fires after stdio streams are closed. Publishing completion
    // only after our output stream finishes makes the contract stronger:
    // consumers that observe exitedAt or `exited` can immediately read outputFile.
    //
    // Register these lifecycle listeners before attaching data handlers below.
    // Very short-lived commands can exit fast enough under Bun/full-suite load
    // that delaying the `close` subscription leaves the task permanently
    // running from the store's point of view.
    child.on("close", (code, sig) => finalize(code, sig))
    child.on("error", (err) => {
      try { out.write(`\n[task-store] spawn error: ${err.message}\n`) } catch {}
      finalize(null, null)
    })

    const handleData = (chunk: Buffer) => {
      outputBytes += chunk.length
      this.byteCounts.set(taskId, outputBytes)
      try { out.write(chunk) } catch {}
      let resourceExceeded = false
      try { opts.resources?.consumeBackgroundOutputBytes(chunk.length) } catch { resourceExceeded = true }
      if ((outputBytes > taskOutputLimit || resourceExceeded) && !outputLimitExceeded) {
        outputLimitExceeded = true
        try { out.write(`\n[task-store] output exceeded ${taskOutputLimit} bytes; sending SIGKILL\n`) } catch {}
        this.signalTask(task, "SIGKILL")
      }
    }
    child.stdout?.on("data", handleData)
    child.stderr?.on("data", handleData)

    const snapshot = this.snapshotOf(task)
    this.emit("started", { task: snapshot })
    return snapshot
  }

  get(taskId: string): TaskSnapshot | undefined {
    const t = this.tasks.get(taskId)
    return t ? this.snapshotOf(t) : undefined
  }

  /** Enumerate tasks with optional filtering. Order is insertion order
   *  (the Map iterator preserves it), which is also chronological. */
  list(filter?: { ownerAgentId?: string; running?: boolean }): TaskSnapshot[] {
    const out: TaskSnapshot[] = []
    for (const t of this.tasks.values()) {
      if (filter?.ownerAgentId !== undefined && t.ownerAgentId !== filter.ownerAgentId) continue
      if (filter?.running === true && t.exitedAt !== undefined) continue
      if (filter?.running === false && t.exitedAt === undefined) continue
      out.push(this.snapshotOf(t))
    }
    return out
  }

  /** Return the most recent captured output for a task. Keeping this behind
   * the store avoids teaching callers where task logs live or letting an
   * agent construct arbitrary paths while checking a background operation. */
  tailOutput(taskId: string, maxBytes = 4 * 1024): string | undefined {
    try {
      return this.readOutputPage(taskId, undefined, maxBytes)?.content
    } catch {
      // A just-created stream may not have flushed yet. Status remains useful
      // and callers can retry only when they have a real dependency.
      return ""
    }
  }

  /** Byte-addressed pages from a task owned by this store. Undefined offset
   * selects the tail. Descriptor reads stay bounded even for multi-GB logs. */
  readOutputPage(taskId: string, offset?: number, maxBytes = 4096) {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new Error("Output offset must be a nonnegative safe integer")
    }
    const limit = Number.isFinite(maxBytes) ? Math.min(16 * 1024, Math.max(0, Math.floor(maxBytes))) : 4096
    const fd = openSync(task.outputFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd)
      const identity = this.outputIdentities.get(taskId)
      if (!info.isFile() || info.dev !== identity?.dev || info.ino !== identity?.ino) {
        throw new Error("Task output identity changed")
      }
      const start = Math.min(offset ?? Math.max(0, info.size - limit), info.size)
      // Up to three lookahead bytes finish a UTF-8 character crossing a page.
      const buffer = Buffer.alloc(Math.min(limit + 3, info.size - start))
      let available = 0
      while (available < buffer.length) {
        const count = readSync(fd, buffer, available, buffer.length - available, start + available)
        if (!count) break
        available += count
      }
      let begin = 0
      if (offset === undefined) {
        while (begin < available && (buffer[begin]! & 0xc0) === 0x80) begin++
      }
      let end = Math.min(limit, available)
      if (end > begin) {
        let lead = end - 1
        while (lead > begin && (buffer[lead]! & 0xc0) === 0x80) lead--
        const byte = buffer[lead]!
        const width = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1
        if (lead + width > end) {
          if (lead + width <= available) end = lead + width
          else if (task.exitedAt === undefined) end = lead
        }
      }
      end = Math.max(begin, end)
      const next = start + end
      return {
        offset: start + begin,
        byte_length: end - begin,
        total_bytes: info.size,
        next_offset: next < info.size ? next : null,
        content: buffer.subarray(begin, end).toString("utf8"),
      }
    } finally { closeSync(fd) }
  }

  /** Signal a single task. Returns false if the task is unknown or has
   *  already exited. Default signal is SIGTERM — caller picks SIGKILL
   *  for force. */
  kill(taskId: string, sig: NodeJS.Signals = "SIGTERM"): boolean {
    const t = this.tasks.get(taskId)
    if (!t || t.exitedAt !== undefined) return false
    return this.signalTask(t, sig)
  }

  /** Kill every still-running task owned by a given agent. Called when a
   *  sub-agent terminates so its shell children don't reparent to init.
   *  Returns the number of kill signals successfully delivered. */
  killByOwner(ownerAgentId: string, sig: NodeJS.Signals = "SIGTERM"): number {
    let killed = 0
    for (const t of this.tasks.values()) {
      if (t.ownerAgentId !== ownerAgentId) continue
      if (t.exitedAt !== undefined) continue
      if (this.signalTask(t, sig)) killed++
    }
    return killed
  }

  /** Kill every still-running task. Output streams are closed by the child
   *  `close` finalizer, not here, so shell traps/cleanup output emitted after
   *  the signal still lands in outputFile before the `exited` event fires. */
  stopAll(sig: NodeJS.Signals = "SIGTERM"): void {
    for (const t of this.tasks.values()) {
      if (t.exitedAt !== undefined) continue
      this.signalTask(t, sig)
    }
  }

  /** Stop selected tasks and wait for process close plus output flush. */
  async settle(taskIds: string[], graceMs = 1000): Promise<void> {
    const pending = () => taskIds.filter(id => this.get(id)?.exitedAt === undefined && this.get(id));
    const wait = () => new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.off("exited", check); resolve(); };
      const check = () => { if (!pending().length) done(); };
      const timer = setTimeout(done, graceMs);
      this.on("exited", check);
      check();
    });
    for (const id of pending()) this.kill(id, "SIGTERM");
    await wait();
    for (const id of pending()) this.kill(id, "SIGKILL");
    await wait();
  }

  private signalTask(task: Task, sig: NodeJS.Signals): boolean {
    const child = task.child
    if (!child?.pid) return false

    if (process.platform === "win32") {
      const args = ["/PID", String(child.pid), "/T"]
      if (sig === "SIGKILL") args.push("/F")
      const result = spawnSync("taskkill", args, {
        windowsHide: true,
        stdio: "ignore",
      })
      if (!result.error && result.status === 0) return true
    } else {
      return terminateProcessTree(child, sig)
    }

    try {
      return child.kill(sig)
    } catch {
      return false
    }
  }

  private ensureDir(): void {
    mkdirSync(this.outputDir, { recursive: true })
    chmodSync(this.outputDir, 0o700)
  }

  private newId(): string {
    for (let i = 0; i < 8; i++) {
      const id = randomBytes(4).toString("hex")
      if (!this.tasks.has(id)) return id
    }
    throw new Error("Failed to generate unique task id after 8 attempts")
  }

  private snapshotOf(task: Task): TaskSnapshot {
    const { child: _child, ...rest } = task
    return rest
  }
}

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DefaultExecutionProcessBroker } from "../../execution/process.js"
import type { SandboxExecutionContext } from "../../execution/types.js"
import { TaskStore } from "../../tasks/store.js"
import type { TaskExitedEvent } from "../../tasks/types.js"
import { resolveProjectDataSegment } from "../../utils/project-paths.js"

function awaitExit(store: TaskStore, taskId: string): Promise<TaskExitedEvent> {
  return new Promise((resolve) => {
    const done = (event: TaskExitedEvent) => {
      store.off("exited", onExit as (...args: unknown[]) => void)
      resolve(event)
    }
    const onExit = (e: TaskExitedEvent) => {
      if (e.taskId === taskId) done(e)
    }
    store.on("exited", onExit)
    const snap = store.get(taskId)
    if (snap?.exitedAt !== undefined) {
      done({
        taskId,
        exitCode: snap.exitCode ?? null,
        signal: snap.signal ?? null,
        outputBytes: existsSync(snap.outputFile) ? statSync(snap.outputFile).size : 0,
      })
    }
  })
}

function awaitAllExited(store: TaskStore, taskIds: string[], timeoutMs = 3000): Promise<TaskExitedEvent[]> {
  const pending = new Set(taskIds)
  const events = new Map<string, TaskExitedEvent>()

  const recordSnapshot = (taskId: string): void => {
    const snap = store.get(taskId)
    if (snap?.exitedAt === undefined) return
    pending.delete(taskId)
    events.set(taskId, {
      taskId,
      exitCode: snap.exitCode ?? null,
      signal: snap.signal ?? null,
      outputBytes: existsSync(snap.outputFile) ? statSync(snap.outputFile).size : 0,
    })
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      store.off("exited", onExit as (...args: unknown[]) => void)
    }
    const finishIfDone = () => {
      if (pending.size > 0) return
      cleanup()
      resolve(taskIds.map((id) => events.get(id)!))
    }
    const onExit = (event: TaskExitedEvent) => {
      if (!pending.has(event.taskId)) return
      pending.delete(event.taskId)
      events.set(event.taskId, event)
      finishIfDone()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for task exits: ${[...pending].join(", ")}`))
    }, timeoutMs)

    store.on("exited", onExit)
    for (const taskId of taskIds) recordSnapshot(taskId)
    finishIfDone()
  })
}

async function waitForFileText(path: string, needle: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf-8").includes(needle)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${needle}`)
}

describe("TaskStore", () => {
  let store: TaskStore
  let outputDir: string
  let cleanupDataDir: string | null = null
  let cleanupProjectDirs: string[] = []
  let previousDataDir: string | undefined
  let previousDataDirCaptured = false

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "zap-task-store-"))
    chmodSync(outputDir, 0o777)
    store = new TaskStore({ outputDir })
  })

  afterEach(() => {
    try { store.stopAll("SIGKILL") } catch {}
    try { rmSync(outputDir, { recursive: true, force: true }) } catch {}
    if (cleanupDataDir) {
      rmSync(cleanupDataDir, { recursive: true, force: true })
      cleanupDataDir = null
    }
    for (const dir of cleanupProjectDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    cleanupProjectDirs = []
    if (previousDataDirCaptured && previousDataDir !== undefined) {
      process.env.ZAPCODE_DATA_DIR = previousDataDir
      previousDataDir = undefined
    } else if (previousDataDirCaptured) {
      delete process.env.ZAPCODE_DATA_DIR
    }
    previousDataDirCaptured = false
  })

  it("spawns a shell command, streams output to file, emits exit event", async () => {
    const snap = store.spawnShell({ command: "printf 'hello\\nworld\\n'" })
    expect(snap.taskId).toMatch(/^[0-9a-f]{8}$/)
    expect(snap.outputFile.startsWith(outputDir)).toBe(true)
    expect(snap.pid).toBeGreaterThan(0)
    expect(snap.exitedAt).toBeUndefined()

    const event = await awaitExit(store, snap.taskId)
    expect(event.exitCode).toBe(0)
    expect(event.outputBytes).toBeGreaterThan(0)

    const contents = readFileSync(snap.outputFile, "utf-8")
    expect(contents).toContain("hello")
    expect(contents).toContain("world")
    expect(statSync(snap.outputFile).mode & 0o777).toBe(0o600)
    expect(statSync(outputDir).mode & 0o777).toBe(0o700)
  })

  it("passes explicitly preserved runtime variables to background processes", async () => {
    let preservedEnvironment: string[] | undefined
    const sandbox = {
      provider: "zapvm",
      enforced: true,
      readablePaths: [outputDir],
      writablePaths: [outputDir],
      protectedPaths: [],
      networkAllowed: false,
      prepareCommand: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
      prepareShell: (_command, options) => {
        preservedEnvironment = options.preserveEnvironment
        return { executable: "/usr/bin/true", args: [], env: {}, release: () => {} }
      },
    } satisfies SandboxExecutionContext

    const snap = store.spawnShell({
      command: "true",
      preserveEnvironment: ["ZAPVM_ARTIFACT_DIR"],
      process: new DefaultExecutionProcessBroker(sandbox),
    })
    await awaitExit(store, snap.taskId)

    expect(preservedEnvironment).toEqual(["ZAPVM_ARTIFACT_DIR"])
  })

  it("get() returns updated snapshot after exit (no leaking child handle)", async () => {
    const snap = store.spawnShell({ command: "true" })
    await awaitExit(store, snap.taskId)

    const after = store.get(snap.taskId)
    expect(after?.exitedAt).toBeDefined()
    expect(after?.exitCode).toBe(0)
    // The "child" field must NOT be present on snapshots.
    expect((after as Record<string, unknown>).child).toBeUndefined()
  })

  it("tracks bursts of very short-lived commands without losing exits", async () => {
    const snaps = Array.from({ length: 25 }, (_, i) =>
      store.spawnShell({ command: `printf fast-${i}` }))
    const exits = await awaitAllExited(store, snaps.map((snap) => snap.taskId))

    expect(exits.every((event) => event.exitCode === 0)).toBe(true)
    for (let i = 0; i < snaps.length; i++) {
      const snap = store.get(snaps[i]!.taskId)
      expect(snap?.exitedAt).toBeDefined()
      expect(readFileSync(snaps[i]!.outputFile, "utf-8")).toBe(`fast-${i}`)
    }
  })

  it("defaults description to first 60 chars of command", () => {
    const long = "echo " + "x".repeat(200)
    const snap = store.spawnShell({ command: long })
    expect(snap.description.length).toBeLessThanOrEqual(60)
    expect(snap.description.startsWith("echo")).toBe(true)
  })

  it("list() filters by running flag", async () => {
    const a = store.spawnShell({ command: "true" })
    const b = store.spawnShell({ command: "sleep 5" })
    await awaitExit(store, a.taskId)

    const running = store.list({ running: true })
    expect(running.map(t => t.taskId)).toEqual([b.taskId])

    const done = store.list({ running: false })
    expect(done.map(t => t.taskId)).toEqual([a.taskId])

    // Don't leak the sleep process to other tests.
    store.kill(b.taskId, "SIGKILL")
  })

  it("kill() returns false for already-exited tasks", async () => {
    const snap = store.spawnShell({ command: "true" })
    await awaitExit(store, snap.taskId)
    expect(store.kill(snap.taskId)).toBe(false)
  })

  it("killByOwner kills only matching agent's tasks", async () => {
    const a = store.spawnShell({ command: "sleep 5", ownerAgentId: "agent-1" })
    const b = store.spawnShell({ command: "sleep 5", ownerAgentId: "agent-2" })
    const c = store.spawnShell({ command: "sleep 5", ownerAgentId: "agent-1" })

    // Register the listener BEFORE the kill so we catch both exits no
    // matter how fast they fire.
    const bothAgent1Exited = new Promise<void>((resolve) => {
      const exited = new Set<string>()
      store.on("exited", (e) => {
        exited.add(e.taskId)
        if (exited.has(a.taskId) && exited.has(c.taskId)) resolve()
      })
    })

    const killed = store.killByOwner("agent-1", "SIGKILL")
    expect(killed).toBe(2)

    await bothAgent1Exited
    expect(store.get(b.taskId)?.exitedAt).toBeUndefined()

    store.kill(b.taskId, "SIGKILL")
  })

  it("stopAll signals all live tasks and is idempotent", async () => {
    const a = store.spawnShell({ command: "sleep 5" })
    const b = store.spawnShell({ command: "sleep 5" })
    // Register the listener BEFORE the kill so we don't race the exit event.
    const both = new Promise<void>((resolve) => {
      const exited = new Set<string>()
      store.on("exited", (e) => {
        exited.add(e.taskId)
        if (exited.has(a.taskId) && exited.has(b.taskId)) resolve()
      })
    })
    store.stopAll("SIGKILL")
    store.stopAll("SIGKILL") // second call must not throw
    await both
  })

  it("stopAll keeps output stream open until signal cleanup output is flushed", async () => {
    const snap = store.spawnShell({
      command: "trap 'echo cleanup; exit 0' TERM; echo ready; while true; do sleep 1; done",
    })
    await waitForFileText(snap.outputFile, "ready")

    const exited = awaitExit(store, snap.taskId)
    store.stopAll("SIGTERM")
    await exited

    const contents = readFileSync(snap.outputFile, "utf-8")
    expect(contents).toContain("ready")
    expect(contents).toContain("cleanup")
  })

  it("writes output file path under the configured outputDir", async () => {
    const snap = store.spawnShell({ command: "true" })
    expect(snap.outputFile).toContain(outputDir)
    // createWriteStream opens the fd async, so the file may not be on disk
    // synchronously. Wait for exit, then assert existence.
    await awaitExit(store, snap.taskId)
    expect(existsSync(snap.outputFile)).toBe(true)
  })

  it("recreates the output directory if it is removed between spawns", async () => {
    const first = store.spawnShell({ command: "true" })
    await awaitExit(store, first.taskId)
    rmSync(outputDir, { recursive: true, force: true })

    const second = store.spawnShell({ command: "printf recreated" })
    await awaitExit(store, second.taskId)

    expect(readFileSync(second.outputFile, "utf-8")).toBe("recreated")
    if (process.platform !== "win32") {
      expect(statSync(outputDir).mode & 0o777).toBe(0o700)
      expect(statSync(second.outputFile).mode & 0o777).toBe(0o600)
    }
  })

  it("tightens the output directory again on later spawns", async () => {
    const first = store.spawnShell({ command: "true" })
    await awaitExit(store, first.taskId)
    mkdirSync(outputDir, { recursive: true })
    chmodSync(outputDir, 0o777)

    const second = store.spawnShell({ command: "true" })
    await awaitExit(store, second.taskId)

    if (process.platform !== "win32") {
      expect(statSync(outputDir).mode & 0o777).toBe(0o700)
    }
  })

  it("defaults output files to the project data directory", async () => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    previousDataDirCaptured = true
    cleanupDataDir = mkdtempSync(join(tmpdir(), "zap-task-default-"))
    process.env.ZAPCODE_DATA_DIR = cleanupDataDir

    const scoped = new TaskStore()
    const snap = scoped.spawnShell({ command: "printf scoped; sleep 0.1" })
    const exited = awaitExit(scoped, snap.taskId)
    const expectedDir = join(
      cleanupDataDir,
      "projects",
      resolveProjectDataSegment(process.cwd()),
      "tasks",
      "outputs",
    )

    expect(snap.outputFile.startsWith(expectedDir)).toBe(true)
    await exited
    expect(readFileSync(snap.outputFile, "utf-8")).toBe("scoped")
    if (process.platform !== "win32") {
      expect(statSync(expectedDir).mode & 0o777).toBe(0o700)
      expect(statSync(snap.outputFile).mode & 0o777).toBe(0o600)
    }
  })

  it("uses explicit projectCwd for default output directory", async () => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    previousDataDirCaptured = true
    cleanupDataDir = mkdtempSync(join(tmpdir(), "zap-task-explicit-"))
    const projectCwd = mkdtempSync(join(tmpdir(), "zap-task-project-"))
    cleanupProjectDirs.push(projectCwd)
    process.env.ZAPCODE_DATA_DIR = cleanupDataDir

    const scoped = new TaskStore({ projectCwd })
    const snap = scoped.spawnShell({ command: "printf project-scoped" })
    const exited = awaitExit(scoped, snap.taskId)
    const expectedDir = join(
      cleanupDataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tasks",
      "outputs",
    )

    expect(snap.outputFile.startsWith(expectedDir)).toBe(true)
    await exited
    expect(readFileSync(snap.outputFile, "utf-8")).toBe("project-scoped")
  })
})

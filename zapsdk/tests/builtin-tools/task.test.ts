import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { taskStatusTool, taskStopTool } from "../../builtin-tools/task.js"
import { createBuiltinRegistry } from "../../builtin-tools/index.js"
import { TaskStore } from "../../tasks/store.js"
import type { TaskExitedEvent } from "../../tasks/types.js"

function waitForExit(store: TaskStore, taskId: string): Promise<TaskExitedEvent> {
  return new Promise((resolve) => {
    const onExit = (event: TaskExitedEvent) => {
      if (event.taskId !== taskId) return
      store.off("exited", onExit)
      resolve(event)
    }
    store.on("exited", onExit)
    const existing = store.get(taskId)
    if (existing?.exitedAt !== undefined) {
      store.off("exited", onExit)
      resolve({
        taskId,
        exitCode: existing.exitCode ?? null,
        signal: existing.signal ?? null,
        outputBytes: 0,
      })
    }
  })
}

describe("background task control tools", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("reports a store-owned output tail after a task exits", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-tool-"))
    dirs.push(outputDir)
    const store = new TaskStore({ outputDir })
    const task = store.spawnShell({ command: "printf 'background-ready\\n'" })
    await waitForExit(store, task.taskId)

    const result = await taskStatusTool({ store }).handler({
      task_id: task.taskId,
      include_output: true,
      tail_bytes: 1024,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('"status": "exited"')
    expect(result.output).toContain("background-ready")
    expect(result.output).toContain("Do not repeatedly poll")
  })

  it("registers task controls only when a caller supplies the shared store", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-tool-"))
    dirs.push(outputDir)
    const store = new TaskStore({ outputDir })

    const withoutTasks = createBuiltinRegistry({ exclude: ["bash"] })
    const withTasks = createBuiltinRegistry({
      taskTools: { store },
      exclude: ["bash"],
    })

    expect(withoutTasks.has("task_status")).toBe(false)
    expect(withTasks.get("task_status")?.definition.permission).toBe("auto")
    expect(withTasks.get("task_stop")?.definition.permission).toBe("confirm")
  })

  it("waits for a selected task by default and returns its fully drained output", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-wait-"))
    dirs.push(outputDir)
    const store = new TaskStore({ outputDir })
    const task = store.spawnShell({ command: "sleep 0.05; printf 'wait-completed\\n'" })
    const result = await taskStatusTool({ store }).handler({ task_id: task.taskId, include_output: true, tail_bytes: 1024 })
    expect(result.runtime?.taskObservation?.tasks).toEqual([{ taskId: task.taskId, status: "exited" }])
    expect(result.output).toContain("wait-completed")
    expect(store.listenerCount("exited")).toBe(0)
  })

  it("a bounded wait or immediate snapshot leaves the task running", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-wait-"))
    dirs.push(outputDir)
    const store = new TaskStore({ outputDir })
    const task = store.spawnShell({ command: "sleep 10" })
    try {
      for (const wait_ms of [0, 20]) {
        const result = await taskStatusTool({ store }).handler({ task_id: task.taskId, wait_ms })
        expect(result.runtime?.taskObservation?.tasks).toEqual([{ taskId: task.taskId, status: "running" }])
        expect(store.get(task.taskId)?.exitedAt).toBeUndefined()
        expect(store.listenerCount("exited")).toBe(0)
      }
    } finally { store.kill(task.taskId, "SIGKILL"); await waitForExit(store, task.taskId) }
  })

  it("cancels waiting without cancelling the owned task or leaking listeners", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-wait-"))
    dirs.push(outputDir)
    const store = new TaskStore({ outputDir })
    const task = store.spawnShell({ command: "sleep 10" })
    const controller = new AbortController()
    try {
      const pending = taskStatusTool({ store }).handler({ task_id: task.taskId }, controller.signal)
      controller.abort(new Error("wait cancelled"))
      await expect(pending).rejects.toThrow("wait cancelled")
      expect(store.get(task.taskId)?.exitedAt).toBeUndefined()
      expect(store.listenerCount("exited")).toBe(0)
    } finally { store.kill(task.taskId, "SIGKILL"); await waitForExit(store, task.taskId) }
  })

  it("rejects an unknown task and only signals a known running task", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-tool-"))
    dirs.push(outputDir)
    const store = new TaskStore({ outputDir })
    const status = taskStatusTool({ store })
    const stop = taskStopTool({ store })

    const missing = await status.handler({ task_id: "unknown", include_output: false, tail_bytes: 4096 })
    expect(missing.success).toBe(false)

    const task = store.spawnShell({ command: "sleep 5" })
    const stopped = await stop.handler({ task_id: task.taskId, force: false })
    expect(stopped).toMatchObject({ success: true })
    await waitForExit(store, task.taskId)
  })
})

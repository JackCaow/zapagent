import { z } from "zod"
import type { Tool } from "../tools/types.js"
import type { TaskSnapshot } from "../tasks/types.js"
import { TaskStore } from "../tasks/store.js"

export interface TaskToolsOptions {
  store: TaskStore
}

function statusOf(task: TaskSnapshot): "running" | "exited" {
  return task.exitedAt === undefined ? "running" : "exited"
}

async function waitForTaskExit(store: TaskStore, taskId: string, waitMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const task = store.get(taskId)
  if (!task || task.exitedAt !== undefined || waitMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer)
      store.off("exited", onExit)
      signal?.removeEventListener("abort", onAbort)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const onExit = (event: { taskId: string }) => { if (event.taskId === taskId) finish() }
    const onAbort = () => finish(signal?.reason ?? new Error("aborted"))
    const timer = setTimeout(() => finish(), waitMs)
    store.on("exited", onExit)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else if (store.get(taskId)?.exitedAt !== undefined) finish()
  })
}

function taskView(store: TaskStore, task: TaskSnapshot, includeOutput: boolean, tailBytes: number, outputOffset?: number) {
  return {
    taskId: task.taskId,
    kind: task.kind,
    description: task.description,
    pid: task.pid,
    status: statusOf(task),
    verification: "unverified",
    startedAt: task.startedAt,
    ...(task.exitedAt !== undefined ? {
      exitedAt: task.exitedAt,
      exitCode: task.exitCode ?? null,
      signal: task.signal ?? null,
    } : {}),
    ...(outputOffset !== undefined
      ? { outputPage: store.readOutputPage(task.taskId, outputOffset, tailBytes) }
      : includeOutput ? { outputTail: store.tailOutput(task.taskId, tailBytes) ?? "" } : {}),
  }
}

/** Read-only task metadata for commands started with `run_in_background`.
 * This intentionally exposes store-owned ids instead of a generic shell
 * polling surface, which prevents `sleep`/`ps` loops from consuming turns. */
export function taskStatusTool(options: TaskToolsOptions): Tool {
  return {
    definition: {
      name: "task_status",
      description: "Inspect or wait for a tracked background task. Use include_output=true for recent output, or output_offset=0 and subsequent next_offset values to page through its log by task ID; outputFile paths do not grant read_file access. A specific running task waits up to 30 seconds by default; listing and output pages are immediate unless wait_ms is supplied. Use when a dependent action needs the result; completion is also delivered automatically.",
      timeoutMs: 40_000,
      parameters: z.object({
        task_id: z.string().min(1).optional().describe("Specific task id; omit to list tracked tasks"),
        include_output: z.boolean().optional().default(false).describe("Include up to tail_bytes of recent output"),
        tail_bytes: z.number().int().min(256).max(16 * 1024).optional().default(4096).describe("Output byte limit for a tail or page; pages may add up to 3 bytes to finish a UTF-8 character"),
        output_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe("Byte offset for a log page; requires task_id and implies output inclusion. Follow next_offset for intact UTF-8 text. A partial live character may leave the cursor unchanged until more output arrives."),
        wait_ms: z.number().int().min(0).max(30_000).optional().describe("Wait for the selected task to exit, up to 30000 ms; 0 returns immediately. Timeout only ends this wait, not the task."),
      }),
      permission: "auto",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [], external: [],
        workspace: { mode: "shared-readonly" as const },
        confidence: "declared" as const,
      }),
    },
    handler: async (args, signal, context) => {
      signal?.throwIfAborted()
      const taskId = args.task_id as string | undefined
      const includeOutput = args.include_output === true
      const tailBytes = args.tail_bytes as number
      const outputOffset = args.output_offset as number | undefined
      if (outputOffset !== undefined && !taskId) return { success: false, output: "", error: "output_offset requires task_id" }
      if (taskId && context?.sessionId && options.store.get(taskId)?.sessionId && options.store.get(taskId)?.sessionId !== context.sessionId) {
        return { success: false, output: "", error: `Unknown background task in this session: ${taskId}` }
      }
      if (taskId) await waitForTaskExit(options.store, taskId, (args.wait_ms as number | undefined) ?? (outputOffset === undefined ? 30_000 : 0), signal)
      signal?.throwIfAborted()
      const tasks = taskId
        ? [options.store.get(taskId)].filter((task): task is TaskSnapshot => task !== undefined)
        : options.store.list().filter(task => !context?.sessionId || !task.sessionId || task.sessionId === context.sessionId)
      if (taskId && tasks.length === 0) {
        return { success: false, output: "", error: `Unknown background task: ${taskId}` }
      }
      let views
      try { views = tasks.map((task) => taskView(options.store, task, includeOutput, tailBytes, outputOffset)) }
      catch (error) { return { success: false, output: "", error: `Cannot read task output: ${error instanceof Error ? error.message : String(error)}` } }
      for (const task of tasks) options.store.observeExit(task.taskId)
      return {
        success: true,
        runtime: { taskObservation: { tasks: tasks.map(task => ({ taskId: task.taskId, status: statusOf(task) })) } },
        output: JSON.stringify({
          tasks: views,
          guidance: "Do not repeatedly poll unchanged tasks. Continue independent work, or wait for the same task when its result is required. A wait timeout does not mean the task stopped. Unobserved completion is sent automatically. Exit status describes the process only; verify the requested artifact or behavior before completing its todo.",
        }, null, 2),
      }
    },
  }
}

/** Explicit, approval-gated cancellation for a task owned by this session. */
export function taskStopTool(options: TaskToolsOptions): Tool {
  return {
    definition: {
      name: "task_stop",
      description: "Stop one tracked background task. Use when its result is no longer needed or it is clearly stuck.",
      parameters: z.object({
        task_id: z.string().min(1).describe("Background task id"),
        force: z.boolean().optional().default(false).describe("Use SIGKILL instead of graceful SIGTERM"),
      }),
      permission: "confirm",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [], external: [],
        workspace: { mode: "root-integration" as const },
        confidence: "declared" as const,
      }),
    },
    handler: async (args, signal, context) => {
      const taskId = args.task_id as string
      const task = options.store.get(taskId)
      if (!task || (context?.sessionId && task.sessionId && task.sessionId !== context.sessionId)) return { success: false, output: "", error: `Unknown background task: ${taskId}` }
      if (task.exitedAt !== undefined) {
        return { success: true, output: `Task ${taskId} has already exited.` }
      }
      const stopSignal = args.force === true ? "SIGKILL" : "SIGTERM"
      if (!options.store.kill(taskId, stopSignal)) {
        return { success: false, output: "", error: `Failed to stop background task: ${taskId}` }
      }
      return { success: true, output: `Sent ${stopSignal} to background task ${taskId}.` }
    },
  }
}

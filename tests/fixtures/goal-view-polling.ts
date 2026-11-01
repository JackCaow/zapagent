// Run only in the child process owned by goal-view-lifecycle.test.ts: module
// and timer mocks must never leak into the surrounding Bun test process.
import { expect, mock } from "bun:test"
import { createElement } from "react"
import { Text, render } from "ink"
import { PassThrough } from "node:stream"
import type { ReadStream, WriteStream } from "node:tty"

const realView = await import("../../src/goal-view.js")
const values = new Map<string, any>([
  ["a", { id: "a-goal", objective: "Fixture A", status: "running", accepted: false }],
  ["b", { id: "b-goal", objective: "Fixture B", status: "paused", accepted: false }],
])
let broken = false, reads = 0
mock.module("../../src/goal-view.js", () => ({ ...realView,
  readSessionGoalView: (_cwd: string, id: string) => { reads++; if (broken) throw Error("sensitive path must not be logged"); return values.get(id) },
}))
const { useGoalView } = await import("../../src/hooks/useGoalView.js")
const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout
type Task = { callback: () => void; delay: number; cancelled: boolean }
const tasks: Task[] = []
const logs: unknown[][] = []
const logger = { debug: (...args: unknown[]) => { logs.push(args) } }
const flush = () => new Promise<void>(resolve => originalTimeout(resolve, 40))
function next() { const task = tasks.shift(); if (!task) throw Error("No poll scheduled"); if (!task.cancelled) task.callback(); return task }
function pending() { return tasks.filter(task => !task.cancelled) }
function discardCancelled() { while (tasks[0]?.cancelled) tasks.shift() }

async function verifyPollingLifecycle() {
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
    if (callback.name !== "poll") return originalTimeout(callback, delay, ...args)
    const task = { callback, delay, cancelled: false }; tasks.push(task); return task
  }) as any
  globalThis.clearTimeout = ((timer: any) => {
    if (timer && "cancelled" in Object(timer)) timer.cancelled = true
    else originalClear(timer)
  }) as any
  let current!: ReturnType<typeof useGoalView>
  function Harness({ id, attached = false }: { id: string; attached?: boolean }) {
    current = useGoalView(id, "/fixture", attached, "/fixture/no-real-database", logger)
    return createElement(Text, null, current.view?.objective ?? "none")
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 }), stdin = new PassThrough(), stderr = new PassThrough()
  stdout.on("data", () => {}); stderr.on("data", () => {})
  const ui = render(createElement(Harness, { id: "a" }), { stdout: stdout as unknown as WriteStream, stdin: stdin as unknown as ReadStream, stderr: stderr as unknown as WriteStream, patchConsole: false, exitOnCtrlC: false })
  try {
    await flush(); expect(current.view?.id).toBe("a-goal"); expect(pending()[0]?.delay).toBe(1000)
    broken = true
    for (const delay of [2000,4000,8000,16000,32000,60000,60000]) { next(); await flush(); expect(pending()[0]?.delay).toBe(delay) }
    expect(current.view?.id).toBe("a-goal")
    expect(logs).toEqual([["goal_view_read_failed", { category: "unavailable" }]])
    broken = false; next(); await flush(); expect(pending()[0]?.delay).toBe(1000)
    const lateA = pending()[0]!.callback
    ui.rerender(createElement(Harness, { id: "b" })); await flush()
    expect(current.view?.id).toBe("b-goal")
    const beforeLate = reads; lateA(); expect(reads).toBe(beforeLate)
    discardCancelled(); expect(pending()[0]?.delay).toBe(5000)
    for (const delay of [10000,20000,30000,30000]) { next(); await flush(); expect(pending()[0]?.delay).toBe(delay) }
    const lateB = pending()[0]!.callback
    current.clear(); await flush(); expect(current.view).toBeUndefined()
    const beforeClear = reads; lateB(); expect(reads).toBe(beforeClear)
    expect(pending()).toHaveLength(0)
    discardCancelled()
    ui.rerender(createElement(Harness, { id: "a" })); await flush(); expect(current.view?.id).toBe("a-goal")
    values.set("a", { ...values.get("a"), status: "completed", accepted: true }); next(); await flush()
    expect(current.view?.status).toBe("completed"); expect(pending()).toHaveLength(0)
    ui.rerender(createElement(Harness, { id: "b", attached: true })); await flush(); expect(pending()).toHaveLength(0)
    ui.rerender(createElement(Harness, { id: "b" })); await flush(); const lateUnmount = pending()[0]!.callback
    ui.unmount(); await flush(); const beforeUnmount = reads; lateUnmount(); expect(reads).toBe(beforeUnmount)
  } finally {
    ui.unmount(); stdout.destroy(); stdin.destroy(); stderr.destroy()
    globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear
  }
}

await verifyPollingLifecycle()
console.log("Goal polling lifecycle passed")

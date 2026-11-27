import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskStore } from "../zapsdk/tasks/store.js"
import { taskStatusTool } from "../zapsdk/builtin-tools/task.js"
import { _resetForTest, drainSystemInbox, getSystemInboxLength, pushSystemEvent, restoreSystemEvents, retrySystemEvents } from "../src/queue/systemInbox.js"

const dirs: string[] = []
beforeEach(_resetForTest)
afterEach(() => { _resetForTest(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe("task completion delivery", () => {
  it("wait observes an exit once, suppressing its queued notification; zero is not artifact verification", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-task-resume-")); dirs.push(outputDir)
    const store = new TaskStore({ outputDir })
    store.on("exited", ({ taskId }) => pushSystemEvent({
      kind: "task-notification", payload: taskId, ts: Date.now(), id: taskId, sessionId: "s1", taskId,
      isObsolete: () => store.hasObservedExit(taskId),
    }))
    // A successful final pipeline stage does not mean the producer succeeded.
    const task = store.spawnShell({ command: "(printf 'producer failed'; exit 1) | cat", sessionId: "s1" })
    const result = await taskStatusTool({ store }).handler({ task_id: task.taskId, include_output: true, tail_bytes: 1024 }, undefined, { sessionId: "s1" })
    const [view] = JSON.parse(result.output).tasks
    expect(view.exitCode).toBe(0)
    expect(view.verification).toBe("unverified")
    expect(view.outputTail).toContain("producer failed")
    expect(store.hasObservedExit(task.taskId)).toBe(true)
    expect(drainSystemInbox({ sessionId: "s1" })).toEqual([])
    const other = await taskStatusTool({ store }).handler({ task_id: task.taskId }, undefined, { sessionId: "s2" })
    expect(other.success).toBe(false)
  })
  it("deduplicates pending events, retains another session, and restores unaccepted delivery", () => {
    const event = { kind: "task-notification" as const, payload: "done", ts: 1, id: "exit", sessionId: "s1" }
    pushSystemEvent(event); pushSystemEvent(event)
    expect(getSystemInboxLength()).toBe(1)
    expect(drainSystemInbox({ sessionId: "s2" })).toEqual([])
    const claimed = drainSystemInbox({ sessionId: "s1" })
    restoreSystemEvents(claimed)
    expect(drainSystemInbox({ sessionId: "s1" })).toEqual([event])
  })
  it("holds a failed delivery across renders until steering for its session", () => {
    const event = { kind: "task-notification" as const, payload: "done", ts: 1, id: "exit", sessionId: "s1" }
    restoreSystemEvents([event], true)
    expect(drainSystemInbox({ sessionId: "s1" })).toEqual([])
    retrySystemEvents("s2")
    expect(drainSystemInbox({ sessionId: "s1" })).toEqual([])
    retrySystemEvents("s1")
    expect(drainSystemInbox({ sessionId: "s1" })).toHaveLength(1)
  })
})

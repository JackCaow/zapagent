import { expect, test } from "bun:test"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { resolveTurnActivity } from "../../src/queue/turnActivity.js"

test("delivery stays busy from enqueue through receipt and cleanup, then idle", () => {
  const queue = new MessageQueue()
  const message = queue.enqueue({ text: "hello", displayForm: "hello" })
  const activity = (status = "ready") => resolveTurnActivity(status, queue.getSnapshot(), queue.getActiveRunId())
  expect(activity()).toEqual({ busy: true, status: "sending", foregroundId: message.id })
  queue.claimNext()
  expect(activity().busy).toBe(true)
  queue.beginRun("run")
  queue.acknowledge(message.id, message.sessionId)
  expect(activity().busy).toBe(true)
  expect(activity("thinking").status).toBe("thinking")
  expect(activity("writing").status).toBe("writing")
  queue.endRun("run")
  expect(activity().busy).toBe(false)
})

test("active-run ownership changes notify even with an empty receipt queue", () => {
  const queue = new MessageQueue()
  const states: (string | undefined)[] = []
  queue.subscribe(() => states.push(queue.getActiveRunId()))
  queue.beginRun("run")
  queue.endRun("unrelated")
  queue.endRun("run")
  expect(states).toEqual(["run", undefined])
})

test("failed and editing heads never look like active delivery", () => {
  for (const kind of ["failed", "editing", "accepted"] as const) {
    const queue = new MessageQueue()
    const entry = queue.enqueue({ text: "first", displayForm: "first" })
    queue.enqueue({ text: "next", displayForm: "next" })
    if (kind === "failed") queue.fail(entry.id, "provider unavailable")
    else if (kind === "editing") queue.edit(entry.id)
    else { queue.claimNext(); queue.acknowledge(entry.id, entry.sessionId); queue.clear() }
    expect(resolveTurnActivity("ready", queue.getSnapshot()).busy).toBe(false)
  }
})

test("pending follow-ups and Steer do not replace active execution status", () => {
  const queue = new MessageQueue()
  queue.beginRun("run")
  queue.enqueue({ text: "steer", displayForm: "steer" }, "steer")
  expect(resolveTurnActivity("thinking", queue.getSnapshot(), "run")).toEqual({ busy: true, status: "thinking", foregroundId: undefined })
})

test("run completion remains observable when saving Steer recovery fails", () => {
  let failWrite = false
  const queue = new MessageQueue("/unused-fixture", () => { if (failWrite) throw new Error("disk full") })
  queue.beginRun("run")
  queue.enqueue({ text: "steer", displayForm: "steer" }, "steer")
  const states: (string | undefined)[] = []
  queue.subscribe(() => states.push(queue.getActiveRunId()))
  failWrite = true
  expect(() => queue.endRun("run")).toThrow("disk full")
  expect(states).toEqual([undefined])
  expect(resolveTurnActivity("ready", queue.getSnapshot(), queue.getActiveRunId()).busy).toBe(false)
})

test("broken queue storage does not show a pending send as busy", () => {
  const queue = new MessageQueue()
  queue.enqueue({ text: "hello", displayForm: "hello" })
  expect(resolveTurnActivity("ready", queue.getSnapshot(), undefined, "disk failure").busy).toBe(false)
})

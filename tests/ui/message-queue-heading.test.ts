import { expect, test } from "bun:test"
import { queuePanelHeading } from "../../src/ui/message-queue.js"
import type { QueueEntry } from "../../src/queue/messageQueue.js"

function entry(state: QueueEntry["state"] = "queued", mode: QueueEntry["mode"] = "queue"): QueueEntry {
  return { id: "test", sessionId: "test", text: "hello", displayForm: "hello", state, mode }
}

test("idle first sends are not described as follow-ups", () => {
  expect(queuePanelHeading([entry()], "queue", false)).toBe("Sending · 1")
  expect(queuePanelHeading([entry()], "steer", false)).toBe("Sending · 1")
  expect(queuePanelHeading([entry("dispatching")], "queue", true)).toBe("Sending · 1")
})

test("messages waiting behind an active run remain follow-ups", () => {
  expect(queuePanelHeading([entry()], "queue", true)).toMatch(/^Follow-ups · 1/)
  expect(queuePanelHeading([entry("dispatching", "steer")], "steer", true)).toMatch(/^Follow-ups · 1/)
  expect(queuePanelHeading([entry("dispatching"), entry()], "queue", true)).toMatch(/^Follow-ups · 2/)
})

test("idle failures remain visibly paused rather than sending", () => {
  expect(queuePanelHeading([entry("failed")], "queue", false)).toContain("PAUSED")
})

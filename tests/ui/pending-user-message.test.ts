import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { PendingUserMessage } from "../../src/ui/pending-user-message.js"
import { UserMessage } from "../../src/ui/Transcript.js"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { deliverNextMessage } from "../../src/queue/delivery.js"
import { resolveTurnActivity } from "../../src/queue/turnActivity.js"

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "")
const preview = (queue: MessageQueue, status = "ready") => {
  const { foregroundId } = resolveTurnActivity(status, queue.getSnapshot(), queue.getActiveRunId())
  return plain(renderToString(createElement(PendingUserMessage, {
    entry: queue.getSnapshot().find(entry => entry.id === foregroundId),
  })))
}

it("shows a send before preparation completes, then replaces it with exactly one accepted row", async () => {
  const queue = new MessageQueue()
  queue.enqueue({ text: "visible prompt", displayForm: "visible prompt" })
  expect(preview(queue)).toContain("› visible prompt")
  let release!: () => void
  const preparing = new Promise<void>(resolve => { release = resolve })
  const accepted: string[] = []
  const run = deliverNextMessage(queue, {
    providerReady: () => true, command: async () => {}, onError: error => { throw new Error(error) },
    dispatch: async (entry, accept) => {
      queue.beginRun("fixture")
      await preparing
      accept()
      accepted.push(entry.displayForm)
      queue.endRun("fixture")
      return { stopped: "end_turn" }
    },
  })
  expect(preview(queue, "preparing")).toContain("› visible prompt")
  expect(preview(queue, "compacting")).toContain("› visible prompt")
  expect(accepted).toHaveLength(0)
  expect(queue.getSnapshot()[0]?.state).toBe("dispatching")
  release()
  expect(await run).toBe(true)
  expect(preview(queue)).toBe("")
  expect(accepted).toEqual(["visible prompt"])
  const committed = plain(renderToString(createElement(UserMessage, { log: { id: 1, type: "user", text: accepted[0]! } })))
  expect(committed.match(/› visible prompt/g)).toHaveLength(1)
})

it("keeps a failed preparation retryable without creating a phantom accepted message", async () => {
  const queue = new MessageQueue()
  const entry = queue.enqueue({ text: "keep me", displayForm: "keep me" })
  let receipts = 0
  await deliverNextMessage(queue, {
    providerReady: () => true, command: async () => {}, onError() {},
    dispatch: async () => { throw new Error("preparation failed") },
  })
  expect(queue.getSnapshot()[0]?.state).toBe("failed")
  expect(preview(queue)).toBe("")
  expect(queue.retry(entry.id)).toBe(true)
  expect(preview(queue).match(/› keep me/g)).toHaveLength(1)
  await deliverNextMessage(queue, {
    providerReady: () => true, command: async () => {}, onError() {},
    dispatch: async (_entry, accept) => { receipts++; accept(); return {} },
  })
  expect(receipts).toBe(1)
  expect(queue.getSnapshot()).toHaveLength(0)
})

it("uses the submitted paste and image display, keeping model-only attachments private", () => {
  const queue = new MessageQueue()
  queue.enqueue({ text: "expanded with MODEL_ONLY_CONTEXT", displayForm: "[Pasted #1] [Image #1]",
    restoreText: "my first line\nmy second line",
    images: [{ id: 1, content: { type: "image", filePath: "/fixture/image.png", source: "file", mediaType: "image/png", base64: "AA==" } }],
  })
  const output = preview(queue)
  expect(output).toContain("my first line")
  expect(output).toContain("my second line")
  expect(output).toContain("[1 image attached]")
  expect(output).not.toContain("MODEL_ONLY_CONTEXT")
})

it("does not echo slash commands twice or show a follow-up as the active prompt", () => {
  const queue = new MessageQueue()
  queue.enqueue({ text: "/review", displayForm: "/review" })
  expect(preview(queue)).toBe("")
  queue.clear()
  queue.enqueue({ text: "/tmp/fixture.txt", displayForm: "/tmp/fixture.txt" })
  expect(preview(queue)).toContain("› /tmp/fixture.txt")
  queue.clear()
  queue.beginRun("already-running")
  queue.enqueue({ text: "follow-up", displayForm: "follow-up" })
  expect(preview(queue, "thinking")).toBe("")
})

for (const [name, text] of [
  ["many lines", Array.from({ length: 140 }, (_, i) => `line ${i + 1}`).join("\n")],
  ["long line", "x".repeat(25_000)],
  ["many long lines", Array.from({ length: 140 }, () => "x".repeat(1_000)).join("\n")],
] as const) {
  it(`describes folded ${name} as pending until acceptance`, () => {
    const queue = new MessageQueue()
    queue.enqueue({ text, displayForm: "[Pasted #1]", restoreText: text })
    const pending = preview(queue).replace(/\s+/g, " ")
    expect(pending).toContain("retained in queue; awaiting acceptance")
    expect(pending).not.toContain("was sent")
    expect(pending).not.toContain("/copy-input")
    const accepted = plain(renderToString(createElement(UserMessage, {
      log: { id: 1, type: "user", text: "[Pasted #1]", restoreText: text },
    }))).replace(/\s+/g, " ")
    expect(accepted).toContain("was sent and preserved")
    expect(accepted).toContain("/copy-input")
    expect(accepted).not.toContain("awaiting acceptance")
  })
}

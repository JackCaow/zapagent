import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { writeFileAtomic } from "../../src/utils/secure-write.js"
import { prepareQueuedCommandsForEditing, type QueuedCommand } from "../../src/queue/inputQueue.js"
import { createSubmittedPasteExpander, consumeSubmittedArtifacts } from "../../src/hooks/useTurnDispatcher.js"

const roots: string[] = []
function directory() { const root = mkdtempSync(join(tmpdir(), "zap-follow-ups-")); roots.push(root); return root }
const command = (text: string): QueuedCommand => ({ text, displayForm: text })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("MessageQueue ownership and management", () => {
  it("retains distinct stable IDs and FIFO claims until acceptance", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("a")), b = queue.enqueue(command("b"))
    expect(a.id).not.toBe(b.id)
    expect(queue.claimNext()?.id).toBe(a.id)
    expect(queue.getSnapshot()).toHaveLength(2)
    expect(queue.claimNext()).toBeUndefined()
    expect(queue.remove(a.id)).toBe(false)
    expect(queue.edit(a.id)).toBeUndefined()
    expect(queue.move(b.id, -1)).toBe(false)
    queue.acknowledge(a.id, "wrong-thread")
    expect(queue.claimNext()).toBeUndefined()
    queue.acknowledge(a.id, a.sessionId)
    expect(queue.claimNext()?.id).toBe(b.id)
  })

  it("blocks at a failed head until an explicit operation", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("a")), b = queue.enqueue(command("b"))
    queue.claimNext(); queue.fail(a.id, "provider setup failed")
    expect(queue.claimNext()).toBeUndefined()
    expect(queue.move(b.id, -1)).toBe(true)
    expect(queue.getSnapshot().map(entry => entry.id)).toEqual([b.id, a.id])
    expect(queue.claimNext()?.id).toBe(b.id)
    queue.acknowledge(b.id, b.sessionId)
    expect(queue.retry(a.id)).toBe(true)
    expect(queue.claimNext()?.id).toBe(a.id)
  })

  it("edits one entry in place without combining adjacent inputs", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("a")), b = queue.enqueue(command("b"))
    queue.edit(a.id)
    expect(queue.claimNext()).toBeUndefined()
    expect(queue.remove(a.id)).toBe(false)
    expect(queue.replace(a.id, command("edited"))).toBe(true)
    expect(queue.getSnapshot().map(entry => [entry.id, entry.text])).toEqual([[a.id, "edited"], [b.id, "b"]])
  })

  it("reports a pause while a failed message heads the queue, and clear-failed resumes it", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("/compact")), b = queue.enqueue(command("next question"))
    expect(queue.isPaused()).toBe(false)
    queue.claimNext(); queue.fail(a.id, "aborted")
    expect(queue.isPaused()).toBe(true)
    expect(queue.claimNext()).toBeUndefined()
    // New input just piles up behind it.
    const c = queue.enqueue(command("third"))
    expect(queue.isPaused()).toBe(true)
    expect(queue.discardFailed()).toBe(1)
    expect(queue.isPaused()).toBe(false)
    expect(queue.getSnapshot().map(entry => entry.id)).toEqual([b.id, c.id])
    expect(queue.claimNext()?.id).toBe(b.id)
    expect(queue.discardFailed()).toBe(0)
  })

  it("does not drop a message that is being sent or edited when clearing failed ones", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("a")), b = queue.enqueue(command("b"))
    queue.claimNext(); queue.fail(a.id, "x")
    queue.edit(b.id)
    expect(queue.discardFailed()).toBe(1)
    expect(queue.getSnapshot().map(entry => [entry.id, entry.state])).toEqual([[b.id, "editing"]])
  })

  it("cancel restores a failed entry and its original error", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("original"))
    queue.fail(a.id, "missing provider"); queue.edit(a.id); queue.cancelEdit(a.id)
    expect(queue.getSnapshot()[0]).toMatchObject({ id: a.id, text: "original", state: "failed", error: "missing provider" })
  })

  it("keeps an edited follow-up paused when its preceding run is interrupted", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("pending"))
    queue.edit(a.id)
    queue.pause("previous run aborted")
    expect(queue.getSnapshot()[0]).toMatchObject({ state: "editing", beforeEdit: "failed", error: "previous run aborted" })
    queue.cancelEdit(a.id)
    expect(queue.getSnapshot()[0]?.state).toBe("failed")
    expect(queue.claimNext()).toBeUndefined()
    expect(queue.retry(a.id)).toBe(true)
    expect(queue.claimNext()?.id).toBe(a.id)
  })

  it("rejects a stale asynchronous replacement after cancelling and reopening an edit", () => {
    const queue = new MessageQueue()
    const a = queue.enqueue(command("original"))
    const oldVersion = queue.edit(a.id)!.editVersion
    queue.cancelEdit(a.id)
    const newVersion = queue.edit(a.id)!.editVersion
    expect(newVersion).not.toBe(oldVersion)
    expect(queue.replace(a.id, command("stale MCP result"), oldVersion)).toBe(false)
    expect(queue.getSnapshot()[0]?.text).toBe("original")
    expect(queue.replace(a.id, command("current edit"), newVersion)).toBe(true)
  })

  it("captures pasted payloads before asynchronous resolution changes the live draft", () => {
    const store = new Map([[1, "  code\n"], [2, "next draft"]])
    const expand = createSubmittedPasteExpander(store)
    store.clear(); store.set(1, "replacement")
    expect(expand("[Pasted #1 · 1 lines · 7 chars]")).toBe("  code\n")
    expect(expand("[Pasted #3 · 1 lines · 1 chars]")).toBe("[Pasted #3 · 1 lines · 1 chars]")
  })

  it("retains submitted sidecars still referenced by a changed draft", () => {
    const store = { current: new Map([[1, "code"], [2, "consumed"], [3, "new draft"]]) }
    let images = [1, 2, 3].map(id => ({ id, content: { type: "image" as const, filePath: `/tmp/${id}.png`, source: "file", mediaType: "image/png" } }))
    const submitted = images.slice(0, 2)
    const setImages = (next: typeof images | ((current: typeof images) => typeof images)) => { images = typeof next === "function" ? next(images) : next }
    consumeSubmittedArtifacts(store, setImages, { "1": "code", "2": "consumed" }, submitted,
      "[Pasted #1 · 1 lines · 4 chars] [Image #1] continued draft")
    expect([...store.current.keys()]).toEqual([1, 3])
    expect(images.map(image => image.id)).toEqual([1, 3])
    consumeSubmittedArtifacts(store, setImages, { "1": "code" }, submitted)
    expect([...store.current.keys()]).toEqual([3])
    expect(images.map(image => image.id)).toEqual([3])
  })

  it("freezes cloned payloads and clears old attachments on replacement", () => {
    const queue = new MessageQueue()
    const payload: QueuedCommand = {
      text: "  original\n", displayForm: "[Pasted #1 · 1 lines · 8 chars] [Image #1]",
      pastedContents: { "1": "  code\n" }, restoreText: "  original\n",
      images: [{ id: 1, content: { type: "image", filePath: "/tmp/a.png", source: "file", mediaType: "image/png", base64: "AQ==" } }],
    }
    const a = queue.enqueue(payload)
    payload.images![0]!.content.base64 = "changed"
    payload.pastedContents!["1"] = "changed"
    expect(a.images?.[0]?.content.base64).toBe("AQ==")
    expect(Object.isFrozen(a.images?.[0]?.content)).toBe(true)
    const prepared = prepareQueuedCommandsForEditing([a], { nextImageId: 9, nextPasteId: 10 })
    expect(prepared.images[0]?.id).toBe(9)
    expect(prepared.pastedContents["10"]).toBe("  code\n")
    expect(queue.getSnapshot()[0]?.id).toBe(a.id)
    queue.edit(a.id); queue.replace(a.id, command("text only"))
    expect(queue.getSnapshot()[0]?.images).toBeUndefined()
    expect(queue.getSnapshot()[0]?.pastedContents).toBeUndefined()
    expect(queue.getSnapshot()[0]?.restoreText).toBeUndefined()
  })

  it("binds Steer to the active run and falls back to Queue when idle", () => {
    const queue = new MessageQueue()
    const idle = queue.enqueue(command("idle"), "steer")
    expect(idle.mode).toBe("queue")
    queue.beginRun("run1")
    const first = queue.enqueue(command("live"), "steer")
    const second = queue.enqueue(command("later"))
    expect(queue.hasSteering("run2")).toBe(false)
    expect(queue.claimSteering("run1")?.id).toBe(first.id)
    queue.acknowledge(first.id, first.sessionId)
    expect(queue.steer(second.id)).toBe(true)
    queue.endRun("run1")
    expect(queue.getSnapshot().find(entry => entry.id === second.id)).toMatchObject({ mode: "queue", targetRunId: undefined })
    expect(queue.hasSteering("run1")).toBe(false)
  })

  it("never Steers slash commands; absolute file paths are ordinary input", () => {
    const queue = new MessageQueue()
    queue.beginRun("live")
    const slash = queue.enqueue(command("/new"), "steer")
    expect(slash.mode).toBe("queue")
    expect(queue.steer(slash.id)).toBe(false)
    expect(queue.enqueue(command("/tmp/example.txt"), "steer").mode).toBe("steer")
    expect(() => queue.bind("other")).toThrow("active run")
  })

  it("never accepts a claim from an ended run as a new Steer", () => {
    const queue = new MessageQueue()
    queue.beginRun("one")
    const a = queue.enqueue(command("live"), "steer")
    queue.claimSteering("one"); queue.endRun("one"); queue.beginRun("two")
    expect(queue.hasSteering("two")).toBe(false)
    expect(queue.getSnapshot()[0]?.state).toBe("failed")
    expect(queue.retry(a.id)).toBe(true)
    expect(queue.claimNext()?.mode).toBe("queue")
  })
})

describe("MessageQueue durable receipts and recovery", () => {
  it("restores pending and in-flight messages held for review, never auto-replays", () => {
    const root = directory(), queue = new MessageQueue(root)
    queue.bind("writer1")
    queue.enqueue(command("in flight")); queue.enqueue(command("pending")); queue.claimNext()
    const recovered = new MessageQueue(root); recovered.bind("writer1")
    expect(recovered.getSnapshot().map(entry => entry.state)).toEqual(["failed", "failed"])
    expect(recovered.claimNext()).toBeUndefined()
    expect(recovered.getSnapshot()[0]?.error).toContain("Check the transcript")
  })

  it("keeps concurrent journals isolated and copies recovery to a fork", () => {
    const root = directory(), a = new MessageQueue(root), b = new MessageQueue(root)
    a.bind("a"); b.bind("b")
    a.enqueue(command("a pending")); b.enqueue(command("b pending"))
    const original = readFileSync(join(root, "a.json"), "utf8")
    const fork = new MessageQueue(root); fork.bind("fork", "a")
    expect(fork.getSnapshot()[0]).toMatchObject({ sessionId: "fork", text: "a pending", state: "failed" })
    expect(readFileSync(join(root, "a.json"), "utf8")).toBe(original)
    expect(JSON.parse(readFileSync(join(root, "b.json"), "utf8")).entries[0].text).toBe("b pending")
  })

  it("fails closed on corrupt metadata and unsafe session paths", () => {
    const root = directory(), path = join(root, "bad.json")
    const invalid = JSON.stringify({ version: 1, sessionId: "bad", entries: [{ ...command("x"), id: "x", sessionId: "bad", mode: "queue", state: "failed", error: {} }] })
    writeFileAtomic(path, invalid)
    const queue = new MessageQueue(root)
    expect(() => queue.bind("bad")).toThrow("Invalid pending-message store")
    expect(readFileSync(path, "utf8")).toBe(invalid)
    expect(() => queue.bind("../escape")).toThrow("Invalid queue session")
  })

  it("keeps the previous snapshot when ordinary persistence fails", () => {
    const root = directory()
    let fail = false
    const queue = new MessageQueue(root, (path, content) => { if (fail) throw new Error("disk full"); writeFileAtomic(path, content) })
    queue.bind("a"); const a = queue.enqueue(command("a")), snapshot = queue.getSnapshot()
    fail = true
    expect(() => queue.enqueue(command("b"))).toThrow("disk full")
    expect(queue.getSnapshot()).toBe(snapshot)
    expect(() => queue.edit(a.id)).toThrow("disk full")
    expect(queue.getSnapshot()[0]?.state).toBe("queued")
  })

  it("holds safety transitions in memory when their storage write fails", () => {
    const root = directory()
    let fail = false
    const queue = new MessageQueue(root, (path, content) => { if (fail) throw new Error("disk full"); writeFileAtomic(path, content) })
    queue.bind("a")
    const a = queue.enqueue(command("sending")), b = queue.enqueue(command("editing"))
    queue.claimNext(); queue.edit(b.id)
    fail = true
    expect(() => queue.fail(a.id, "setup failed")).toThrow("disk full")
    expect(() => queue.pause("previous run stopped")).toThrow("disk full")
    expect(queue.getSnapshot()[0]?.state).toBe("failed")
    expect(queue.getSnapshot()[1]).toMatchObject({ state: "editing", beforeEdit: "failed" })
    fail = false
    queue.cancelEdit(b.id)
    queue.enqueue(command("new input"))
    expect(queue.claimNext()).toBeUndefined()
    expect(JSON.parse(readFileSync(join(root, "a.json"), "utf8")).entries.map((entry: { state: string }) => entry.state))
      .toEqual(["failed", "failed", "queued"])
  })

  it("does not retry already accepted input if saving the receipt fails", () => {
    const root = directory()
    let fail = false
    const queue = new MessageQueue(root, (path, content) => { if (fail) throw new Error("disk full"); writeFileAtomic(path, content) })
    queue.bind("a"); const a = queue.enqueue(command("a")); queue.claimNext()
    fail = true
    expect(queue.acknowledge(a.id, a.sessionId)).toContain("Accepted")
    expect(queue.getSnapshot()[0]?.state).toBe("accepted")
    expect(queue.retry(a.id)).toBe(false)
    expect(queue.steer(a.id)).toBe(false)
    expect(queue.claimNext()).toBeUndefined()
    fail = false
    const recovery = new MessageQueue(root); recovery.bind("a")
    expect(recovery.getSnapshot()[0]?.state).toBe("failed")
    expect(recovery.claimNext()).toBeUndefined()
  })
})

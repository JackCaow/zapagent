import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { hydrateQueuedImage } from "../../src/queue/queued-images.js"

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "queued-images-")); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function command(filePath: string, base64: string) {
  return { text: "look at this", displayForm: "look at this [Image #1]",
    images: [{ id: 1, content: { type: "image" as const, filePath, mediaType: "image/png", source: "clipboard", base64 } }] }
}

describe("queue journal and inline image bytes (#39)", () => {
  it("keeps base64 out of the journal but in the live snapshot", () => {
    const dir = tmp()
    const big = "A".repeat(5_000_000)
    const queue = new MessageQueue(dir)
    queue.bind("s1")
    queue.enqueue(command("/cache/shot.png", big))
    const journal = join(dir, "s1.json")
    expect(statSync(journal).size).toBeLessThan(2_000)
    expect(readFileSync(journal, "utf8")).not.toContain("base64")
    expect(readFileSync(journal, "utf8")).toContain("/cache/shot.png")
    expect(queue.getSnapshot()[0]?.images?.[0]?.content.base64).toBe(big)
  })

  it("stays cheap as the queue grows and entries change state", () => {
    const dir = tmp()
    const queue = new MessageQueue(dir)
    queue.bind("s1")
    for (let i = 0; i < 6; i++) queue.enqueue(command(`/cache/${i}.png`, "A".repeat(3_000_000)))
    queue.claimNext()
    expect(statSync(join(dir, "s1.json")).size).toBeLessThan(10_000)
  })

  it("restores image bytes from the file when entries are recovered after a restart", () => {
    const dir = tmp()
    const file = join(dir, "shot.png")
    writeFileSync(file, PNG)
    const first = new MessageQueue(dir)
    first.bind("s1")
    first.enqueue(command(file, PNG.toString("base64")))
    const second = new MessageQueue(dir)
    second.bind("s1")
    const recovered = second.getSnapshot()[0]!
    expect(recovered.state).toBe("failed")
    expect(recovered.images?.[0]?.content.filePath).toBe(file)
    expect(recovered.images?.[0]?.content.base64).toBe(PNG.toString("base64"))
    expect(recovered.images?.[0]?.content.source).toBe("clipboard")
    expect(recovered.error).not.toContain("no longer readable")
  })

  it("says so on the entry when a recovered image file is gone", () => {
    const dir = tmp()
    const first = new MessageQueue(dir)
    first.bind("s1")
    first.enqueue(command("/cache/deleted.png", "QUJD"))
    const second = new MessageQueue(dir)
    second.bind("s1")
    const recovered = second.getSnapshot()[0]!
    expect(recovered.images?.[0]?.content.base64).toBeUndefined()
    expect(recovered.error).toContain("/cache/deleted.png")
  })

  it("hands steering and editing the same bytes a recovered entry had before the restart", () => {
    const dir = tmp()
    const file = join(dir, "shot.png")
    writeFileSync(file, PNG)
    const first = new MessageQueue(dir)
    first.bind("s1")
    first.enqueue(command(file, PNG.toString("base64")))
    const second = new MessageQueue(dir)
    second.bind("s1")
    const id = second.getSnapshot()[0]!.id
    // Editing reads the entry straight from the queue snapshot.
    expect(second.edit(id)?.images?.[0]?.content.base64).toBe(PNG.toString("base64"))
    second.cancelEdit(id)
    // Steering claims a failed entry into a live run.
    second.beginRun("run-1")
    expect(second.steer(id)).toBe(true)
    const claimed = second.claimSteering("run-1")
    expect(claimed?.images?.[0]?.content.base64).toBe(PNG.toString("base64"))
  })
})

describe("hydrateQueuedImage", () => {
  it("returns an image that already has bytes untouched", () => {
    const image = { type: "image" as const, filePath: "/nope.png", mediaType: "image/png", source: "x", base64: "QUJD" }
    expect(hydrateQueuedImage(image)).toEqual({ image, readable: true })
  })

  it("reloads the bytes from the file and keeps the original source", () => {
    const dir = tmp()
    const file = join(dir, "shot.png")
    writeFileSync(file, PNG)
    const result = hydrateQueuedImage({ type: "image", filePath: file, mediaType: "image/png", source: "clipboard" })
    expect(result.readable).toBe(true)
    expect(result.image.base64).toBe(PNG.toString("base64"))
    expect(result.image.source).toBe("clipboard")
    expect(result.image.mediaType).toBe("image/png")
  })

  it("reports a file that is gone instead of pretending the image was sent", () => {
    const image = { type: "image" as const, filePath: "/definitely/missing.png", mediaType: "image/png", source: "x" }
    expect(hydrateQueuedImage(image)).toEqual({ image, readable: false })
  })
})

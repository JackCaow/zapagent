import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pruneImageStorage } from "../../src/imageStore.js"
import { loadImageFromFile } from "../../zapsdk/utils/image.js"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { parsePromptHistoryLines } from "../../src/ui/prompt-history.js"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
let dataDir: string
let previousDataDir: string | undefined
beforeEach(() => {
  previousDataDir = process.env.ZAPCODE_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), "zap-image-retention-"))
  process.env.ZAPCODE_DATA_DIR = dataDir
})
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})
function image(name: string, directory = "image-paste"): string {
  const dir = join(dataDir, directory)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, PNG)
  return path
}
function queue(project: string, filePath: string) {
  const directory = join(dataDir, "projects", project, "follow-ups")
  const store = new MessageQueue(directory)
  store.bind("original")
  const entry = store.enqueue({ text: "inspect", displayForm: "inspect [Image #1]",
    images: [{ id: 1, content: { type: "image", filePath, mediaType: "image/png", source: "clipboard", base64: PNG.toString("base64") } }] })
  return { store, entry, directory }
}

describe("durable queued image retention", () => {
  it("keeps an image after prompt history rollover and restores its queued bytes", () => {
    const path = image("queued.png")
    const { directory } = queue("project-a", path)
    const history = [{ display: "inspect [Image #1]", pastedContents: {}, imageRefs: { 1: path }, timestamp: 1 },
      ...Array.from({ length: 200 }, (_, i) => ({ display: `later ${i}`, pastedContents: {}, timestamp: i + 2 }))]
    const parsed = parsePromptHistoryLines(history.map(entry => JSON.stringify(entry)))
    expect(parsed.dirty).toBe(true)
    expect(parsed.entries).toHaveLength(200)
    writeFileSync(join(dataDir, "history.jsonl"), parsed.entries.map(entry => JSON.stringify(entry)).join("\n"))
    expect(readFileSync(join(dataDir, "history.jsonl"), "utf8")).not.toContain(path)
    expect(readFileSync(join(directory, "original.json"), "utf8")).not.toContain("base64")
    // A fresh TUI prunes before the user chooses to restore the older session.
    const restored = new MessageQueue(directory)
    restored.bind("fresh")
    pruneImageStorage()
    expect(existsSync(path)).toBe(true)
    restored.bind("restored", "original")
    expect(restored.getSnapshot()[0]?.images?.[0]?.content.base64).toBe(PNG.toString("base64"))
    expect(restored.getSnapshot()[0]?.error).not.toContain("no longer readable")
  })

  it("protects queues across projects and reclaims only cleared ownership", () => {
    const first = image("first.png"), second = image("second.png"), orphan = image("orphan.png")
    const a = queue("project-a", first), b = queue("project-b", second)
    expect(pruneImageStorage().deleted).toBe(1)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
    a.store.clear()
    expect(pruneImageStorage().deleted).toBe(1)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(true)
    b.store.claimNext()
    b.store.acknowledge(b.entry.id, "original")
    expect(pruneImageStorage().deleted).toBe(1)
    expect(existsSync(second)).toBe(false)
  })

  it("does not retain images for accepted entries left in a journal", () => {
    const path = image("accepted.png")
    const { directory } = queue("project-a", path)
    const journal = join(directory, "original.json")
    const saved = JSON.parse(readFileSync(journal, "utf8"))
    saved.entries[0].state = "accepted"
    writeFileSync(journal, JSON.stringify(saved))
    expect(pruneImageStorage().deleted).toBe(1)
    expect(existsSync(path)).toBe(false)
  })

  it("retains stale cache images while queued, then allows age-based eviction", () => {
    const path = image("cached.png", "image-cache")
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    utimesSync(path, old, old)
    const { store } = queue("project-a", path)
    expect(pruneImageStorage().deleted).toBe(0)
    expect(existsSync(path)).toBe(true)
    store.clear()
    expect(pruneImageStorage().deleted).toBe(1)
    expect(existsSync(path)).toBe(false)
  })

  it("preserves image files when a journal is malformed and the live set is incomplete", () => {
    const pasted = image("possibly-queued.png")
    const cached = image("possibly-queued-cache.png", "image-cache")
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    utimesSync(cached, old, old)
    const { directory } = queue("project-a", pasted)
    writeFileSync(join(directory, "original.json"), "{ incomplete journal")
    const result = pruneImageStorage()
    expect(result.deleted).toBe(0)
    expect(result.skipped).toContain("pending-message journals unreadable")
    expect(existsSync(pasted)).toBe(true)
    expect(existsSync(cached)).toBe(true)
  })

  for (const state of ["failed", "editing", "dispatching"] as const) {
    it(`retains images owned by ${state} entries`, () => {
      const path = image(`${state}.png`)
      const { directory } = queue("project-a", path)
      const journal = join(directory, "original.json")
      const saved = JSON.parse(readFileSync(journal, "utf8"))
      saved.entries[0].state = state
      writeFileSync(journal, JSON.stringify(saved))
      expect(pruneImageStorage().deleted).toBe(0)
      expect(existsSync(path)).toBe(true)
    })
  }

  for (const level of ["project", "follow-ups", "journal"] as const) {
    (process.platform === "win32" ? it.skip : it)(`does not traverse a symlink at the ${level} level`, () => {
      const orphan = image("orphan.png")
      // An external malformed journal would stop pruning if followed. It is
      // deliberately outside projects, but still inside this isolated fixture.
      const external = join(dataDir, "external")
      const externalQueue = join(external, "follow-ups")
      mkdirSync(externalQueue, { recursive: true })
      writeFileSync(join(externalQueue, "original.json"), "{ malformed")
      const projects = join(dataDir, "projects")
      mkdirSync(projects)
      const project = join(projects, "linked")
      if (level === "project") symlinkSync(external, project, "dir")
      else {
        mkdirSync(project)
        const followUps = join(project, "follow-ups")
        if (level === "follow-ups") symlinkSync(externalQueue, followUps, "dir")
        else {
          mkdirSync(followUps)
          symlinkSync(join(externalQueue, "original.json"), join(followUps, "original.json"), "file")
        }
      }
      expect(pruneImageStorage().deleted).toBe(1)
      expect(existsSync(orphan)).toBe(false)
      expect(readFileSync(join(externalQueue, "original.json"), "utf8")).toBe("{ malformed")
    })
  }

  it("matches absolute image references when the data directory is configured relatively", () => {
    const pasted = image("relative-paste.png")
    const cached = image("relative-cache.png", "image-cache")
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    utimesSync(cached, old, old)
    process.env.ZAPCODE_DATA_DIR = relative(process.cwd(), dataDir)
    const directory = join(process.env.ZAPCODE_DATA_DIR, "projects", "relative-project", "follow-ups")
    const store = new MessageQueue(directory)
    store.bind("original")
    const images = [pasted, cached].map((path, i) => ({
      id: i + 1,
      content: loadImageFromFile(relative(process.cwd(), path)),
    }))
    expect(images[0]?.content.filePath).toBe(pasted)
    expect(images[1]?.content.filePath).toBe(cached)
    store.enqueue({ text: "inspect both", displayForm: "[Image #1] [Image #2]", images })
    expect(pruneImageStorage().deleted).toBe(0)
    expect(existsSync(pasted)).toBe(true)
    expect(existsSync(cached)).toBe(true)
  })

})

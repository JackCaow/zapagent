import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMdStore } from "../../memory/md-store.js"

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `zapcode-md-store-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("MdMemoryStore record cache", () => {
  it("reads unchanged record contents once and refreshes after an external edit", () => {
    const diskReads: string[] = []
    const store = openMdStore(dir, { onRecordRead: (filename) => diskReads.push(filename) })
    store.save({
      name: "cache_state",
      description: "cache state",
      type: "project",
      body: "body one\n",
    })
    diskReads.length = 0

    const initialRevision = store.snapshot?.().revision
    expect(initialRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(store.list()[0]?.body).toBe("body one\n")
    expect(store.get("cache_state.md")?.body).toBe("body one\n")
    expect(store.list()[0]?.body).toBe("body one\n")
    expect(diskReads).toEqual([])
    expect(store.snapshot?.().revision).toBe(initialRevision)

    const path = join(dir, "cache_state.md")
    const changed = readFileSync(path, "utf-8").replace("body one", "body two expanded")
    writeFileSync(path, changed)

    expect(store.list()[0]?.body).toBe("body two expanded\n")
    expect(store.get("cache_state.md")?.body).toBe("body two expanded\n")
    expect(diskReads).toEqual(["cache_state.md"])
    expect(store.snapshot?.().revision).not.toBe(initialRevision)
  })

  it("does not expose mutable cached frontmatter to callers", () => {
    const store = openMdStore(dir)
    store.save({
      name: "preferences",
      description: "stable preferences",
      type: "user",
      tags: ["stable"],
      body: "Prefer concise output.\n",
    })

    const first = store.list()[0]!
    first.frontmatter.description = "mutated"
    first.frontmatter.tags?.push("mutated")

    const second = store.get("preferences.md")!
    expect(second.frontmatter.description).toBe("stable preferences")
    expect(second.frontmatter.tags).toEqual(["stable"])
  })

  it("invalidates removed files and discovers externally restored records", () => {
    const store = openMdStore(dir)
    store.save({
      name: "lifecycle",
      description: "lifecycle",
      type: "project",
      body: "present\n",
    })
    const path = join(dir, "lifecycle.md")
    const original = readFileSync(path, "utf-8")

    expect(store.list().map((record) => record.filename)).toEqual(["lifecycle.md"])
    unlinkSync(path)
    expect(store.list()).toEqual([])

    writeFileSync(path, original.replace("present", "restored"))
    expect(store.list()[0]?.body).toBe("restored\n")
  })
})

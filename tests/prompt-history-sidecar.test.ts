import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  MAX_HISTORY_PASTED_ENTRY_BYTES,
  MAX_HISTORY_PASTED_SIDECAR_TOTAL_BYTES,
  persistSidecarPastedContents,
  readSidecarPastedContents,
  restorePromptHistoryEntry,
} from "../src/ui/prompt-history.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("prompt history sidecar paste storage", () => {
  it("stores oversized paste bodies in sidecar files and reads them back", () => {
    const dataDir = mkDataDir()
    const large = "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)

    const refs = persistSidecarPastedContents(dataDir, { "1": large })
    const sidecarPath = refs["1"]

    expect(typeof sidecarPath).toBe("string")
    expect(existsSync(join(dataDir, sidecarPath!))).toBe(true)
    expect(readFileSync(join(dataDir, sidecarPath!), "utf-8")).toBe(large)
    expect(readSidecarPastedContents(dataDir, refs)).toEqual({ "1": large })
  })

  it("uses stable sidecar refs for identical paste bodies", () => {
    const dataDir = mkDataDir()
    const large = "same paste\n" + "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)

    const firstRefs = persistSidecarPastedContents(dataDir, { "1": large })
    const secondRefs = persistSidecarPastedContents(dataDir, { "2": large })

    expect(secondRefs["2"]).toBe(firstRefs["1"])
    expect(readSidecarPastedContents(dataDir, secondRefs)).toEqual({ "2": large })
  })

  it("repairs corrupted content-addressed sidecar files before reusing them", () => {
    const dataDir = mkDataDir()
    const large = "correct paste\n" + "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)
    const refs = persistSidecarPastedContents(dataDir, { "1": large })
    const sidecarPath = refs["1"]!
    writeFileSync(join(dataDir, sidecarPath), "corrupt")

    const repairedRefs = persistSidecarPastedContents(dataDir, { "1": large })

    expect(repairedRefs["1"]).toBe(sidecarPath)
    expect(readFileSync(join(dataDir, sidecarPath), "utf-8")).toBe(large)
    expect(readSidecarPastedContents(dataDir, repairedRefs)).toEqual({ "1": large })
  })

  it("does not restore corrupted content-addressed sidecar files", () => {
    const dataDir = mkDataDir()
    const large = "correct paste\n" + "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)
    const refs = persistSidecarPastedContents(dataDir, { "1": large })
    writeFileSync(join(dataDir, refs["1"]!), "corrupt")

    expect(readSidecarPastedContents(dataDir, refs)).toEqual({})
  })

  it("keeps inline pasted content when a same-id sidecar is corrupted", () => {
    const dataDir = mkDataDir()
    const large = "correct paste\n" + "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)
    const refs = persistSidecarPastedContents(dataDir, { "1": large })
    writeFileSync(join(dataDir, refs["1"]!), "corrupt")

    const restored = restorePromptHistoryEntry(dataDir, {
      display: "review [Pasted #1 · 1 lines · 12 chars]",
      pastedContents: { "1": "inline paste" },
      pastedContentRefs: refs,
      timestamp: 1,
    })

    expect(restored.display).toBe("review [Pasted #1 · 1 lines · 12 chars]")
    expect(restored.pastedContents).toEqual({ "1": "inline paste" })
  })

  it("does not read symlinked sidecar refs inside the paste-history directory", () => {
    const dataDir = mkDataDir()
    const pasteHistoryDir = join(dataDir, "paste-history")
    const externalDir = join(dataDir, "outside")
    mkdirSync(pasteHistoryDir, { recursive: true })
    mkdirSync(externalDir, { recursive: true })
    const external = join(externalDir, "secret.txt")
    const sidecar = join(pasteHistoryDir, "linked.txt")
    writeFileSync(external, "do not read")
    symlinkSync(external, sidecar)

    expect(readSidecarPastedContents(dataDir, { "1": sidecar })).toEqual({})
  })

  it("does not follow a symlinked paste-history directory", () => {
    const dataDir = mkDataDir()
    const externalDir = join(dataDir, "outside")
    mkdirSync(externalDir, { recursive: true })
    writeFileSync(join(externalDir, "secret.txt"), "do not read")
    symlinkSync(externalDir, join(dataDir, "paste-history"))

    expect(persistSidecarPastedContents(dataDir, { "1": "do not write" })).toEqual({})
    expect(readSidecarPastedContents(dataDir, {
      "1": "paste-history/secret.txt",
    })).toEqual({})
  })

  it("does not read sidecar refs outside the paste-history directory", () => {
    const dataDir = mkDataDir()
    const externalDir = join(dataDir, "outside")
    mkdirSync(externalDir, { recursive: true })
    const external = join(externalDir, "secret.txt")
    writeFileSync(external, "do not read")

    expect(readSidecarPastedContents(dataDir, { "1": external })).toEqual({})
  })

  it("restores navigation display and pasted contents from readable sidecars", () => {
    const dataDir = mkDataDir()
    const large = "first line\n" + "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)
    const refs = persistSidecarPastedContents(dataDir, { "1": large })

    const restored = restorePromptHistoryEntry(dataDir, {
      display: "review [Pasted #1 · 2 lines · 65547 chars]",
      pastedContents: {},
      pastedContentRefs: refs,
      timestamp: 1,
    })

    expect(restored.display).toBe(`review [Pasted #1 · 2 lines · ${large.length} chars]`)
    expect(restored.pastedContents).toEqual({ "1": large })
  })

  it("keeps prompt-history sidecars restorable after moving the data directory", () => {
    const dataDir = mkDataDir()
    const movedDataDir = `${dataDir}-moved`
    dirs.push(movedDataDir)
    const large = `LONG_HEAD\n${"界🧪".repeat(40_000)}\nLONG_TAIL`
    const refs = persistSidecarPastedContents(dataDir, { "1": large })
    const entry = {
      display: `review [Pasted #1 · 3 lines · ${Array.from(large).length} chars]`,
      pastedContents: {},
      pastedContentRefs: refs,
      timestamp: 1,
    }

    renameSync(dataDir, movedDataDir)
    const restored = restorePromptHistoryEntry(movedDataDir, entry)

    expect(restored.pastedContents).toEqual({ "1": large })
    expect(restored.display).toBe(entry.display)
  })

  it("relocates legacy absolute content-addressed refs by hash filename", () => {
    const dataDir = mkDataDir()
    const movedDataDir = `${dataDir}-moved`
    dirs.push(movedDataDir)
    const large = `LEGACY_HEAD\n${"x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)}\nLEGACY_TAIL`
    const refs = persistSidecarPastedContents(dataDir, { "1": large })
    const legacyAbsoluteRef = join(dataDir, refs["1"]!)

    renameSync(dataDir, movedDataDir)
    const restored = restorePromptHistoryEntry(movedDataDir, {
      display: `review [Pasted #1 · 3 lines · ${large.length} chars]`,
      pastedContents: {},
      pastedContentRefs: { "1": legacyAbsoluteRef },
      timestamp: 1,
    })

    expect(restored.pastedContents).toEqual({ "1": large })
  })

  it("normalizes restored sidecar paste placeholder metadata from the file content", () => {
    const dataDir = mkDataDir()
    const large = "first\r" + "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 10)
    const refs = persistSidecarPastedContents(dataDir, { "1": large })

    const restored = restorePromptHistoryEntry(dataDir, {
      display: "review [Pasted #1 · 1 lines · 999 chars]",
      pastedContents: {},
      pastedContentRefs: refs,
      timestamp: 1,
    })

    expect(restored.display).toBe(`review [Pasted #1 · 2 lines · ${large.length} chars]`)
    expect(restored.pastedContents).toEqual({ "1": large })
  })

  it("caps total sidecar bytes restored from prompt history", () => {
    const dataDir = mkDataDir()
    const pasteHistoryDir = join(dataDir, "paste-history")
    mkdirSync(pasteHistoryDir, { recursive: true })
    const chunkSize = MAX_HISTORY_PASTED_SIDECAR_TOTAL_BYTES / 4
    const refs: Record<string, string> = {}
    const chunks: Record<string, string> = {}
    for (let i = 1; i <= 5; i++) {
      const body = `${i}`.repeat(chunkSize)
      chunks[String(i)] = body
      const path = join(pasteHistoryDir, `paste-${i}.txt`)
      writeFileSync(path, body)
      refs[String(i)] = path
    }

    const restored = restorePromptHistoryEntry(dataDir, {
      display: [
        "[Pasted #1 · 1 lines · 2097152 chars]",
        "[Pasted #2 · 1 lines · 2097152 chars]",
        "[Pasted #3 · 1 lines · 2097152 chars]",
        "[Pasted #4 · 1 lines · 2097152 chars]",
        "[Pasted #5 · 1 lines · 2097152 chars]",
      ].join(" "),
      pastedContents: {},
      pastedContentRefs: refs,
      timestamp: 1,
    })

    const directRead = readSidecarPastedContents(dataDir, refs)
    expect(Object.keys(directRead)).toEqual(["1", "2", "3", "4"])
    expect(Object.keys(restored.pastedContents)).toEqual(["1", "2", "3", "4"])
    expect(restored.pastedContents["1"]?.length).toBe(chunkSize)
    expect(restored.pastedContents["4"]?.length).toBe(chunkSize)
    expect(restored.pastedContents["4"]?.startsWith("4")).toBe(true)
    expect(restored.display).toContain("[Pasted #4 · 1 lines · 2097152 chars]")
    expect(restored.display).toContain("[Pasted #5 unavailable in history; paste again to resend full text]")
  })

  it("marks navigation paste placeholders unavailable when the sidecar is missing", () => {
    const dataDir = mkDataDir()

    const restored = restorePromptHistoryEntry(dataDir, {
      display: "review [Pasted #1 · 2 lines · 65547 chars]",
      pastedContents: {},
      pastedContentRefs: { "1": join(dataDir, "paste-history", "missing.txt") },
      timestamp: 1,
    })

    expect(restored.display).toBe("review [Pasted #1 unavailable in history; paste again to resend full text]")
    expect(restored.pastedContents).toEqual({})
  })
})

function mkDataDir(): string {
  const dir = join(tmpdir(), `zapcode-prompt-history-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  dirs.push(dir)
  return dir
}

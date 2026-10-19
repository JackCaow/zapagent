import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  pruneOrphanedPasteImages,
  pruneOrphanedPasteHistoryText,
  pruneStaleImageCache,
  pruneImageStorage,
} from "../src/imageStore.js"

// ── shared tmp data dir, isolated from the developer's real ~/.zapcode ──
let dataDirBackup: string | undefined
let dataDir = ""
let pasteDir = ""
let pasteHistoryDir = ""
let cacheDir = ""
let historyPath = ""

beforeAll(() => {
  dataDirBackup = process.env.ZAPCODE_DATA_DIR
  dataDir = join(tmpdir(), `zapcode-imgstore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.ZAPCODE_DATA_DIR = dataDir
  pasteDir = join(dataDir, "image-paste")
  pasteHistoryDir = join(dataDir, "paste-history")
  cacheDir = join(dataDir, "image-cache")
  historyPath = join(dataDir, "history.jsonl")
})

afterAll(() => {
  if (dataDirBackup === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = dataDirBackup
  rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Reset all the dirs/files between tests so each starts clean.
  rmSync(pasteDir,    { recursive: true, force: true })
  rmSync(pasteHistoryDir, { recursive: true, force: true })
  rmSync(cacheDir,    { recursive: true, force: true })
  rmSync(historyPath, { recursive: true, force: true })
  rmSync(join(dataDir, "projects"), { recursive: true, force: true })
  mkdirSync(pasteDir, { recursive: true })
  mkdirSync(pasteHistoryDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
})

const writeFile = (p: string, content = "x") => writeFileSync(p, content)
const writeHistory = (entries: Array<Record<string, unknown>>) => {
  writeFileSync(historyPath, entries.map(e => JSON.stringify(e)).join("\n") + "\n")
}

// ─── pruneOrphanedPasteImages ─────────────────────────────────────────

describe("pruneOrphanedPasteImages", () => {
  it("no-op when paste dir is empty", () => {
    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(0)
    expect(r.bytesFreed).toBe(0)
  })

  it("deletes everything when history.jsonl doesn't exist", () => {
    writeFile(join(pasteDir, "paste-1.png"), "AAAA")
    writeFile(join(pasteDir, "paste-2.png"), "BBBBB")
    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(2)
    expect(r.bytesFreed).toBe(9)
    expect(existsSync(join(pasteDir, "paste-1.png"))).toBe(false)
    expect(existsSync(join(pasteDir, "paste-2.png"))).toBe(false)
  })

  it("keeps files referenced by any history entry's imageRefs", () => {
    const kept    = join(pasteDir, "paste-1.png")
    const orphan1 = join(pasteDir, "paste-2.png")
    const orphan2 = join(pasteDir, "paste-3.png")
    writeFile(kept, "AAA")
    writeFile(orphan1, "BBB")
    writeFile(orphan2, "CCC")
    writeHistory([
      { display: "hi",    pastedContents: {}, imageRefs: { 1: kept }, timestamp: 1 },
      { display: "later", pastedContents: {},                          timestamp: 2 },
    ])

    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(2)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(orphan1)).toBe(false)
    expect(existsSync(orphan2)).toBe(false)
  })

  it("survives malformed history lines", () => {
    const kept = join(pasteDir, "paste-1.png")
    writeFile(kept, "X")
    // Mix valid + garbage + empty line — must not throw, must still
    // honor the valid imageRefs from the good line.
    writeFileSync(
      historyPath,
      [
        JSON.stringify({ display: "ok", pastedContents: {}, imageRefs: { 9: kept }, timestamp: 1 }),
        "{ broken json",
        "",
      ].join("\n") + "\n",
    )
    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(0)
    expect(existsSync(kept)).toBe(true)
  })

  it("ignores non-string filePaths in imageRefs (defensive)", () => {
    const orphan = join(pasteDir, "paste-1.png")
    writeFile(orphan, "X")
    writeHistory([
      // bogus types — number, null, undefined values; none should be
      // treated as a referenced filePath
      { display: "hi", pastedContents: {}, imageRefs: { 1: 42, 2: null }, timestamp: 1 },
    ])
    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(1)
    expect(existsSync(orphan)).toBe(false)
  })

  it("ignores image refs with non-canonical placeholder ids", () => {
    const orphan = join(pasteDir, "paste-1.png")
    writeFile(orphan, "X")
    writeHistory([
      { display: "hi", pastedContents: {}, imageRefs: { "0": orphan, "01": orphan, bad: orphan }, timestamp: 1 },
    ])

    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(1)
    expect(existsSync(orphan)).toBe(false)
  })

  it("never touches files outside image-paste/", () => {
    // The user's drag-drop path is THEIR file — pruning should never
    // walk outside the paste dir, regardless of what history references.
    const externalDir = join(dataDir, "user-files")
    mkdirSync(externalDir, { recursive: true })
    const userFile = join(externalDir, "photo.png")
    writeFile(userFile, "external")
    writeHistory([
      { display: "hi", pastedContents: {}, imageRefs: { 1: userFile }, timestamp: 1 },
    ])
    const r = pruneOrphanedPasteImages()
    expect(r.deleted).toBe(0)
    expect(existsSync(userFile)).toBe(true)
  })
})

// ─── pruneOrphanedPasteHistoryText ───────────────────────────────────

describe("pruneOrphanedPasteHistoryText", () => {
  it("keeps text sidecars referenced by history entries", () => {
    const kept = join(pasteHistoryDir, "kept.txt")
    const orphan = join(pasteHistoryDir, "orphan.txt")
    writeFile(kept, "long paste")
    writeFile(orphan, "old paste")
    writeHistory([
      { display: "hi", pastedContents: {}, pastedContentRefs: { 1: kept }, timestamp: 1 },
    ])

    const r = pruneOrphanedPasteHistoryText()
    expect(r.deleted).toBe(1)
    expect(r.bytesFreed).toBe("old paste".length)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it("keeps text sidecars referenced by session restoreText refs", () => {
    const kept = join(pasteHistoryDir, "session-kept.txt")
    const orphan = join(pasteHistoryDir, "orphan.txt")
    writeFile(kept, "long restore text")
    writeFile(orphan, "old paste")
    const sessionDir = join(dataDir, "projects", "repo", "sessions")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, "session-1.jsonl"),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "[Pasted #1 · 1 lines · 17 chars]" },
        zapRestoreTextRef: kept,
      }) + "\n",
    )

    const r = pruneOrphanedPasteHistoryText()

    expect(r.deleted).toBe(1)
    expect(r.bytesFreed).toBe("old paste".length)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it("keeps session restoreText refs outside the history tail window", () => {
    const kept = join(pasteHistoryDir, "early-session-kept.txt")
    const orphan = join(pasteHistoryDir, "orphan.txt")
    writeFile(kept, "long restore text")
    writeFile(orphan, "old paste")
    const sessionDir = join(dataDir, "projects", "repo", "sessions")
    mkdirSync(sessionDir, { recursive: true })
    const fd = openSync(join(sessionDir, "large-session.jsonl"), "w")
    try {
      writeSync(
        fd,
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "[Pasted #1 · 1 lines · 17 chars]" },
          zapRestoreTextRef: kept,
        }) + "\n",
      )
      ftruncateSync(fd, 70 * 1024 * 1024)
    } finally {
      closeSync(fd)
    }

    const r = pruneOrphanedPasteHistoryText()

    expect(r.deleted).toBe(1)
    expect(r.bytesFreed).toBe("old paste".length)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it("does not touch text files outside paste-history", () => {
    const externalDir = join(dataDir, "user-files")
    mkdirSync(externalDir, { recursive: true })
    const userFile = join(externalDir, "note.txt")
    writeFile(userFile, "external")
    writeHistory([
      { display: "hi", pastedContents: {}, pastedContentRefs: { 1: userFile }, timestamp: 1 },
    ])

    const r = pruneOrphanedPasteHistoryText()
    expect(r.deleted).toBe(0)
    expect(existsSync(userFile)).toBe(true)
  })

  it("ignores text sidecar refs with non-canonical placeholder ids", () => {
    const orphan = join(pasteHistoryDir, "orphan.txt")
    writeFile(orphan, "old paste")
    writeHistory([
      { display: "hi", pastedContents: {}, pastedContentRefs: { "0": orphan, "01": orphan, bad: orphan }, timestamp: 1 },
    ])

    const r = pruneOrphanedPasteHistoryText()
    expect(r.deleted).toBe(1)
    expect(r.bytesFreed).toBe("old paste".length)
    expect(existsSync(orphan)).toBe(false)
  })

  it("keeps text sidecars referenced by valid capped history even beyond the old 2MB tail", () => {
    const old = join(pasteHistoryDir, "old.txt")
    const recent = join(pasteHistoryDir, "recent.txt")
    const orphan = join(pasteHistoryDir, "orphan.txt")
    writeFile(old, "old paste")
    writeFile(recent, "recent paste")
    writeFile(orphan, "orphan paste")
    writeFileSync(
      historyPath,
      [
        JSON.stringify({ display: "old", pastedContents: {}, pastedContentRefs: { 1: old }, timestamp: 1 }),
        "x".repeat(2 * 1024 * 1024 + 1024),
        JSON.stringify({ display: "recent", pastedContents: {}, pastedContentRefs: { 1: recent }, timestamp: 2 }),
      ].join("\n") + "\n",
    )

    const r = pruneOrphanedPasteHistoryText()

    expect(r.deleted).toBe(1)
    expect(r.bytesFreed).toBe("orphan paste".length)
    expect(existsSync(old)).toBe(true)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it("deletes referenced content-addressed text sidecars whose content no longer matches the filename hash", () => {
    const validBody = "valid long paste"
    const validHash = createHash("sha256").update(validBody).digest("hex")
    const valid = join(pasteHistoryDir, `${validHash}.txt`)
    const originalBody = "original long paste"
    const corruptHash = createHash("sha256").update(originalBody).digest("hex")
    const corrupt = join(pasteHistoryDir, `${corruptHash}.txt`)
    const legacy = join(pasteHistoryDir, "legacy.txt")
    writeFile(valid, validBody)
    writeFile(corrupt, "mutated long paste")
    writeFile(legacy, "legacy referenced paste")
    writeHistory([
      {
        display: "hi",
        pastedContents: {},
        pastedContentRefs: { 1: valid, 2: corrupt, 3: legacy },
        timestamp: 1,
      },
    ])

    const r = pruneOrphanedPasteHistoryText()

    expect(r.deleted).toBe(1)
    expect(r.bytesFreed).toBe("mutated long paste".length)
    expect(existsSync(valid)).toBe(true)
    expect(existsSync(corrupt)).toBe(false)
    expect(existsSync(legacy)).toBe(true)
  })
})

// ─── pruneStaleImageCache ─────────────────────────────────────────────

describe("pruneStaleImageCache", () => {
  it("no-op when cache dir is empty", () => {
    const r = pruneStaleImageCache()
    expect(r.deleted).toBe(0)
  })

  it("keeps fresh files (mtime within TTL)", () => {
    const fresh = join(cacheDir, "fresh.png")
    writeFile(fresh, "X")  // implicitly mtime = now
    const r = pruneStaleImageCache()
    expect(r.deleted).toBe(0)
    expect(existsSync(fresh)).toBe(true)
  })

  it("deletes files whose mtime is older than the TTL", () => {
    const stale = join(cacheDir, "stale.png")
    const fresh = join(cacheDir, "fresh.png")
    writeFile(stale, "S")
    writeFile(fresh, "F")
    // Mark `stale` as 60 days old — well past the 30-day TTL.
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stale, sixtyDaysAgo, sixtyDaysAgo)

    const r = pruneStaleImageCache()
    expect(r.deleted).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})

// ─── pruneImageStorage (combined) ─────────────────────────────────────

describe("pruneImageStorage", () => {
  it("runs all passes and aggregates stats", () => {
    // paste-side orphan
    writeFile(join(pasteDir, "paste-orphan.png"), "AAA")
    // text-paste orphan
    writeFile(join(pasteHistoryDir, "paste-orphan.txt"), "CCCC")
    // cache-side stale
    const stale = join(cacheDir, "stale.png")
    writeFile(stale, "BB")
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stale, sixtyDaysAgo, sixtyDaysAgo)

    const r = pruneImageStorage()
    expect(r.deleted).toBe(3)
    expect(r.bytesFreed).toBe(9)
  })
})

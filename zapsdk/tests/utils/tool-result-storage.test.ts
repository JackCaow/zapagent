import { afterEach, beforeEach, describe, it, expect } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { resolveProjectDataSegment } from "../../utils/project-paths.js"
import {
  maybePersistToolResult,
  deletePersistedToolOutputs,
  readPersistedOutput,
  PERSIST_THRESHOLD_CHARS,
  PERSISTED_OUTPUT_TAG,
  PREVIEW_CHARS,
} from "../../utils/tool-result-storage.js"

describe("maybePersistToolResult", () => {
  let dataDir: string
  let projectDirs: string[]
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), "zap-tool-output-"))
    projectDirs = []
    process.env.ZAPCODE_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = previousDataDir
    for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it("returns content as-is when below threshold", () => {
    const r = maybePersistToolResult("t1", "s1", "read_file", "short content")
    expect(r.persisted).toBe(false)
    expect(r.contentForConversation).toBe("short content")
    expect(r.persistedPath).toBeUndefined()
  })

  it("persists below-threshold content when a context-aware caller forces storage", () => {
    const content = "small but context-dominating output"
    const r = maybePersistToolResult(
      "t-forced",
      "forced-session",
      "bash",
      content,
      { force: true },
    )

    expect(r.persisted).toBe(true)
    expect(r.persistedPath).toBeDefined()
    expect(readPersistedOutput(r.persistedPath!)).toBe(content)
    expect(r.contentForConversation).toContain("use offset/limit for large files")
  })

  it("uses Unicode code points for the persistence threshold", () => {
    const almostBig = "😀".repeat(PERSIST_THRESHOLD_CHARS - 1)

    const r = maybePersistToolResult("t-emoji-small", "emoji-threshold", "read_file", almostBig)

    expect(r.persisted).toBe(false)
    expect(r.contentForConversation).toBe(almostBig)
  })

  it("persists oversized content to disk and returns preview + marker", () => {
    const big = "x".repeat(PERSIST_THRESHOLD_CHARS + 1000)
    const r = maybePersistToolResult("t-big-1", "test-session", "read_file", big)
    expect(r.persisted).toBe(true)
    expect(r.persistedPath).toBeTruthy()
    expect(r.persistedPath).toBe(join(projectToolOutputsDir(dataDir), "test-session", "t-big-1.txt"))
    expect(existsSync(r.persistedPath!)).toBe(true)
    expect(statSync(r.persistedPath!).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(r.persistedPath!)).mode & 0o777).toBe(0o700)

    // conversation content should be short — preview + marker, not the full thing
    expect(r.contentForConversation.length).toBeLessThan(big.length)
    expect(r.contentForConversation).toContain(`<${PERSISTED_OUTPUT_TAG}>`)
    expect(r.contentForConversation).toContain(`</${PERSISTED_OUTPUT_TAG}>`)
    expect(r.contentForConversation).toContain("read_file")
    // Preview should be the first chunk of content
    expect(r.contentForConversation.startsWith("x".repeat(PREVIEW_CHARS))).toBe(true)

    // Roundtrip: read back the full content from disk
    const restored = readPersistedOutput(r.persistedPath!)
    expect(restored).toBe(big)
  })

  it("reuses an unchanged persisted output without rewriting it", () => {
    const content = "same".repeat(PERSIST_THRESHOLD_CHARS)
    const first = maybePersistToolResult("t-reuse", "reuse-session", "bash", content)
    const firstStat = statSync(first.persistedPath!)

    const second = maybePersistToolResult("t-reuse", "reuse-session", "bash", content)
    const secondStat = statSync(second.persistedPath!)

    expect(first.reused).toBe(false)
    expect(second.persisted).toBe(true)
    expect(second.reused).toBe(true)
    expect(second.persistedPath).toBe(first.persistedPath)
    expect(secondStat.ino).toBe(firstStat.ino)
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs)
    expect(readPersistedOutput(second.persistedPath!)).toBe(content)
  })

  it("rewrites the same tool-call path when its content changes", () => {
    const firstContent = "a".repeat(PERSIST_THRESHOLD_CHARS + 10)
    const secondContent = "b".repeat(PERSIST_THRESHOLD_CHARS + 10)
    const first = maybePersistToolResult("t-changed", "changed-session", "bash", firstContent)

    const second = maybePersistToolResult("t-changed", "changed-session", "bash", secondContent)

    expect(first.persistedPath).toBe(second.persistedPath)
    expect(second.reused).toBe(false)
    expect(readPersistedOutput(second.persistedPath!)).toBe(secondContent)
  })

  it("repairs a deleted output instead of trusting the reuse cache", () => {
    const content = "delete".repeat(PERSIST_THRESHOLD_CHARS)
    const first = maybePersistToolResult("t-deleted", "deleted-session", "bash", content)
    rmSync(first.persistedPath!, { force: true })

    const second = maybePersistToolResult("t-deleted", "deleted-session", "bash", content)

    expect(second.reused).toBe(false)
    expect(readPersistedOutput(second.persistedPath!)).toBe(content)
  })

  it("repairs a corrupted output instead of trusting the reuse cache", () => {
    const content = "repair".repeat(PERSIST_THRESHOLD_CHARS)
    const first = maybePersistToolResult("t-corrupt", "corrupt-session", "bash", content)
    writeFileSync(first.persistedPath!, "corrupt")

    const second = maybePersistToolResult("t-corrupt", "corrupt-session", "bash", content)

    expect(second.reused).toBe(false)
    expect(readPersistedOutput(second.persistedPath!)).toBe(content)
  })

  it("returns a bounded head-tail warning when oversized output cannot be persisted", () => {
    const blockedRoot = join(dataDir, "not-a-directory")
    writeFileSync(blockedRoot, "blocked")
    process.env.ZAPCODE_DATA_DIR = blockedRoot
    const content = `HEAD:${"x".repeat(PERSIST_THRESHOLD_CHARS + 1000)}:TAIL`

    const result = maybePersistToolResult(
      "t-storage-failure",
      "failed-session",
      "bash",
      content,
    )

    expect(result.persisted).toBe(false)
    expect(result.attempted).toBe(true)
    expect(result.failureReason).toBeTruthy()
    expect(result.persistedPath).toBeUndefined()
    expect(result.contentForConversation.length).toBeLessThan(content.length / 2)
    expect(result.contentForConversation).toContain("HEAD:")
    expect(result.contentForConversation).toContain(":TAIL")
    expect(result.contentForConversation).toContain('status="unavailable"')
    expect(result.contentForConversation).toContain(`full_chars: ${Array.from(content).length}`)
    expect(result.contentForConversation).toContain("rerun the tool with narrower output")
  })

  it("does not split non-BMP characters in the persisted output preview", () => {
    const big = "a".repeat(PREVIEW_CHARS - 1) + "😀" + "b".repeat(PERSIST_THRESHOLD_CHARS)

    const r = maybePersistToolResult("t-emoji", "emoji-session", "read_file", big)

    expect(r.persisted).toBe(true)
    expect(r.contentForConversation).toContain(`<${PERSISTED_OUTPUT_TAG}>`)
    expect(r.contentForConversation).toContain("truncated")
    expect(hasUnpairedSurrogate(r.contentForConversation)).toBe(false)
    expect(readPersistedOutput(r.persistedPath!)).toBe(big)
  })

  it("reports persisted output full_chars by Unicode code point", () => {
    const big = "😀".repeat(PERSIST_THRESHOLD_CHARS)

    const r = maybePersistToolResult("t-emoji-count", "emoji-count-session", "read_file", big)

    expect(r.persisted).toBe(true)
    expect(r.contentForConversation).toContain(`full_chars: ${PERSIST_THRESHOLD_CHARS}`)
    expect(r.contentForConversation).not.toContain(`full_chars: ${big.length}`)
    expect(hasUnpairedSurrogate(r.contentForConversation)).toBe(false)
    expect(readPersistedOutput(r.persistedPath!)).toBe(big)
  })

  it("synthesizes an id when toolCallId is missing", () => {
    const big = "y".repeat(PERSIST_THRESHOLD_CHARS + 100)
    const r = maybePersistToolResult(undefined, "test-session-2", "web_search", big)
    expect(r.persisted).toBe(true)
    expect(r.persistedPath).toMatch(/synth_[a-f0-9]+\.txt$/)
  })

  it("tightens an existing broad persisted output file", () => {
    const dir = join(projectToolOutputsDir(dataDir), "test-session-3")
    const path = join(dir, "t-broad.txt")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, "old", { mode: 0o666 })
    chmodSync(path, 0o666)

    const big = "z".repeat(PERSIST_THRESHOLD_CHARS + 100)
    const r = maybePersistToolResult("t-broad", "test-session-3", "read_file", big)

    expect(r.persisted).toBe(true)
    expect(r.persistedPath).toBe(path)
    expect(readFileSync(path, "utf-8")).toBe(big)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("uses explicit projectCwd instead of process.cwd when provided", () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "zap-tool-output-project-"))
    projectDirs.push(projectCwd)
    const big = "p".repeat(PERSIST_THRESHOLD_CHARS + 100)

    const r = maybePersistToolResult(
      "t-scoped",
      "scoped-session",
      "read_file",
      big,
      { projectCwd },
    )

    expect(r.persisted).toBe(true)
    expect(r.persistedPath).toBe(
      join(projectToolOutputsDir(dataDir, projectCwd), "scoped-session", "t-scoped.txt"),
    )
    expect(readPersistedOutput(r.persistedPath!)).toBe(big)
  })

  it("does not reuse cached storage dirs after ZAPCODE_DATA_DIR changes", () => {
    const firstDataDir = dataDir
    const secondDataDir = mkdtempSync(join(tmpdir(), "zap-tool-output-second-"))
    const big = "d".repeat(PERSIST_THRESHOLD_CHARS + 100)
    try {
      const first = maybePersistToolResult("t-one", "same-session", "read_file", big)
      expect(first.persistedPath).toBe(
        join(projectToolOutputsDir(firstDataDir), "same-session", "t-one.txt"),
      )

      process.env.ZAPCODE_DATA_DIR = secondDataDir
      const second = maybePersistToolResult("t-two", "same-session", "read_file", big)

      expect(second.persistedPath).toBe(
        join(projectToolOutputsDir(secondDataDir), "same-session", "t-two.txt"),
      )
      expect(existsSync(second.persistedPath!)).toBe(true)
      expect(second.persistedPath).not.toContain(firstDataDir)
    } finally {
      rmSync(secondDataDir, { recursive: true, force: true })
      process.env.ZAPCODE_DATA_DIR = firstDataDir
    }
  })

  it("recreates a cached session directory with private permissions if it is removed", () => {
    const big = "r".repeat(PERSIST_THRESHOLD_CHARS + 100)
    const first = maybePersistToolResult("t-first", "removed-session", "read_file", big)
    const sessionDir = dirname(first.persistedPath!)
    expect(first.persisted).toBe(true)
    rmSync(sessionDir, { recursive: true, force: true })

    const second = maybePersistToolResult("t-second", "removed-session", "read_file", big)

    expect(second.persisted).toBe(true)
    expect(second.persistedPath).toBe(join(sessionDir, "t-second.txt"))
    expect(existsSync(second.persistedPath!)).toBe(true)
    if (process.platform !== "win32") {
      expect(statSync(sessionDir).mode & 0o777).toBe(0o700)
      expect(statSync(second.persistedPath!).mode & 0o777).toBe(0o600)
    }
  })

  it("deletes only the persisted outputs owned by the requested session", () => {
    const first = maybePersistToolResult("t1", "session-one", "bash", "one", { force: true })
    const second = maybePersistToolResult("t2", "session-two", "bash", "two", { force: true })

    expect(deletePersistedToolOutputs("session-one")).toBe(true)
    expect(existsSync(dirname(first.persistedPath!))).toBe(false)
    expect(readPersistedOutput(second.persistedPath!)).toBe("two")
  })

  it("clears reuse fingerprints when deleting a session", () => {
    const content = "cleanup".repeat(PERSIST_THRESHOLD_CHARS)
    const first = maybePersistToolResult("t-cleanup", "cleanup-session", "bash", content)

    expect(deletePersistedToolOutputs("cleanup-session")).toBe(true)

    const second = maybePersistToolResult("t-cleanup", "cleanup-session", "bash", content)

    expect(first.persistedPath).toBe(second.persistedPath)
    expect(second.reused).toBe(false)
    expect(readPersistedOutput(second.persistedPath!)).toBe(content)
  })

  it("keeps traversal-like session ids inside the tool-outputs directory", () => {
    const result = maybePersistToolResult("t1", "..", "bash", "safe", { force: true })
    const outputRoot = projectToolOutputsDir(dataDir)

    expect(result.persistedPath?.startsWith(`${outputRoot}${sep}`)).toBe(true)
    expect(dirname(result.persistedPath!)).not.toBe(dirname(outputRoot))
    expect(deletePersistedToolOutputs("..")).toBe(true)
    expect(existsSync(outputRoot)).toBe(true)
  })
})

function projectToolOutputsDir(dataDir: string, projectCwd = process.cwd()): string {
  return join(dataDir, "projects", resolveProjectDataSegment(projectCwd), "tool-outputs")
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

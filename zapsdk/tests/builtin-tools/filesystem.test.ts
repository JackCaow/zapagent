import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  deleteFileTool,
  moveFileTool,
  readFileTool,
  isPathAllowed,
  writeFileTool,
} from "../../builtin-tools/filesystem.js"
import { editFileTool } from "../../builtin-tools/edit.js"
import { multiEditTool } from "../../builtin-tools/multi-edit.js"
import { createBuiltinRegistry } from "../../builtin-tools/index.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("native file tool checkpoint contracts", () => {
  it("declares exact undo targets while leaving strict recovery to explicit policy", () => {
    for (const tool of [writeFileTool(), moveFileTool(), deleteFileTool(), editFileTool(), multiEditTool()]) {
      expect(tool.definition.checkpointTracking).toBe("files")
      expect(tool.definition.checkpointRequirement).toBeUndefined()
      expect(typeof tool.definition.writesPath).toBe("function")
      expect(tool.definition.permission).toBe("confirm")
    }
  })
})

describe("read_file default line cap", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("returns whole file when under the default cap", async () => {
    const path = join(dir, "small.txt")
    writeFileSync(path, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"))
    const tool = readFileTool()
    const result = await tool.handler({ path })
    expect(result.success).toBe(true)
    expect(result.output).toContain("line 50")
    // No header when the whole file fits.
    expect(result.output).not.toMatch(/^#/)
  })

  it("caps to 2000 lines and tells the model how to page further", async () => {
    const path = join(dir, "big.txt")
    writeFileSync(path, Array.from({ length: 3500 }, (_, i) => `row ${i + 1}`).join("\n"))
    const tool = readFileTool()
    const result = await tool.handler({ path })
    expect(result.success).toBe(true)
    // Must contain row 2000, must NOT contain row 2001 (default cap)
    expect(result.output).toContain("row 2000")
    expect(result.output).not.toContain("row 2001")
    // Loud header mentions the total and the workaround
    expect(result.output).toMatch(/Default limit of 2000 lines reached/)
    expect(result.output).toContain("of 3500")
    expect(result.output).toContain("offset")
  })

  it("respects an explicit limit even if smaller than default", async () => {
    const path = join(dir, "medium.txt")
    writeFileSync(path, Array.from({ length: 300 }, (_, i) => `L${i + 1}`).join("\n"))
    const tool = readFileTool()
    const result = await tool.handler({ path, limit: 10 })
    expect(result.success).toBe(true)
    expect(result.output).toContain("L10")
    expect(result.output).not.toContain("L11")
    // Explicit limits don't use the default-cap header — just the plain range header.
    expect(result.output).not.toMatch(/Default limit of 2000/)
  })

  it("respects offset with default limit", async () => {
    const path = join(dir, "offset.txt")
    writeFileSync(path, Array.from({ length: 2500 }, (_, i) => `R${i + 1}`).join("\n"))
    const tool = readFileTool()
    const result = await tool.handler({ path, offset: 100 })
    expect(result.success).toBe(true)
    // Starts at R100, reads up to default cap = R2099
    expect(result.output).toContain("R100")
    expect(result.output).toContain("R2099")
    expect(result.output).not.toContain("R2100")
  })

  it("treats CR-only files as logical lines for offset and limit", async () => {
    const path = join(dir, "cr-only.txt")
    writeFileSync(path, ["alpha", "beta", "gamma"].join("\r"))
    const tool = readFileTool()
    const result = await tool.handler({ path, offset: 2, limit: 1 })
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/# Lines 2-2 of 3/)
    expect(result.output).toContain("2→ beta")
    expect(result.output).not.toContain("alpha")
    expect(result.output).not.toContain("gamma")
  })

  it("normalizes CRLF line endings without leaking carriage returns", async () => {
    const path = join(dir, "crlf.txt")
    writeFileSync(path, "first\r\nsecond\r\nthird")
    const tool = readFileTool()
    const result = await tool.handler({ path, limit: 2 })
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/# Lines 1-2 of 3/)
    expect(result.output).toContain("1→ first")
    expect(result.output).toContain("2→ second")
    expect(result.output).not.toContain("\r")
    expect(result.output).not.toContain("third")
  })

  it("does not truncate when code units exceed maxLength but Unicode characters fit", async () => {
    const path = join(dir, "emoji-fit.txt")
    const body = "😀".repeat(20)
    writeFileSync(path, body)
    const tool = readFileTool({ maxLength: 23 })
    const result = await tool.handler({ path })
    expect(result.success).toBe(true)
    expect(result.output).toContain(`1→ ${body}`)
    expect(result.output).not.toContain("[truncated by maxLength]")
    expect(countOccurrences(result.output, "😀")).toBe(20)
  })

  it("truncates maxLength by Unicode character count without splitting non-BMP chars", async () => {
    const path = join(dir, "emoji-truncate.txt")
    writeFileSync(path, "😀".repeat(20))
    const tool = readFileTool({ maxLength: 15 })
    const result = await tool.handler({ path })
    expect(result.success).toBe(true)
    expect(result.output).toContain(`1→ ${"😀".repeat(12)}`)
    expect(result.output).toContain("[truncated by maxLength]")
    expect(countOccurrences(result.output, "😀")).toBe(12)
    expect(hasUnpairedSurrogate(result.output)).toBe(false)
  })

  it("returns image as a content block instead of rejecting as binary", async () => {
    // Smallest valid PNG: 1x1 transparent pixel
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ])
    const path = join(dir, "pixel.png")
    writeFileSync(path, png)
    const tool = readFileTool()
    const result = await tool.handler({ path })
    expect(result.success).toBe(true)
    expect(result.contentBlocks).toBeDefined()
    expect(result.contentBlocks?.length).toBe(1)
    const block = result.contentBlocks![0]
    expect(block.type).toBe("image")
    if (block.type === "image") {
      expect(block.mediaType).toBe("image/png")
      expect(block.base64).toBeTruthy()
    }
    // Text stub tells the model an image was loaded (so it has something to
    // reason about in plain-text contexts too).
    expect(result.output).toContain("Loaded image")
    expect(result.output).toContain("image/png")
  })
})

describe("write_file staleness check", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("creates a new file atomically when the path remains absent", async () => {
    const path = join(dir, "new.txt")
    const tool = writeFileTool()
    const result = await tool.handler({ path, content: "hello" })
    expect(result.success).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("hello")
  })

  it("does not overwrite a file created after the initial ENOENT observation", async () => {
    const path = join(dir, "concurrently-created.txt")
    const tool = writeFileTool({
      beforeWrite: () => {
        writeFileSync(path, "external create")
      },
    })

    const result = await tool.handler({ path, content: "our content" })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/created concurrently/)
    expect(readFileSync(path, "utf-8")).toBe("external create")
  })

  it("reports write size by Unicode character count", async () => {
    const path = join(dir, "emoji-write.txt")
    const tool = writeFileTool()
    const result = await tool.handler({ path, content: "😀".repeat(5) })
    expect(result.success).toBe(true)
    expect(result.output).toContain("Written 5 chars")
    expect(result.output).not.toContain("Written 10 chars")
    expect(readFileSync(path, "utf-8")).toBe("😀".repeat(5))
  })

  it("overwrites an existing file when nothing else is touching it", async () => {
    const path = join(dir, "existing.txt")
    writeFileSync(path, "original")
    const tool = writeFileTool()
    const result = await tool.handler({ path, content: "replaced" })
    expect(result.success).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("replaced")
  })

  it("aborts when the file is modified between our pre-read stat and the pre-write stat", async () => {
    const path = join(dir, "raced.txt")
    writeFileSync(path, "original")

    // Simulate a concurrent modification after the tool has captured its
    // initial stat but before it performs the final stale-write guard.
    const tool = writeFileTool({
      beforeWrite: () => {
        writeFileSync(path, "external write that changes size")
        // Force a clearly-different mtime in case the writes happen inside the
        // same millisecond tick (common on fast SSDs).
        const now = Date.now() / 1000
        utimesSync(path, now + 5, now + 5)
      },
    })

    const result = await tool.handler({ path, content: "our new content" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/modified concurrently/)
    // The concurrent external content must be preserved — our stale write
    // should NOT have landed.
    expect(readFileSync(path, "utf-8")).toBe("external write that changes size")
  })

  it("still aborts when only size changes (mtime granularity edge case)", async () => {
    const path = join(dir, "size-only.txt")
    writeFileSync(path, "aaaa")
    const st = statSync(path)

    const tool = writeFileTool({
      beforeWrite: () => {
        writeFileSync(path, "bb") // different size
        // Pin mtime back to the original to isolate the size check.
        utimesSync(path, st.atime, st.mtime)
      },
    })

    const result = await tool.handler({ path, content: "our write" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/modified concurrently/)
  })
})

describe("allowedPaths real filesystem boundary", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("allows new nested paths under a real allowed root", async () => {
    const allowed = join(dir, "allowed")
    mkdirSync(allowed)

    expect(await isPathAllowed(join(allowed, "new", "file.txt"), [allowed])).toBe(true)
  })

  it("allows an allowed root that is itself a directory symlink", async () => {
    const actual = join(dir, "actual")
    const alias = join(dir, "alias")
    mkdirSync(actual)
    symlinkSync(actual, alias, "dir")

    expect(await isPathAllowed(join(alias, "file.txt"), [alias])).toBe(true)
  })

  it("rejects a path that escapes through a directory symlink", async () => {
    const allowed = join(dir, "allowed")
    const outside = join(dir, "outside")
    mkdirSync(allowed)
    mkdirSync(outside)
    symlinkSync(outside, join(allowed, "link"), "dir")

    expect(await isPathAllowed(join(allowed, "link", "escaped.txt"), [allowed])).toBe(false)
  })

  it("prevents read_file from following an allowed-root symlink to an outside secret", async () => {
    const allowed = join(dir, "allowed")
    const outside = join(dir, "outside")
    mkdirSync(allowed)
    mkdirSync(outside)
    writeFileSync(join(outside, "secret.txt"), "outside secret")
    symlinkSync(join(outside, "secret.txt"), join(allowed, "inside-link.txt"), "file")

    const result = await readFileTool({ allowedPaths: [allowed], defaultCwd: allowed })
      .handler({ path: "inside-link.txt" })

    expect(result.success).toBe(false)
    expect(result.output).not.toContain("outside secret")
    expect(result.error).toContain("not allowed")
  })

  it("prevents generic write tools from modifying protected control-plane paths", async () => {
    const allowed = join(dir, "workspace")
    const gitDir = join(allowed, ".git")
    const zapDir = join(allowed, ".zapcode")
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(zapDir, { recursive: true })
    writeFileSync(join(gitDir, "config"), "git-original")
    writeFileSync(join(zapDir, "settings.json"), "zap-original")
    const protectedPaths = [gitDir, zapDir]

    const gitWrite = await writeFileTool({ allowedPaths: [allowed], protectedPaths })
      .handler({ path: join(gitDir, "config"), content: "hacked" })
    const zapEdit = await editFileTool({ allowedPaths: [allowed], protectedPaths })
      .handler({ path: join(zapDir, "settings.json"), old_string: "original", new_string: "hacked" })

    expect(gitWrite.success).toBe(false)
    expect(zapEdit.success).toBe(false)
    expect(readFileSync(join(gitDir, "config"), "utf8")).toBe("git-original")
    expect(readFileSync(join(zapDir, "settings.json"), "utf8")).toBe("zap-original")
  })

  it("authorizes via canonical paths but deletes the symlink itself, not its in-root target", async () => {
    const allowed = join(dir, "workspace")
    mkdirSync(allowed)
    const target = join(allowed, "target.txt")
    const alias = join(allowed, "alias.txt")
    writeFileSync(target, "keep me")
    symlinkSync(target, alias, "file")

    const result = await deleteFileTool({ allowedPaths: [allowed] }).handler({ path: alias })

    expect(result.success).toBe(true)
    expect(existsSync(alias)).toBe(false)
    expect(readFileSync(target, "utf8")).toBe("keep me")
  })

  it("prevents every mutating file tool from escaping through a directory symlink", async () => {
    const allowed = join(dir, "allowed")
    const outside = join(dir, "outside")
    mkdirSync(allowed)
    mkdirSync(outside)
    symlinkSync(outside, join(allowed, "link"), "dir")
    const escaped = join(allowed, "link", "escaped.txt")
    const victim = join(outside, "victim.txt")
    const escapedVictim = join(allowed, "link", "victim.txt")
    const moveSource = join(allowed, "move-source.txt")
    writeFileSync(victim, "outside original")
    writeFileSync(moveSource, "move source")

    const results = await Promise.all([
      writeFileTool({ allowedPaths: [allowed] }).handler({ path: escaped, content: "write" }),
      editFileTool({ allowedPaths: [allowed] }).handler({
        path: escapedVictim,
        old_string: "outside",
        new_string: "edited",
      }),
      multiEditTool({ allowedPaths: [allowed] }).handler({
        path: escapedVictim,
        edits: [{ old_string: "outside", new_string: "multi-edited" }],
      }),
      deleteFileTool({ allowedPaths: [allowed] }).handler({ path: escapedVictim }),
      moveFileTool({ allowedPaths: [allowed] }).handler({
        source: moveSource,
        destination: escaped,
      }),
    ])

    expect(results).toHaveLength(5)
    for (const result of results) {
      expect(result.success).toBe(false)
      expect(result.error).toContain("allowed")
    }
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false)
    expect(readFileSync(victim, "utf-8")).toBe("outside original")
    expect(readFileSync(moveSource, "utf-8")).toBe("move source")
  })
})

describe("move_file no-clobber semantics", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("refuses to overwrite an existing destination by default", async () => {
    const source = join(dir, "source.txt")
    const destination = join(dir, "destination.txt")
    writeFileSync(source, "source content")
    writeFileSync(destination, "destination content")

    const result = await moveFileTool().handler({ source, destination })

    expect(result.success).toBe(false)
    expect(result.error).toContain("already exists")
    expect(readFileSync(source, "utf-8")).toBe("source content")
    expect(readFileSync(destination, "utf-8")).toBe("destination content")
  })

  it("allows an explicit overwrite", async () => {
    const source = join(dir, "source.txt")
    const destination = join(dir, "destination.txt")
    writeFileSync(source, "source content")
    writeFileSync(destination, "destination content")

    const result = await moveFileTool().handler({ source, destination, overwrite: true })

    expect(result.success).toBe(true)
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(destination, "utf-8")).toBe("source content")
  })

  it("does not overwrite a destination created concurrently", async () => {
    const source = join(dir, "source.txt")
    const destination = join(dir, "destination.txt")
    writeFileSync(source, "source content")
    const tool = moveFileTool({
      beforeMove: () => {
        writeFileSync(destination, "external create")
      },
    })

    const result = await tool.handler({ source, destination })

    expect(result.success).toBe(false)
    expect(result.error).toContain("already exists")
    expect(readFileSync(source, "utf-8")).toBe("source content")
    expect(readFileSync(destination, "utf-8")).toBe("external create")
  })

  it("rejects directories instead of applying platform-specific rename behavior", async () => {
    const source = join(dir, "source-dir")
    const destination = join(dir, "destination-dir")
    mkdirSync(source)

    const result = await moveFileTool().handler({ source, destination })

    expect(result.success).toBe(false)
    expect(result.error).toContain("only moves files")
    expect(existsSync(source)).toBe(true)
    expect(existsSync(destination)).toBe(false)
  })
})

describe("read_file exact target retry", () => {
  let dir: string
  beforeEach(() => {
    dir = makeTmpDir()
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it("returns a candidate without reading content when matching by basename", async () => {
    mkdirSync(join(dir, "src", "deep"), { recursive: true })
    writeFileSync(join(dir, "src", "deep", "uniqloop.ts"), "export const x = 1\n")

    const tool = readFileTool({ defaultCwd: dir })
    const result = await tool.handler({ path: "uniqloop.ts" })

    expect(result.success).toBe(false)
    expect(result.error).toBe("Exact file path required after path resolution")
    expect(result.output).toContain("Call read_file again")
    expect(result.output).not.toContain("export const x = 1")
    const candidate = String((result.meta as Record<string, unknown> | undefined)?.pathCandidate)
    expect(candidate).toBe(join(dir, "src", "deep", "uniqloop.ts"))
    const retried = await tool.handler({ path: candidate })
    expect(retried.success).toBe(true)
    expect(retried.output).toContain("export const x = 1")
  })

  it("does not add [AUTO-RESOLVED] prefix when the literal path exists", async () => {
    const path = join(dir, "exact.txt")
    writeFileSync(path, "literal hit")
    const tool = readFileTool()
    const result = await tool.handler({ path })
    expect(result.success).toBe(true)
    expect(result.output).not.toContain("[AUTO-RESOLVED]")
    expect((result as any).meta?.autoResolved).toBeUndefined()
  })
})

describe("filesystem tools defaultCwd", () => {
  let projectDir: string
  let otherDir: string

  beforeEach(() => {
    projectDir = makeTmpDir()
    otherDir = makeTmpDir()
  })

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
    try { rmSync(otherDir, { recursive: true, force: true }) } catch {}
  })

  it("read_file resolves relative literal paths against defaultCwd", async () => {
    writeFileSync(join(projectDir, "target.txt"), "from project")
    writeFileSync(join(otherDir, "target.txt"), "from process cwd")

    const tool = readFileTool({ defaultCwd: projectDir })
    const result = await tool.handler({ path: "target.txt" })

    expect(result.success).toBe(true)
    expect(result.output).toContain("from project")
    expect(result.output).not.toContain("from process cwd")
  })

  it("read_file discovers a basename candidate inside defaultCwd without reading it", async () => {
    mkdirSync(join(projectDir, "src", "deep"), { recursive: true })
    writeFileSync(join(projectDir, "src", "deep", "only-here.ts"), "export const scoped = true\n")

    const tool = readFileTool({ defaultCwd: projectDir })
    const result = await tool.handler({ path: "only-here.ts" })

    expect(result.success).toBe(false)
    expect(result.output).not.toContain("export const scoped = true")
    expect((result.meta as Record<string, unknown> | undefined)?.pathCandidate).toBe(join(projectDir, "src", "deep", "only-here.ts"))
  })

  it("write/delete/move resolve relative paths against defaultCwd", async () => {
    const write = writeFileTool({ defaultCwd: projectDir })
    const move = moveFileTool({ defaultCwd: projectDir })
    const del = deleteFileTool({ defaultCwd: projectDir })

    expect((await write.handler({ path: "notes/a.txt", content: "one" })).success).toBe(true)
    expect(existsSync(join(projectDir, "notes", "a.txt"))).toBe(true)
    expect(existsSync(join(otherDir, "notes", "a.txt"))).toBe(false)

    expect((await move.handler({ source: "notes/a.txt", destination: "moved/a.txt" })).success).toBe(true)
    expect(existsSync(join(projectDir, "moved", "a.txt"))).toBe(true)

    expect((await del.handler({ path: "moved/a.txt" })).success).toBe(true)
    expect(existsSync(join(projectDir, "moved", "a.txt"))).toBe(false)
  })

  it("createBuiltinRegistry forwards executeCommand.defaultCwd to filesystem tools", async () => {
    writeFileSync(join(projectDir, "registry.txt"), "from registry cwd")
    writeFileSync(join(otherDir, "registry.txt"), "wrong cwd")
    const registry = createBuiltinRegistry({
      executeCommand: { defaultCwd: projectDir },
      exclude: ["bash"],
    })
    const read = registry.get("read_file")!

    const result = await read.handler({ path: "registry.txt" })

    expect(result.success).toBe(true)
    expect(result.output).toContain("from registry cwd")
    expect(result.output).not.toContain("wrong cwd")
  })
})

function countOccurrences(text: string, needle: string): number {
  let count = 0
  for (const ch of text) {
    if (ch === needle) count++
  }
  return count
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

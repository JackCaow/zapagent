import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { multiEditTool } from "../../builtin-tools/multi-edit.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-multiedit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("multi_edit", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("applies multiple edits sequentially in one call", async () => {
    const path = join(dir, "a.ts")
    writeFileSync(path, "const foo = 1\nconst bar = 2\nconst baz = 3\n")
    const tool = multiEditTool()
    const result = await tool.handler({
      path,
      edits: [
        { old_string: "const foo = 1", new_string: "const foo = 10" },
        { old_string: "const bar = 2", new_string: "const bar = 20" },
      ],
    })
    expect(result.success).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("const foo = 10\nconst bar = 20\nconst baz = 3\n")
    expect(result.output).toContain("Applied 2 edits")
  })

  it("supports chained rewrites where edit N depends on edit N-1's output", async () => {
    const path = join(dir, "chain.ts")
    writeFileSync(path, "value=A")
    const tool = multiEditTool()
    const result = await tool.handler({
      path,
      edits: [
        { old_string: "A", new_string: "B" },
        { old_string: "B", new_string: "C" },
      ],
    })
    expect(result.success).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("value=C")
  })

  it("rolls back entirely when any edit fails — file on disk untouched", async () => {
    const path = join(dir, "rollback.ts")
    const original = "line1\nline2\nline3\n"
    writeFileSync(path, original)
    const tool = multiEditTool()
    const result = await tool.handler({
      path,
      edits: [
        { old_string: "line1", new_string: "LINE1" },
        { old_string: "NOT_THERE", new_string: "X" }, // fails
        { old_string: "line3", new_string: "LINE3" },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Edit #2 failed")
    expect(result.error).toContain("NOT_THERE")
    // Crucial: original file is untouched
    expect(readFileSync(path, "utf-8")).toBe(original)
  })

  it("rejects ambiguous match unless replace_all is set", async () => {
    const path = join(dir, "dup.ts")
    writeFileSync(path, "x\nx\nx\n")
    const tool = multiEditTool()
    const failed = await tool.handler({
      path,
      edits: [{ old_string: "x", new_string: "y" }],
    })
    expect(failed.success).toBe(false)
    expect(failed.error).toContain("Edit #1 failed")
    expect(failed.error).toContain("3 occurrences")

    const ok = await tool.handler({
      path,
      edits: [{ old_string: "x", new_string: "y", replace_all: true }],
    })
    expect(ok.success).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("y\ny\ny\n")
  })

  it("enforces allowedPaths", async () => {
    const path = join(dir, "blocked.ts")
    writeFileSync(path, "hi")
    const tool = multiEditTool({ allowedPaths: ["/nope"] })
    const result = await tool.handler({
      path,
      edits: [{ old_string: "hi", new_string: "bye" }],
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("not allowed")
  })

  it("emits a single DiffMeta spanning the original → final buffer", async () => {
    const path = join(dir, "diff.ts")
    writeFileSync(path, "a\nb\nc\n")
    const tool = multiEditTool()
    const result = await tool.handler({
      path,
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "c", new_string: "C" },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.meta).toBeTruthy()
    const meta = result.meta as { diff: string; filetype: string }
    expect(meta.filetype).toBe("typescript")
    expect(meta.diff).toContain("-a")
    expect(meta.diff).toContain("+A")
    expect(meta.diff).toContain("-c")
    expect(meta.diff).toContain("+C")
  })

  it("resolves relative paths against defaultCwd", async () => {
    const projectDir = makeTmpDir()
    const otherDir = makeTmpDir()
    try {
      writeFileSync(join(projectDir, "target.ts"), "const a = 1\nconst b = 2\n")
      writeFileSync(join(otherDir, "target.ts"), "const a = 100\nconst b = 200\n")
      const tool = multiEditTool({ defaultCwd: projectDir })

      const result = await tool.handler({
        path: "target.ts",
        edits: [
          { old_string: "const a = 1", new_string: "const a = 10" },
          { old_string: "const b = 2", new_string: "const b = 20" },
        ],
      })

      expect(result.success).toBe(true)
      expect(readFileSync(join(projectDir, "target.ts"), "utf-8")).toBe("const a = 10\nconst b = 20\n")
      expect(readFileSync(join(otherDir, "target.ts"), "utf-8")).toBe("const a = 100\nconst b = 200\n")
    } finally {
      try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
      try { rmSync(otherDir, { recursive: true, force: true }) } catch {}
    }
  })
})

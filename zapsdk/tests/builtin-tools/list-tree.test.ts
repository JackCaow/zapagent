import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { listTreeTool } from "../../builtin-tools/list-tree.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-tree-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("list_tree", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("renders a multi-level tree at default depth (2)", async () => {
    mkdirSync(join(dir, "src", "agent"), { recursive: true })
    mkdirSync(join(dir, "src", "tools"), { recursive: true })
    writeFileSync(join(dir, "src", "agent", "loop.ts"), "")
    writeFileSync(join(dir, "src", "tools", "executor.ts"), "")
    writeFileSync(join(dir, "README.md"), "")

    const tool = listTreeTool()
    const result = await tool.handler({ path: dir })
    expect(result.success).toBe(true)
    // depth 2: dir, dir/file ARE visible; dir/dir/file would be depth 3 → NOT visible
    expect(result.output).toContain("src/")
    expect(result.output).toContain("agent/")
    expect(result.output).toContain("tools/")
    expect(result.output).toContain("README.md")
    expect(result.output).not.toContain("loop.ts")
    expect(result.output).not.toContain("executor.ts")
  })

  it("descends three levels when depth=3 is requested", async () => {
    mkdirSync(join(dir, "src", "agent"), { recursive: true })
    writeFileSync(join(dir, "src", "agent", "loop.ts"), "")
    const tool = listTreeTool()
    const result = await tool.handler({ path: dir, depth: 3 })
    expect(result.output).toContain("loop.ts")
  })

  it("hides dotfiles by default and shows them with include_hidden", async () => {
    writeFileSync(join(dir, ".hidden"), "")
    writeFileSync(join(dir, "visible.txt"), "")
    const tool = listTreeTool()

    const r1 = await tool.handler({ path: dir })
    expect(r1.output).not.toContain(".hidden")
    expect(r1.output).toContain("visible.txt")

    const r2 = await tool.handler({ path: dir, include_hidden: true })
    expect(r2.output).toContain(".hidden")
  })

  it("adds file metadata only when detail is requested", async () => {
    writeFileSync(join(dir, "visible.txt"), "hello")
    const tool = listTreeTool()

    const compact = await tool.handler({ path: dir })
    const detailed = await tool.handler({ path: dir, detail: true })

    expect(compact.output).toContain("visible.txt")
    expect(compact.output).not.toMatch(/visible\.txt \(0\.0 KB, \d{4}-\d{2}-\d{2}\)/)
    expect(detailed.output).toMatch(/visible\.txt \(0\.0 KB, \d{4}-\d{2}-\d{2}\)/)
  })

  it("always skips node_modules and .git regardless of include_hidden", async () => {
    mkdirSync(join(dir, "node_modules", "foo"), { recursive: true })
    mkdirSync(join(dir, ".git", "objects"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "foo", "x.js"), "")
    writeFileSync(join(dir, "src.ts"), "")

    const tool = listTreeTool()
    const result = await tool.handler({ path: dir, include_hidden: true, depth: 3 })
    expect(result.output).not.toContain("node_modules")
    expect(result.output).not.toContain(".git")
    expect(result.output).toContain("src.ts")
  })

  it("respects .gitignore", async () => {
    writeFileSync(join(dir, ".gitignore"), "build/\nsecret.txt\n")
    mkdirSync(join(dir, "build"), { recursive: true })
    writeFileSync(join(dir, "build", "out.js"), "")
    writeFileSync(join(dir, "secret.txt"), "")
    writeFileSync(join(dir, "keep.ts"), "")

    const tool = listTreeTool()
    const result = await tool.handler({ path: dir, depth: 3 })
    expect(result.output).not.toContain("build/")
    expect(result.output).not.toContain("secret.txt")
    expect(result.output).toContain("keep.ts")
  })

  it("truncates at max_entries and surfaces a tail message", async () => {
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), "")
    const tool = listTreeTool()
    const result = await tool.handler({ path: dir, max_entries: 10 })
    expect(result.output.split("\n").filter((l) => l.includes(".txt")).length).toBeLessThanOrEqual(10)
    expect(result.output).toContain("[truncated at 10 entries")
  })

  it("returns an empty marker for empty directories", async () => {
    const tool = listTreeTool()
    const result = await tool.handler({ path: dir })
    expect(result.success).toBe(true)
    expect(result.output).toContain("(empty:")
  })

  it("sorts directories before files, alphabetically within each group", async () => {
    mkdirSync(join(dir, "z-dir"), { recursive: true })
    mkdirSync(join(dir, "a-dir"), { recursive: true })
    writeFileSync(join(dir, "b-file.txt"), "")
    writeFileSync(join(dir, "a-file.txt"), "")

    const tool = listTreeTool()
    const result = await tool.handler({ path: dir })
    const lines = result.output.split("\n")
    expect(lines[0]).toBe("a-dir/")
    expect(lines[1]).toBe("z-dir/")
    expect(lines[2]).toBe("a-file.txt")
    expect(lines[3]).toBe("b-file.txt")
  })

  it("resolves relative paths against defaultCwd", async () => {
    const projectDir = makeTmpDir()
    const otherDir = makeTmpDir()
    try {
      mkdirSync(join(projectDir, "src"), { recursive: true })
      mkdirSync(join(otherDir, "src"), { recursive: true })
      writeFileSync(join(projectDir, "src", "project.ts"), "")
      writeFileSync(join(otherDir, "src", "other.ts"), "")
      const tool = listTreeTool({ defaultCwd: projectDir })

      const result = await tool.handler({ path: "src" })

      expect(result.success).toBe(true)
      expect(result.output).toContain("project.ts")
      expect(result.output).not.toContain("other.ts")
    } finally {
      try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
      try { rmSync(otherDir, { recursive: true, force: true }) } catch {}
    }
  })
})

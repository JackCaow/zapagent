import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { editFileTool } from "../../builtin-tools/edit.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("edit_file fuzzy hint on failure", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("surfaces nearest candidate lines when old_string isn't found", async () => {
    const path = join(dir, "a.ts")
    writeFileSync(path, "const foo = 1\nconst bar = 2\nconst baz = 3\n")
    const tool = editFileTool()
    const result = await tool.handler({
      path,
      old_string: "const fox = 1",
      new_string: "const fox = 99",
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("String not found")
    expect(result.error).toContain("Closest candidates in file:")
    expect(result.error).toContain("line 1")
    expect(result.error).toContain("const foo = 1")
  })

  it("omits the candidates section when nothing close exists", async () => {
    const path = join(dir, "b.ts")
    writeFileSync(path, "totally\nunrelated\nbuffer\n")
    const tool = editFileTool()
    const result = await tool.handler({
      path,
      old_string: "xy", // length-band pre-filter rejects all the lines
      new_string: "yz",
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("String not found")
    expect(result.error).not.toContain("Closest candidates")
  })

  it("does not change behavior on a successful edit", async () => {
    const path = join(dir, "c.ts")
    writeFileSync(path, "const a = 1\n")
    const tool = editFileTool()
    const result = await tool.handler({
      path,
      old_string: "const a = 1",
      new_string: "const a = 99",
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain("Replaced 1 occurrence")
  })
})

describe("edit_file pre-write syntax check", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("rejects an edit that produces invalid TS, leaving the file unchanged", async () => {
    const path = join(dir, "broken.ts")
    const original = "function f() { return 1 }\n"
    writeFileSync(path, original)
    const tool = editFileTool()
    const result = await tool.handler({
      path,
      // Drop the closing brace
      old_string: "function f() { return 1 }",
      new_string: "function f() { return 1",
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("syntax check failed")
    expect(result.error).toContain("skip_syntax_check=true")
    // File on disk must still be the original
    expect(readFileSync(path, "utf-8")).toBe(original)
  })

  it("allows the edit through when skip_syntax_check is true", async () => {
    const path = join(dir, "skipme.ts")
    writeFileSync(path, "const x = 1\n")
    const tool = editFileTool()
    const result = await tool.handler({
      path,
      old_string: "const x = 1",
      new_string: "const x =", // syntactically broken
      skip_syntax_check: true,
    })
    expect(result.success).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("const x =\n")
  })

  it("does not block edits to files we don't validate (e.g. .py)", async () => {
    const path = join(dir, "any.py")
    writeFileSync(path, "x = 1\n")
    const tool = editFileTool()
    const result = await tool.handler({
      path,
      old_string: "x = 1",
      new_string: "def f(:", // would be invalid Python — but we don't validate .py
    })
    expect(result.success).toBe(true)
  })
})

describe("edit_file defaultCwd", () => {
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

  it("resolves relative paths against defaultCwd", async () => {
    writeFileSync(join(projectDir, "target.ts"), "const value = 'project'\n")
    writeFileSync(join(otherDir, "target.ts"), "const value = 'wrong'\n")
    const tool = editFileTool({ defaultCwd: projectDir })

    const result = await tool.handler({
      path: "target.ts",
      old_string: "'project'",
      new_string: "'edited'",
    })

    expect(result.success).toBe(true)
    expect(readFileSync(join(projectDir, "target.ts"), "utf-8")).toContain("'edited'")
    expect(readFileSync(join(otherDir, "target.ts"), "utf-8")).toContain("'wrong'")
  })
})

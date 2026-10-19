import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { searchFilesTool } from "../../builtin-tools/search.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-search-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("search_files default context", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("includes 2 lines before and after each match by default", async () => {
    const file = join(dir, "sample.ts")
    writeFileSync(file, [
      "line 1 setup",
      "line 2 setup",
      "line 3 setup",
      "line 4 TARGET here",
      "line 5 trailing",
      "line 6 trailing",
      "line 7 far away",
    ].join("\n"))
    const tool = searchFilesTool()
    const result = await tool.handler({ pattern: "TARGET", path: dir })
    expect(result.success).toBe(true)
    const out = result.output
    // Match line
    expect(out).toMatch(/sample\.ts:4.*TARGET/)
    // 2 lines before
    expect(out).toContain("line 2 setup")
    expect(out).toContain("line 3 setup")
    // 2 lines after
    expect(out).toContain("line 5 trailing")
    expect(out).toContain("line 6 trailing")
    // not 3 away (outside ±2 window)
    expect(out).not.toContain("line 7 far away")
    // not line 1 (outside ±2 window)
    expect(out).not.toContain("line 1 setup")
  })

  it("honors explicit context_lines: 0 for minimal output", async () => {
    const file = join(dir, "minimal.ts")
    writeFileSync(file, ["one", "TWO", "three"].join("\n"))
    const tool = searchFilesTool()
    const result = await tool.handler({ pattern: "TWO", path: dir, context_lines: 0 })
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/minimal\.ts:2.*TWO/)
    expect(result.output).not.toContain("one")
    expect(result.output).not.toContain("three")
  })

  it("treats a leading-dash pattern as data rather than a ripgrep option", async () => {
    writeFileSync(join(dir, "flags.txt"), "run --version here\n")
    const tool = searchFilesTool({ allowedPaths: [dir] })

    const result = await tool.handler({ pattern: "--version", path: dir, context_lines: 0 })

    expect(result.success).toBe(true)
    expect(result.output).toContain("flags.txt")
    expect(result.output).toContain("--version")
  })

  it("searches a single file instead of treating it as a directory", async () => {
    const file = join(dir, "vm.js")
    writeFileSync(file, ["const startup = true", "function runElf() {}", "runElf()"].join("\n"))
    const tool = searchFilesTool()

    const result = await tool.handler({ pattern: "runElf", path: file, context_lines: 0 })

    expect(result.success).toBe(true)
    expect(result.output).toContain("vm.js:2")
    expect(result.output).toContain("runElf")
  })
})

describe("search_files multiline mode", () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("matches a pattern that spans multiple lines", async () => {
    const file = join(dir, "fn.ts")
    writeFileSync(
      file,
      [
        "function compute(",
        "  a: number,",
        "  b: number,",
        "): number {",
        "  return a + b",
        "}",
        "",
        "// noise below",
      ].join("\n"),
    )
    const tool = searchFilesTool()
    const result = await tool.handler({
      pattern: "function compute\\([^)]*\\)",
      path: dir,
      multiline: true,
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain("fn.ts:1")
    expect(result.output).toContain("function compute(")
    // The match string itself (now on one line) contains the param list
    expect(result.output).toMatch(/a: number/)
  })

  it("does NOT match across newlines without multiline mode", async () => {
    const file = join(dir, "fn.ts")
    writeFileSync(
      file,
      [
        "function compute(",
        "  a: number,",
        ")",
      ].join("\n"),
    )
    const tool = searchFilesTool()
    const result = await tool.handler({
      pattern: "function compute\\([^)]*\\)",
      path: dir,
    })
    expect(result.success).toBe(true)
    // Without multiline, the pattern can't span — single-line scan finds nothing.
    expect(result.output).toBe("No matches found.")
  })

  it("captures all lines of a multi-line match block", async () => {
    const file = join(dir, "block.ts")
    writeFileSync(file, ["alpha", "BEGIN", "middle1", "middle2", "END", "tail"].join("\n"))
    const tool = searchFilesTool()
    // context_lines: 0 strips surrounding context so the assertion targets
    // match lines only (rg shows ±2 by default, which would let "alpha" in).
    const result = await tool.handler({
      pattern: "BEGIN.*END",
      path: dir,
      multiline: true,
      context_lines: 0,
    })
    expect(result.success).toBe(true)
    // rg emits each match line individually; the JS fallback emits one range
    // line. Either way BEGIN and END must appear, and surrounding lines must
    // not (they were not part of the match).
    expect(result.output).toContain("BEGIN")
    expect(result.output).toContain("END")
    expect(result.output).not.toContain("alpha")
    expect(result.output).not.toContain("tail")
  })
})

describe("search_files defaultCwd", () => {
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

  it("resolves relative search directories against defaultCwd", async () => {
    mkdirSync(join(projectDir, "src"), { recursive: true })
    mkdirSync(join(otherDir, "src"), { recursive: true })
    writeFileSync(join(projectDir, "src", "project.ts"), "PROJECT_ONLY\n")
    writeFileSync(join(otherDir, "src", "other.ts"), "PROJECT_ONLY\n")
    const tool = searchFilesTool({ defaultCwd: projectDir })

    const result = await tool.handler({
      pattern: "PROJECT_ONLY",
      path: "src",
      context_lines: 0,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain("project.ts")
    expect(result.output).not.toContain("other.ts")
  })
})

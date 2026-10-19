import { describe, it, expect } from "bun:test"
import { buildUnifiedDiff, buildDiffMeta } from "../../builtin-tools/diff-meta.js"

describe("buildUnifiedDiff", () => {
  it("emits a hunk with @@ headers for a simple change", () => {
    const out = buildUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", "test.txt")
    expect(out).toContain("@@")
    expect(out).toContain("-b")
    expect(out).toContain("+B")
  })

  it("returns empty string when inputs are identical", () => {
    const out = buildUnifiedDiff("same\n", "same\n", "x.txt")
    expect(out).toBe("")
  })

  it("strips jsdiff headers AND file-path lines — output is hunks only", () => {
    const out = buildUnifiedDiff("old\n", "new\n", "x.ts")
    expect(out).not.toMatch(/^Index:/)
    expect(out).not.toMatch(/^=+$/m)
    expect(out).not.toMatch(/^---\s/m)
    expect(out).not.toMatch(/^\+\+\+\s/m)
    expect(out).not.toContain("No newline at end of file")
    // First line should be the `@@` hunk header.
    expect(out.split("\n")[0]).toMatch(/^@@/)
  })

  it("strips octal-escaped non-ASCII paths from header — never leaks to UI", () => {
    const out = buildUnifiedDiff("a\n", "b\n", "/tmp/全球分析报告.md")
    // Without the strip, jsdiff would emit `--- "/tmp/\345\205\250..."`
    expect(out).not.toMatch(/\\3\d\d/)
    expect(out).not.toContain("全球分析报告")
  })
})

describe("buildDiffMeta size cap", () => {
  it("marks skipped=too_large when either side exceeds 1 MB", () => {
    const big = "x\n".repeat(600_000) // ~1.2 MB
    const meta = buildDiffMeta(big, big + "change\n", "huge.txt")
    expect(meta.skipped).toBe("too_large")
    expect(meta.diff).toBe("")
    expect(meta.oldBytes).toBeGreaterThan(1_000_000)
  })

  it("produces a real diff for files under the cap", () => {
    const meta = buildDiffMeta("hello\n", "hello world\n", "greet.txt")
    expect(meta.skipped).toBeUndefined()
    expect(meta.diff).toContain("+hello world")
  })
})

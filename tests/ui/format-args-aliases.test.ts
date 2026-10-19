import { describe, it, expect } from "bun:test"
import { formatToolCall, oneLine, truncateOutput } from "../../src/ui/transcript-format"

/**
 * Regression: Delegated CLI tools (Anthropic Claude code, codex) emit
 * tool_use blocks whose args use names that don't match zapcode's
 * builtin schemas — Anthropic Read/Write/Edit/MultiEdit/Glob all use
 * `file_path`, some legacy schemas use `filePath` or `file`. Without
 * normalizing those aliases, the transcript rendered `Read()` /
 * `Edit()` with empty parens. tool-use-summary.ts already coalesces
 * all four keys; the UI formatter was the only place still hard-wired
 * to `args.path`.
 */
describe("formatToolCall: path key aliases", () => {
  it("uses args.path for zapcode builtins", () => {
    expect(formatToolCall("read_file", { path: "src/foo.ts" })).toContain("src/foo.ts")
  })

  it("uses args.file_path for Anthropic Read", () => {
    const out = formatToolCall("Read", { file_path: "/Users/x/internal/jwt/jwt.go" })
    expect(out).toContain("jwt.go")
  })

  it("uses args.file_path for Anthropic Edit", () => {
    const out = formatToolCall("Edit", {
      file_path: "/tmp/foo.go",
      old_string: "x",
      new_string: "y",
    })
    expect(out).toContain("foo.go")
  })

  it("uses args.file_path for Anthropic Write", () => {
    expect(formatToolCall("Write", { file_path: "/tmp/new.go", content: "..." }))
      .toContain("new.go")
  })

  it("uses args.file_path for Anthropic MultiEdit", () => {
    expect(formatToolCall("MultiEdit", { file_path: "/tmp/multi.go", edits: [] }))
      .toContain("multi.go")
  })

  it("uses args.filePath legacy alias", () => {
    expect(formatToolCall("Read", { filePath: "/tmp/legacy.go" })).toContain("legacy.go")
  })

  it("uses args.file as last-resort alias", () => {
    expect(formatToolCall("Read", { file: "/tmp/x.go" })).toContain("x.go")
  })

  it("Glob still prefers pattern over file_path (search/glob branch)", () => {
    // Glob's pattern is the user-facing arg; file_path is just an
    // optional cwd override and shouldn't dominate the label.
    const out = formatToolCall("glob_files", { pattern: "**/*.ts", file_path: "/tmp" })
    expect(out).toContain("**/*.ts")
  })

  it("returns empty parens when no recognized arg is present", () => {
    expect(formatToolCall("UnknownTool", {})).toMatch(/\(\s*\)$/)
  })
})

describe("transcript formatting Unicode truncation", () => {
  it("does not truncate one-line previews when code units exceed the cap but code points fit", () => {
    const text = "😀".repeat(120)
    expect(oneLine(text, 120)).toBe(text)
  })

  it("truncates one-line previews without splitting non-BMP characters", () => {
    const out = oneLine("😀".repeat(121), 120)
    expect(out).toBe(`${"😀".repeat(119)}...`)
    expect(hasUnpairedSurrogate(out)).toBe(false)
  })

  it("does not clip transcript output lines when code units exceed the line cap but code points fit", () => {
    const text = "😀".repeat(200)
    const out = truncateOutput(text)
    expect(out.lines).toEqual([text])
    expect(out.truncated).toBe(false)
  })

  it("clips transcript output lines by Unicode character count", () => {
    const out = truncateOutput("😀".repeat(202))
    expect(out.lines).toEqual([`${"😀".repeat(200)} … +2c`])
    expect(hasUnpairedSurrogate(out.lines[0] ?? "")).toBe(false)
  })
})

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

it("renders steps-only bash calls", () => {
  expect(formatToolCall("bash", { check_steps: ["echo first", "echo second"] })).toContain("(echo first) && (echo second)")
})

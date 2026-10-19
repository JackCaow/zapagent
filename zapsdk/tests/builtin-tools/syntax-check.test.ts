import { describe, it, expect } from "bun:test"
import { validateSyntax } from "../../builtin-tools/syntax-check.js"

describe("validateSyntax: TypeScript", () => {
  it("accepts valid TS", () => {
    const r = validateSyntax("a.ts", "const x: number = 1\nfunction f() { return x }\n")
    expect(r.ok).toBe(true)
  })

  it("rejects unbalanced braces in TS with line/column info", () => {
    const r = validateSyntax("a.ts", "function f() { return 1\n")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/Syntax error at line \d+, column \d+/)
    }
  })

  it("rejects unbalanced parens in TS", () => {
    const r = validateSyntax("a.ts", "const x = (1 + 2\n")
    expect(r.ok).toBe(false)
  })

  it("rejects an unterminated string", () => {
    const r = validateSyntax("a.ts", 'const x = "hello\n')
    expect(r.ok).toBe(false)
  })

  it("accepts valid TSX with JSX", () => {
    const r = validateSyntax("c.tsx", "const x = <div>hello</div>\n")
    expect(r.ok).toBe(true)
  })

  it("rejects malformed TSX", () => {
    const r = validateSyntax("c.tsx", "const x = <div>hello</span>\n")
    expect(r.ok).toBe(false)
  })

  it("does NOT reject a type error (out of scope for syntax check)", () => {
    // `'1'` to a number-typed slot is a type error, not a syntax error.
    // validateSyntax must let this through — type checking is a separate pass.
    const r = validateSyntax("a.ts", "const x: number = '1'\n")
    expect(r.ok).toBe(true)
  })
})

describe("validateSyntax: JavaScript", () => {
  it("accepts valid JS", () => {
    const r = validateSyntax("a.js", "const x = 1\n")
    expect(r.ok).toBe(true)
  })

  it("rejects bad JS", () => {
    const r = validateSyntax("a.js", "function f( {\n")
    expect(r.ok).toBe(false)
  })

  it("accepts JSX in .jsx", () => {
    const r = validateSyntax("a.jsx", "const x = <Foo bar={1} />\n")
    expect(r.ok).toBe(true)
  })
})

describe("validateSyntax: JSON", () => {
  it("accepts valid JSON", () => {
    const r = validateSyntax("a.json", '{"a": 1, "b": [2, 3]}')
    expect(r.ok).toBe(true)
  })

  it("rejects JSON with trailing comma", () => {
    const r = validateSyntax("a.json", '{"a": 1,}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Invalid JSON")
  })

  it("rejects JSON with single quotes", () => {
    const r = validateSyntax("a.json", "{'a': 1}")
    expect(r.ok).toBe(false)
  })
})

describe("validateSyntax: unsupported extensions skip", () => {
  it("skips Python files (no parser available here)", () => {
    const r = validateSyntax("a.py", "def f(:\n  bad\n")
    expect(r.ok).toBe(true)
  })

  it("skips files with no extension", () => {
    const r = validateSyntax("Makefile", "garbage content :: invalid")
    expect(r.ok).toBe(true)
  })

  it("skips markdown", () => {
    const r = validateSyntax("README.md", "# heading\n\n```not-real-code")
    expect(r.ok).toBe(true)
  })
})

import { describe, it, expect } from "bun:test"
import { nearestLines, renderNearestLines } from "../../builtin-tools/edit-helpers.js"

describe("nearestLines", () => {
  it("returns empty list for empty needle", () => {
    expect(nearestLines("", "abc\ndef\n")).toEqual([])
    expect(nearestLines("   \n  ", "abc\ndef\n")).toEqual([])
  })

  it("finds the closest line by Levenshtein distance", () => {
    const haystack = [
      "const foo = 1",
      "const bar = 2",
      "const baz = 3",
      "totally unrelated thing here",
    ].join("\n")
    const out = nearestLines("const fox = 1", haystack, 3)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].line).toBe(1)
    expect(out[0].distance).toBe(1) // o → x
    expect(out[0].content).toBe("const foo = 1")
  })

  it("picks the smallest-distance line when several are similar", () => {
    const haystack = ["abcdefg", "abcdefz", "abcdxyz", "qqqqqq"].join("\n")
    const out = nearestLines("abcdefg", haystack, 3)
    expect(out[0].line).toBe(1)
    expect(out[0].distance).toBe(0)
    expect(out[1].distance).toBe(1)
  })

  it("ignores lines way outside the length band (cheap pre-filter)", () => {
    const huge = "x".repeat(500)
    const tiny = "x"
    const target = "abc"
    const haystack = [huge, tiny, "abx", target].join("\n")
    const out = nearestLines("abc", haystack, 5)
    // Both `huge` and `tiny` are filtered by the length band; we should see
    // the close matches and not hit the band-rejected lines.
    const lines = out.map((m) => m.content)
    expect(lines).not.toContain("x")
    expect(lines).not.toContain(huge)
    // The exact match must appear and be ranked first.
    expect(out[0].content).toBe("abc")
    expect(out[0].distance).toBe(0)
  })

  it("uses only the needle's first non-empty line for matching", () => {
    const haystack = ["function foo() {", "  body();", "}"].join("\n")
    const needle = "\n\nfunction fou() {\n  body();\n}\n"
    const out = nearestLines(needle, haystack, 3)
    expect(out[0].line).toBe(1)
    expect(out[0].content).toBe("function foo() {")
    expect(out[0].distance).toBe(1)
  })

  it("trims candidate line content before comparing", () => {
    const haystack = "    indented match here\nother\n"
    const out = nearestLines("indented match here", haystack, 1)
    expect(out[0].distance).toBe(0)
    expect(out[0].content).toBe("indented match here")
  })

  it("drops candidates farther than the half-length ceiling", () => {
    // needle length 10 → ceiling = 5. A line with distance 8 must NOT appear.
    const haystack = "abcdefghij\nzzzzzzzzzz\n"
    const out = nearestLines("abcdefghij", haystack, 5)
    expect(out.find((m) => m.content === "zzzzzzzzzz")).toBeUndefined()
  })

  it("limits the result count to n", () => {
    const haystack = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n")
    const out = nearestLines("line 09", haystack, 3)
    expect(out.length).toBe(3)
  })
})

describe("renderNearestLines", () => {
  it("returns empty string for empty input", () => {
    expect(renderNearestLines([])).toBe("")
  })

  it("renders one match per line with distance and JSON-quoted content", () => {
    const out = renderNearestLines([
      { line: 5, content: "const x = 1", distance: 0 },
      { line: 10, content: "const x = 2", distance: 1 },
    ])
    expect(out).toContain("Closest candidates in file:")
    expect(out).toContain("line 5 (0 chars off):")
    expect(out).toContain("line 10 (1 char off):")
    expect(out).toContain('"const x = 1"')
  })
})

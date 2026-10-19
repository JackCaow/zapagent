import { describe, it, expect } from "bun:test"
import { displayWidth, truncateToWidth } from "../../src/ui/truncate"

describe("displayWidth", () => {
  it("returns 0 for empty", () => {
    expect(displayWidth("")).toBe(0)
  })

  it("counts ASCII as 1 cell each", () => {
    expect(displayWidth("hello")).toBe(5)
  })

  it("counts CJK as 2 cells each", () => {
    expect(displayWidth("你好")).toBe(4)
    expect(displayWidth("你好world")).toBe(9) // 2+2+5
  })

  it("counts emoji as 2 cells", () => {
    expect(displayWidth("⚡")).toBe(1) // U+26A1 lightning is in BMP, treated as 1 here
    expect(displayWidth("🎉")).toBe(2)
  })
})

describe("truncateToWidth", () => {
  it("returns input unchanged when within budget", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello")
    expect(truncateToWidth("你好", 10)).toBe("你好")
  })

  it("returns input unchanged when exactly at budget", () => {
    expect(truncateToWidth("hello", 5)).toBe("hello")
  })

  it("truncates ASCII with ellipsis", () => {
    expect(truncateToWidth("abcdefghij", 5)).toBe("abcd…")
  })

  it("truncates CJK respecting cell width", () => {
    // 6 cells available minus 1 for ellipsis = 5 cells of content.
    // Chinese chars are 2 cells; can fit 2 chars (4 cells), then "…" makes 5.
    // Result width: 4 + 1 = 5 ≤ 6.
    expect(truncateToWidth("你好世界", 6)).toBe("你好…")
  })

  it("does not split a wide char across budget boundary", () => {
    // 4 cells: ellipsis takes 1, leaves 3. "你" (2) fits, "好" (2 more) doesn't.
    expect(truncateToWidth("你好世界", 4)).toBe("你…")
  })

  it("returns ellipsis only when budget is exactly its width", () => {
    expect(truncateToWidth("abcdef", 1)).toBe("…")
  })

  it("returns empty when maxWidth is 0", () => {
    expect(truncateToWidth("abc", 0)).toBe("")
  })

  it("handles mixed CJK + ASCII", () => {
    // budget = 10 - 1(ellipsis) = 9; CJK chars consume 2, space 1.
    // 4×CJK (8) + " " (1) = 9; next "l" would push to 10 → stops here.
    expect(truncateToWidth("帮我实现 llm provider 网关", 10)).toBe("帮我实现 …")
  })
})

import { describe, it, expect } from "bun:test"
import { extractAtQuery, replaceAtToken } from "../src/utils/file-completer.js"

describe("file completer @ token formatting", () => {
  it("leaves plain selected paths unquoted", () => {
    expect(replaceAtToken("inspect @sr", "src/App.tsx")).toBe("inspect @src/App.tsx ")
  })

  it("quotes selected paths containing spaces", () => {
    expect(replaceAtToken("inspect @My", "My File.txt")).toBe('inspect @"My File.txt" ')
  })

  it("keeps quoted directory selections open for drill-down typing", () => {
    const next = replaceAtToken("inspect @Dir", "Dir With Spaces/")

    expect(next).toBe('inspect @"Dir With Spaces/')
    expect(extractAtQuery(`${next}child`)).toBe("Dir With Spaces/child")
  })

  it("escapes quotes inside quoted selected paths", () => {
    expect(replaceAtToken("inspect @", 'a "quote".ts')).toBe('inspect @"a \\"quote\\".ts" ')
  })

  it("extracts an in-progress quoted query", () => {
    expect(extractAtQuery('inspect @"My File')).toBe("My File")
  })

  it("unescapes quoted query escapes for matching", () => {
    expect(extractAtQuery('inspect @"a \\"quote')).toBe('a "quote')
  })
})

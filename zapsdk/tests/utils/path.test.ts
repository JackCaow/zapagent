import { describe, it, expect } from "bun:test"
import { homedir } from "node:os"
import { expandHome, rewriteDevNullRedirects } from "../../utils/path.js"

describe("expandHome", () => {
  const home = homedir()

  it("expands bare ~", () => {
    expect(expandHome("~")).toBe(home)
  })

  it("expands ~/subpath", () => {
    expect(expandHome("~/workspace/llm-wrapper")).toBe(`${home}/workspace/llm-wrapper`)
  })

  it("leaves absolute paths unchanged", () => {
    expect(expandHome("/usr/local/bin")).toBe("/usr/local/bin")
  })

  it("leaves relative paths unchanged", () => {
    expect(expandHome("src/index.ts")).toBe("src/index.ts")
  })

  it("does not expand mid-path ~", () => {
    expect(expandHome("./foo/~/bar")).toBe("./foo/~/bar")
  })

  it("does not expand ~user form", () => {
    expect(expandHome("~alice/foo")).toBe("~alice/foo")
  })

  it("passes through empty string", () => {
    expect(expandHome("")).toBe("")
  })
})

// rewriteDevNullRedirects is the pure form of pathConverter.sanitizeDevNull.
// We test it directly (instead of the bound class method) because the bound
// method's devNull depends on host platform, which would make these tests
// no-ops on macOS/Linux where CI runs.
describe("rewriteDevNullRedirects", () => {
  it("rewrites `> /dev/null` to `> NUL`", () => {
    expect(rewriteDevNullRedirects("cmd > /dev/null 2>&1", "NUL"))
      .toBe("cmd > NUL 2>&1")
  })

  it("rewrites `2>/dev/null` (no space) to `2> NUL`", () => {
    expect(rewriteDevNullRedirects("x 2>/dev/null", "NUL")).toBe("x 2> NUL")
  })

  it("rewrites bash `&> /dev/null`", () => {
    expect(rewriteDevNullRedirects("cmd &> /dev/null", "NUL")).toBe("cmd &> NUL")
  })

  it("rewrites stdin redirect `</dev/null`", () => {
    expect(rewriteDevNullRedirects("a </dev/null", "NUL")).toBe("a < NUL")
  })

  it("rewrites append `2>>/dev/null`", () => {
    expect(rewriteDevNullRedirects("cmd 2>>/dev/null", "NUL")).toBe("cmd 2>> NUL")
  })

  it("does NOT touch quoted literal /dev/null", () => {
    expect(rewriteDevNullRedirects('echo "/dev/null"', "NUL"))
      .toBe('echo "/dev/null"')
  })

  it("does NOT touch /dev/null used as a positional argument (no redirect op)", () => {
    expect(rewriteDevNullRedirects("cat /dev/null", "NUL")).toBe("cat /dev/null")
  })

  it("survives chained commands — only the redirect rewrites", () => {
    expect(rewriteDevNullRedirects("a 2>/dev/null && b", "NUL"))
      .toBe("a 2> NUL && b")
  })

  it("is a no-op when devNull is /dev/null (Unix host)", () => {
    expect(rewriteDevNullRedirects("anything > /dev/null", "/dev/null"))
      .toBe("anything > /dev/null")
  })
})

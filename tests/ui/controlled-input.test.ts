import { describe, expect, it } from "bun:test"
import {
  commandInput,
  isNewlineInput,
  isReturnInput,
  normalizePlainPasteInput,
  textBeforeReturn,
} from "../../src/ui/controlled-input.js"

describe("isReturnInput", () => {
  it("recognizes Ink's normalized return key flag", () => {
    expect(isReturnInput("", { return: true })).toBe(true)
  })

  it("recognizes raw CR enter bytes from terminal automation", () => {
    expect(isReturnInput("\r", {})).toBe(true)
    expect(isReturnInput("/status\r", {})).toBe(true)
  })

  it("does not classify printable input as Enter", () => {
    expect(isReturnInput("x", {})).toBe(false)
  })

  it("leaves LF available for Shift+Enter newline insertion", () => {
    expect(isReturnInput("\n", {})).toBe(false)
  })

  it("extracts text before a coalesced raw CR submit", () => {
    expect(textBeforeReturn("/status\r")).toBe("/status")
    expect(textBeforeReturn("abc\rdef")).toBe("abc")
    expect(textBeforeReturn("abc")).toBe("abc")
  })
})

describe("isNewlineInput", () => {
  it("recognizes normalized LF and modified Return", () => {
    expect(isNewlineInput("\n", {})).toBe(true)
    expect(isNewlineInput("\r", { return: true, shift: true })).toBe(true)
    expect(isNewlineInput("\r", { return: true, meta: true })).toBe(true)
  })

  it("recognizes Ink's fallback shape for xterm modifyOtherKeys", () => {
    expect(isNewlineInput("[27;2;13~", { shift: true })).toBe(true)
  })

  it("leaves ordinary Return for submit", () => {
    expect(isNewlineInput("\r", { return: true })).toBe(false)
  })
})

describe("commandInput", () => {
  it("extracts a coalesced command key before raw return", () => {
    expect(commandInput("d\r", {})).toBe("d")
    expect(commandInput("n\r", {})).toBe("n")
  })

  it("preserves space as a command key before raw return", () => {
    expect(commandInput(" \r", {})).toBe(" ")
  })

  it("leaves plain command input unchanged", () => {
    expect(commandInput("c", {})).toBe("c")
  })

  it("strips CR/LF from command input defensively", () => {
    expect(commandInput("q\n", {})).toBe("q")
  })
})

describe("normalizePlainPasteInput", () => {
  it("normalizes CRLF blobs from non-bracketed paste into inserted newlines", () => {
    expect(normalizePlainPasteInput("first\r\nsecond\r\nthird", {}))
      .toBe("first\nsecond\nthird")
  })

  it("normalizes CR-only multiline blobs from non-bracketed paste", () => {
    expect(normalizePlainPasteInput("first\rsecond\rthird", {}))
      .toBe("first\nsecond\nthird")
  })

  it("recognizes LF-only multiline blobs from non-bracketed paste", () => {
    expect(normalizePlainPasteInput("first\nsecond\nthird", {}))
      .toBe("first\nsecond\nthird")
  })

  it("recognizes long single-line blobs from non-bracketed paste", () => {
    const pasted = "single-line pasted payload ".repeat(12)
    expect(normalizePlainPasteInput(pasted, {})).toBe(pasted)
  })

  it("recognizes short terminal selections with boundary padding", () => {
    expect(normalizePlainPasteInput("      copied transcript row      ", {}))
      .toBe("      copied transcript row      ")
  })

  it("does not submit a padded terminal selection ending in raw CR", () => {
    expect(normalizePlainPasteInput("      copied transcript row      \r", {}))
      .toBe("      copied transcript row      \n")
  })

  it("leaves short multi-codepoint input on the ordinary insertion path", () => {
    expect(normalizePlainPasteInput("中文输入", {})).toBeNull()
    expect(normalizePlainPasteInput("😀".repeat(199), {})).toBeNull()
  })

  it("does not treat terminal escape sequences as pasted text", () => {
    expect(normalizePlainPasteInput(`\x1b[${"1".repeat(40)}`, {})).toBeNull()
  })

  it("does not intercept an actual Enter key event", () => {
    expect(normalizePlainPasteInput("\r", { return: true })).toBeNull()
    expect(normalizePlainPasteInput("prefix\r", { return: true })).toBeNull()
  })

  it("never submits a multi-character unframed paste ending in raw CR", () => {
    expect(normalizePlainPasteInput("/status\r", {})).toBe("/status\n")
  })
})

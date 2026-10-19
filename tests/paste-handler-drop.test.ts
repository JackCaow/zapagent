import { describe, it, expect } from "bun:test"
import {
  __test,
  normalizePasteForInsertion,
  normalizeTextPaste,
} from "../src/hooks/usePasteHandler"
import { shouldFoldPastedText } from "../src/utils/pastedPlaceholder.js"

const { looksLikeDroppedPath, insertPasteText } = __test

describe("normalizeTextPaste", () => {
  it("removes terminal selection padding from a copied transcript line", () => {
    expect(normalizeTextPaste(
      "\r\n      Loaded image /Users/example/qrcode.png (image/png, 9.7 KB).      \r\n",
    )).toBe("Loaded image /Users/example/qrcode.png (image/png, 9.7 KB).")
  })

  it("preserves intentional single-line indentation and trailing whitespace", () => {
    expect(normalizeTextPaste("    return value    "))
      .toBe("    return value    ")
  })

  it("trims an unframed row only when the classifier tags selection padding", () => {
    expect(normalizeTextPaste("    copied row    ", { trimBoundaryPadding: true }))
      .toBe("copied row")
  })

  it("preserves a leading LF coalesced with text after Shift+Enter", () => {
    expect(normalizeTextPaste("\nafter", { boundaryRows: "none" }))
      .toBe("\nafter")
  })

  it("removes only a synthetic trailing row from an unframed CR paste", () => {
    expect(normalizeTextPaste("copied row\n", { boundaryRows: "trailing" }))
      .toBe("copied row")
  })

  it("preserves multiline code boundary rows and indentation", () => {
    expect(normalizeTextPaste(
      "\n    if (ready) {\n      run()\n    }\n\t\n",
    )).toBe("\n    if (ready) {\n      run()\n    }\n\t\n")
  })

  it("normalizes CR-only multiline text without dropping boundary rows", () => {
    expect(normalizeTextPaste("\r  first\r    second\r"))
      .toBe("\n  first\n    second\n")
  })

  it("turns whitespace-only selection payloads into an empty paste", () => {
    expect(normalizeTextPaste(" \t\r\n  \n")).toBe("")
  })
})

describe("normalizePasteForInsertion", () => {
  const bracketed = {
    source: "bracketed" as const,
    trimBoundaryPadding: false,
    stripTrailingBoundaryRows: false,
  }

  it("removes Apple Terminal's final row boundary from a copied display line", () => {
    expect(normalizePasteForInsertion(
      "• 安吉确实比上海凉，但不是所有地方都凉——城区 26℃ 左右\r\n",
      bracketed,
    )).toBe("• 安吉确实比上海凉，但不是所有地方都凉——城区 26℃ 左右")
  })

  it("preserves multiline bracketed paste boundaries and indentation", () => {
    const code = "  const first = 1\n  const second = 2\n"
    expect(normalizePasteForInsertion(code, bracketed)).toBe(code)
  })

  it("preserves a leading blank row instead of treating it as a selection frame", () => {
    expect(normalizePasteForInsertion("\nindented later\n", bracketed))
      .toBe("\nindented later\n")
  })
})

describe("looksLikeDroppedPath", () => {
  it("recognises bare absolute paths", () => {
    expect(looksLikeDroppedPath("/Users/x/foo.pdf")).toBe(true)
    expect(looksLikeDroppedPath("/etc/hosts")).toBe(true)
  })

  it("recognises home-prefixed paths", () => {
    expect(looksLikeDroppedPath("~/Downloads/report.txt")).toBe(true)
  })

  it("recognises paths with shell-escaped spaces (Finder default)", () => {
    expect(looksLikeDroppedPath("/Users/x/My\\ File.pdf")).toBe(true)
  })

  it("recognises quoted-wrapped paths", () => {
    expect(looksLikeDroppedPath("'/Users/x/My File.pdf'")).toBe(true)
    expect(looksLikeDroppedPath('"/Users/x/foo.txt"')).toBe(true)
  })

  it("rejects multi-line blobs (code pastes)", () => {
    expect(looksLikeDroppedPath("/Users/x\nshould not match")).toBe(false)
  })

  it("rejects CR-only multi-line blobs", () => {
    expect(looksLikeDroppedPath("/Users/x\rshould not match")).toBe(false)
  })

  it("rejects relative paths / non-leading-slash text", () => {
    expect(looksLikeDroppedPath("foo/bar.pdf")).toBe(false)
    expect(looksLikeDroppedPath("./relative")).toBe(false)
  })

  it("rejects empty / whitespace", () => {
    expect(looksLikeDroppedPath("")).toBe(false)
    expect(looksLikeDroppedPath("   ")).toBe(false)
  })

  it("rejects URLs (they have :// but don't start with /)", () => {
    expect(looksLikeDroppedPath("https://github.com/foo/bar")).toBe(false)
  })

  it("rejects code lines that contain a backslash-space (not a path)", () => {
    expect(looksLikeDroppedPath("const re = /\\s+/")).toBe(false)
  })

  it("rejects oversize text (paste of huge code block)", () => {
    const huge = "/" + "x".repeat(5000)
    expect(looksLikeDroppedPath(huge)).toBe(false)
  })
})

describe("insertPasteText", () => {
  it("uses cursor-aware insertion when Prompt provides a paste context", () => {
    let inserted = ""
    let setCalls = 0
    let epochCalls = 0

    insertPasteText("[Pasted #1 · 5 lines · 240 chars]", {
      ctx: {
        value: "before after",
        cursorOffset: "before ".length,
        insertText: (text) => { inserted = text },
      },
      setInputValue: () => { setCalls++ },
      bumpInputEpoch: () => { epochCalls++ },
    })

    expect(inserted).toBe("[Pasted #1 · 5 lines · 240 chars]")
    expect(setCalls).toBe(0)
    expect(epochCalls).toBe(0)
  })

  it("falls back to append plus epoch bump for legacy callers", () => {
    let value = "before "
    let epochCalls = 0

    insertPasteText("after", {
      setInputValue: (next) => {
        value = typeof next === "function" ? next(value) : next
      },
      bumpInputEpoch: () => { epochCalls++ },
    })

    expect(value).toBe("before after")
    expect(epochCalls).toBe(1)
  })
})

describe("shouldFoldPastedText", () => {
  it("uses shared logical-line and Unicode character thresholds", () => {
    expect(shouldFoldPastedText("one\ntwo\nthree\nfour")).toBe(false)
    expect(shouldFoldPastedText("one\ntwo\nthree\nfour\nfive")).toBe(true)
    expect(shouldFoldPastedText("😀".repeat(199))).toBe(false)
    expect(shouldFoldPastedText("😀".repeat(200))).toBe(true)
  })
})

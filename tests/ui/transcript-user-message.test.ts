import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import {
  UserMessage,
  foldLongUserMessageForDisplay,
  userMessageDisplayText,
} from "../../src/ui/Transcript.js"

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("UserMessage", () => {
  it("renders a compact submitted-prompt row without terminal-width padding", () => {
    const output = renderToString(createElement(UserMessage, {
      log: { id: 1, type: "user", text: "hello" },
    }), { columns: 120 })
    const row = stripAnsi(output).split("\n").find(line => line.includes("hello"))

    expect(row).toBe("› hello")
  })

  it("uses a shell marker while preserving command display semantics", () => {
    const output = renderToString(createElement(UserMessage, {
      log: { id: 1, type: "user", text: "!pwd" },
    }), { columns: 120 })
    const row = stripAnsi(output).split("\n").find(line => line.includes("pwd"))

    expect(row).toBe("$ pwd")
  })

  it("aligns multiline continuation text under the message body", () => {
    const output = renderToString(createElement(UserMessage, {
      log: { id: 1, type: "user", text: "first\nsecond" },
    }), { columns: 120 })
    const rows = stripAnsi(output).split("\n").filter(Boolean)

    expect(rows).toEqual(["› first", "  second"])
  })
})

describe("userMessageDisplayText", () => {
  it("renders restoreText instead of compact paste placeholders", () => {
    const text = userMessageDisplayText({
      text: "[Pasted #1 · 3 lines · 42 chars]",
      restoreText: "first line\nsecond line\nthird line",
    })

    expect(text).toBe("first line\nsecond line\nthird line")
  })

  it("preserves restoreText leading and trailing whitespace for long pastes", () => {
    const text = userMessageDisplayText({
      text: "[Pasted #1 · 4 lines · 32 chars]",
      restoreText: "\n  first line\n  second line\n",
    })

    expect(text).toBe("\n  first line\n  second line\n")
  })

  it("normalizes carriage returns for terminal display without dropping pasted lines", () => {
    const text = userMessageDisplayText({
      text: "[Pasted #1 · 3 lines · 32 chars]",
      restoreText: "first line\r\nsecond line\rthird line",
    })

    expect(text).toBe("first line\nsecond line\nthird line")
    expect(text).not.toContain("\r")
  })

  it("does not treat expanded pasted text starting with bang as a shell command", () => {
    const text = userMessageDisplayText({
      text: "[Pasted #1 · 2 lines · 28 chars]",
      restoreText: "!important\nkeep the leading bang",
    })

    expect(text).toBe("!important\nkeep the leading bang")
  })

  it("keeps shell command display without the leading bang", () => {
    expect(userMessageDisplayText({ text: "!pwd" })).toBe("pwd")
  })

  it("trims only command wrapper whitespace for shell command display", () => {
    expect(userMessageDisplayText({ text: "  !pwd  \n" })).toBe("pwd")
  })

  it("renders shell restoreText instead of compact paste placeholders", () => {
    const text = userMessageDisplayText({
      text: "![Pasted #1 · 3 lines · 42 chars]",
      restoreText: "!printf 'first line\\nsecond line\\nthird line'",
    })

    expect(text).toBe("printf 'first line\\nsecond line\\nthird line'")
  })

  it("folds very long pasted user text with an explicit preservation notice", () => {
    const full = Array.from({ length: 140 }, (_, i) => `line ${i + 1}`).join("\n")

    const text = userMessageDisplayText({
      text: "[Pasted #1 · 140 lines · 1171 chars]",
      restoreText: full,
    })

    expect(text.split("\n")[0]).toContain("display folded only")
    expect(text.split("\n")[0]).toContain("full 140 lines,")
    expect(text.split("\n")[0]).toContain("was sent and preserved")
    expect(text).toContain("line 1")
    expect(text).toContain("line 140")
    expect(text).toContain("display folded only: 30 lines omitted")
    expect(text).toContain("[... 30 lines omitted from display here ...]")
    expect(text).toContain("preserved in session/model context")
    expect(text).toContain("use /copy-input to copy exact input")
    expect(text).not.toContain("line 90")
    expect(text.indexOf("line 80")).toBeLessThan(text.indexOf("[... 30 lines omitted from display here ...]"))
    expect(text.indexOf("[... 30 lines omitted from display here ...]")).toBeLessThan(text.indexOf("line 111"))
  })

  it("folds CRLF pasted user text by logical display lines", () => {
    const full = Array.from({ length: 140 }, (_, i) => `line ${i + 1}`).join("\r\n")

    const text = userMessageDisplayText({
      text: "[Pasted #1 · 140 lines · 1310 chars]",
      restoreText: full,
    })

    expect(text.split("\n")[0]).toContain("display folded only")
    expect(text).toContain("full 140 lines")
    expect(text).toContain("line 1")
    expect(text).toContain("line 140")
    expect(text).not.toContain("\r")
  })
})

describe("foldLongUserMessageForDisplay", () => {
  it("leaves ordinary messages unchanged", () => {
    expect(foldLongUserMessageForDisplay("short\nmessage")).toBe("short\nmessage")
  })

  it("folds a single very long line by characters", () => {
    const text = `start-${"x".repeat(25_000)}-end`
    const folded = foldLongUserMessageForDisplay(text)

    expect(folded).toContain("start-")
    expect(folded).toContain("-end")
    expect(folded.split("\n")[0]).toContain("display folded only")
    expect(folded).toContain("display folded only: 7010 chars omitted")
    expect(folded).toContain("[... 7010 chars omitted from display here ...]")
    expect(folded).toContain("was sent and preserved")
    expect(folded).toContain("preserved in session/model context")
    expect(folded).toContain("use /copy-input to copy exact input")
    expect(folded.length).toBeLessThan(text.length)
  })

  it("does not fold non-BMP text just because code units exceed the character cap", () => {
    const text = "😀".repeat(12_001)

    const display = foldLongUserMessageForDisplay(text)

    expect(text.length).toBeGreaterThan(24_000)
    expect(display).toBe(text)
  })

  it("keeps line folding when folded non-BMP display fits by code point count", () => {
    const text = Array.from({ length: 140 }, () => "😀".repeat(120)).join("\n")

    const folded = foldLongUserMessageForDisplay(text)

    expect(folded.split("\n")[0]).toContain("display folded only")
    expect(folded).toContain("display folded only: 30 lines omitted")
    expect(folded).toContain("[... 30 lines omitted from display here ...]")
    expect(folded).not.toContain("chars omitted")
    expect(hasUnpairedSurrogate(folded)).toBe(false)
  })

  it("does not split non-BMP characters when folding a very long line", () => {
    const emoji = "😀"
    const text = [
      "a".repeat(11_999),
      emoji,
      "b".repeat(25_000),
      emoji,
      "c".repeat(5_999),
    ].join("")

    const folded = foldLongUserMessageForDisplay(text)

    expect(folded).toContain("display folded only")
    expect(hasUnpairedSurrogate(folded)).toBe(false)
  })

  it("keeps folded display tail within budget at surrogate boundaries", () => {
    const boundaryEmoji = "🧪"
    const text = [
      "head".repeat(4_625),
      boundaryEmoji,
      "tail".repeat(1_499),
      "tai",
    ].join("")

    const folded = foldLongUserMessageForDisplay(text)

    expect(folded).toContain("display folded only")
    expect(folded).toContain("tailtailtail")
    expect(folded).toContain(boundaryEmoji)
    expect(hasUnpairedSurrogate(folded)).toBe(false)
  })

  it("reports folded non-BMP character counts by code point", () => {
    const text = [
      "a".repeat(12_000),
      "😀",
      "b".repeat(20_000),
      "😀",
      "c".repeat(6_000),
    ].join("")

    const folded = foldLongUserMessageForDisplay(text)

    expect(folded.split("\n")[0]).toContain("full 38002 chars")
    expect(folded).toContain("display folded only: 20002 chars omitted")
    expect(folded).toContain("[... 20002 chars omitted from display here ...]")
    expect(hasUnpairedSurrogate(folded)).toBe(false)
  })

  it("keeps a hard character cap even when many lines are individually long", () => {
    const text = Array.from({ length: 140 }, (_, i) => `line-${i}-${"x".repeat(1000)}`).join("\n")
    const folded = foldLongUserMessageForDisplay(text)

    expect(folded.split("\n")[0]).toContain("display folded only")
    expect(folded).toContain("chars omitted")
    expect(folded).toContain("was sent and preserved")
    expect(folded).toContain("preserved in session/model context")
    expect(folded).toContain("use /copy-input to copy exact input")
    expect(folded.length).toBeLessThan(19_000)
    expect(folded.length).toBeLessThan(text.length)
  })
})

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

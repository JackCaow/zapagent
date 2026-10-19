import { describe, it, expect } from "bun:test"
import { __test } from "../../src/ui/markdown"

const { parseBlocks, parseAlignRow, looksLikeTableRow, flattenRuns, wrapAtoms, parseInline } = __test

// Convenience: total visual width of an atom line.
function atomsWidth(line: Array<{ value: string }>): number {
  let w = 0
  for (const a of line) {
    // Ascii-only test data here; length === displayWidth for the strings used.
    for (const ch of a.value) w += /[一-鿿＀-￿]/.test(ch) ? 2 : 1
  }
  return w
}
function plainOf(line: Array<{ value: string }>): string {
  return line.map(a => a.value).join("")
}

describe("markdown table sniff", () => {
  it("recognises a basic GFM table", () => {
    const src = [
      "| 配置 | 价格 | 备注 |",
      "| ---- | ---- | ---- |",
      "| 2核2G | 68元/年 | 推荐 |",
      "| 2核4G | 188元/年 | 够用 |",
    ].join("\n")
    const blocks = parseBlocks(src)
    expect(blocks.length).toBe(1)
    const t = blocks[0] as { kind: "table"; header: string[]; rows: string[][]; align: string[] }
    expect(t.kind).toBe("table")
    expect(t.header).toEqual(["配置", "价格", "备注"])
    expect(t.rows.length).toBe(2)
    expect(t.rows[0]).toEqual(["2核2G", "68元/年", "推荐"])
  })

  it("parses align colons", () => {
    expect(parseAlignRow("| :--- | :---: | ---: |")).toEqual(["left", "center", "right"])
    expect(parseAlignRow("| --- | --- |")).toEqual(["default", "default"])
  })

  it("rejects align row with non-dash content", () => {
    expect(parseAlignRow("| --- | hello |")).toBeNull()
    expect(parseAlignRow("| -- | --- |")).toBeNull()  // too few dashes
  })

  it("does not misidentify plain text with a pipe", () => {
    const src = [
      "a | b is a logic OR",
      "this is normal text",
    ].join("\n")
    const blocks = parseBlocks(src)
    expect(blocks[0].kind).toBe("p")
  })

  it("pads ragged rows to the widest column count", () => {
    const src = [
      "| a | b | c |",
      "| --- | --- | --- |",
      "| 1 | 2 |",
      "| 1 | 2 | 3 | 4 |",
    ].join("\n")
    const blocks = parseBlocks(src)
    const t = blocks[0] as { kind: "table"; rows: string[][]; align: string[] }
    expect(t.align.length).toBe(4)
    expect(t.rows[0]).toEqual(["1", "2", "", ""])
    expect(t.rows[1]).toEqual(["1", "2", "3", "4"])
  })

  it("stops the row run at a blank line", () => {
    const src = [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "后续段落",
    ].join("\n")
    const blocks = parseBlocks(src)
    expect(blocks.length).toBe(3)
    expect(blocks[0].kind).toBe("table")
    expect(blocks[1].kind).toBe("blank")
    expect(blocks[2].kind).toBe("p")
  })

  it("accepts a table with no outer pipes", () => {
    const src = [
      "a | b",
      "--- | ---",
      "1 | 2",
    ].join("\n")
    const blocks = parseBlocks(src)
    expect(blocks[0].kind).toBe("table")
    const t = blocks[0] as { kind: "table"; header: string[]; rows: string[][] }
    expect(t.header).toEqual(["a", "b"])
    expect(t.rows[0]).toEqual(["1", "2"])
  })

  it("looksLikeTableRow needs at least 2 cells", () => {
    expect(looksLikeTableRow("| one |")).toBe(false)
    expect(looksLikeTableRow("| one | two |")).toBe(true)
    expect(looksLikeTableRow("no pipe here")).toBe(false)
  })
})

describe("flattenRuns", () => {
  it("converts text + code + bold + italic + link to atoms with style flags", () => {
    const atoms = flattenRuns(parseInline("a **b** *i* `c` [d](https://e.com)"))
    // Expect 8 atoms: text "a ", bold "b", text " ", italic "i", text " ",
    // code "c", text " ", link "d"
    const styles = atoms.map(a => ({
      value: a.value,
      bold: !!a.style.bold,
      italic: !!a.style.italic,
      code: !!a.style.code,
      link: a.style.link ?? null,
    }))
    expect(styles).toEqual([
      { value: "a ", bold: false, italic: false, code: false, link: null },
      { value: "b", bold: true, italic: false, code: false, link: null },
      { value: " ", bold: false, italic: false, code: false, link: null },
      { value: "i", bold: false, italic: true, code: false, link: null },
      { value: " ", bold: false, italic: false, code: false, link: null },
      { value: "c", bold: false, italic: false, code: true, link: null },
      { value: " ", bold: false, italic: false, code: false, link: null },
      { value: "d", bold: false, italic: false, code: false, link: "https://e.com" },
    ])
  })

  it("inherits parent style into nested children (bold containing code)", () => {
    const atoms = flattenRuns(parseInline("**bold and `code` here**"))
    // bold "bold and ", bold+code "code", bold " here"
    const codeAtom = atoms.find(a => a.value === "code")
    expect(codeAtom?.style.bold).toBe(true)
    expect(codeAtom?.style.code).toBe(true)
  })

  it("returns plain text unchanged", () => {
    const atoms = flattenRuns(parseInline("2核2G 3M"))
    expect(atoms.length).toBe(1)
    expect(atoms[0].value).toBe("2核2G 3M")
    expect(atoms[0].style).toEqual({})
  })
})

describe("wrapAtoms", () => {
  it("returns single line when atoms already fit", () => {
    const lines = wrapAtoms(flattenRuns(parseInline("hello")), 10)
    expect(lines.length).toBe(1)
    expect(plainOf(lines[0])).toBe("hello")
  })

  it("wraps at word boundaries", () => {
    const lines = wrapAtoms(flattenRuns(parseInline("the quick brown fox")), 10)
    expect(lines.map(plainOf)).toEqual(["the quick", "brown fox"])
  })

  it("preserves code style across the line boundary", () => {
    // Cell `foo \`bar baz\` qux` wrapped narrow — the code span "bar baz"
    // straddles two lines. Each output line's relevant atoms must keep
    // style.code === true.
    const lines = wrapAtoms(flattenRuns(parseInline("foo `bar baz` qux")), 7)
    // Expect at least 2 lines. Both should carry the code styling on the
    // portions of "bar"/"baz" that fall on them.
    expect(lines.length).toBeGreaterThanOrEqual(2)
    let codeChars = ""
    for (const line of lines) {
      for (const a of line) {
        if (a.style.code) codeChars += a.value
      }
    }
    // Whitespace between bar/baz may or may not survive — but at minimum the
    // two words themselves both stay styled.
    expect(codeChars.replace(/\s+/g, "")).toBe("barbaz")
  })

  it("breaks long CJK runs by character with style carried", () => {
    // `\`200GB/月流量\`` — code span, hard-break at width 6.
    const atoms = flattenRuns(parseInline("`200GB/月流量`"))
    const lines = wrapAtoms(atoms, 6)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) expect(atomsWidth(line)).toBeLessThanOrEqual(6)
    // Every chunk on every line should still be marked as code.
    for (const line of lines) {
      for (const a of line) expect(a.style.code).toBe(true)
    }
  })

  it("drops whitespace at line wrap boundaries", () => {
    const lines = wrapAtoms(flattenRuns(parseInline("a b c d e f")), 3)
    for (const line of lines) {
      const tail = plainOf(line).replace(/^[\s\S]*?(\s*)$/, "$1")
      expect(tail).toBe("")
    }
  })

  it("coalesces adjacent same-style atoms when wrapping forces a re-pack", () => {
    // Two consecutive plain atoms wider than the column: wrap re-packs
    // them and coalesces consecutive same-style atoms on each output line.
    const lines = wrapAtoms(
      [
        { style: {}, value: "foo " },
        { style: {}, value: "bar baz" },
      ],
      5,
    )
    // First line should be "foo" (single atom, plain style).
    expect(plainOf(lines[0])).toBe("foo")
    expect(lines[0].every(a => Object.keys(a.style).length === 0)).toBe(true)
  })

  it("handles empty atom input", () => {
    expect(wrapAtoms([], 10)).toEqual([[]])
  })
})

describe("horizontal rules", () => {
  it("drops --- / *** / ___ entirely (no hr block emitted)", () => {
    for (const sep of ["---", "***", "___", "------"]) {
      const src = ["one paragraph", "", sep, "", "another"].join("\n")
      const blocks = parseBlocks(src)
      for (const b of blocks) expect(b.kind).not.toBe("hr")
      // Both surrounding paragraphs should survive.
      const kinds = blocks.map(b => b.kind)
      expect(kinds.filter(k => k === "p").length).toBe(2)
    }
  })

  it("doesn't swallow content that just happens to start with dashes", () => {
    // < 3 dashes → still a paragraph, not a rule.
    const blocks = parseBlocks("-- not a rule")
    expect(blocks[0].kind).toBe("p")
  })
})

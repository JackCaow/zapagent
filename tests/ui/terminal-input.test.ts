import { describe, expect, it } from "bun:test"
import { TerminalInputDecoder } from "../../src/ui/terminal-input.js"

function decodeChunks(chunks: string[]): { text: string; focus: boolean[] } {
  const focus: boolean[] = []
  const decoder = new TerminalInputDecoder((value) => focus.push(value))
  const text = chunks.map((chunk) => decoder.push(chunk)).join("") + decoder.flushPending()
  return { text, focus }
}

describe("TerminalInputDecoder", () => {
  it("normalizes every Shift+Enter encoding", () => {
    expect(decodeChunks([
      "before\x1b[27;2;13~middle\x1b[13;2uafter\x1b\r",
    ])).toEqual({ text: "before\nmiddle\nafter\n", focus: [] })
  })

  it("normalizes Shift+Enter sequences split across arbitrary chunks", () => {
    expect(decodeChunks(["a\x1b[13;", "2", "u", "b"]).text).toBe("a\nb")
    expect(decodeChunks(["a\x1b[27;2;", "13", "~b"]).text).toBe("a\nb")
    expect(decodeChunks(["a\x1b", "\rb"]).text).toBe("a\nb")
  })

  it("consumes focus reports split across chunks", () => {
    expect(decodeChunks(["a\x1b[", "O", "b\x1b", "[I", "c"]))
      .toEqual({ text: "abc", focus: [false, true] })
  })

  it("preserves bracketed paste payload bytes verbatim", () => {
    const pasted = "log \x1b[I \x1b[O \x1b[13;2u \x1b\r"
    const framed = `\x1b[200~${pasted}\x1b[201~`
    expect(decodeChunks([framed])).toEqual({ text: framed, focus: [] })
  })

  it("preserves paste payload when both framing markers span chunks", () => {
    const chunks = [
      "head\x1b[20",
      "0~payload \x1b[I \x1b[13;2u\x1b[20",
      "1~tail",
    ]
    expect(decodeChunks(chunks)).toEqual({
      text: "head\x1b[200~payload \x1b[I \x1b[13;2u\x1b[201~tail",
      focus: [],
    })
  })

  it("preserves a paste surrounded by split focus notifications", () => {
    const framed = "\x1b[200~selected row\r\n\x1b[201~"
    expect(decodeChunks([
      "\x1b[", "O", "\x1b[20", "0~selected row\r\n\x1b[20", "1~", "\x1b", "[I",
    ])).toEqual({ text: framed, focus: [false, true] })
  })

  it("flushes an unknown or standalone escape prefix unchanged", () => {
    expect(decodeChunks(["\x1b["]).text).toBe("\x1b[")
  })
})

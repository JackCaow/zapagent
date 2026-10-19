import { describe, it, expect } from "bun:test"
import {
  findPlaceholders,
  placeholderAt,
  navigateLeft,
  navigateRight,
  wordJumpLeft,
  wordJumpRight,
  backspaceAt,
  deleteAt,
  deleteWordBackward,
  deleteToStart,
  deleteToEnd,
  insertAt,
  clampCursor,
} from "../src/ui/input-nav.js"

describe("findPlaceholders", () => {
  it("finds none in plain text", () => {
    expect(findPlaceholders("hello world")).toEqual([])
  })

  it("finds a single Image placeholder", () => {
    const r = findPlaceholders("[Image #5] tail")
    expect(r.length).toBe(1)
    expect(r[0]?.start).toBe(0)
    expect(r[0]?.end).toBe(10)
    expect(r[0]?.text).toBe("[Image #5]")
  })

  it("finds multiple placeholders mixed with text and Pasted", () => {
    const r = findPlaceholders("hi [Image #1] foo [Pasted #2 · 3 lines · 100 chars] bye")
    expect(r.map(x => x.text)).toEqual(["[Image #1]", "[Pasted #2 · 3 lines · 100 chars]"])
  })

  it("does not match malformed placeholders", () => {
    expect(findPlaceholders("[Image #5")).toEqual([])
    expect(findPlaceholders("Image #5]")).toEqual([])
    expect(findPlaceholders("[Image # 5]")).toEqual([])
    expect(findPlaceholders("[Image #0]")).toEqual([])
    expect(findPlaceholders("[Image #01]")).toEqual([])
    expect(findPlaceholders("[Pasted #01 · 1 lines · 12 chars]")).toEqual([])
  })
})

describe("placeholderAt", () => {
  it("returns null at boundaries (legal cursor positions)", () => {
    const v = "hi [Image #1] tail"
    expect(placeholderAt(v, 3)).toBeNull()  // at left boundary
    expect(placeholderAt(v, 13)).toBeNull() // at right boundary
  })

  it("returns the placeholder when cursor is in the interior", () => {
    const v = "hi [Image #1] tail"
    expect(placeholderAt(v, 7)?.text).toBe("[Image #1]")  // mid-token
  })

  it("returns null outside any placeholder", () => {
    expect(placeholderAt("hi [Image #1] tail", 0)).toBeNull()
    expect(placeholderAt("hi [Image #1] tail", 17)).toBeNull()
  })
})

describe("navigateLeft", () => {
  it("plain text moves 1 left", () => {
    expect(navigateLeft("hello", 3)).toBe(2)
  })

  it("from right boundary of placeholder jumps to its start", () => {
    expect(navigateLeft("[Image #1] foo", 10)).toBe(0)
  })

  it("from inside a placeholder snaps to its start", () => {
    expect(navigateLeft("[Image #1] foo", 7)).toBe(0)
  })

  it("at 0 stays at 0", () => {
    expect(navigateLeft("hello", 0)).toBe(0)
  })

  it("crossing into prev placeholder boundary jumps over it", () => {
    // value:  "[Image #1] x"
    // cursor at 11 (after space, before "x"). ← steps to 10 (right of `]`),
    // which is allowed (boundary). But from 10 itself, ← jumps over.
    expect(navigateLeft("[Image #1] x", 11)).toBe(10)
    expect(navigateLeft("[Image #1] x", 10)).toBe(0)
  })
})

describe("navigateRight", () => {
  it("plain text moves 1 right", () => {
    expect(navigateRight("hello", 2)).toBe(3)
  })

  it("from left boundary of placeholder jumps to its end", () => {
    expect(navigateRight("hi [Image #1] tail", 3)).toBe(13)
  })

  it("from inside a placeholder snaps to its end", () => {
    expect(navigateRight("hi [Image #1] tail", 7)).toBe(13)
  })

  it("at end stays at end", () => {
    expect(navigateRight("hello", 5)).toBe(5)
  })
})

describe("backspaceAt", () => {
  it("plain text deletes one char before cursor", () => {
    const r = backspaceAt("hello", 3)
    expect(r.value).toBe("helo")
    expect(r.cursorOffset).toBe(2)
    expect(r.deletedPlaceholder).toBeUndefined()
  })

  it("at cursor 0 is a no-op", () => {
    const r = backspaceAt("hello", 0)
    expect(r.value).toBe("hello")
    expect(r.cursorOffset).toBe(0)
  })

  it("at right boundary of placeholder deletes the whole token atomically", () => {
    const r = backspaceAt("[Image #5] tail", 10)
    expect(r.value).toBe(" tail")
    expect(r.cursorOffset).toBe(0)
    expect(r.deletedPlaceholder?.text).toBe("[Image #5]")
  })

  it("inside a placeholder deletes the whole token (defensive)", () => {
    const r = backspaceAt("[Image #5] tail", 7)
    expect(r.value).toBe(" tail")
    expect(r.deletedPlaceholder?.text).toBe("[Image #5]")
  })

  it("works for [Pasted #N · ...] tokens too", () => {
    const v = "before [Pasted #3 · 5 lines · 200 chars] after"
    const right = "[Pasted #3 · 5 lines · 200 chars]".length + "before ".length
    const r = backspaceAt(v, right)
    expect(r.value).toBe("before  after")
    expect(r.deletedPlaceholder?.text).toBe("[Pasted #3 · 5 lines · 200 chars]")
  })

  it("CJK-safe (treats each code point as one char)", () => {
    // "你好世界" — backspace from position 3 should delete '世'
    const r = backspaceAt("你好世界", 3)
    expect(r.value).toBe("你好界")
    expect(r.cursorOffset).toBe(2)
  })
})

describe("deleteAt (forward delete)", () => {
  it("plain text deletes one char at cursor", () => {
    const r = deleteAt("hello", 1)
    expect(r.value).toBe("hllo")
    expect(r.cursorOffset).toBe(1)
  })

  it("at end is a no-op", () => {
    const r = deleteAt("hello", 5)
    expect(r.value).toBe("hello")
    expect(r.cursorOffset).toBe(5)
  })

  it("at left boundary of placeholder deletes the whole token", () => {
    const r = deleteAt("hi [Image #1] tail", 3)
    expect(r.value).toBe("hi  tail")
    expect(r.cursorOffset).toBe(3)
    expect(r.deletedPlaceholder?.text).toBe("[Image #1]")
  })
})

describe("wordJumpLeft / wordJumpRight", () => {
  it("left jump skips whitespace then word chars", () => {
    expect(wordJumpLeft("hello world foo", 15)).toBe(12)  // start of "foo"
    expect(wordJumpLeft("hello world foo", 12)).toBe(6)   // start of "world"
  })

  it("right jump skips word chars then whitespace", () => {
    expect(wordJumpRight("hello world foo", 0)).toBe(6)
    expect(wordJumpRight("hello world foo", 6)).toBe(12)
  })

  it("left jump treats placeholder as single word", () => {
    expect(wordJumpLeft("[Image #1] foo", 14)).toBe(11)  // start of "foo"
    expect(wordJumpLeft("[Image #1] foo", 11)).toBe(0)    // jump over [Image #1]
  })

  it("right jump treats placeholder as single word", () => {
    expect(wordJumpRight("foo [Image #1]", 0)).toBe(4)
    expect(wordJumpRight("foo [Image #1]", 4)).toBe(14)
  })
})

describe("deleteWordBackward (Ctrl+W)", () => {
  it("deletes the word before cursor", () => {
    const r = deleteWordBackward("hello world", 11)
    expect(r.value).toBe("hello ")
    expect(r.cursorOffset).toBe(6)
  })

  it("at right boundary of placeholder deletes the whole token", () => {
    const r = deleteWordBackward("[Image #5] tail", 10)
    expect(r.value).toBe(" tail")
    expect(r.deletedPlaceholder?.text).toBe("[Image #5]")
  })
})

describe("deleteToStart / deleteToEnd", () => {
  it("Ctrl+U clears from start to cursor", () => {
    const r = deleteToStart("hello world", 6)
    expect(r.value).toBe("world")
    expect(r.cursorOffset).toBe(0)
  })

  it("Ctrl+K clears from cursor to end", () => {
    const r = deleteToEnd("hello world", 5)
    expect(r.value).toBe("hello")
    expect(r.cursorOffset).toBe(5)
  })
})

describe("insertAt", () => {
  it("inserts at cursor", () => {
    const r = insertAt("hello", 3, "X")
    expect(r.value).toBe("helXlo")
    expect(r.cursorOffset).toBe(4)
  })

  it("appends at end", () => {
    const r = insertAt("hello", 5, "!")
    expect(r.value).toBe("hello!")
    expect(r.cursorOffset).toBe(6)
  })

  it("snaps insertion point out of placeholder interior to its right boundary", () => {
    const r = insertAt("[Image #1]", 5, "X")
    expect(r.value).toBe("[Image #1]X")
    expect(r.cursorOffset).toBe(11)
  })

  it("inserts multi-char paste atomically", () => {
    const r = insertAt("ab", 1, "XYZ")
    expect(r.value).toBe("aXYZb")
    expect(r.cursorOffset).toBe(4)
  })
})

describe("clampCursor", () => {
  it("clamps below 0", () => {
    expect(clampCursor("hello", -3)).toBe(0)
  })

  it("clamps above length", () => {
    expect(clampCursor("hello", 999)).toBe(5)
  })

  it("snaps inside-placeholder cursor to nearer boundary", () => {
    // "[Image #1]" — interior is positions 1..9
    expect(clampCursor("[Image #1]", 2)).toBe(0)   // closer to start
    expect(clampCursor("[Image #1]", 8)).toBe(10)  // closer to end
  })

  it("leaves boundary positions untouched", () => {
    expect(clampCursor("[Image #1]", 0)).toBe(0)
    expect(clampCursor("[Image #1]", 10)).toBe(10)
  })

  it("leaves valid in-text positions untouched", () => {
    expect(clampCursor("hello", 3)).toBe(3)
  })
})

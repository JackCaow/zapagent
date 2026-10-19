import { describe, it, expect } from "bun:test"
import { detectBrokenPlaceholders } from "../src/imagePlaceholder.js"
const detectBrokenImagePlaceholders = detectBrokenPlaceholders

describe("detectBrokenImagePlaceholders", () => {
  // ── no-op cases ────────────────────────────────────────────────

  it("returns null when prev and next are identical", () => {
    expect(detectBrokenImagePlaceholders("hello", "hello")).toBeNull()
  })

  it("returns null when no [Image #N] tokens in either side", () => {
    expect(detectBrokenImagePlaceholders("foo bar", "foo baz")).toBeNull()
  })

  it("ignores non-canonical placeholder ids", () => {
    expect(detectBrokenImagePlaceholders("[Image #01]", "[Image #01")).toBeNull()
    expect(detectBrokenPlaceholders(
      "[Pasted #0 · 1 lines · 4 chars]",
      "[Pasted #0 · 1 lines · 4 chars",
    )).toBeNull()
  })

  it("returns null when prev had no images and next adds one (attach path)", () => {
    expect(detectBrokenImagePlaceholders("hello", "hello [Image #1]")).toBeNull()
  })

  it("returns null when an image is preserved unchanged", () => {
    expect(detectBrokenImagePlaceholders("[Image #1] foo", "[Image #1] bar")).toBeNull()
  })

  // ── single-image damage cases ──────────────────────────────────

  it("strips a closing-bracket-deleted fragment and reports the lost id", () => {
    // user backspaced over `]`
    const r = detectBrokenImagePlaceholders("[Image #5] hello", "[Image #5 hello")
    expect(r).not.toBeNull()
    expect(r!.cleaned).toBe(" hello")
    expect(r!.lostImageIds).toEqual([5])
  })

  it("strips an opening-bracket-deleted fragment", () => {
    // user forward-deleted `[`
    const r = detectBrokenImagePlaceholders("[Image #3]", "Image #3]")
    expect(r).not.toBeNull()
    expect(r!.cleaned).toBe("")
    expect(r!.lostImageIds).toEqual([3])
  })

  it("strips a fully-bare fragment (both brackets gone)", () => {
    const r = detectBrokenImagePlaceholders("[Image #7] tail", "Image #7 tail")
    expect(r).not.toBeNull()
    expect(r!.cleaned).toBe(" tail")
    expect(r!.lostImageIds).toEqual([7])
  })

  it("clean delete (selection + Delete) drops the image, no fragment to strip", () => {
    const r = detectBrokenImagePlaceholders("[Image #2] keep this", " keep this")
    expect(r).not.toBeNull()
    expect(r!.cleaned).toBe(" keep this")
    expect(r!.lostImageIds).toEqual([2])
  })

  // ── multi-image cases ──────────────────────────────────────────

  it("only drops the damaged id when others are intact", () => {
    const r = detectBrokenImagePlaceholders(
      "[Image #1] middle [Image #2]",
      "[Image #1] middle [Image #2",  // user backspaced #2's `]`
    )
    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([2])
    expect(r!.cleaned).toBe("[Image #1] middle ")
  })

  it("handles two damaged placeholders in one edit", () => {
    const r = detectBrokenImagePlaceholders(
      "[Image #1] [Image #2] tail",
      "[Image #1 [Image #2 tail",
    )
    expect(r).not.toBeNull()
    expect(r!.lostImageIds.sort()).toEqual([1, 2])
    expect(r!.cleaned).toBe("  tail")  // both fragments stripped
  })

  // ── lookahead correctness ──────────────────────────────────────

  it("id '1' does NOT mis-match inside a well-formed [Image #11] token", () => {
    // damage id 5 only — id 1 is mentioned via [Image #11] which is fine
    const r = detectBrokenImagePlaceholders(
      "[Image #5] [Image #11]",
      "[Image #5 [Image #11]",  // damage #5
    )
    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([5])
    expect(r!.cleaned).toBe(" [Image #11]")  // #11 untouched
  })

  it("strips id 11 cleanly when 11 itself is damaged", () => {
    const r = detectBrokenImagePlaceholders("[Image #11]", "[Image #11")
    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([11])
    expect(r!.cleaned).toBe("")
  })

  // ── replacement edits ──────────────────────────────────────────

  it("user retypes the digit (5 → 9) — id 5 dropped, id 9 left as-is", () => {
    // [Image #5] → user selects '5', types '9' → [Image #9]
    const r = detectBrokenImagePlaceholders("[Image #5]", "[Image #9]")
    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([5])
    // Edge case: the new [Image #9] is left intact (it's well-formed
    // in next), even though pendingImages won't actually have id 9.
    // Caller's responsibility to handle the orphan placeholder if it
    // matters. For now we don't strip well-formed tokens.
    expect(r!.cleaned).toBe("[Image #9]")
  })

  // ── add + damage in one edit ───────────────────────────────────

  it("attach a new image AND damage an old one in one edit", () => {
    // unrealistic single-edit but logic should still be correct
    const r = detectBrokenImagePlaceholders("[Image #1]", "[Image #1 [Image #2]")
    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([1])
    expect(r!.cleaned).toBe(" [Image #2]")
  })

  it("cleans a damaged duplicate image placeholder without dropping the shared image", () => {
    const r = detectBrokenPlaceholders(
      "[Image #4] again [Image #4]",
      "[Image #4] again [Image #4",
    )

    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([])
    expect(r!.cleaned).toBe("[Image #4] again ")
  })
})

// ─── [Pasted #N · ...] handling ──────────────────────────────────────

describe("detectBrokenPlaceholders — Pasted tokens", () => {
  it("returns null when paste tokens are intact", () => {
    expect(detectBrokenPlaceholders(
      "before [Pasted #3 · 5 lines · 200 chars] after",
      "before [Pasted #3 · 5 lines · 200 chars] after!",
    )).toBeNull()
  })

  it("clean atomic delete (the ControlledInput path) reports lostPasteIds", () => {
    const r = detectBrokenPlaceholders(
      "before [Pasted #3 · 5 lines · 200 chars] after",
      "before  after",
    )
    expect(r).not.toBeNull()
    expect(r!.lostPasteIds).toEqual([3])
    expect(r!.lostImageIds).toEqual([])
    expect(r!.cleaned).toBe("before  after")  // already clean, no fragment to strip
  })

  it("damaged paste token: closing-bracket gone → strip just the token, keep adjacent text", () => {
    const r = detectBrokenPlaceholders(
      "[Pasted #7 · 1 lines · 50 chars] tail",
      "[Pasted #7 · 1 lines · 50 chars tail",
    )
    expect(r).not.toBeNull()
    expect(r!.lostPasteIds).toEqual([7])
    // The strip regex is anchored on the canonical token shape so
    // the trailing " tail" is preserved.
    expect(r!.cleaned).toBe(" tail")
  })

  it("mixed: image and pasted both lost → both ids reported", () => {
    const r = detectBrokenPlaceholders(
      "[Image #1] [Pasted #2 · 1 lines · 10 chars]",
      "",
    )
    expect(r).not.toBeNull()
    expect(r!.lostImageIds).toEqual([1])
    expect(r!.lostPasteIds).toEqual([2])
  })

  it("strip regex doesn't eat past adjacent token boundary", () => {
    // damaged paste #5 followed by intact image #2 — image must survive
    const r = detectBrokenPlaceholders(
      "[Pasted #5 · 1 lines · 5 chars][Image #2]",
      "[Pasted #5 · 1 lines · 5 chars[Image #2]",
    )
    expect(r).not.toBeNull()
    expect(r!.lostPasteIds).toEqual([5])
    // [Image #2] still present
    expect(r!.cleaned).toContain("[Image #2]")
  })

  it("cleans a damaged duplicate paste placeholder without dropping the shared paste content", () => {
    const r = detectBrokenPlaceholders(
      "[Pasted #5 · 1 lines · 5 chars] again [Pasted #5 · 1 lines · 5 chars]",
      "[Pasted #5 · 1 lines · 5 chars] again [Pasted #5 · 1 lines · 5 chars",
    )

    expect(r).not.toBeNull()
    expect(r!.lostPasteIds).toEqual([])
    expect(r!.cleaned).toBe("[Pasted #5 · 1 lines · 5 chars] again ")
  })
})

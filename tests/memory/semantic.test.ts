import { describe, expect, it } from "bun:test"
import { normalizeMemorySemanticScores } from "../../zapsdk/memory/semantic.js"

describe("normalizeMemorySemanticScores", () => {
  it("clamps valid scores and drops unknown or non-finite entries", () => {
    const scores = normalizeMemorySemanticScores(new Map([
      ["high.md", 1.7],
      ["low.md", -0.2],
      ["rounded.md", 0.1236],
      ["nan.md", Number.NaN],
      ["unknown.md", 0.8],
    ]), new Set(["high.md", "low.md", "rounded.md", "nan.md"]))

    expect([...scores.entries()]).toEqual([
      ["high.md", 1],
      ["low.md", 0],
      ["rounded.md", 0.124],
    ])
  })
})

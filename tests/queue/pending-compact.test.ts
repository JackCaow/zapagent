import { describe, expect, it } from "bun:test"
import { hasPendingManualCompact, isManualCompactCommand } from "../../src/queue/pending-compact.js"

const entry = (id: string, state: "queued" | "dispatching" | "editing" | "failed" | "accepted", text = "/compact") =>
  ({ id, state, text })

describe("hasPendingManualCompact", () => {
  it("is blocked by a waiting, delivering or edited /compact", () => {
    expect(hasPendingManualCompact([entry("a", "queued")])).toBe(true)
    expect(hasPendingManualCompact([entry("a", "dispatching")])).toBe(true)
    expect(hasPendingManualCompact([entry("a", "editing")])).toBe(true)
  })

  it("is not blocked by a failed /compact left behind by a paused queue (#35)", () => {
    expect(hasPendingManualCompact([entry("a", "failed")])).toBe(false)
  })

  it("is not blocked by one that already ran", () => {
    expect(hasPendingManualCompact([entry("a", "accepted")])).toBe(false)
  })

  it("ignores the entry being edited and unrelated messages", () => {
    expect(hasPendingManualCompact([entry("a", "queued")], "a")).toBe(false)
    expect(hasPendingManualCompact([entry("a", "queued", "write a test")])).toBe(false)
    expect(hasPendingManualCompact([entry("a", "failed"), entry("b", "queued")])).toBe(true)
  })

  it("matches only the bare command, case-insensitively", () => {
    expect(isManualCompactCommand("  /COMPACT ")).toBe(true)
    expect(isManualCompactCommand("/compact now")).toBe(false)
  })
})

import { describe, expect, it } from "bun:test"
import { contextFooterText } from "../../src/ui/footer.js"
import type { ContextBudgetSnapshot } from "../../src/context-budget.js"

function snapshot(
  tokens: number | null,
  source: ContextBudgetSnapshot["usage"]["source"],
): ContextBudgetSnapshot {
  return {
    usage: {
      currentPromptTokens: tokens,
      lastMeasuredPromptTokens: source === "provider" ? tokens : 14_100,
      source,
      approximate: source !== "provider",
    },
    limits: {
      contextWindow: 1_000_000,
      reservedOutputTokens: 8192,
      safetyMarginTokens: 1000,
      effectiveInputLimit: 990_808,
      compactAt: 792_646,
      keepFloorTokens: 396_323,
      source: "models-dev",
    },
    remaining: { untilCompact: null, untilHardLimit: null },
    pressure: null,
    percentUntilCompact: null,
    severity: "normal",
  }
}

describe("contextFooterText", () => {
  it("marks an actionable next-prompt estimate with a tilde", () => {
    expect(contextFooterText(snapshot(15_300, "estimated"))).toBe("~15.3K/1.00M")
  })

  it("renders provider truth without an approximation marker", () => {
    expect(contextFooterText(snapshot(14_100, "provider"))).toBe("14.1K/1.00M")
  })

  it("shows pending only when a restored conversation has content", () => {
    expect(contextFooterText(snapshot(16_000, "pending"))).toBe("?/1.00M")
    expect(contextFooterText(snapshot(null, "pending"))).toBe("")
  })
})

describe("output TPS footer", () => {
  it("distinguishes estimates, measured rates and unavailable samples", async () => {
    const { throughputFooterText } = await import("../../src/ui/footer.js")
    expect(throughputFooterText({ tokensPerSecond: 42.15, estimated: true })).toBe("~42.1 token/s")
    expect(throughputFooterText({ tokensPerSecond: 42, estimated: false })).toBe("42.0 token/s")
    expect(throughputFooterText(undefined)).toBe("")
    expect(throughputFooterText({ tokensPerSecond: Infinity, estimated: false })).toBe("")
  })
})

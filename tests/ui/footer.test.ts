import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { stripVTControlCharacters } from "node:util"
import { Footer, contextFooterText } from "../../src/ui/footer.js"
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

it("renders the agent's latest window beside TPS and hides Zap's local context while awaiting ACP usage", () => {
  const props = {
    cwd: "/long-project-path".repeat(6), provider: "Codex", model: "test",
    isRunning: false, step: 0, maxSteps: 1, hasApiKey: true, termWidth: 80,
    contextBudget: snapshot(900_000, "provider"),
    outputThroughput: { tokensPerSecond: 12, estimated: false, turnAverage: true },
  }
  const render = (remoteContext: { used: number; size: number } | null) =>
    stripVTControlCharacters(renderToString(createElement(Footer, { ...props, remoteContext }), { columns: 80 }))
  const footer = render({ used: 30_800, size: 475_000 })
  expect(footer).toContain("ctx 30.8K/475.0K (6%)")
  expect(footer).toContain("avg 12.0 token/s")
  expect(render(null)).not.toContain("900.0K")
})

import { describe, expect, it } from "bun:test"
import { getDefaultConfig } from "../../src/config.js"
import { buildContextBudgetSnapshot, legacyContextUsage } from "../../src/context-budget.js"
import { tokenWarningText } from "../../src/ui/token-warning.js"

function budget(tokens: number, pending = false) {
  return buildContextBudgetSnapshot(getDefaultConfig(), legacyContextUsage(tokens, pending))
}

describe("tokenWarningText", () => {
  it("suppresses context warnings while usage is pending", () => {
    expect(tokenWarningText(budget(120_000, true))).toBeNull()
  })

  it("shows the normal warning once usage is measured", () => {
    expect(tokenWarningText(budget(120_000))?.text)
      .toContain("Context low")
  })

  it("keeps verbose heads-up hidden while usage is pending", () => {
    expect(tokenWarningText(budget(75_000, true), { verbose: true })).toBeNull()
    expect(tokenWarningText(budget(75_000), { verbose: true })?.text)
      .toContain("until auto-compact")
  })
})

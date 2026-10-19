import { describe, expect, it } from "bun:test"
import { buildStatusText } from "../../src/commands/status.js"
import { buildContextBudgetSnapshot, updateContextUsage, EMPTY_CONTEXT_USAGE } from "../../src/context-budget.js"
import { getDefaultConfig } from "../../src/config.js"

describe("context status snapshot", () => {
  it("distinguishes the estimated next prompt from the last API sample", () => {
    const config = getDefaultConfig()
    const measured = updateContextUsage(EMPTY_CONTEXT_USAGE, 14_100, "provider")
    const usage = updateContextUsage(measured, 15_300, "estimated")
    const budget = buildContextBudgetSnapshot(config, usage)

    const text = buildStatusText(
      config,
      "/repo",
      15_300,
      undefined,
      undefined,
      [],
      [],
      {},
      false,
      budget,
    )

    expect(text).toContain("Current prompt:  ~15.3K")
    expect(text).toContain("Last API prompt: 14.1K")
    expect(text).toContain("Auto-compact at:")
    expect(text).toContain("Usage source:    estimated")
  })
})

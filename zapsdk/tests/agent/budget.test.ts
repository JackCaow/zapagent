import { describe, expect, it } from "bun:test"
import { AgentBudget } from "../../agent/budget.js"

describe("AgentBudget token accounting", () => {
  it("accepts the exact-cap charge but refuses another step without consuming it", () => {
    const budget = new AgentBudget({ maxTokens: 12, maxSteps: 3 })
    expect(budget.useStep()).toBe(true)
    expect(budget.chargeTokens(4, 8)).toBe(true)
    expect(budget.canUseStep()).toBe(false)
    expect(budget.useStep()).toBe(false)
    expect(budget.stepsUsed).toBe(1)
  })

  it("normalizes invalid constructor limits before enforcing budgets", () => {
    const budget = new AgentBudget({
      maxSteps: Number.NaN,
      maxSpawns: Number.POSITIVE_INFINITY,
      maxTokens: Number.NaN,
    })

    expect(budget.maxSteps).toBe(200)
    expect(budget.maxSpawns).toBe(10)
    expect(budget.maxTokens).toBe(0)
    expect(budget.tokensRemaining).toBe(Infinity)
  })

  it("clamps negative constructor limits to zero", () => {
    const budget = new AgentBudget({
      maxSteps: -1,
      maxSpawns: -1,
      maxTokens: -1,
    })

    expect(budget.maxSteps).toBe(0)
    expect(budget.maxSpawns).toBe(0)
    expect(budget.maxTokens).toBe(0)
    expect(budget.useStep()).toBe(false)
    expect(budget.reserveSpawn()).toBe(false)
    expect(budget.chargeTokens(100, 100)).toBe(true)
  })

  it("floors fractional constructor limits", () => {
    const budget = new AgentBudget({
      maxSteps: 1.9,
      maxSpawns: 2.9,
      maxTokens: 10.9,
    })

    expect(budget.maxSteps).toBe(1)
    expect(budget.maxSpawns).toBe(2)
    expect(budget.maxTokens).toBe(10)
  })

  it("charges normal input and output tokens against the cap", () => {
    const budget = new AgentBudget({ maxTokens: 10 })

    expect(budget.chargeTokens(4, 5)).toBe(true)
    expect(budget.tokensUsed).toBe(9)
    expect(budget.tokensRemaining).toBe(1)

    expect(budget.chargeTokens(1, 1)).toBe(false)
    expect(budget.tokensUsed).toBe(11)
    expect(budget.tokensRemaining).toBe(0)
  })

  it("does not let negative charges refund consumed budget", () => {
    const budget = new AgentBudget({ maxTokens: 10 })

    expect(budget.chargeTokens(6, 2)).toBe(true)
    expect(budget.chargeTokens(-5, -5)).toBe(true)

    expect(budget.tokensUsed).toBe(8)
    expect(budget.tokensRemaining).toBe(2)
  })

  it("ignores non-finite token charges so budget state stays usable", () => {
    const budget = new AgentBudget({ maxTokens: 10 })

    expect(budget.chargeTokens(Number.NaN, Number.POSITIVE_INFINITY)).toBe(true)
    expect(budget.tokensUsed).toBe(0)
    expect(budget.tokensRemaining).toBe(10)

    expect(budget.chargeTokens(9, Number.NEGATIVE_INFINITY)).toBe(true)
    expect(budget.tokensUsed).toBe(9)
    expect(budget.tokensRemaining).toBe(1)
  })
})

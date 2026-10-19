import { describe, expect, it } from "bun:test"
import {
  assessMemoryUtilityQuality,
  evaluateMemoryUtility,
  formatMemoryUtilityEvalReport,
} from "../../src/agent/memoryUtilityEval.js"

describe("memory utility evaluation", () => {
  it("computes conservative binary quality, error, and latency metrics", async () => {
    const ticks = [0, 5, 5, 15, 15, 25, 25, 45]
    const report = await evaluateMemoryUtility([
      { id: "true-positive", expectedUsed: true, payload: "tp" },
      { id: "true-negative", expectedUsed: false, payload: "tn" },
      { id: "false-positive", expectedUsed: false, payload: "fp" },
      { id: "classifier-error", expectedUsed: true, payload: "error" },
    ], (payload) => {
      if (payload === "error") throw new Error("classifier unavailable")
      return { used: payload === "tp" || payload === "fp" }
    }, { now: () => ticks.shift() ?? 45 })

    expect(report).toMatchObject({
      caseCount: 4,
      positiveCount: 2,
      negativeCount: 2,
      truePositive: 1,
      trueNegative: 1,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0.5,
      recall: 0.5,
      specificity: 0.5,
      falsePositiveRate: 0.5,
      accuracy: 0.5,
      classificationErrorRate: 0.25,
      p50LatencyMs: 10,
      p95LatencyMs: 20,
    })
    expect(report.cases[3]).toMatchObject({
      correct: false,
      error: "classifier unavailable",
    })
    expect(report.cases[3]?.predictedUsed).toBeUndefined()
  })

  it("reports every failed quality threshold", async () => {
    const report = await evaluateMemoryUtility([
      { id: "miss", expectedUsed: true, payload: "miss" },
      { id: "false-positive", expectedUsed: false, payload: "fp" },
    ], (payload) => ({ used: payload === "fp" }), {
      now: (() => {
        const ticks = [0, 10, 10, 30]
        return () => ticks.shift() ?? 30
      })(),
    })
    const assessment = assessMemoryUtilityQuality(report, {
      minPrecision: 1,
      minRecall: 1,
      minSpecificity: 1,
      minAccuracy: 1,
      maxFalsePositiveRate: 0,
      maxClassificationErrorRate: 0,
      maxP95LatencyMs: 5,
    })

    expect(assessment.passed).toBe(false)
    expect(assessment.failures).toHaveLength(6)
    expect(assessment.failures.join("\n")).toContain("precision")
    expect(assessment.failures.join("\n")).toContain("false-positive rate")
    expect(assessment.failures.join("\n")).toContain("p95 latency ms")
  })

  it("formats a compact CI summary", async () => {
    const report = await evaluateMemoryUtility([
      { id: "hit", expectedUsed: true, payload: true },
      { id: "reject", expectedUsed: false, payload: false },
    ], (used) => ({ used }), { now: () => 5 })

    expect(formatMemoryUtilityEvalReport(report)).toBe(
      "memory utility cases=2 positive=1 negative=1 precision=1.0000 recall=1.0000 " +
      "specificity=1.0000 fpr=0.0000 accuracy=1.0000 errors=0.0000 p50=0.00ms p95=0.00ms",
    )
  })

  it("rejects invalid corpora, predictions, and thresholds", async () => {
    await expect(evaluateMemoryUtility([], () => ({ used: false })))
      .rejects.toThrow("corpus must not be empty")
    await expect(evaluateMemoryUtility([
      { id: "same", expectedUsed: true, payload: 1 },
      { id: "same", expectedUsed: false, payload: 2 },
    ], () => ({ used: false }))).rejects.toThrow("duplicate memory utility eval case id")
    await expect(evaluateMemoryUtility([
      { id: "positive-1", expectedUsed: true, payload: 1 },
      { id: "positive-2", expectedUsed: true, payload: 2 },
    ], () => ({ used: true }))).rejects.toThrow("requires positive and negative cases")

    const malformed = await evaluateMemoryUtility([
      { id: "positive", expectedUsed: true, payload: 1 },
      { id: "negative", expectedUsed: false, payload: 2 },
    ], () => ({ used: "yes" } as any))
    expect(malformed.classificationErrorRate).toBe(1)
    expect(malformed.accuracy).toBe(0)

    expect(() => assessMemoryUtilityQuality(malformed, { minPrecision: 1.1 }))
      .toThrow("minPrecision must be between 0 and 1")
    expect(() => assessMemoryUtilityQuality(malformed, { maxP95LatencyMs: -1 }))
      .toThrow("maxP95LatencyMs must be a non-negative finite number")
  })
})

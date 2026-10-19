import { describe, expect, it } from "bun:test"
import {
  assessMemoryRecallQuality,
  evaluateMemoryRecall,
  formatMemoryRecallEvalReport,
} from "../../memory/recall-eval.js"

describe("memory recall evaluation", () => {
  it("computes ranking, safety, duplicate, error, and latency metrics", async () => {
    const ticks = [0, 10, 10, 30, 30, 60]
    const report = await evaluateMemoryRecall([
      { id: "first", query: "q1", relevant: ["a.md"], forbidden: ["x.md"] },
      { id: "second", query: "q2", relevant: ["b.md", "c.md"] },
      { id: "error", query: "q3", relevant: ["d.md"] },
    ], async (query) => {
      if (query === "q1") return { selected: ["a.md", "x.md"] }
      if (query === "q2") return { selected: ["noise.md", "c.md"] }
      throw new Error("retriever unavailable")
    }, {
      k: 2,
      now: () => ticks.shift() ?? 60,
    })

    expect(report).toMatchObject({
      k: 2,
      caseCount: 3,
      hitRateAtK: 2 / 3,
      recallAtK: 0.5,
      precisionAtK: 1 / 3,
      meanReciprocalRankAtK: 0.5,
      forbiddenCaseRateAtK: 1 / 3,
      duplicateCaseRateAtK: 0,
      retrievalErrorRate: 1 / 3,
      p50LatencyMs: 20,
      p95LatencyMs: 30,
    })
    expect(report.cases[1]).toMatchObject({
      relevantHits: ["c.md"],
      missingRelevant: ["b.md"],
      unexpectedAtK: ["noise.md"],
      reciprocalRankAtK: 0.5,
    })
    expect(report.cases[2]?.error).toBe("retriever unavailable")
  })

  it("counts duplicate selections once and treats repeated ranks as unexpected", async () => {
    const report = await evaluateMemoryRecall([
      { id: "duplicate", query: "q", relevant: ["a.md"] },
    ], () => ({ selected: ["a.md", "a.md"] }), { k: 2 })

    expect(report.recallAtK).toBe(1)
    expect(report.precisionAtK).toBe(0.5)
    expect(report.duplicateCaseRateAtK).toBe(1)
    expect(report.cases[0]?.duplicateSelectionsAtK).toEqual(["a.md"])
    expect(report.cases[0]?.unexpectedAtK).toEqual(["a.md"])
  })

  it("reports every failed quality threshold", async () => {
    const report = await evaluateMemoryRecall([
      { id: "miss", query: "q", relevant: ["a.md"], forbidden: ["x.md"] },
    ], () => ({ selected: ["x.md", "x.md"] }), {
      k: 2,
      now: (() => {
        const ticks = [0, 10]
        return () => ticks.shift() ?? 10
      })(),
    })
    const assessment = assessMemoryRecallQuality(report, {
      minHitRateAtK: 1,
      minRecallAtK: 1,
      minPrecisionAtK: 0.5,
      minMeanReciprocalRankAtK: 1,
      maxForbiddenCaseRateAtK: 0,
      maxDuplicateCaseRateAtK: 0,
      maxRetrievalErrorRate: 0,
      maxP95LatencyMs: 5,
    })

    expect(assessment.passed).toBe(false)
    expect(assessment.failures).toHaveLength(7)
    expect(assessment.failures.join("\n")).toContain("Hit@K")
    expect(assessment.failures.join("\n")).toContain("forbidden-case rate@K")
    expect(assessment.failures.join("\n")).toContain("p95 latency ms")
  })

  it("formats a compact CI summary", async () => {
    const report = await evaluateMemoryRecall([
      { id: "hit", query: "q", relevant: ["a.md"] },
    ], () => ({ selected: ["a.md"] }), { k: 1, now: () => 5 })

    expect(formatMemoryRecallEvalReport(report)).toBe(
      "memory recall k=1 cases=1 hit=1.0000 recall=1.0000 precision=1.0000 " +
      "mrr=1.0000 forbidden=0.0000 duplicates=0.0000 errors=0.0000 p50=0.00ms p95=0.00ms",
    )
  })

  it("rejects invalid or contradictory corpora", async () => {
    await expect(evaluateMemoryRecall([], () => ({ selected: [] })))
      .rejects.toThrow("corpus must not be empty")

    await expect(evaluateMemoryRecall([
      { id: "same", query: "q1", relevant: ["a.md"] },
      { id: "same", query: "q2", relevant: ["b.md"] },
    ], () => ({ selected: [] }))).rejects.toThrow("duplicate memory recall eval case id")

    await expect(evaluateMemoryRecall([
      { id: "overlap", query: "q", relevant: ["a.md"], forbidden: ["a.md"] },
    ], () => ({ selected: [] }))).rejects.toThrow("marks a.md relevant and forbidden")

    await expect(evaluateMemoryRecall([
      { id: "empty", query: "q", relevant: [] },
    ], () => ({ selected: [] }))).rejects.toThrow("requires relevant records")

    await expect(evaluateMemoryRecall([
      { id: "k", query: "q", relevant: ["a.md"] },
    ], () => ({ selected: [] }), { k: 0 })).rejects.toThrow("k must be a positive integer")
  })

  it("rejects invalid quality thresholds", async () => {
    const report = await evaluateMemoryRecall([
      { id: "hit", query: "q", relevant: ["a.md"] },
    ], () => ({ selected: ["a.md"] }), { k: 1 })

    expect(() => assessMemoryRecallQuality(report, { minHitRateAtK: 1.1 }))
      .toThrow("minHitRateAtK must be between 0 and 1")
    expect(() => assessMemoryRecallQuality(report, { maxP95LatencyMs: -1 }))
      .toThrow("maxP95LatencyMs must be a non-negative finite number")
  })
})

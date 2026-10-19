import { performance } from "node:perf_hooks"

export interface MemoryUtilityEvalCase<TPayload = unknown> {
  id: string
  expectedUsed: boolean
  payload: TPayload
}

export interface MemoryUtilityEvalPrediction {
  used: boolean
}

export type MemoryUtilityEvalClassifier<TPayload = unknown> = (
  payload: TPayload,
  scenario: MemoryUtilityEvalCase<TPayload>,
) => MemoryUtilityEvalPrediction | Promise<MemoryUtilityEvalPrediction>

export interface MemoryUtilityEvalOptions {
  now?: () => number
}

export interface MemoryUtilityEvalCaseResult {
  id: string
  expectedUsed: boolean
  predictedUsed?: boolean
  correct: boolean
  latencyMs: number
  error?: string
}

export interface MemoryUtilityEvalReport {
  caseCount: number
  positiveCount: number
  negativeCount: number
  truePositive: number
  trueNegative: number
  falsePositive: number
  falseNegative: number
  precision: number
  recall: number
  specificity: number
  falsePositiveRate: number
  accuracy: number
  classificationErrorRate: number
  p50LatencyMs: number
  p95LatencyMs: number
  cases: MemoryUtilityEvalCaseResult[]
}

export interface MemoryUtilityQualityThresholds {
  minPrecision?: number
  minRecall?: number
  minSpecificity?: number
  minAccuracy?: number
  maxFalsePositiveRate?: number
  maxClassificationErrorRate?: number
  maxP95LatencyMs?: number
}

export interface MemoryUtilityQualityAssessment {
  passed: boolean
  failures: string[]
}

export async function evaluateMemoryUtility<TPayload>(
  scenarios: readonly MemoryUtilityEvalCase<TPayload>[],
  classify: MemoryUtilityEvalClassifier<TPayload>,
  options: MemoryUtilityEvalOptions = {},
): Promise<MemoryUtilityEvalReport> {
  validateScenarios(scenarios)
  const now = options.now ?? (() => performance.now())
  const cases: MemoryUtilityEvalCaseResult[] = []

  for (const scenario of scenarios) {
    const startedAt = now()
    let predictedUsed: boolean | undefined
    let error: string | undefined
    try {
      const prediction = await classify(scenario.payload, scenario)
      if (!prediction || typeof prediction.used !== "boolean") {
        throw new TypeError("memory utility classifier must return a boolean used field")
      }
      predictedUsed = prediction.used
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const latencyMs = nonNegativeFinite(now() - startedAt)
    cases.push({
      id: scenario.id,
      expectedUsed: scenario.expectedUsed,
      ...(predictedUsed !== undefined ? { predictedUsed } : {}),
      correct: predictedUsed === scenario.expectedUsed,
      latencyMs,
      ...(error !== undefined ? { error } : {}),
    })
  }

  const positiveCount = cases.filter((item) => item.expectedUsed).length
  const negativeCount = cases.length - positiveCount
  const truePositive = cases.filter((item) => item.expectedUsed && item.predictedUsed === true).length
  const trueNegative = cases.filter((item) => !item.expectedUsed && item.predictedUsed === false).length
  // Classifier failures count against the expected class instead of silently
  // improving precision or specificity by disappearing from the denominator.
  const falseNegative = positiveCount - truePositive
  const falsePositive = negativeCount - trueNegative
  const latencies = cases.map((item) => item.latencyMs).sort((a, b) => a - b)
  return {
    caseCount: cases.length,
    positiveCount,
    negativeCount,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, positiveCount),
    specificity: ratio(trueNegative, negativeCount),
    falsePositiveRate: ratio(falsePositive, negativeCount),
    accuracy: ratio(truePositive + trueNegative, cases.length),
    classificationErrorRate: ratio(cases.filter((item) => item.error !== undefined).length, cases.length),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    cases,
  }
}

export function assessMemoryUtilityQuality(
  report: MemoryUtilityEvalReport,
  thresholds: MemoryUtilityQualityThresholds,
): MemoryUtilityQualityAssessment {
  validateThresholds(thresholds)
  const failures: string[] = []
  checkMinimum(failures, "precision", report.precision, thresholds.minPrecision)
  checkMinimum(failures, "recall", report.recall, thresholds.minRecall)
  checkMinimum(failures, "specificity", report.specificity, thresholds.minSpecificity)
  checkMinimum(failures, "accuracy", report.accuracy, thresholds.minAccuracy)
  checkMaximum(failures, "false-positive rate", report.falsePositiveRate, thresholds.maxFalsePositiveRate)
  checkMaximum(
    failures,
    "classification error rate",
    report.classificationErrorRate,
    thresholds.maxClassificationErrorRate,
  )
  checkMaximum(failures, "p95 latency ms", report.p95LatencyMs, thresholds.maxP95LatencyMs, 2)
  return { passed: failures.length === 0, failures }
}

export function formatMemoryUtilityEvalReport(
  report: MemoryUtilityEvalReport,
): string {
  return [
    `memory utility cases=${report.caseCount}`,
    `positive=${report.positiveCount}`,
    `negative=${report.negativeCount}`,
    `precision=${formatRate(report.precision)}`,
    `recall=${formatRate(report.recall)}`,
    `specificity=${formatRate(report.specificity)}`,
    `fpr=${formatRate(report.falsePositiveRate)}`,
    `accuracy=${formatRate(report.accuracy)}`,
    `errors=${formatRate(report.classificationErrorRate)}`,
    `p50=${report.p50LatencyMs.toFixed(2)}ms`,
    `p95=${report.p95LatencyMs.toFixed(2)}ms`,
  ].join(" ")
}

function validateScenarios<TPayload>(scenarios: readonly MemoryUtilityEvalCase<TPayload>[]): void {
  if (scenarios.length === 0) throw new Error("memory utility eval corpus must not be empty")
  const ids = new Set<string>()
  let positives = 0
  for (const scenario of scenarios) {
    const id = scenario.id.trim()
    if (!id) throw new Error("memory utility eval case id is required")
    if (ids.has(id)) throw new Error(`duplicate memory utility eval case id: ${id}`)
    ids.add(id)
    if (scenario.expectedUsed) positives++
  }
  if (positives === 0 || positives === scenarios.length) {
    throw new Error("memory utility eval corpus requires positive and negative cases")
  }
}

function validateThresholds(thresholds: MemoryUtilityQualityThresholds): void {
  const rates: Array<[string, number | undefined]> = [
    ["minPrecision", thresholds.minPrecision],
    ["minRecall", thresholds.minRecall],
    ["minSpecificity", thresholds.minSpecificity],
    ["minAccuracy", thresholds.minAccuracy],
    ["maxFalsePositiveRate", thresholds.maxFalsePositiveRate],
    ["maxClassificationErrorRate", thresholds.maxClassificationErrorRate],
  ]
  for (const [name, value] of rates) {
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be between 0 and 1`)
    }
  }
  const latency = thresholds.maxP95LatencyMs
  if (latency !== undefined && (!Number.isFinite(latency) || latency < 0)) {
    throw new Error("maxP95LatencyMs must be a non-negative finite number")
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? 0
}

function checkMinimum(
  failures: string[],
  label: string,
  actual: number,
  expected: number | undefined,
  digits = 4,
): void {
  if (expected === undefined || actual >= expected) return
  failures.push(`${label} ${actual.toFixed(digits)} is below minimum ${expected.toFixed(digits)}`)
}

function checkMaximum(
  failures: string[],
  label: string,
  actual: number,
  expected: number | undefined,
  digits = 4,
): void {
  if (expected === undefined || actual <= expected) return
  failures.push(`${label} ${actual.toFixed(digits)} exceeds maximum ${expected.toFixed(digits)}`)
}

function formatRate(value: number): string {
  return value.toFixed(4)
}

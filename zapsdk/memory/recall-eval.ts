import { performance } from "node:perf_hooks"

export interface MemoryRecallEvalCase<TQuery = string> {
  id: string
  query: TQuery
  relevant: readonly string[]
  forbidden?: readonly string[]
}

export interface MemoryRecallEvalSelection {
  selected: readonly string[]
}

export type MemoryRecallEvalRetriever<TQuery = string> = (
  query: TQuery,
  scenario: MemoryRecallEvalCase<TQuery>,
) => MemoryRecallEvalSelection | Promise<MemoryRecallEvalSelection>

export interface MemoryRecallEvalOptions {
  k?: number
  now?: () => number
}

export interface MemoryRecallEvalCaseResult<TQuery = string> {
  id: string
  query: TQuery
  relevant: string[]
  forbidden: string[]
  selected: string[]
  selectedAtK: string[]
  relevantHits: string[]
  missingRelevant: string[]
  unexpectedAtK: string[]
  forbiddenHits: string[]
  duplicateSelectionsAtK: string[]
  hitAtK: boolean
  recallAtK: number
  precisionAtK: number
  reciprocalRankAtK: number
  latencyMs: number
  error?: string
}

export interface MemoryRecallEvalReport<TQuery = string> {
  k: number
  caseCount: number
  hitRateAtK: number
  recallAtK: number
  precisionAtK: number
  meanReciprocalRankAtK: number
  forbiddenCaseRateAtK: number
  duplicateCaseRateAtK: number
  retrievalErrorRate: number
  p50LatencyMs: number
  p95LatencyMs: number
  cases: MemoryRecallEvalCaseResult<TQuery>[]
}

export interface MemoryRecallQualityThresholds {
  minHitRateAtK?: number
  minRecallAtK?: number
  minPrecisionAtK?: number
  minMeanReciprocalRankAtK?: number
  maxForbiddenCaseRateAtK?: number
  maxDuplicateCaseRateAtK?: number
  maxRetrievalErrorRate?: number
  maxP95LatencyMs?: number
}

export interface MemoryRecallQualityAssessment {
  passed: boolean
  failures: string[]
}

export async function evaluateMemoryRecall<TQuery = string>(
  scenarios: readonly MemoryRecallEvalCase<TQuery>[],
  retrieve: MemoryRecallEvalRetriever<TQuery>,
  options: MemoryRecallEvalOptions = {},
): Promise<MemoryRecallEvalReport<TQuery>> {
  const k = positiveInteger(options.k, 5, "k")
  const now = options.now ?? (() => performance.now())
  validateScenarios(scenarios)

  const results: MemoryRecallEvalCaseResult<TQuery>[] = []
  for (const scenario of scenarios) {
    const relevant = uniqueNames(scenario.relevant)
    const forbidden = uniqueNames(scenario.forbidden ?? [])
    const start = now()
    let selected: string[] = []
    let error: string | undefined
    try {
      const result = await retrieve(scenario.query, scenario)
      selected = cleanSelection(result?.selected)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const latencyMs = nonNegativeFinite(now() - start)
    results.push(evaluateCase(scenario, relevant, forbidden, selected, k, latencyMs, error))
  }

  const caseCount = results.length
  const divisor = Math.max(1, caseCount)
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b)
  return {
    k,
    caseCount,
    hitRateAtK: results.filter((result) => result.hitAtK).length / divisor,
    recallAtK: sum(results, (result) => result.recallAtK) / divisor,
    precisionAtK: sum(results, (result) => result.precisionAtK) / divisor,
    meanReciprocalRankAtK: sum(results, (result) => result.reciprocalRankAtK) / divisor,
    forbiddenCaseRateAtK: results.filter((result) => result.forbiddenHits.length > 0).length / divisor,
    duplicateCaseRateAtK: results.filter((result) => result.duplicateSelectionsAtK.length > 0).length / divisor,
    retrievalErrorRate: results.filter((result) => result.error !== undefined).length / divisor,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    cases: results,
  }
}

export function assessMemoryRecallQuality<TQuery>(
  report: MemoryRecallEvalReport<TQuery>,
  thresholds: MemoryRecallQualityThresholds,
): MemoryRecallQualityAssessment {
  validateThresholds(thresholds)
  const failures: string[] = []
  checkMinimum(failures, "Hit@K", report.hitRateAtK, thresholds.minHitRateAtK)
  checkMinimum(failures, "Recall@K", report.recallAtK, thresholds.minRecallAtK)
  checkMinimum(failures, "Precision@K", report.precisionAtK, thresholds.minPrecisionAtK)
  checkMinimum(failures, "MRR@K", report.meanReciprocalRankAtK, thresholds.minMeanReciprocalRankAtK)
  checkMaximum(failures, "forbidden-case rate@K", report.forbiddenCaseRateAtK, thresholds.maxForbiddenCaseRateAtK)
  checkMaximum(failures, "duplicate-case rate@K", report.duplicateCaseRateAtK, thresholds.maxDuplicateCaseRateAtK)
  checkMaximum(failures, "retrieval error rate", report.retrievalErrorRate, thresholds.maxRetrievalErrorRate)
  checkMaximum(failures, "p95 latency ms", report.p95LatencyMs, thresholds.maxP95LatencyMs, 2)
  return { passed: failures.length === 0, failures }
}

export function formatMemoryRecallEvalReport<TQuery>(report: MemoryRecallEvalReport<TQuery>): string {
  return [
    `memory recall k=${report.k} cases=${report.caseCount}`,
    `hit=${formatRate(report.hitRateAtK)}`,
    `recall=${formatRate(report.recallAtK)}`,
    `precision=${formatRate(report.precisionAtK)}`,
    `mrr=${formatRate(report.meanReciprocalRankAtK)}`,
    `forbidden=${formatRate(report.forbiddenCaseRateAtK)}`,
    `duplicates=${formatRate(report.duplicateCaseRateAtK)}`,
    `errors=${formatRate(report.retrievalErrorRate)}`,
    `p50=${report.p50LatencyMs.toFixed(2)}ms`,
    `p95=${report.p95LatencyMs.toFixed(2)}ms`,
  ].join(" ")
}

function evaluateCase<TQuery>(
  scenario: MemoryRecallEvalCase<TQuery>,
  relevant: string[],
  forbidden: string[],
  selected: string[],
  k: number,
  latencyMs: number,
  error: string | undefined,
): MemoryRecallEvalCaseResult<TQuery> {
  const relevantSet = new Set(relevant)
  const forbiddenSet = new Set(forbidden)
  const selectedAtK = selected.slice(0, k)
  const seen = new Set<string>()
  const duplicateSelectionsAtK: string[] = []
  for (const filename of selectedAtK) {
    if (seen.has(filename) && !duplicateSelectionsAtK.includes(filename)) duplicateSelectionsAtK.push(filename)
    seen.add(filename)
  }
  const relevantHits = relevant.filter((filename) => seen.has(filename))
  const firstRelevantIndex = selectedAtK.findIndex((filename) => relevantSet.has(filename))
  return {
    id: scenario.id,
    query: scenario.query,
    relevant,
    forbidden,
    selected,
    selectedAtK,
    relevantHits,
    missingRelevant: relevant.filter((filename) => !seen.has(filename)),
    unexpectedAtK: selectedAtK.filter((filename, index) =>
      !relevantSet.has(filename) || selectedAtK.indexOf(filename) !== index),
    forbiddenHits: forbidden.filter((filename) => seen.has(filename)),
    duplicateSelectionsAtK,
    hitAtK: relevantHits.length > 0,
    recallAtK: relevantHits.length / relevant.length,
    precisionAtK: relevantHits.length / k,
    reciprocalRankAtK: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    latencyMs,
    ...(error !== undefined ? { error } : {}),
  }
}

function validateScenarios<TQuery>(scenarios: readonly MemoryRecallEvalCase<TQuery>[]): void {
  if (scenarios.length === 0) throw new Error("memory recall eval corpus must not be empty")
  const ids = new Set<string>()
  for (const scenario of scenarios) {
    const id = scenario.id.trim()
    if (!id) throw new Error("memory recall eval case id is required")
    if (ids.has(id)) throw new Error(`duplicate memory recall eval case id: ${id}`)
    ids.add(id)
    const relevant = uniqueNames(scenario.relevant)
    if (relevant.length === 0) throw new Error(`memory recall eval case ${id} requires relevant records`)
    const relevantSet = new Set(relevant)
    const overlap = uniqueNames(scenario.forbidden ?? []).find((filename) => relevantSet.has(filename))
    if (overlap) throw new Error(`memory recall eval case ${id} marks ${overlap} relevant and forbidden`)
  }
}

function validateThresholds(thresholds: MemoryRecallQualityThresholds): void {
  const rates: Array<[string, number | undefined]> = [
    ["minHitRateAtK", thresholds.minHitRateAtK],
    ["minRecallAtK", thresholds.minRecallAtK],
    ["minPrecisionAtK", thresholds.minPrecisionAtK],
    ["minMeanReciprocalRankAtK", thresholds.minMeanReciprocalRankAtK],
    ["maxForbiddenCaseRateAtK", thresholds.maxForbiddenCaseRateAtK],
    ["maxDuplicateCaseRateAtK", thresholds.maxDuplicateCaseRateAtK],
    ["maxRetrievalErrorRate", thresholds.maxRetrievalErrorRate],
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

function cleanSelection(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueNames(value: readonly string[]): string[] {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? 0
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0)
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

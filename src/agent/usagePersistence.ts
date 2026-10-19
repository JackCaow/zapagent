import { computeCacheUsageStats, type CacheUsageInput } from "../../zapsdk/agent/cache-metrics.js"
import type { ContextDiagnostics } from "../../zapsdk/agent/events.js"
import type { PromptCacheDiagnostics } from "./promptDiagnostics.js"
import { sanitizeContextDiagnostics, sanitizePromptCacheDiagnostics } from "./diagnosticSanitizers.js"
import { sanitizePromptCacheScope, type PromptCacheScope } from "./cacheScope.js"

export interface RunUsageForPersistence extends CacheUsageInput {
  purpose?: "main" | "maintenance"
  outputTokens: number
  providerUsageReported?: boolean
  usageIncomplete?: boolean
  step?: number
  finishReason?: string
  cacheScope?: PromptCacheScope
  contextDiagnostics?: ContextDiagnostics
  promptCacheDiagnostics?: PromptCacheDiagnostics
}

export interface PersistRunUsageDeps {
  getLocalEstimate: () => number
  appendUsage: (
    total: number,
    localEstimateAtTime: number,
    output: number,
    detail?: {
      purpose?: "main" | "maintenance"
      inputTokens?: number
      providerUsageReported?: boolean
      usageIncomplete?: boolean
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
      cacheMissInputTokens?: number
      totalPromptInputTokens?: number
      cacheHitRatio?: number | null
      cacheReuseRatio?: number | null
      cacheWriteRatio?: number | null
      step?: number
      finishReason?: string
      cacheScope?: PromptCacheScope
      contextDiagnostics?: ContextDiagnostics
      promptCacheDiagnostics?: PromptCacheDiagnostics
    },
  ) => void
  setPromptOverhead?: (overhead: number) => void
}

export function persistRunUsage(
  usage: RunUsageForPersistence,
  deps: PersistRunUsageDeps,
): { used: number; localEstimateAtTime: number; promptOverhead: number } {
  const maintenance = usage.purpose === "maintenance"
  const localEstimateAtTime = maintenance ? 0 : deps.getLocalEstimate()
  const outputTokens = nonNegativeFinite(usage.outputTokens)
  const contextDiagnostics = sanitizeContextDiagnostics(maintenance ? undefined : usage.contextDiagnostics)
  const promptCacheDiagnostics = sanitizePromptCacheDiagnostics(maintenance ? undefined : usage.promptCacheDiagnostics)
  const cacheScope = sanitizePromptCacheScope(usage.cacheScope)
  if (usage.providerUsageReported === false) {
    deps.appendUsage(0, localEstimateAtTime, outputTokens, {
      ...(maintenance ? { purpose: "maintenance" as const } : {}),
      providerUsageReported: false,
      ...(usage.usageIncomplete ? { usageIncomplete: true } : {}),
      step: usage.step,
      finishReason: usage.finishReason,
      ...(cacheScope ? { cacheScope } : {}),
      ...(contextDiagnostics ? { contextDiagnostics } : {}),
      ...(promptCacheDiagnostics ? { promptCacheDiagnostics } : {}),
    })
    return { used: 0, localEstimateAtTime, promptOverhead: 0 }
  }

  const cache = computeCacheUsageStats(usage)
  const cacheReadReported = typeof usage.cacheReadInputTokens === "number"
  const cacheCreationReported = typeof usage.cacheCreationInputTokens === "number"
  const cacheMissReported = typeof usage.cacheMissInputTokens === "number"
  const used = cache.totalPromptInputTokens
  const promptOverhead = maintenance ? 0 : Math.max(0, used - localEstimateAtTime)
  if (promptOverhead > 0) deps.setPromptOverhead?.(promptOverhead)
  deps.appendUsage(used, localEstimateAtTime, outputTokens, {
    ...(maintenance ? { purpose: "maintenance" as const } : {}),
    inputTokens: cache.freshInputTokens,
    ...(usage.usageIncomplete ? { usageIncomplete: true } : {}),
    ...(typeof usage.providerUsageReported === "boolean"
      ? { providerUsageReported: usage.providerUsageReported }
      : {}),
    ...(cacheReadReported ? { cacheReadInputTokens: cache.cacheReadInputTokens } : {}),
    ...(cacheCreationReported ? { cacheCreationInputTokens: cache.cacheCreationInputTokens } : {}),
    ...(cacheMissReported ? { cacheMissInputTokens: cache.cacheMissInputTokens } : {}),
    totalPromptInputTokens: cache.totalPromptInputTokens,
    ...(cacheReadReported || cacheCreationReported || cacheMissReported
      ? {
          cacheHitRatio: cache.cacheHitRatio,
          cacheReuseRatio: cache.cacheReuseRatio,
          cacheWriteRatio: cache.cacheWriteRatio,
        }
      : {}),
    step: usage.step,
    finishReason: usage.finishReason,
    ...(cacheScope ? { cacheScope } : {}),
    ...(contextDiagnostics ? { contextDiagnostics } : {}),
    ...(promptCacheDiagnostics ? { promptCacheDiagnostics } : {}),
  })
  return { used, localEstimateAtTime, promptOverhead }
}

function nonNegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0
}

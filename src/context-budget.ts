import {
  PROVIDER_PRESETS,
  deriveCompaction,
  getActiveProvider,
  inferLegacyContextWindowMode,
  resolveProviderContextWindow,
  type AppConfig,
} from "./config.js"
import { compactBudget } from "../zapsdk/context/compact-budget.js"
import { CONTEXT_INPUT_SAFETY_MARGIN_TOKENS } from "../zapsdk/agent/context-limits.js"

export type ContextUsageSource = "provider" | "estimated" | "restored" | "pending"
export type ContextLimitSource = "manual" | "models-dev" | "preset" | "provider" | "fallback"
export type ContextSeverity = "unknown" | "normal" | "notice" | "warning" | "critical"

/** Mutable runtime measurement. It intentionally records both the actionable
 * next-prompt estimate and the last provider truth: after a response is added
 * to the conversation those values are no longer the same thing. */
export interface ContextUsageState {
  currentPromptTokens: number | null
  lastMeasuredPromptTokens: number | null
  source: ContextUsageSource
  approximate: boolean
}

export interface ContextLimits {
  /** Provider/model advertised combined context window. */
  contextWindow: number
  /** Explicit prompt-input ceiling when the model catalog publishes one. */
  inputLimit?: number
  reservedOutputTokens: number
  safetyMarginTokens: number
  /** Prompt capacity after respecting inputLimit and output reservation. */
  effectiveInputLimit: number
  compactAt: number
  keepFloorTokens: number
  source: ContextLimitSource
}

export interface ContextBudgetSnapshot {
  usage: ContextUsageState
  limits: ContextLimits
  remaining: {
    untilCompact: number | null
    untilHardLimit: number | null
  }
  /** Usage pressure against the operational auto-compact boundary. */
  pressure: number | null
  percentUntilCompact: number | null
  severity: ContextSeverity
}

export const EMPTY_CONTEXT_USAGE: ContextUsageState = {
  currentPromptTokens: null,
  lastMeasuredPromptTokens: null,
  source: "pending",
  approximate: true,
}

export function updateContextUsage(
  previous: ContextUsageState,
  tokens: number | null,
  source: ContextUsageSource,
  lastMeasuredPromptTokens?: number | null,
): ContextUsageState {
  const currentPromptTokens = finiteTokensOrNull(tokens)
  const measured = source === "provider"
    ? currentPromptTokens
    : lastMeasuredPromptTokens === undefined
      ? previous.lastMeasuredPromptTokens
      : finiteTokensOrNull(lastMeasuredPromptTokens)
  return {
    currentPromptTokens,
    lastMeasuredPromptTokens: measured,
    source,
    approximate: source !== "provider",
  }
}

/** Compatibility adapter for call sites that still expose tokens + pending.
 * New runtime code should carry ContextUsageState directly. */
export function legacyContextUsage(tokens: number, pending = false): ContextUsageState {
  const normalized = finiteTokensOrNull(tokens)
  if (pending) {
    return {
      currentPromptTokens: normalized,
      lastMeasuredPromptTokens: null,
      source: "pending",
      approximate: true,
    }
  }
  return {
    currentPromptTokens: normalized,
    lastMeasuredPromptTokens: normalized,
    source: "provider",
    approximate: false,
  }
}

export function buildContextBudgetSnapshot(
  config: AppConfig,
  usage: ContextUsageState,
): ContextBudgetSnapshot {
  const limits = resolveActiveContextLimits(config)
  const normalizedUsage: ContextUsageState = {
    ...usage,
    currentPromptTokens: finiteTokensOrNull(usage.currentPromptTokens),
    lastMeasuredPromptTokens: finiteTokensOrNull(usage.lastMeasuredPromptTokens),
  }
  const current = normalizedUsage.currentPromptTokens
  const usageKnown = usage.source !== "pending" && current !== null
  const pressure = usageKnown ? current / limits.compactAt : null
  const percentUntilCompact = usageKnown
    ? Math.max(0, Math.round(((limits.compactAt - current) / limits.compactAt) * 100))
    : null

  return {
    usage: normalizedUsage,
    limits,
    remaining: {
      untilCompact: usageKnown ? Math.max(0, limits.compactAt - current) : null,
      untilHardLimit: usageKnown ? Math.max(0, limits.effectiveInputLimit - current) : null,
    },
    pressure,
    percentUntilCompact,
    severity: severityFromPressure(pressure),
  }
}

export function resolveActiveContextLimits(config: AppConfig): ContextLimits {
  const provider = getActiveProvider(config)
  const contextWindow = resolveProviderContextWindow(provider, config.active.model)
  const metadata = provider?.modelMetadata?.[config.active.model]
  const inputLimit = positiveInteger(metadata?.inputLimit)
  const derived = deriveCompaction(contextWindow)
  const budget = compactBudget({ contextWindow, inputTokenLimit: inputLimit, reservedOutputTokens: derived.reserveForOutput })!
  const { effectiveInputLimit, compactAt, keepFloorTokens } = budget
  return {
    contextWindow,
    ...(inputLimit ? { inputLimit } : {}),
    reservedOutputTokens: derived.reserveForOutput,
    safetyMarginTokens: CONTEXT_INPUT_SAFETY_MARGIN_TOKENS,
    effectiveInputLimit,
    compactAt,
    keepFloorTokens,
    source: resolveContextLimitSource(config),
  }
}

export function resolveContextLimitSource(config: AppConfig): ContextLimitSource {
  const provider = getActiveProvider(config)
  if (!provider) return "fallback"
  const mode = provider.contextWindowMode ?? inferLegacyContextWindowMode(provider)
  if (mode === "manual") return "manual"
  const metadata = provider.modelMetadata?.[config.active.model]
  if (positiveInteger(metadata?.contextWindow)) {
    return metadata?.source === "models.dev" ? "models-dev" : "provider"
  }
  const preset = provider.sourcePresetId
    ? PROVIDER_PRESETS.find(candidate => candidate.id === provider.sourcePresetId)
    : undefined
  if (positiveInteger(preset?.contextWindow)) return "preset"
  if (positiveInteger(provider.contextWindow)) return "provider"
  return "fallback"
}

export function severityFromPressure(pressure: number | null): ContextSeverity {
  if (pressure === null || !Number.isFinite(pressure)) return "unknown"
  if (pressure >= 1) return "critical"
  // These map to 60% and 70% of the effective input window when compactAt is
  // 80%, preserving the old warning cadence while using one operational ratio.
  if (pressure >= 0.875) return "warning"
  if (pressure >= 0.75) return "notice"
  return "normal"
}

function finiteTokensOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

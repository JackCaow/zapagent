import { CONTEXT_INPUT_SAFETY_MARGIN_TOKENS } from "../agent/context-limits.js";

export function deriveCompactionThresholds(contextWindow: number) {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 128000;
  const reserveForOutput = Math.min(8192, Math.max(1024, Math.floor(window * 0.10)));
  return { triggerAt: Math.floor((window - reserveForOutput) * 0.8),
    keepFloorTokens: Math.floor((window - reserveForOutput) * 0.4), reserveForOutput };
}

export interface CompactLimits {
  contextWindow?: number;
  inputTokenLimit?: number;
  reservedOutputTokens?: number;
  outputTokenCeiling?: number;
}

/** Undefined means legacy SDK mode, never an invented 128K context. */
export function compactBudget(limits: CompactLimits) {
  const value = limits.contextWindow;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const window = Math.floor(value);
  const reserved = limits.reservedOutputTokens !== undefined && Number.isFinite(limits.reservedOutputTokens)
    ? Math.max(0, Math.floor(limits.reservedOutputTokens)) : deriveCompactionThresholds(window).reserveForOutput;
  const inputLimit = limits.inputTokenLimit !== undefined && Number.isFinite(limits.inputTokenLimit)
    ? Math.max(0, Math.floor(limits.inputTokenLimit)) : Infinity;
  const effectiveInputLimit = Math.max(1, Math.floor(Math.min(window - reserved,
    inputLimit) - CONTEXT_INPUT_SAFETY_MARGIN_TOKENS));
  return { effectiveInputLimit, compactAt: Math.max(1, Math.floor(effectiveInputLimit * 0.8)),
    keepFloorTokens: Math.max(1, Math.floor(effectiveInputLimit * 0.4)), reservedOutputTokens: reserved };
}

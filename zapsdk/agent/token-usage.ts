import type { TokenUsage } from "../core/types.js";

export function sanitizeTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    inputTokens: nonNegativeFinite(usage.inputTokens),
    outputTokens: nonNegativeFinite(usage.outputTokens),
    ...(usage.usageIncomplete ? { usageIncomplete: true } : {}),
    ...(typeof usage.providerUsageReported === "boolean"
      ? { providerUsageReported: usage.providerUsageReported }
      : {}),
    ...(typeof usage.cacheReadInputTokens === "number"
      ? { cacheReadInputTokens: nonNegativeFinite(usage.cacheReadInputTokens) }
      : {}),
    ...(typeof usage.cacheCreationInputTokens === "number"
      ? { cacheCreationInputTokens: nonNegativeFinite(usage.cacheCreationInputTokens) }
      : {}),
    ...(typeof usage.cacheMissInputTokens === "number"
      ? { cacheMissInputTokens: nonNegativeFinite(usage.cacheMissInputTokens) }
      : {}),
  };
}

/** Add one provider call's usage into a run total and return the sanitized
 *  per-call usage for event emission or budget accounting. */
export function accumulateTokenUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
  const sanitized = sanitizeTokenUsage(usage);
  total.inputTokens += sanitized.inputTokens;
  total.outputTokens += sanitized.outputTokens;
  if (sanitized.usageIncomplete) total.usageIncomplete = true;
  if (sanitized.providerUsageReported === true) {
    total.providerUsageReported = true;
  } else if (
    sanitized.providerUsageReported === false &&
    total.providerUsageReported !== true
  ) {
    total.providerUsageReported = false;
  }
  if (typeof sanitized.cacheCreationInputTokens === "number") {
    total.cacheCreationInputTokens =
      (total.cacheCreationInputTokens ?? 0) + sanitized.cacheCreationInputTokens;
  }
  if (typeof sanitized.cacheReadInputTokens === "number") {
    total.cacheReadInputTokens =
      (total.cacheReadInputTokens ?? 0) + sanitized.cacheReadInputTokens;
  }
  if (typeof sanitized.cacheMissInputTokens === "number") {
    total.cacheMissInputTokens =
      (total.cacheMissInputTokens ?? 0) + sanitized.cacheMissInputTokens;
  }
  return sanitized;
}

function nonNegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

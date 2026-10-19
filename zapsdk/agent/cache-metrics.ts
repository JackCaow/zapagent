export interface CacheUsageInput {
  inputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheMissInputTokens?: number;
}

export interface CacheUsageStats {
  freshInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheMissInputTokens?: number;
  totalPromptInputTokens: number;
  /**
   * Effective prompt-cache share across all prompt input, including cache
   * creation writes. Good for cost/context accounting, but can look low during
   * warm-up when the provider is writing a large new cache block.
   */
  cacheHitRatio: number | null;
  /**
   * Reuse hit ratio over reusable prompt input only: read / (fresh + read).
   * This is the closest answer to "did the stable prompt prefix hit cache?"
   * because cache writes are reported separately as churn.
   */
  cacheReuseRatio: number | null;
  /** Share of prompt input spent writing new cache blocks. */
  cacheWriteRatio: number | null;
  /** How cache write churn was accounted. Explicit creation is used when
   * available; otherwise an automatic cache's reported miss tokens are used. */
  cacheWriteAccounting: "explicit_creation" | "automatic_miss" | null;
}

function nonNegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

export function computeCacheUsageStats(usage: CacheUsageInput): CacheUsageStats {
  const freshInputTokens = nonNegativeFinite(usage.inputTokens);
  const cacheReadInputTokens = nonNegativeFinite(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = nonNegativeFinite(usage.cacheCreationInputTokens);
  const cacheMissReported = typeof usage.cacheMissInputTokens === "number";
  const cacheMissInputTokens = cacheMissReported
    ? nonNegativeFinite(usage.cacheMissInputTokens)
    : undefined;
  const cacheCreationReported = typeof usage.cacheCreationInputTokens === "number";
  const totalPromptInputTokens =
    freshInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const reusablePromptInputTokens = freshInputTokens + cacheReadInputTokens;
  return {
    freshInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens }),
    totalPromptInputTokens,
    cacheHitRatio:
      totalPromptInputTokens > 0
        ? cacheReadInputTokens / totalPromptInputTokens
        : null,
    cacheReuseRatio:
      reusablePromptInputTokens > 0
        ? cacheReadInputTokens / reusablePromptInputTokens
        : null,
    cacheWriteRatio: cacheCreationReported
      ? (totalPromptInputTokens > 0 ? cacheCreationInputTokens / totalPromptInputTokens : null)
      : cacheMissReported
        ? ((cacheMissInputTokens! + cacheReadInputTokens) > 0
          ? cacheMissInputTokens! / (cacheMissInputTokens! + cacheReadInputTokens)
          : null)
        : null,
    cacheWriteAccounting: cacheCreationReported
      ? "explicit_creation"
      : cacheMissReported ? "automatic_miss" : null,
  };
}

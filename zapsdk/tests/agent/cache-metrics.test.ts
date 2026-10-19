import { describe, expect, it } from "bun:test";
import { computeCacheUsageStats } from "../../agent/cache-metrics.js";

describe("computeCacheUsageStats", () => {
  it("computes cache hit ratio over fresh + read + write prompt tokens", () => {
    const stats = computeCacheUsageStats({
      inputTokens: 10,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 0,
    });

    expect(stats.totalPromptInputTokens).toBe(100);
    expect(stats.cacheHitRatio).toBe(0.9);
    expect(stats.cacheReuseRatio).toBe(0.9);
    expect(stats.cacheWriteRatio).toBe(0);
  });

  it("separates reuse hit ratio from cache-write churn", () => {
    const stats = computeCacheUsageStats({
      inputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
    });

    expect(stats.totalPromptInputTokens).toBe(100);
    expect(stats.cacheHitRatio).toBe(0.8);
    expect(stats.cacheReuseRatio).toBeCloseTo(80 / 90);
    expect(stats.cacheWriteRatio).toBe(0.1);
    expect(stats.cacheWriteAccounting).toBe("explicit_creation");
  });

  it("uses provider cache misses as write churn for automatic caches", () => {
    const stats = computeCacheUsageStats({
      inputTokens: 10,
      cacheReadInputTokens: 90,
      cacheMissInputTokens: 10,
    });

    expect(stats.cacheHitRatio).toBe(0.9);
    expect(stats.cacheWriteRatio).toBe(0.1);
    expect(stats.cacheWriteAccounting).toBe("automatic_miss");
  });

  it("returns null ratio when the provider reported no prompt tokens", () => {
    const stats = computeCacheUsageStats({ inputTokens: 0 });

    expect(stats.totalPromptInputTokens).toBe(0);
    expect(stats.cacheHitRatio).toBeNull();
    expect(stats.cacheReuseRatio).toBeNull();
    expect(stats.cacheWriteRatio).toBeNull();
  });

  it("clamps negative token counts to zero", () => {
    const stats = computeCacheUsageStats({
      inputTokens: -10,
      cacheReadInputTokens: -20,
      cacheCreationInputTokens: -30,
    });

    expect(stats.freshInputTokens).toBe(0);
    expect(stats.cacheReadInputTokens).toBe(0);
    expect(stats.cacheCreationInputTokens).toBe(0);
    expect(stats.totalPromptInputTokens).toBe(0);
    expect(stats.cacheHitRatio).toBeNull();
  });

  it("ignores non-finite token counts so ratios never become NaN", () => {
    const stats = computeCacheUsageStats({
      inputTokens: Number.NaN,
      cacheReadInputTokens: Number.POSITIVE_INFINITY,
      cacheCreationInputTokens: 25,
    });

    expect(stats.freshInputTokens).toBe(0);
    expect(stats.cacheReadInputTokens).toBe(0);
    expect(stats.cacheCreationInputTokens).toBe(25);
    expect(stats.totalPromptInputTokens).toBe(25);
    expect(stats.cacheHitRatio).toBe(0);
    expect(stats.cacheReuseRatio).toBeNull();
    expect(stats.cacheWriteRatio).toBe(1);
  });
});

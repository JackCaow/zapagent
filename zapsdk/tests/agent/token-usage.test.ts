import { describe, expect, it } from "bun:test";
import { accumulateTokenUsage, sanitizeTokenUsage } from "../../agent/token-usage.js";
import type { TokenUsage } from "../../core/types.js";

describe("token usage helpers", () => {
  it("sanitizes invalid usage values while preserving reported cache zeros", () => {
    expect(sanitizeTokenUsage({
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      cacheReadInputTokens: -10,
      cacheCreationInputTokens: 0,
      providerUsageReported: true,
    })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerUsageReported: true,
    });
  });

  it("keeps omitted cache fields absent when accumulating totals", () => {
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    const sanitized = accumulateTokenUsage(total, {
      inputTokens: 12,
      outputTokens: 3,
    });

    expect(sanitized).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(total).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it("accumulates cache fields and lets provider-reported usage win over earlier synthetic misses", () => {
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    accumulateTokenUsage(total, {
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: false,
    });
    accumulateTokenUsage(total, {
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      providerUsageReported: true,
    });
    accumulateTokenUsage(total, {
      inputTokens: 7,
      outputTokens: 4,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 0,
      providerUsageReported: false,
    });

    expect(total).toEqual({
      inputTokens: 12,
      outputTokens: 6,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 10,
      providerUsageReported: true,
    });
  });
});

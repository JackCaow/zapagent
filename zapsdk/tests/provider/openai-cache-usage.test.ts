import { describe, it, expect } from "bun:test";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import type { TokenUsage } from "../../core/types.js";

function extractUsage(usage: Record<string, unknown>): TokenUsage {
  const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
  return (provider as unknown as { extractUsage: (u: unknown) => TokenUsage })
    .extractUsage(usage);
}

function extractMissingUsage(): TokenUsage {
  const provider = new OpenAICompatibleProvider({ model: "gpt-5", apiKey: "x" });
  return (provider as unknown as { extractUsage: (u: unknown) => TokenUsage })
    .extractUsage(undefined);
}

describe("OpenAICompatibleProvider cache usage normalization", () => {
  it("subtracts OpenAI cached_tokens from prompt_tokens", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 900 },
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
    expect(usage.providerUsageReported).toBe(true);
    expect(usage.cacheReadInputTokens).toBe(900);
  });

  it("normalizes camelCase OpenAI prompt token details", () => {
    const usage = extractUsage({
      promptTokens: 1000,
      completionTokens: 25,
      promptTokensDetails: { cachedTokens: 900 },
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
    expect(usage.providerUsageReported).toBe(true);
    expect(usage.cacheReadInputTokens).toBe(900);
  });

  it("normalizes mixed-case OpenAI prompt token details", () => {
    const snakeOuter = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cachedTokens: 900 },
    });
    const camelOuter = extractUsage({
      promptTokens: 1000,
      completionTokens: 25,
      promptTokensDetails: { cached_tokens: 900 },
    });

    expect(snakeOuter.inputTokens).toBe(100);
    expect(snakeOuter.cacheReadInputTokens).toBe(900);
    expect(camelOuter.inputTokens).toBe(100);
    expect(camelOuter.cacheReadInputTokens).toBe(900);
  });

  it("prefers explicit prompt_cache_miss_tokens when present", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_cache_hit_tokens: 880,
      prompt_cache_miss_tokens: 120,
    });

    expect(usage.inputTokens).toBe(120);
    expect(usage.cacheReadInputTokens).toBe(880);
    expect(usage.cacheMissInputTokens).toBe(120);
  });

  it("does not let a zero cached_tokens detail hide provider-specific cache hits", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 880,
      prompt_cache_miss_tokens: 120,
    });

    expect(usage.inputTokens).toBe(120);
    expect(usage.cacheReadInputTokens).toBe(880);
  });

  it("preserves explicit zero cache accounting when OpenAI reports it", () => {
    const usage = extractUsage({
      prompt_tokens: 321,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
    });

    expect(usage.inputTokens).toBe(321);
    expect(usage.outputTokens).toBe(12);
    expect(usage.cacheReadInputTokens).toBe(0);
  });

  it("normalizes Responses-style input token details", () => {
    const usage = extractUsage({
      input_tokens: 1000,
      output_tokens: 25,
      input_tokens_details: { cached_tokens: 900 },
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
    expect(usage.providerUsageReported).toBe(true);
    expect(usage.cacheReadInputTokens).toBe(900);
  });

  it("normalizes camelCase Responses-style input token details", () => {
    const usage = extractUsage({
      inputTokens: 1000,
      outputTokens: 25,
      inputTokensDetails: { cachedTokens: 900 },
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
    expect(usage.providerUsageReported).toBe(true);
    expect(usage.cacheReadInputTokens).toBe(900);
  });

  it("normalizes mixed-case Responses-style input token details", () => {
    const snakeOuter = extractUsage({
      input_tokens: 1000,
      output_tokens: 25,
      input_tokens_details: { cachedTokens: 900 },
    });
    const camelOuter = extractUsage({
      inputTokens: 1000,
      outputTokens: 25,
      inputTokensDetails: { cached_tokens: 900 },
    });

    expect(snakeOuter.inputTokens).toBe(100);
    expect(snakeOuter.cacheReadInputTokens).toBe(900);
    expect(camelOuter.inputTokens).toBe(100);
    expect(camelOuter.cacheReadInputTokens).toBe(900);
  });

  it("prefers prompt_tokens over input_tokens when both are present", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      input_tokens: 2000,
      completion_tokens: 25,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 900 },
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
    expect(usage.cacheReadInputTokens).toBe(900);
  });

  it("treats miss-only provider cache accounting as explicit zero cache hit", () => {
    const usage = extractUsage({
      prompt_tokens: 321,
      completion_tokens: 12,
      prompt_cache_miss_tokens: 321,
    });

    expect(usage.inputTokens).toBe(321);
    expect(usage.outputTokens).toBe(12);
    expect(usage.cacheReadInputTokens).toBe(0);
  });

  it("normalizes Anthropic-style cache fields from OpenAI-compatible proxies", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 200,
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 700,
      cacheCreationInputTokens: 200,
    });
  });

  it("treats input_tokens as fresh tail with Anthropic-style cache fields", () => {
    const usage = extractUsage({
      input_tokens: 2048,
      output_tokens: 25,
      cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 248,
    });

    expect(usage).toEqual({
      inputTokens: 2048,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 248,
    });
  });

  it("treats camelCase inputTokens as fresh tail with Anthropic-style cache fields", () => {
    const usage = extractUsage({
      inputTokens: 2048,
      outputTokens: 25,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 248,
    });

    expect(usage).toEqual({
      inputTokens: 2048,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 248,
    });
  });

  it("derives Anthropic-style cache creation from nested breakdown fields", () => {
    const usage = extractUsage({
      input_tokens: 2048,
      output_tokens: 25,
      cache_read_input_tokens: 1800,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 48,
      },
    });

    expect(usage).toEqual({
      inputTokens: 2048,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 248,
    });
  });

  it("treats prompt_tokens as fresh input when Anthropic-style cache fields exceed it", () => {
    const usage = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 25,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 200,
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 700,
      cacheCreationInputTokens: 200,
    });
  });

  it("treats prompt_tokens as fresh input when provider cache hits exceed it", () => {
    const usage = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 25,
      prompt_cache_hit_tokens: 900,
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 900,
    });
  });

  it("normalizes camelCase cache fields from JS SDK-style gateways", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      cacheReadInputTokens: 750,
      cacheCreationInputTokens: 150,
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 750,
      cacheCreationInputTokens: 150,
    });
  });

  it("normalizes camelCase prompt cache hit and miss fields from compatible gateways", () => {
    const usage = extractUsage({
      promptTokens: 1000,
      completionTokens: 25,
      promptCacheHitTokens: 875,
      promptCacheMissTokens: 125,
    });

    expect(usage).toEqual({
      inputTokens: 125,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 875,
      cacheMissInputTokens: 125,
    });
  });

  it("normalizes camelCase input and output token fields without cache accounting", () => {
    const usage = extractUsage({
      inputTokens: 321,
      outputTokens: 12,
    });

    expect(usage).toEqual({
      inputTokens: 321,
      outputTokens: 12,
      providerUsageReported: true,
    });
  });

  it("does not double-count cache creation tokens when explicit miss tokens are present", () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
      cache_creation_input_tokens: 200,
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      providerUsageReported: true,
      cacheReadInputTokens: 700,
      cacheCreationInputTokens: 200,
      cacheMissInputTokens: 300,
    });
  });

  it("keeps prompt_tokens as fresh input when no cache fields are reported", () => {
    const usage = extractUsage({
      prompt_tokens: 321,
      completion_tokens: 12,
    });

    expect(usage.inputTokens).toBe(321);
    expect(usage.outputTokens).toBe(12);
    expect(usage.providerUsageReported).toBe(true);
    expect(usage.cacheReadInputTokens).toBeUndefined();
  });

  it("derives prompt input from total_tokens when prompt fields are missing", () => {
    const usage = extractUsage({
      total_tokens: 345,
      completion_tokens: 45,
    });

    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(45);
    expect(usage.providerUsageReported).toBe(true);
  });

  it("derives prompt input from camelCase totalTokens when needed", () => {
    const usage = extractUsage({
      totalTokens: 345,
      output_tokens: 45,
    });

    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(45);
  });

  it("clamps total-token prompt fallback when output exceeds total", () => {
    const usage = extractUsage({
      total_tokens: 20,
      completion_tokens: 45,
    });

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(45);
  });

  it("marks adapter-synthesized zero usage as not provider-reported", () => {
    const usage = extractMissingUsage();

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: false,
    });
  });

  it("treats empty provider usage objects as unreported", () => {
    expect(extractUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: false,
    });
    expect(extractUsage({ service_tier: "default" })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: false,
    });
  });

  it("clamps negative usage fields to zero", () => {
    const usage = extractUsage({
      prompt_tokens: -100,
      completion_tokens: -25,
      prompt_cache_hit_tokens: -80,
      prompt_cache_miss_tokens: -20,
      cache_creation_input_tokens: -10,
    });

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheMissInputTokens: 0,
    });
  });

  it("ignores non-finite usage fields", () => {
    const usage = extractUsage({
      prompt_tokens: Number.NaN,
      completion_tokens: Number.POSITIVE_INFINITY,
      prompt_tokens_details: { cached_tokens: Number.NaN },
      prompt_cache_hit_tokens: 50,
      cache_creation_input_tokens: Number.NEGATIVE_INFINITY,
    });

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
      cacheReadInputTokens: 50,
    });
  });
});

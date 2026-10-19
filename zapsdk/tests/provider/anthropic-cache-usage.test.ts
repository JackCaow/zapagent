import { describe, expect, it } from "bun:test";
import { anthropicUsageToTokenUsage } from "../../core/providers/anthropic.js";

describe("AnthropicProvider cache usage normalization", () => {
  it("keeps cache fields absent when Anthropic omits cache accounting", () => {
    const usage = anthropicUsageToTokenUsage({
      input_tokens: 123,
      output_tokens: 7,
    });

    expect(usage).toEqual({
      inputTokens: 123,
      outputTokens: 7,
      providerUsageReported: true,
    });
  });

  it("preserves explicit zero cache accounting when Anthropic reports it", () => {
    const usage = anthropicUsageToTokenUsage({
      input_tokens: 123,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    expect(usage).toEqual({
      inputTokens: 123,
      outputTokens: 7,
      providerUsageReported: true,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("passes through non-zero cache accounting", () => {
    const usage = anthropicUsageToTokenUsage({
      input_tokens: 10,
      output_tokens: 7,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 90,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      providerUsageReported: true,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 90,
    });
  });

  it("derives cache creation from nested breakdown fields when the total is absent", () => {
    const usage = anthropicUsageToTokenUsage({
      input_tokens: 10,
      output_tokens: 7,
      cache_read_input_tokens: 90,
      cache_creation: {
        ephemeral_5m_input_tokens: 15,
        ephemeral_1h_input_tokens: 5,
      },
    });

    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      providerUsageReported: true,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 90,
    });
  });

  it("clamps negative usage fields to zero", () => {
    const usage = anthropicUsageToTokenUsage({
      input_tokens: -10,
      output_tokens: -7,
      cache_creation_input_tokens: -20,
      cache_read_input_tokens: -90,
    });

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("ignores non-finite usage fields", () => {
    const usage = anthropicUsageToTokenUsage({
      input_tokens: Number.NaN,
      output_tokens: Number.POSITIVE_INFINITY,
      cache_creation_input_tokens: Number.NEGATIVE_INFINITY,
      cache_read_input_tokens: 90,
    });

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 90,
    });
  });
});

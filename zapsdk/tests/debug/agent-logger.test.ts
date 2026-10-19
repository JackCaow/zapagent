import { describe, expect, it } from "bun:test";
import { formatUsageLogFields } from "../../debug/agent-logger.js";

describe("formatUsageLogFields", () => {
  it("does not invent cache fields when the provider omitted cache accounting", () => {
    const fields = formatUsageLogFields({
      inputTokens: 123,
    });

    expect(fields).toEqual({
      inputTokens: 123,
      totalPromptInputTokens: 123,
    });
    expect("cacheReadInputTokens" in fields).toBe(false);
    expect("cacheCreationInputTokens" in fields).toBe(false);
    expect("cacheHitRatio" in fields).toBe(false);
    expect("cacheReuseRatio" in fields).toBe(false);
    expect("cacheWriteRatio" in fields).toBe(false);
  });

  it("keeps explicit zero cache accounting when the provider reported it", () => {
    const fields = formatUsageLogFields({
      inputTokens: 123,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    expect(fields).toEqual({
      inputTokens: 123,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalPromptInputTokens: 123,
      cacheHitRatio: 0,
      cacheReuseRatio: 0,
      cacheWriteRatio: 0,
    });
  });

  it("logs whether token usage itself was provider-reported", () => {
    const fields = formatUsageLogFields({
      inputTokens: 0,
      providerUsageReported: false,
    });

    expect(fields).toEqual({
      inputTokens: 0,
      providerUsageReported: false,
      totalPromptInputTokens: 0,
    });
  });
});

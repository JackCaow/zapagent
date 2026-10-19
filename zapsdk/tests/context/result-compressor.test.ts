import { describe, expect, it } from "bun:test";
import { ResultCompressor } from "../../context/result-compressor.js";
import type { LLMProvider } from "../../core/llm.js";

describe("ResultCompressor", () => {
  it("does not split non-BMP characters when truncating single-block tool output", () => {
    const text = "😀".repeat(1000);

    const compressed = new ResultCompressor({ maxTokens: 101, headRatio: 0.5 }).compress(text);

    expect(compressed).toContain("[truncated ~");
    expect(hasUnpairedSurrogate(compressed)).toBe(false);
  });

  it("does not split non-BMP characters in summarizer input preview", async () => {
    let capturedInput = "";
    const provider: LLMProvider = {
      call: async (messages) => {
        capturedInput = messages[0]?.content ?? "";
        return {
          type: "text",
          text: "summarized",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const text = `${"a".repeat(9999)}😀tail`;

    const compressed = await new ResultCompressor({ maxTokens: 1, summarizer: provider })
      .compressWithSummary(text);

    expect(compressed).toBe("summarized");
    expect(capturedInput).toContain("Summarize the following tool output");
    expect(hasUnpairedSurrogate(capturedInput)).toBe(false);
  });

  it("passes summarizer input previews by Unicode code point budget", async () => {
    let capturedInput = "";
    const provider: LLMProvider = {
      call: async (messages) => {
        capturedInput = messages[0]?.content ?? "";
        return {
          type: "text",
          text: "summarized",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const text = `${"😀".repeat(10_000)}tail`;

    await new ResultCompressor({ maxTokens: 1, summarizer: provider })
      .compressWithSummary(text);

    expect(countOccurrences(capturedInput, "😀")).toBe(10_000);
    expect(capturedInput).not.toContain("tail");
    expect(hasUnpairedSurrogate(capturedInput)).toBe(false);
  });
});

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function countOccurrences(text: string, needle: string): number {
  return Array.from(text.matchAll(new RegExp(needle, "gu"))).length;
}

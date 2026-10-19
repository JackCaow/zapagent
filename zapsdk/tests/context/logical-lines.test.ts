import { describe, expect, it } from "bun:test";
import { ResultCompressor } from "../../context/result-compressor.js";
import { generateToolUseSummary } from "../../context/tool-use-summary.js";
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints } from "../../utils/logical-lines.js";

describe("context logical line handling", () => {
  it("summarizes CR-only tool outputs by logical lines", () => {
    const summary = generateToolUseSummary([
      {
        name: "read_file",
        arguments: { path: "src/foo.ts" },
        result: { success: true, output: "one\rtwo\rthree" },
      },
      {
        name: "search_files",
        arguments: { pattern: "cache" },
        result: { success: true, output: "hit one\rhit two\r" },
      },
      {
        name: "bash",
        arguments: { command: "printf" },
        result: { success: true, output: "first line\rsecond line" },
      },
      {
        name: "list_directory",
        arguments: { path: "." },
        result: { success: true, output: "a.ts\rb.ts\r" },
      },
    ]);

    expect(summary).toContain("read_file(src/foo.ts) → 3 lines");
    expect(summary).toContain('search_files("cache") → 2 results');
    expect(summary).toContain("bash(printf) → first line");
    expect(summary).toContain("list_directory(.) → 2 entries");
  });

  it("compresses CR-only multi-line results as multi-line text", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${"x".repeat(80)}`).join("\r");
    const compressed = new ResultCompressor({ maxTokens: 80, headRatio: 0.5 }).compress(text);

    expect(compressed).toContain("[truncated ");
    expect(compressed).toContain(" lines, ~");
    expect(compressed).toContain("line 1 ");
    expect(compressed).toContain("line 100 ");
    expect(compressed).not.toContain("\r");
  });

  it("counts non-BMP characters as one logical character", () => {
    expect("a😀b".length).toBe(4);
    expect(countCodePoints("a😀b")).toBe(3);
  });

  it("slices text heads by Unicode code point without splitting non-BMP characters", () => {
    const sliced = sliceHeadCodePoints("a😀b😀c", 4);
    expect(sliced).toBe("a😀b😀");
    expect(hasUnpairedSurrogate(sliced)).toBe(false);
  });

  it("slices text tails by Unicode code point without splitting non-BMP characters", () => {
    const sliced = sliceTailCodePoints("a😀b😀c", 4);
    expect(sliced).toBe("😀b😀c");
    expect(hasUnpairedSurrogate(sliced)).toBe(false);
  });

  it("summarizes tool output sizes by Unicode code point", () => {
    const summary = generateToolUseSummary([
      {
        name: "read_file",
        arguments: { path: "emoji.txt" },
        result: { success: true, output: "😀😀😀" },
      },
      {
        name: "custom_tool",
        arguments: { query: "emoji" },
        result: { success: true, output: "😀".repeat(101) },
      },
    ]);

    expect(summary).toContain("read_file(emoji.txt) → 1 lines, 3 chars");
    expect(summary).toContain('custom_tool("emoji") → 101 chars');
    expect(summary).not.toContain("6 chars");
    expect(summary).not.toContain("202 chars");
  });

  it("does not truncate short non-BMP tool previews by code unit", () => {
    const output = "😀".repeat(60);
    const summary = generateToolUseSummary([
      {
        name: "custom_tool",
        arguments: { query: "emoji" },
        result: { success: true, output },
      },
    ]);

    expect(countOccurrences(summary, "😀")).toBe(60);
    expect(hasUnpairedSurrogate(summary)).toBe(false);
  });
});

function countOccurrences(text: string, needle: string): number {
  return Array.from(text.matchAll(new RegExp(needle, "gu"))).length;
}

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

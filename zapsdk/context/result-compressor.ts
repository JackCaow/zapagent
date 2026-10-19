import type { LLMProvider } from "../core/llm.js";
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints, splitLogicalLines } from "../utils/logical-lines.js";
import { TokenCounter } from "./token-counter.js";

export interface ResultCompressorOptions {
  maxTokens: number;
  headRatio?: number;
  summarizer?: LLMProvider;
}

export class ResultCompressor {
  private maxTokens: number;
  private headRatio: number;
  private summarizer?: LLMProvider;
  private counter = new TokenCounter();

  constructor(options: ResultCompressorOptions) {
    this.maxTokens = options.maxTokens;
    this.headRatio = options.headRatio ?? 0.7;
    this.summarizer = options.summarizer;
  }

  /** Synchronous compression via truncation (head + tail). */
  compress(text: string): string {
    const tokens = this.counter.countText(text);
    if (tokens <= this.maxTokens) {
      return text;
    }

    return this.truncateHeadTail(text, tokens);
  }

  /** Async compression: tries LLM summary first, falls back to truncation. */
  async compressWithSummary(text: string): Promise<string> {
    const tokens = this.counter.countText(text);
    if (tokens <= this.maxTokens) {
      return text;
    }

    if (this.summarizer) {
      try {
        const response = await this.summarizer.call([
          {
            role: "user",
            content: `Summarize the following tool output concisely, preserving key facts, numbers, and actionable information:\n\n${sliceHeadCodePoints(text, 10000)}`,
          },
        ]);
        return response.text;
      } catch {
        // Fall back to truncation
      }
    }

    return this.truncateHeadTail(text, tokens);
  }

  private truncateHeadTail(text: string, totalTokens: number): string {
    const lines = splitLogicalLines(text);

    if (lines.length <= 2) {
      // Single block of text — just cut by characters
      const charBudget = Math.floor((this.maxTokens / totalTokens) * countCodePoints(text));
      const headChars = Math.floor(charBudget * this.headRatio);
      const tailChars = charBudget - headChars;

      const head = sliceHeadCodePoints(text, headChars);
      const tail = tailChars > 0 ? sliceTailCodePoints(text, tailChars) : "";

      const omitted = totalTokens - this.maxTokens;
      return `${head}\n\n[truncated ~${omitted} tokens]\n\n${tail}`;
    }

    // Multi-line: keep head lines + tail lines
    const headLineCount = Math.max(1, Math.floor(lines.length * this.headRatio * (this.maxTokens / totalTokens)));
    const tailLineCount = Math.max(1, Math.floor(lines.length * (1 - this.headRatio) * (this.maxTokens / totalTokens)));

    const headLines = lines.slice(0, headLineCount);
    const tailLines = lines.slice(-tailLineCount);

    const omittedLines = lines.length - headLineCount - tailLineCount;
    const omittedTokens = totalTokens - this.maxTokens;

    return [
      ...headLines,
      "",
      `[truncated ${omittedLines} lines, ~${omittedTokens} tokens]`,
      "",
      ...tailLines,
    ].join("\n");
  }
}

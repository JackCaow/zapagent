import type { LLMProvider, LLMCallOptions } from "../core/llm.js";
import type { Message } from "../core/types.js";
import { TokenCounter } from "./token-counter.js";
import { executeCompact, type CompactOptions, type CompactResult } from "./compact.js";
import type { AutoCompactOptions } from "./compact-summary.js";
export * from "./compact-summary.js";

/** Compatibility wrapper. Budgeted hosts share the same planner as /compact. */
export class AutoCompact {
  private readonly counter = new TokenCounter();
  constructor(private readonly options: AutoCompactOptions = {}) {}
  totalChars(messages: Message[]): number {
    return messages.reduce((sum, message) => sum + this.counter.countMessageChars(message), 0);
  }
  shouldCompact(messages: Message[]): boolean {
    return this.totalChars(messages) > (this.options.charThreshold ?? 320_000);
  }
  async compact(messages: Message[], provider: LLMProvider,
    callOptions: Pick<LLMCallOptions, "signal" | "deadline"> = {}, options: CompactOptions = {}): Promise<CompactResult> {
    try {
      return await executeCompact(messages, provider, { ...options,
        legacyKeepRecent: this.options.keepRecent ?? 10,
        legacyCharThreshold: this.options.charThreshold ?? 320_000,
        ...callOptions,
      });
    } catch (error) {
      if (callOptions.signal?.aborted && options.contextWindow !== undefined) throw error;
      return { messages, summary: "", status: "failed",
        failureReason: `summarizer failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

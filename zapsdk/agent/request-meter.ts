import type { LLMProvider, LLMCallOptions } from "../core/llm.js";
import type { Message, TokenUsage } from "../core/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { TokenCounter } from "../context/token-counter.js";
import { estimateRequestTokens } from "./call-budget.js";
import { AgentBudget } from "./budget.js";
import { computeCacheUsageStats } from "./cache-metrics.js";
import { sanitizeTokenUsage } from "./token-usage.js";
import { assertProviderRequestAllowed } from "../core/provider-deadline.js";

export class BudgetLimitError extends Error {
  constructor() { super("Agent request/tool budget exhausted; task completion remains unverified."); }
}
export type RequestPurpose = "main" | "maintenance";

/** One boundary per SDK provider invocation, outside internal HTTP retries.
 * Counts maintenance and recovery too, with a shared tree admission ledger. */
export class RequestMeter {
  calls = 0;
  blocked = false;
  private tokens = 0;
  private active = true;
  constructor(private readonly budget: AgentBudget, private readonly limits: { modelCalls?: number; tokens?: number },
    private readonly onUsage: (usage: TokenUsage, purpose: RequestPurpose) => void) {}

  close(): void { this.active = false; }
  canRequest(): boolean {
    return this.active && !this.blocked
      && !(this.budget.tokensUncertain && Number.isFinite(this.limits.tokens)) && this.calls < (this.limits.modelCalls ?? Infinity)
      && this.tokens < (this.limits.tokens ?? Infinity) && this.budget.canUseStep();
  }
  admitTool(): boolean {
    if (!this.active || this.blocked || !this.budget.useTool()) { this.blocked = true; return false; }
    return true;
  }
  private admit(provider: LLMProvider, messages: Message[], tools: ToolDefinition[] | undefined, options?: LLMCallOptions) {
    assertProviderRequestAllowed(options ?? {});
    const counter = new TokenCounter(provider.getImageTokenContext?.(options) ?? { model: options?.model });
    const estimate = estimateRequestTokens(messages, tools ?? [], counter);
    const release = this.canRequest() ? this.budget.reserveRequest(estimate) : undefined;
    if (!release) { this.blocked = true; throw new BudgetLimitError(); }
    this.calls++;
    return release;
  }
  private record(raw: TokenUsage | undefined, purpose: RequestPurpose) {
    const usage = sanitizeTokenUsage(raw ?? { inputTokens: 0, outputTokens: 0, providerUsageReported: false, usageIncomplete: true });
    if (usage.providerUsageReported === false) usage.usageIncomplete = true;
    const stats = computeCacheUsageStats(usage);
    this.tokens += stats.totalPromptInputTokens + usage.outputTokens;
    this.budget.chargeTokens(stats.totalPromptInputTokens, usage.outputTokens);
    this.budget.chargeFresh(stats.freshInputTokens + stats.cacheCreationInputTokens, !!usage.usageIncomplete);
    if (this.active) this.onUsage(usage, purpose);
  }
  wrap(inner: LLMProvider, purpose: RequestPurpose = "main"): LLMProvider {
    const meter = this;
    const wrapped: LLMProvider = {
      async call(messages, tools, options) {
        const release = meter.admit(inner, messages, tools, options);
        let reported = false;
        try {
          const result = await waitForCall(() => inner.call(messages, tools, options), options?.signal);
          reported = true; meter.record(result.usage, purpose);
          return result;
        } finally { release(); if (!reported) meter.record(undefined, purpose); }
      },
      getImageTokenContext: options => inner.getImageTokenContext?.(options) ?? { model: options?.model },
    };
    if (inner.setVisionSupported) wrapped.setVisionSupported = inner.setVisionSupported.bind(inner);
    if (inner.stream) wrapped.stream = async function* (messages, tools, options) {
      const release = meter.admit(inner, messages, tools, options);
      let reported = false;
      try {
        for await (const chunk of inner.stream!(messages, tools, options)) {
          if (chunk.type === "done" && !reported) { reported = true; meter.record(chunk.usage, purpose); }
          yield chunk;
        }
      } finally { release(); if (!reported) meter.record(undefined, purpose); }
    };
    return wrapped;
  }
}

async function waitForCall<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return action();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(action), interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

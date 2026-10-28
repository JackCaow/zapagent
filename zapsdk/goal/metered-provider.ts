import { randomUUID } from "node:crypto";
import { estimateRequestTokens } from "../agent/call-budget.js";
import { TokenCounter } from "../context/token-counter.js";
import type { LLMCallOptions, LLMProvider } from "../core/llm.js";
import type { LLMChunk, Message, TokenUsage } from "../core/types.js";
import type { ToolDefinition } from "../tools/types.js";

export type GoalMeterRole = "planner" | "worker" | "verifier" | "repair" | "maintenance" | "finalization";

/** Synchronous host-owned ledger; never exposed to a model or a tool. */
export interface GoalProviderLedger {
  reserve(goalId: string, epoch: number, input: { operationId: string; logicalCallId: string; role: GoalMeterRole; estimatedTokens: number; estimatedCostMicro: number | null; scope?: { providerId: string; modelId: string; priceRevision?: string; currency?: string } }): { ok: true; operationId: string } | { ok: false; reason: string };
  dispatch(goalId: string, epoch: number, operationId: string): { ok: true; operationId: string } | { ok: false; reason: string };
  settle(goalId: string, operationId: string, usage: { freshInputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number; costMicro: number | null; usageIncomplete?: boolean }): void;
  markUncertain(goalId: string, operationId: string): void;
}

export class GoalProviderBudgetError extends Error {
  constructor(readonly reason: string) { super(`Goal provider admission denied: ${reason}`); this.name = "GoalProviderBudgetError"; }
}

/** Wrap the provider inside RetryProvider, so each actual attempt reserves its
 * own budget. A missing usage record or abandoned stream is uncertain, never
 * silently charged as zero. Cost is unknown unless a trusted host supplies it. */
export function meterGoalProvider(inner: LLMProvider, ledger: GoalProviderLedger, context: {
  goalId: string; epoch: number; role: GoalMeterRole;
  scope?: { providerId: string; modelId: string; priceRevision?: string; currency?: string };
  estimateCost?: (usage: TokenUsage, options?: LLMCallOptions) => number | null;
  estimateRequestCost?: (tokens: number, options?: LLMCallOptions) => number | null;
}): LLMProvider {
  function start(messages: Message[], tools?: ToolDefinition[], options?: LLMCallOptions): string {
    options?.signal?.throwIfAborted();
    const operationId = randomUUID();
    const counter = new TokenCounter(inner.getImageTokenContext?.(options));
    const estimatedTokens = estimateRequestTokens(messages, tools ?? [], counter) + Math.max(0, options?.maxOutputTokens ?? 4096);
    const result = ledger.reserve(context.goalId, context.epoch, {
      operationId, logicalCallId: options?.requestId ?? operationId, role: context.role, estimatedTokens,
      estimatedCostMicro: context.estimateRequestCost?.(estimatedTokens, options) ?? null,
      ...(context.scope ? { scope: { ...context.scope, modelId: options?.model ?? context.scope.modelId } } : {}),
    });
    if (!result.ok) throw new GoalProviderBudgetError(result.reason);
    // Persist dispatched before entering the provider. If this throws no I/O is attempted.
    const dispatched = ledger.dispatch(context.goalId, context.epoch, operationId);
    if (!dispatched.ok) throw new GoalProviderBudgetError(dispatched.reason);
    return operationId;
  }
  function finish(operationId: string, usage: TokenUsage | undefined, options?: LLMCallOptions): void {
    if (!usage || usage.providerUsageReported === false) { ledger.markUncertain(context.goalId, operationId); return; }
    ledger.settle(context.goalId, operationId, {
      freshInputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationInputTokens ?? 0, outputTokens: usage.outputTokens,
      costMicro: context.estimateCost?.(usage, options) ?? null,
      ...(usage.usageIncomplete ? { usageIncomplete: true } : {}),
    });
  }
  const wrapped: LLMProvider = {
    getImageTokenContext: options => inner.getImageTokenContext?.(options) ?? { model: options?.model },
    async call(messages, tools, options) {
      const id = start(messages, tools, options);
      let finished = false;
      try {
        const response = await inner.call(messages, tools, options);
        finish(id, response.usage, options); finished = true;
        return response;
      } finally { if (!finished) ledger.markUncertain(context.goalId, id); }
    },
  };
  if (inner.stream) wrapped.stream = async function* (messages: Message[], tools?: ToolDefinition[], options?: LLMCallOptions): AsyncIterable<LLMChunk> {
    const id = start(messages, tools, options);
    let finished = false;
    try {
      for await (const chunk of inner.stream!(messages, tools, options)) {
        if (chunk.type === "done") { finish(id, chunk.usage, options); finished = true; }
        yield chunk;
      }
    } finally { if (!finished) ledger.markUncertain(context.goalId, id); }
  };
  if (inner.setVisionSupported) wrapped.setVisionSupported = supported => inner.setVisionSupported!(supported);
  return wrapped;
}

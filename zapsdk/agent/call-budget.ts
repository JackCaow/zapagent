import type { Message } from "../core/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { TokenCounter } from "../context/token-counter.js";
import { ContextOverflowError } from "../core/errors.js";
import { canonicalizeJsonSchema, zodToJsonSchema } from "../tools/schema.js";
import { CONTEXT_INPUT_SAFETY_MARGIN_TOKENS } from "./context-limits.js";

export interface CallBudgetLimits {
  contextWindow?: number;
  inputTokenLimit?: number;
  outputTokenCeiling?: number;
  reservedOutputTokens: number;
}

/** Per-request context accounting is independent of loop state and providers. */
export function computeCallBudget(messages: Message[], tools: ToolDefinition[], limits: CallBudgetLimits, counter: TokenCounter): number | undefined {
  if (!limits.contextWindow) return undefined;

  const inputTokens = estimateRequestTokens(messages, tools, counter);

  // Safety margin covers estimator drift + provider-internal special tokens.
  const margin = CONTEXT_INPUT_SAFETY_MARGIN_TOKENS;
  if (limits.inputTokenLimit !== undefined && inputTokens + margin > limits.inputTokenLimit) {
    throw new ContextOverflowError({
      inputTokens,
      reservedOutput: limits.reservedOutputTokens,
      contextWindow: limits.contextWindow,
    });
  }
  const remaining = limits.contextWindow - inputTokens - margin;

  if (remaining < limits.reservedOutputTokens) {
    throw new ContextOverflowError({
      inputTokens,
      reservedOutput: limits.reservedOutputTokens,
      contextWindow: limits.contextWindow,
    });
  }

  const ceiling = limits.outputTokenCeiling ?? remaining;
  return Math.min(ceiling, remaining);
}

/** Use the same serialized tool schemas for context and admission estimates. */
export function estimateRequestTokens(messages: Message[], tools: ToolDefinition[], counter: TokenCounter): number {
  let inputTokens = counter.countMessages(messages);
  if (tools.length > 0) {
    const toolsJson = JSON.stringify(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: canonicalizeJsonSchema(t.rawSchema ?? zodToJsonSchema(t.parameters)),
      })),
    );
    inputTokens += counter.countText(toolsJson);
  }

  return inputTokens;
}

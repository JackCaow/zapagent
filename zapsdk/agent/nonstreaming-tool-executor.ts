import type { LLMResponse } from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import { isToolAuthorization, type ToolExecutor } from "../tools/executor.js";
import { effectsToResourceClaims } from "../tools/effects.js";
import { ToolBatchScheduler } from "../scheduler/batch-scheduler.js";
import { nextContentId, type AgentEventEmitter } from "./events.js";
import type { ToolExecutionHooks, StreamingToolResult } from "./streaming-tool-executor.js";

/** Matches streaming authorization and dependency ordering for call-only providers. */
export async function executeNonStreamingTurn(
  response: LLMResponse,
  context: { executor: ToolExecutor; emitter: AgentEventEmitter; sessionId: string },
  step: number,
  signal?: AbortSignal,
  executionHooks?: ToolExecutionHooks,
): Promise<StreamingToolResult> {
  const results = new Map<string, ToolResult>();
  const toolCalls = response.toolCalls ?? [];
  // Non-streaming path: mint a textId if there's text. Loop will emit content_final
  // for it after cleaning. Skipping content_delta is intentional — non-streaming
  // responses arrive all at once, so preview animation adds no UX value.
  const textId = response.text ? nextContentId("tx") : undefined;

  for (const tc of toolCalls) {
    if (signal?.aborted) throw new Error("aborted");
    context.emitter.emit({ type: "content_final", kind: "tool_call", id: tc.id, step, toolName: tc.name, arguments: tc.arguments });
  }

  const scheduler = new ToolBatchScheduler();
  let failed = false;
  let firstError: unknown;
  const pendingResults = toolCalls.map((tc) => (async () => {
    const suppressed = tc.argumentParseError
      ? undefined
      : executionHooks?.beforeExecute?.(tc.name, tc.arguments);
    const result = tc.argumentParseError
      ? { success: false, output: "", error: tc.argumentParseError }
      : suppressed ?? await (async () => {
          const pending = context.executor.authorize(tc.name, tc.arguments, signal, {
            backgroundTaskOwner: executionHooks?.backgroundTaskOwner,
            deadlineAtMs: executionHooks?.deadlineAtMs?.(),
            sessionId: context.sessionId,
            toolCallId: tc.id,
            step,
          });
          const authorization = pending instanceof Promise ? await pending : pending;
          if (!isToolAuthorization(authorization)) return authorization;
          return scheduler.schedule(
            tc.id,
            effectsToResourceClaims(authorization.effects),
            () => context.executor.executeAuthorized(authorization, signal),
            signal,
          );
        })();
    if (!tc.argumentParseError && !suppressed) {
      executionHooks?.afterExecute?.(tc.name, tc.arguments, result);
    }
    context.emitter.emit({ type: "content_final", kind: "tool_result", id: tc.id, step, toolName: tc.name, result });
    return [tc.id, result] as const;
  })().catch((error: unknown) => {
    if (!failed) { failed = true; firstError = error; }
    throw error;
  }));
  // Admission/lifecycle callbacks can reject while compatible calls are still
  // running. Drain the batch before propagating the original control error.
  const settledResults = await Promise.allSettled(pendingResults);
  if (failed) throw firstError;
  for (const result of settledResults) {
    if (result.status === "fulfilled") results.set(...result.value);
  }

  return { text: response.text, textId, thinking: "", toolCalls, results, usage: response.usage, finishReason: response.finishReason, raw: response.raw };
}

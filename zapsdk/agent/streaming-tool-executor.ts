import type { LLMChunk, TokenUsage, ToolCallRequest } from "../core/types.js";
import type { ToolExecutionContext, ToolResult } from "../tools/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import { isToolAuthorization } from "../tools/executor.js";
import { AgentEventEmitter, nextContentId } from "./events.js";
import { effectsToResourceClaims, type ResourceClaim } from "../tools/effects.js";
import { ToolBatchScheduler } from "../scheduler/batch-scheduler.js";
// Re-exported for callers that previously imported these from this module.
// The watchdog itself moved to core/stream-idle.ts and is now applied inside
// each adapter's stream() (around the SDK iterator) — see issue #10.
export {
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
  getStreamIdleMs,
  withStreamIdleTimeout,
} from "../core/stream-idle.js";

export interface StreamingToolResult {
  text: string;
  /** Id assigned to the accumulated text piece (if any). Loop uses this to
   *  emit a cleaned content_final under the same id. */
  textId?: string;
  /** True when consumeStream already emitted content_final.text during the
   *  stream (on tool_call_start, so the UI sees text-before-tool ordering).
   *  Loop should NOT re-emit — only addMessage to conversation. */
  textFinalEmitted?: boolean;
  thinking: string;
  toolCalls: ToolCallRequest[];
  /** Completed tool results keyed by toolCallId, in call order */
  results: Map<string, ToolResult>;
  usage: TokenUsage;
  finishReason?: string;
  /** Provider-emitted sidecar bag (reasoning_content etc). Loop attaches this
   *  verbatim to the assistant Message so the next turn's serializer can
   *  spread it back into the wire request. */
  raw?: Record<string, unknown>;
}

/** Run-scoped hooks used by LoopAgent to suppress redundant read/search calls
 * before they reach policy, scheduling, or the tool handler. */
export interface ToolExecutionHooks {
  backgroundTaskOwner?: import("../tasks/lifecycle.js").BackgroundTaskOwner;
  /** Known outer execution bound, evaluated before authorization without resetting it. */
  deadlineAtMs?(): number | undefined;
  beforeExecute?(name: string, args: Record<string, unknown>): ToolResult | undefined;
  afterExecute?(name: string, args: Record<string, unknown>, result: ToolResult): void;
}

/**
 * Partial stream state attached to the aborted Error.
 *
 * Why: when a user hits Ctrl+C mid-stream, the model may have already emitted
 * text, thinking, or already-launched tool calls. If we throw and discard this
 * state, conversation history can lose both the partial assistant reply and
 * real tool side effects. Carrying the partial turn lets LoopAgent commit a
 * paired tool turn when needed, or persist a resume hint when no tool ran.
 */
export interface AbortedPartial {
  text: string;
  textId?: string;
  textFinalEmitted: boolean;
  thinking: string;
  thinkingId?: string;
  toolCalls: ToolCallRequest[];
  results: Map<string, ToolResult>;
  raw?: Record<string, unknown>;
}

export interface AbortedStreamError extends Error {
  message: "aborted";
  partial: AbortedPartial;
}

function abortError(partial: AbortedPartial): AbortedStreamError {
  const err = new Error("aborted") as AbortedStreamError;
  err.partial = partial;
  return err;
}

export function isAbortedStreamError(err: unknown): err is AbortedStreamError {
  return err instanceof Error && err.message === "aborted" && "partial" in err;
}

/** A failed response with settled tool results. This is a history checkpoint,
 * never permission to replay the original request or execute buffered args. */
export class InterruptedStreamError extends Error {
  constructor(
    cause: unknown,
    public readonly partial: StreamingToolResult,
    public readonly canContinue: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "InterruptedStreamError";
  }
}

interface InFlightTool {
  id: string;
  name: string;
  jsonBuffer: string;
  launched: boolean;
  arguments?: Record<string, unknown>;
  /** True once a cheap early-args hint has been emitted — avoids re-emitting
   *  every delta for the same value. */
  previewEmitted: boolean;
  /** Preview args (path/command/…) already emitted, carried on every progress
   *  re-emit so the row doesn't flip back to `bash(…)` when bytesHint ticks. */
  lastPreview?: Record<string, unknown>;
  /** Buffer length at the last progress re-emit. When bytes grow by more than
   *  PROGRESS_STEP_BYTES we re-emit `tool_call_pending` with the updated
   *  `bytesHint`, so the UI shows "bash(python -c … · 12KB)" while a large
   *  payload is still streaming in instead of freezing on the first preview. */
  lastProgressBytes: number;
  /** Resolves when execution completes */
  promise?: Promise<ToolResult>;
  result?: ToolResult;
  resultEmitted?: boolean;
}

/** Re-emit progress on every ~2KB of new tool-args buffered. CCB-style: for
 *  huge `python -c` / `bash -c` payloads the model streams tens of KB over
 *  20-60s; without this ticker the UI looks stuck. */
const PROGRESS_STEP_BYTES = 2048;

/**
 * Executes tool calls concurrently as their JSON arguments become complete
 * during LLM streaming, rather than waiting for the full stream to finish.
 *
 * - Tools with complete JSON start executing immediately
 * - Multiple tools run in parallel
 * - Results are collected after stream ends (no orphaned executions)
 *
 * Event protocol: emits content_delta for streaming thinking/text, emits
 * content_final for tool_call (at launch) and tool_result (at settle).
 * The loop owns content_final for thinking/text (so it can apply cleanOutput
 * to text before finalization).
 */
export class StreamingToolExecutor {
  private toolsById = new Map<string, InFlightTool>();
  /** Indexed by OpenAI delta.index for routing deltas that arrive without IDs */
  private toolsByIndex: InFlightTool[] = [];
  private order: string[] = [];
  private discarded = false;
  private currentStep = 0;
  private signal?: AbortSignal;
  /** The same resource-claim scheduler is used by streaming and non-streaming
   * provider paths. Streaming only changes when a completed call is submitted. */
  private scheduler = new ToolBatchScheduler();

  constructor(
    private executor: ToolExecutor,
    private emitter: AgentEventEmitter,
    private executionContext: Readonly<Pick<ToolExecutionContext, "sessionId">> = {},
    private executionHooks?: ToolExecutionHooks,
  ) {}

  async consumeStream(
    stream: AsyncIterable<LLMChunk>,
    step: number,
    signal?: AbortSignal,
  ): Promise<StreamingToolResult> {
    this.currentStep = step;
    this.signal = signal;
    let text = "";
    let thinking = "";
    let textId: string | undefined;
    let thinkingId: string | undefined;
    // Each "section" (thinking → text → tool_call) finalizes when the next
    // section starts. Without these guards, content_final would fire at
    // end-of-stream for thinking/text, arriving AFTER tool_call/tool_result
    // events — UI renders them in the wrong order.
    let textFinalized = false;
    let textFinalizedAt = 0;
    let thinkingFinalized = false;
    let thinkingFinalizedAt = 0;
    const finalizeThinking = (complete = false) => {
      if (thinkingId && (thinking.length > thinkingFinalizedAt || (complete && thinkingFinalized))) {
        this.emitter.emit({ type: "content_final", kind: "thinking", id: thinkingId, text: thinking.slice(thinkingFinalizedAt),
          ...(!complete ? { streamContinues: true } : {}) });
        thinkingFinalized = true;
        thinkingFinalizedAt = thinking.length;
      }
    };
    const finalizeText = (complete = false) => {
      if (textId && (text.length > textFinalizedAt || (complete && textFinalized))) {
        this.emitter.emit({ type: "content_final", kind: "text", id: textId, text: text.slice(textFinalizedAt),
          ...(!complete ? { streamContinues: true } : {}) });
        textFinalized = true;
        textFinalizedAt = text.length;
      }
    };
    let finishReason: string | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let raw: Record<string, unknown> | undefined;
    let abandonedUsage = false;
    let resetBlocked = false;
    let sawDone = false;
    let sourceFailed = false;
    async function* observeSource(): AsyncIterable<LLMChunk> {
      try { yield* stream; }
      catch (error) { sourceFailed = true; throw error; }
    }

    // The stream-idle watchdog now lives inside each adapter's stream(),
    // wrapped around the raw SDK iterator (issue #10). Wrapping here would
    // miss SSE keep-alive frames the adapter chooses to drop (Anthropic
    // `ping`, OpenAI empty-delta), causing false timeouts on healthy but
    // batched upstreams.
    try {
      for await (const chunk of observeSource()) {
        if (this.discarded || signal?.aborted) break;
        if (chunk.type !== "thinking_delta" && chunk.type !== "thinking_reset") resetBlocked = true;

        switch (chunk.type) {
          case "thinking_reset": {
            // Reject an invalid reset even if a custom provider emits one.
            // Tool calls may already have launched while the stream was open.
            if (resetBlocked || textId || this.order.length || thinkingFinalized) {
              throw new Error("Cannot reset a stream after text, tool, or completion output");
            }
            if (thinkingId) this.emitter.emit({ type: "content_abandoned", kind: "thinking",
              id: thinkingId, step, attempt: chunk.attempt, reason: chunk.reason, usageUnknown: true });
            thinking = "";
            thinkingId = undefined;
            raw = undefined;
            abandonedUsage = true;
            break;
          }
          case "thinking_delta": {
            // Preserve only provider-declared sidecars, including when a
            // response fails before done. Never invent wire reasoning fields
            // from generic thinking text (e.g. Anthropic or inline tags).
            for (const [key, value] of Object.entries(chunk.rawDelta ?? {})) {
              raw ??= {};
              raw[key] = (typeof raw[key] === "string" ? raw[key] : "") + value;
            }
            if (!thinkingId) thinkingId = nextContentId("th");
            thinking += chunk.text;
            this.emitter.emit({ type: "content_delta", kind: "thinking", id: thinkingId, text: chunk.text });
            break;
          }

          case "text_delta": {
            // Thinking ends when text starts. Finalize it so the thinking log
            // entry commits BEFORE text starts streaming in UI.
            if (!textId) finalizeThinking();
            if (!textId) textId = nextContentId("tx");
            text += chunk.text;
            this.emitter.emit({ type: "content_delta", kind: "text", id: textId, text: chunk.text });
            break;
          }

          case "tool_call_start": {
            // The model has switched from free-text / thinking preamble to
            // producing a tool call. Finalize whichever section is still open
            // so the transcript order matches what the model actually emitted.
            // Without this, thinking/text content_final fires at end-of-stream
            // — AFTER tool_call/tool_result — and the preamble renders below
            // the ✓ write_file row, which looks like the model is talking to
            // itself after the fact.
            finalizeThinking();
            finalizeText();

            const tool: InFlightTool = {
              id: chunk.toolCallId,
              name: chunk.toolName,
              jsonBuffer: "",
              launched: false,
              previewEmitted: false,
              lastProgressBytes: 0,
            };
            this.toolsById.set(chunk.toolCallId, tool);
            if (chunk.toolCallIndex !== undefined) {
              this.toolsByIndex[chunk.toolCallIndex] = tool;
            } else {
              this.toolsByIndex.push(tool);
            }
            this.order.push(chunk.toolCallId);
            // Surface the tool name immediately so UI can show "generating <tool>…"
            // while the JSON body is still streaming. Without this, large payloads
            // (e.g. write_file of a 18k-char markdown) look like a frozen app
            // until tryLaunch fires — which only happens after the buffer
            // completes, often 30s+ later.
            this.emitter.emit({
              type: "tool_call_pending",
              id: chunk.toolCallId,
              step: this.currentStep,
              toolName: chunk.toolName,
            });
            break;
          }

          case "tool_call_delta": {
            const tool =
              this.toolsById.get(chunk.toolCallId) ??
              (chunk.toolCallIndex !== undefined
                ? this.toolsByIndex[chunk.toolCallIndex]
                : this.toolsByIndex[this.toolsByIndex.length - 1]);

            if (tool && !tool.launched) {
              tool.jsonBuffer += chunk.partialJson;

              // Snag a human-readable arg preview (path / command / query / url)
              // from the partial JSON. Models typically emit these keys BEFORE
              // the big `content` body, so we can render
              //   write_file(report.md)
              // within ~100ms of tool_call_start, instead of making the user
              // stare at `write_file(…)` for 30s while `content` streams in.
              // One-shot per tool: once emitted, we don't re-match.
              let previewJustFired = false;
              if (!tool.previewEmitted) {
                const preview = extractEarlyArgPreview(tool.jsonBuffer);
                if (preview) {
                  tool.previewEmitted = true;
                  tool.lastPreview = preview;
                  previewJustFired = true;
                }
              }

              // Re-emit pending when: preview JUST became available, OR the
              // buffer has grown by ≥ PROGRESS_STEP_BYTES since the last emit.
              // Progress fires independently of whether a preview key was found,
              // so the UI shows "bash(… · 18KB)" even if the model buried
              // `command` past the first 2KB of escapes.
              const grewEnough =
                tool.jsonBuffer.length - tool.lastProgressBytes >= PROGRESS_STEP_BYTES;
              if (previewJustFired || grewEnough) {
                tool.lastProgressBytes = tool.jsonBuffer.length;
                this.emitter.emit({
                  type: "tool_call_pending",
                  id: tool.id,
                  step: this.currentStep,
                  toolName: tool.name,
                  argsPreview: tool.lastPreview,
                  bytesHint: tool.jsonBuffer.length,
                });
              }

              if (tool.jsonBuffer.trimEnd().endsWith("}")) {
                this.tryLaunch(tool);
              }
            }
            break;
          }

          case "done":
            sawDone = true;
            usage = abandonedUsage ? { ...chunk.usage, usageIncomplete: true } : chunk.usage;
            finishReason = chunk.finishReason;
            if (chunk.raw) raw = chunk.raw;
            break;
        }
      }
    } catch (error) {
      finalizeThinking(true);
      finalizeText(true);
      const partial = { text, textId, textFinalEmitted: textFinalized, thinking, thinkingId, raw };
      if (signal?.aborted) throw await this.buildAbortError(partial);
      // Thinking-only failures retain RetryProvider's existing bounded retry
      // behavior. No extra agent-level retry layer for exhausted requests.
      if (!textId && !this.order.length) throw error;
      const settled = await this.collectInterruptedPartial(partial,
        "Provider response interrupted; this tool was not executed. Re-issue only if still needed.");
      // Cancellation may arrive while waiting for an already-started tool.
      if (signal?.aborted) throw abortError(settled);
      throw new InterruptedStreamError(error, {
        ...settled,
        usage: { ...usage, ...(!sawDone ? { providerUsageReported: false, usageIncomplete: true } : {}) },
        finishReason,
      }, sourceFailed && !sawDone);
    }

    // Stream ended without a tool_call_start (pure text or pure thinking
    // response). Catch any sections that weren't finalized yet in-loop. The
    // finalize* helpers no-op if already called, so this is idempotent.
    finalizeThinking(true);
    if (textFinalized || signal?.aborted) finalizeText(true);
    // Note: text is intentionally NOT finalized here — when there are no
    // tool calls, loop.ts applies cleanOutput to strip XML-style markup
    // before emitting. Finalizing raw text here would double-emit. The
    // textFinalEmitted flag below tells the loop which path was used.

    if (signal?.aborted) {
      throw await this.buildAbortError({
        text,
        textId,
        textFinalEmitted: textFinalized,
        thinking,
        thinkingId,
        raw,
      });
    }

    // End-of-stream last-chance launch. allowEmptyArgs=true lets tools with
    // `z.object({})` schemas (like enter_plan_mode) run even when neither
    // provider emitted an input_json_delta / arguments string — see the
    // tryLaunch body for the full contract.
    for (const tool of this.toolsByIndex) {
      if (!tool) continue;
      this.tryLaunch(tool, true);
    }

    const results = new Map<string, ToolResult>();
    const toolCalls: ToolCallRequest[] = [];

    for (const id of this.order) {
      if (signal?.aborted) {
        throw await this.buildAbortError({
          text,
          textId,
          textFinalEmitted: textFinalized,
          thinking,
          thinkingId,
          raw,
        });
      }
      const tool = this.toolsById.get(id);
      if (!tool) continue;

      const args = tool.arguments ?? parseObjectArgs(tool.jsonBuffer).arguments;

      toolCalls.push({ id, name: tool.name, arguments: args });

      if (tool.promise) {
        const result = tool.result ?? await tool.promise;
        if (signal?.aborted) {
          throw await this.buildAbortError({
            text,
            textId,
            textFinalEmitted: textFinalized,
            thinking,
            thinkingId,
            raw,
          });
        }
        results.set(id, result);
        this.emitToolResult(tool, result);
      } else {
        // tryLaunch never fired (JSON never parsed cleanly — stream cut, model
        // emitted malformed args, etc.). The SDK's processNativeToolCalls
        // catches this case via the absent `results` entry and synthesizes a
        // failure ToolResult through buildToolTurn so conversation history
        // pairs by construction. But the UI never sees that synthesis — it
        // only listens to events. Without an explicit `tool_result` here,
        // the row stays at `·` until runAgent's finally cleanup kicks in
        // (often many turns later, since the loop happily continues), so
        // the user observes write_file/multi_edit pending forever.
        // Emit the same shape + reason the SDK would synthesize.
        const failure: ToolResult = {
          success: false,
          output: "",
          error: "stream truncated before this tool finished — re-issue the call if still needed",
        };
        this.emitter.emit({
          type: "content_final",
          kind: "tool_result",
          id,
          step,
          toolName: tool.name,
          result: failure,
        });
      }
    }

    return { text, textId, textFinalEmitted: textFinalized, thinking, toolCalls, results, usage, finishReason, raw };
  }

  private async buildAbortError(
    partial: Omit<AbortedPartial, "toolCalls" | "results">,
  ): Promise<AbortedStreamError> {
    return abortError(await this.collectInterruptedPartial(partial));
  }

  private async collectInterruptedPartial(
    partial: Omit<AbortedPartial, "toolCalls" | "results">,
    unlaunchedReason?: string,
  ): Promise<AbortedPartial> {
    const toolCalls: ToolCallRequest[] = [];
    const results = new Map<string, ToolResult>();
    for (const id of this.order) {
      const tool = this.toolsById.get(id);
      if (!tool) continue;
      const args = tool.arguments ?? parseObjectArgs(tool.jsonBuffer).arguments;
      toolCalls.push({ id, name: tool.name, arguments: args });
      if (!tool.launched) {
        if (unlaunchedReason) {
          const failure: ToolResult = { success: false, output: "", error: unlaunchedReason };
          results.set(id, failure);
          this.emitter.emit({ type: "content_final", kind: "tool_call", id,
            step: this.currentStep, toolName: tool.name, arguments: args });
          this.emitToolResult(tool, failure);
        }
        continue;
      }

      let result = tool.result;
      if (!result && tool.promise) {
        try {
          result = await tool.promise;
        } catch (err) {
          result = {
            success: false,
            output: "",
            error: err instanceof Error ? err.message : String(err),
          };
          tool.result = result;
        }
      }
      if (!result) {
        result = { success: false, output: "", error: "aborted" };
        tool.result = result;
      }
      results.set(id, result);
      this.emitToolResult(tool, result);
    }
    return { ...partial, toolCalls, results };
  }

  private emitToolResult(tool: InFlightTool, result: ToolResult): void {
    if (tool.resultEmitted || this.discarded) return;
    tool.resultEmitted = true;
    this.emitter.emit({
      type: "content_final",
      kind: "tool_result",
      id: tool.id,
      step: this.currentStep,
      toolName: tool.name,
      result,
    });
  }

  private tryLaunch(tool: InFlightTool, allowEmptyArgs = false): void {
    if (this.discarded || tool.launched || this.signal?.aborted) return;

    // Two paths into args parsing:
    //   • mid-stream: only fire when the buffer ends with `}` (caller's
    //     responsibility). On empty buffer, return without launching —
    //     the model may still be about to emit `tool_call_delta`s.
    //   • end-of-stream (allowEmptyArgs=true): empty buffer means the
    //     provider's contract for a no-args tool finished —
    //       Anthropic — `content_block_start` carries `input:{}` and
    //         emits no `input_json_delta` events (nothing to stream).
    //       OpenAI-compat — sends `arguments:""` or omits the field
    //         entirely.
    //     Both adapters only accumulate into jsonBuffer on delta events,
    //     so the buffer stays "" — but the model's intent is `{}`. Treat
    //     it as such and let the tool's zod schema decide: tools with
    //     `z.object({})` (e.g. enter_plan_mode) accept it; tools with
    //     required fields produce a real "Invalid arguments" error
    //     instead of the misleading "stream truncated" synthesis the
    //     model would otherwise see and retry forever on.
    const trimmed = tool.jsonBuffer.trim();
    let args: Record<string, unknown>;
    if (trimmed === "") {
      if (!allowEmptyArgs) return;
      args = {};
    } else {
      const parsed = parseObjectArgs(trimmed);
      if (!parsed.complete) return;
      args = parsed.arguments;
      if (parsed.parseError) {
        tool.arguments = args;
        tool.launched = true;
        const failure: ToolResult = {
          success: false,
          output: "",
          error: parsed.parseError,
        };
        tool.result = failure;
        tool.promise = Promise.resolve(failure);
        this.emitter.emit({
          type: "content_final",
          kind: "tool_call",
          id: tool.id,
          step: this.currentStep,
          toolName: tool.name,
          arguments: args,
        });
        return;
      }
    }

    tool.arguments = args;
    tool.launched = true;
    this.emitter.emit({
      type: "content_final",
      kind: "tool_call",
      id: tool.id,
      step: this.currentStep,
      toolName: tool.name,
      arguments: args,
    });
    const executionContext = {
      ...this.executionContext,
      backgroundTaskOwner: this.executionHooks?.backgroundTaskOwner,
      deadlineAtMs: this.executionHooks?.deadlineAtMs?.(),
      toolCallId: tool.id,
      step: this.currentStep,
    };
    tool.promise = (async (): Promise<ToolResult> => {
      const suppressed = this.executionHooks?.beforeExecute?.(tool.name, args);
      if (suppressed) {
        tool.result = suppressed;
        return suppressed;
      }
      const finish = (result: ToolResult): ToolResult => {
        this.executionHooks?.afterExecute?.(tool.name, args, result);
        tool.result = result;
        return result;
      };
      if (typeof this.executor.authorize !== "function" || typeof this.executor.executeAuthorized !== "function") {
        return this.scheduler.schedule(
          tool.id,
          this.resourceClaimsFor(tool.name, args),
          () => this.executor.execute(tool.name, args, this.signal, executionContext),
          this.signal,
        ).then(finish);
      }
      const pending = this.executor.authorize(tool.name, args, this.signal, executionContext);
      const authorization = pending instanceof Promise ? await pending : pending;
      if (!isToolAuthorization(authorization)) {
        return finish(authorization);
      }
      return this.scheduler.schedule(
        tool.id,
        effectsToResourceClaims(authorization.effects),
        () => this.executor.executeAuthorized(authorization, this.signal),
        this.signal,
      ).then(finish);
    })().catch((error: unknown): ToolResult => {
      // Attach a rejection handler immediately: a tool can fail while the
      // provider is still streaming (or while other results are settling).
      const result = { success: false, output: "",
        error: error instanceof Error ? error.message : String(error) };
      tool.result = result;
      return result;
    });
  }

  private resourceClaimsFor(name: string, args: Record<string, unknown>): ResourceClaim[] {
    if (typeof this.executor.resolveEffects === "function") {
      return effectsToResourceClaims(this.executor.resolveEffects(name, args));
    }
    // Test/custom executor compatibility while embedders migrate to effects.
    return this.executor.isReadOnly?.(name, args)
      ? [{ key: "runtime:legacy-read", mode: "shared" }]
      : [{ key: "global:unknown", mode: "exclusive" }];
  }

  discard(): void {
    this.discarded = true;
  }
}

/**
 * Cheap regex scan over incomplete tool_call JSON to pull out the
 * first user-facing argument — whichever of path/command/query/url/pattern
 * appears first and is a string. Returns a partial args object or null.
 *
 * Why regex and not partial JSON parse: the tool_call body arrives as raw
 * text deltas, and a proper partial parse on every delta is O(n²) work
 * (Claude Code explicitly avoids this). A single regex per delta is O(n)
 * and runs once per tool (gated by `previewEmitted`).
 */
function extractEarlyArgPreview(buf: string): Record<string, string> | null {
  // Order matters: we stop at the first match. Prefer human-addressable keys.
  const keys = ["path", "file_path", "filePath", "command", "query", "url", "pattern"] as const;
  for (const key of keys) {
    // Match `"key": "value"` with support for backslash-escaped chars inside.
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`);
    const m = buf.match(re);
    if (m) return { [key === "file_path" || key === "filePath" ? "path" : key]: unescapeJson(m[1]) };
  }
  return null;
}

function unescapeJson(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseObjectArgs(json: string): {
  complete: boolean;
  arguments: Record<string, unknown>;
  parseError?: string;
} {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { complete: true, arguments: parsed as Record<string, unknown> };
    }
    return {
      complete: true,
      arguments: {},
      parseError: "Tool arguments JSON must be an object.",
    };
  } catch {
    return { complete: false, arguments: {} };
  }
}

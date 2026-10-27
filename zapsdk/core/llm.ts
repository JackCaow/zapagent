import type { RequestCacheShape } from "../context/request-cache.js";
import type { ImageTokenContext } from "../context/image-tokens.js";
import type { LLMResponse, LLMChunk, Message } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

/** Local request telemetry; never serialized into the model prompt. */
export interface ProviderRequestEvent {
  phase: "requesting" | "waiting_output" | "streaming" | "retrying" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  at: number;
  elapsedMs: number;
  reason?: string;
  /** Actual JSON UTF-8 body bytes, measured by the adapter before SDK I/O. */
  requestBytes?: number;
  requestFingerprint?: string;
  /** Bounded digests of the adapter-serialized request; never provider hit data. */
  cacheShape?: RequestCacheShape;
  delayMs?: number;
  /** Snapshot of streamed output observed in this attempt. Times are measured
   * from request start; counts use JS string lengths, not tokens or bytes.
   * Tool output here means protocol output, not validated/executed work.
   * Absent for non-streaming calls; contains no model text or arguments. */
  output?: {
    firstThinkingMs?: number;
    firstTextMs?: number;
    firstToolCallMs?: number;
    thinkingChars: number;
    textChars: number;
    toolArgumentChars: number;
  };
}

/** Per-call overrides — lets callers temporarily swap model without
 *  instantiating a new provider. Used by subagents that want to run on a
 *  cheaper model (e.g. Haiku for explore) while the main agent stays on
 *  the default. Providers that don't support overrides fall back to their
 *  constructor-bound defaults. */
export interface LLMCallOptions {
  /** Override model id for this single call. Provider-specific format. */
  model?: string;
  /** Override `max_tokens` for this single call. LoopAgent uses this to
   *  dynamically cap output budget based on remaining context room, so
   *  `input + max_tokens ≤ contextWindow` always holds. When omitted, the
   *  provider falls back to its constructor-bound maxTokens. */
  maxOutputTokens?: number;
  /** Cancellation signal. Adapters wrap the SDK chunk iterator with the
   *  stream-idle watchdog and race against this signal so Ctrl+C during a
   *  stall cancels in one tick. Also forwarded to the SDK request itself
   *  by adapters that support it. */
  signal?: AbortSignal;
  /** Absolute admission deadline shared by retries and recovery calls.
   * `now` uses the caller's clock domain; omitted means Date.now.
   * Cancellation timers still bound in-flight I/O. Never sent to the model. */
  deadline?: { atMs: number; now?: () => number };
  /** Optional stop sequences for one-off calls such as MCP sampling. */
  stopSequences?: string[];
  /** HTTP establishment deadline (default 60s, ZAPCODE_REQUEST_TIMEOUT_MS).
   * For non-streaming calls this bounds the complete response. */
  requestTimeoutMs?: number;
  /** First meaningful output after response headers (default 180s,
   * ZAPCODE_FIRST_OUTPUT_TIMEOUT_MS). Empty deltas/pings do not satisfy it. */
  firstOutputTimeoutMs?: number;
  /** Consumer understands thinking_reset and can discard an unfinished
   * reasoning-only attempt. Text/tool output always disables stream replay. */
  allowThinkingRetry?: boolean;
  onRequestEvent?: (event: ProviderRequestEvent) => void;
  /** RetryProvider supplies this metadata to each adapter attempt. */
  requestAttempt?: { attempt: number; maxAttempts: number };
}

export interface LLMProvider {
  /** Local budget metadata, including per-call model overrides. Never sent on wire. */
  getImageTokenContext?(options?: LLMCallOptions): ImageTokenContext;
  call(
    messages: Message[],
    tools?: ToolDefinition[],
    opts?: LLMCallOptions,
  ): Promise<LLMResponse>;
  stream?(
    messages: Message[],
    tools?: ToolDefinition[],
    opts?: LLMCallOptions,
  ): AsyncIterable<LLMChunk>;
  /** Inform the provider that the active model rejects image content blocks.
   *  Subsequent calls should strip images at serialize time (replace with a
   *  text breadcrumb). Called by LoopAgent's runtime fallback after a 400
   *  image rejection. Optional — providers without multimodal support can
   *  omit; the loop falls back to bubbling the error. */
  setVisionSupported?(supported: boolean): void;
}

/** Wrap a provider so every call automatically includes a model override.
 *  Used by LoopAgent when `modelOverride` is set — avoids editing every
 *  call site inside the loop. Preserves other LLMCallOptions fields the
 *  caller passes (notably maxOutputTokens from the budget planner). */
export function withModelOverride(inner: LLMProvider, model: string): LLMProvider {
  const wrapped: LLMProvider = {
    call: (msgs, tools, opts) => inner.call(msgs, tools, { ...opts, model }),
    getImageTokenContext: (opts) => inner.getImageTokenContext?.({ ...opts, model }) ?? { model },
  };
  if (inner.stream) {
    // Spread `opts` first (carries `signal`, `maxOutputTokens`) then set model
    // — order matters for the override semantics, signal/maxOutputTokens flow
    // through unchanged.
    wrapped.stream = (msgs, tools, opts) => inner.stream!(msgs, tools, { ...opts, model });
  }
  if (inner.setVisionSupported) {
    wrapped.setVisionSupported = (s) => inner.setVisionSupported!(s);
  }
  return wrapped;
}

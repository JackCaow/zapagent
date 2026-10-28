import type { LLMProvider, LLMCallOptions } from "./llm.js";
import { randomUUID } from "node:crypto";
import type { LLMResponse, LLMChunk, Message } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";
import { hasMeaningfulOutput, notifyProviderRequest, ProviderRequestTimeoutError } from "./provider-request.js";
import { isStreamIdleTimeoutError } from "./stream-idle.js";
import { assertProviderRequestAllowed } from "./provider-deadline.js";

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error) => void;
}

/** Kept as a re-export for callers that imported it. `signal` is now part of
 *  LLMCallOptions itself so adapters can plumb it into the stream-idle
 *  watchdog (see issue #10). */
export type CallOptions = LLMCallOptions;

export class RetryProvider implements LLMProvider {
  private inner: LLMProvider;
  private maxRetries: number;
  private initialDelayMs: number;
  private maxDelayMs: number;
  private backoffMultiplier: number;
  private retryableErrors?: string[];
  private onRetry?: (attempt: number, error: Error) => void;

  constructor(inner: LLMProvider, options: RetryOptions) {
    this.inner = inner;
    this.maxRetries = options.maxRetries;
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.retryableErrors = options.retryableErrors;
    this.onRetry = options.onRetry;
  }

  getImageTokenContext(options?: LLMCallOptions) {
    return this.inner.getImageTokenContext?.(options) ?? { model: options?.model };
  }

  async call(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: CallOptions
  ): Promise<LLMResponse> {
    let lastError: Error | undefined;
    options = { ...options, requestId: options?.requestId ?? randomUUID() };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      assertProviderRequestAllowed(options);

      try {
        // Forward the full options slice (model, maxOutputTokens, signal) so
        // the inner adapter can plumb signal into the stream-idle watchdog.
        // The retry layer also reads `signal` for its own pre-attempt /
        // backoff-cancel checks.
        return await this.inner.call(messages, tools, this.attemptOptions(options, attempt));
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (options?.signal?.aborted || !this.isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt >= this.maxRetries) {
          throw lastError;
        }

        assertProviderRequestAllowed(options);

        const delay = Math.min(
          this.initialDelayMs * Math.pow(this.backoffMultiplier, attempt),
          this.maxDelayMs
        );
        this.reportRetry(options, attempt, lastError, delay);
        await this.sleep(delay, options?.signal);
      }
    }

    throw lastError!;
  }

  async *stream(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: CallOptions,
  ): AsyncIterable<LLMChunk> {
    if (!this.inner.stream) {
      throw new Error("Inner provider does not support streaming");
    }
    // Partial reasoning can be abandoned only by an explicitly capable
    // consumer. Any text/tool/protocol output makes replay unsafe.
    let lastError: Error | undefined;
    options = { ...options, requestId: options?.requestId ?? randomUUID() };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      assertProviderRequestAllowed(options);
      let producedOutput = false;
      let reasoningOnly = true;
      try {
        for await (const chunk of this.inner.stream(messages, tools, this.attemptOptions(options, attempt))) {
          if (chunk.type !== "thinking_delta") reasoningOnly = false;
          producedOutput ||= hasMeaningfulOutput(chunk) || chunk.type === "done";
          yield chunk;
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!reasoningOnly || (producedOutput && !options?.allowThinkingRetry)
          || options?.signal?.aborted || !this.isRetryable(lastError) || attempt >= this.maxRetries) throw lastError;
        assertProviderRequestAllowed(options);
        if (producedOutput) {
          yield { type: "thinking_reset", attempt: attempt + 1,
            reason: this.retryReason(lastError) };
        }
        const delay = Math.min(
          this.initialDelayMs * Math.pow(this.backoffMultiplier, attempt),
          this.maxDelayMs
        );
        this.reportRetry(options, attempt, lastError, delay);
        await this.sleep(delay, options?.signal);
      }
    }
    throw lastError!;
  }

  private isRetryable(error: Error): boolean {
    return isRetryableProviderError(error, this.retryableErrors);
  }

  private attemptOptions(options: CallOptions | undefined, attempt: number): CallOptions {
    return { ...options, requestAttempt: { attempt: attempt + 1, maxAttempts: this.maxRetries + 1 } };
  }

  private reportRetry(options: CallOptions | undefined, attempt: number, error: Error, delayMs: number): void {
    this.onRetry?.(attempt + 1, error);
    const at = Date.now();
    notifyProviderRequest(options, { phase: "retrying", attempt: attempt + 2,
      maxAttempts: this.maxRetries + 1, startedAt: at, at, elapsedMs: 0, delayMs,
      reason: this.retryReason(error) });
  }

  private retryReason(error: Error): string {
    if (error instanceof ProviderRequestTimeoutError) return error.code;
    if (isStreamIdleTimeoutError(error)) return "STREAM_IDLE_TIMEOUT";
    const status = (error as Error & { status?: number }).status;
    return typeof status === "number" ? `HTTP_${status}` : "CONNECTION_ERROR";
  }

  setVisionSupported(supported: boolean): void {
    this.inner.setVisionSupported?.(supported);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Provider retry cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Shared classification; callers still own replay safety and recovery limits. */
export function isRetryableProviderError(error: Error, retryableErrors?: string[]): boolean {
  if (error.name === "AbortError" || /\b(aborted|cancelled|canceled)\b/i.test(error.message)) return false;
  const status = (error as Error & { status?: number }).status;
  if (typeof status === "number") {
    if (![408, 409, 429].includes(status) && !(status >= 500 && status < 600)) return false;
    if (!retryableErrors) return true;
  }
  if (!retryableErrors) {
    if (error instanceof ProviderRequestTimeoutError) return true;
    return /connection|network|fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN|timeout|timed out/i.test(`${error.name} ${error.message}`);
  }
  return retryableErrors.some((pattern) =>
    error.message.toLowerCase().includes(pattern.toLowerCase())
  );
}

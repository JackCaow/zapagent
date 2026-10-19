import type { LLMCallOptions } from "./llm.js";

/** Timers can be delayed by suspension or a busy event loop. Check at every
 * request boundary as well; expiry is terminal, not a retryable HTTP timeout. */
export function assertProviderRequestAllowed(options?: LLMCallOptions): void {
  options?.signal?.throwIfAborted();
  const deadline = options?.deadline;
  if (deadline && Number.isFinite(deadline.atMs) && (deadline.now ?? Date.now)() >= deadline.atMs) {
    throw new DOMException("Provider execution deadline exceeded", "AbortError");
  }
}

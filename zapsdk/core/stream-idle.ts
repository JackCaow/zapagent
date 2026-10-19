/**
 * Stream-idle watchdog: aborts an SSE/streamed response when the underlying
 * source stops yielding chunks for too long. Lives in core/ (not in any one
 * provider) because every adapter needs it AND the executor used to share
 * the same wrap before it was pushed down. See issue #10 for the rationale:
 * wrapping the *adapter's typed yield* (LLMChunk) instead of the *raw SDK
 * iterator* silently dropped provider keep-alive frames (Anthropic `ping`,
 * OpenAI empty-delta) and produced false timeouts. The fix is for each
 * adapter to wrap the SDK iterator directly inside `stream()` so any frame
 * the SDK sees — typed-yield-worthy or not — counts as liveness.
 */

/** Default hard ceiling for time between SDK chunks. Bumped from 90s → 180s
 *  in v1.6.5 as a band-aid for misplaced wrap; still sensible as the real
 *  default once the wrap is at the SDK layer. Overridable via env var. */
const DEFAULT_STREAM_IDLE_MS = 180_000;

export function getStreamIdleMs(raw?: string): number {
  raw = arguments.length === 0 ? process.env.ZAPCODE_STREAM_IDLE_MS : raw;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_MS;
}

/**
 * Thrown by `withStreamIdleTimeout` when the upstream stalls. Separate class
 * so callers can distinguish "watchdog fired" from "provider 500'd" and show
 * a targeted message — the whole point of the watchdog is that the user
 * knows *why* the stream ended.
 */
export class StreamIdleTimeoutError extends Error {
  constructor(public readonly idleMs: number) {
    super(`stream idle timeout after ${idleMs}ms — no chunk received`);
    this.name = "StreamIdleTimeoutError";
  }
}

export function isStreamIdleTimeoutError(err: unknown): err is StreamIdleTimeoutError {
  return err instanceof StreamIdleTimeoutError
    || (err instanceof Error && err.name === "StreamIdleTimeoutError");
}

/**
 * Watchdog wrapper: aborts the iterator if no value arrives within `idleMs`.
 * Distinct from any HTTP request timeout — this catches half-open connections
 * where the socket stays up but bytes stop flowing.
 *
 * Also races against `signal` (when provided) so a Ctrl+C during a stall
 * cancels within one tick rather than waiting up to `idleMs`.
 *
 * Apply this around the *raw SDK iterator* inside an adapter's `stream()`,
 * NOT around the adapter's typed yield — the latter loses the SDK keep-alive
 * frames the adapter chooses to drop.
 */
const ABORT_SENTINEL = Symbol("stream-abort");
export async function* withStreamIdleTimeout<T>(
  src: AsyncIterable<T>,
  idleMs: number,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const iter = src[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal?.aborted) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamIdleTimeoutError(idleMs)), idleMs);
      });
      // Signal abort: resolve (not reject) with a sentinel so we can cleanly
      // `return` from the generator. Throwing `Error("aborted")` here would
      // bypass downstream abort paths that look for a partial-state error.
      const abortPromise = signal
        ? new Promise<typeof ABORT_SENTINEL>((resolve) => {
            abortListener = () => resolve(ABORT_SENTINEL);
            signal.addEventListener("abort", abortListener, { once: true });
          })
        : null;
      try {
        const races: Promise<IteratorResult<T> | typeof ABORT_SENTINEL | never>[] = [iter.next(), timeout];
        if (abortPromise) races.push(abortPromise);
        const result = await Promise.race(races);
        if (result === ABORT_SENTINEL) return;
        const ir = result as IteratorResult<T>;
        if (ir.done) return;
        yield ir.value;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      }
    }
  } finally {
    iter.return?.().catch(() => {});
  }
}

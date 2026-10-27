import { requestCacheShape } from "../context/request-cache.js";
import type { LLMCallOptions, ProviderRequestEvent } from "./llm.js";
import type { LLMChunk } from "./types.js";
import { assertProviderRequestAllowed } from "./provider-deadline.js";
import { createHash } from "node:crypto";
import { RequestBodyLimitError } from "./errors.js";

export function notifyProviderRequest(opts: LLMCallOptions | undefined, event: ProviderRequestEvent): void {
  // Observability callbacks must not break cancellation or transport cleanup.
  try { opts?.onRequestEvent?.(event); } catch {}
}

export class ProviderRequestTimeoutError extends Error {
  constructor(public readonly code: "REQUEST_TIMEOUT" | "FIRST_OUTPUT_TIMEOUT", ms: number) {
    super(`${code}: provider timed out after ${ms}ms`);
    this.name = "ProviderRequestTimeoutError";
  }
}

function timeoutMs(value: number | string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 2_147_483_647 ? Math.ceil(number) : fallback;
}

export function hasMeaningfulOutput(chunk: LLMChunk): boolean {
  if (chunk.type === "text_delta" || chunk.type === "thinking_delta") return chunk.text.length > 0;
  if (chunk.type === "tool_call_delta") return chunk.partialJson.length > 0;
  return chunk.type === "tool_call_start" || chunk.type === "tool_call_end";
}

/** Starts BEFORE SDK I/O, aborts the transport, and bounds even transports
 * that ignore cancellation. The existing raw-frame idle guard stays separate. */
export class ProviderRequest {
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private startedAt = Date.now();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private responded = false;
  private producedOutput = false;
  private lastOutputEventAt = 0;
  private output?: ProviderRequestEvent["output"];
  private requestBytes?: number;
  private requestFingerprint?: string;
  private cacheShape?: ProviderRequestEvent["cacheShape"];
  private cacheShapeEmitted = false;
  private rejectWait!: (error: Error) => void;
  private failure = new Promise<never>((_, reject) => { this.rejectWait = reject; });
  private abort = () => this.fail(new DOMException("Provider request cancelled", "AbortError"));

  constructor(private opts?: LLMCallOptions) {
    assertProviderRequestAllowed(opts);
    // There may be a synchronous abort before the first consumer races this.
    void this.failure.catch(() => {});
    this.emit("requesting");
    this.deadline("REQUEST_TIMEOUT", timeoutMs(opts?.requestTimeoutMs ?? process.env.ZAPCODE_REQUEST_TIMEOUT_MS, 60_000));
    opts?.signal?.addEventListener("abort", this.abort, { once: true });
    if (opts?.signal?.aborted) this.abort();
  }

  private emit(phase: ProviderRequestEvent["phase"], reason?: string): void {
    if (this.closed) return;
    const at = Date.now();
    if (phase === "streaming") this.lastOutputEventAt = at;
    // Prefix digests are bounded but still sizeable. Send them once per
    // serialized request, not on every streaming progress/audit event.
    const cacheShape = this.cacheShapeEmitted ? undefined : this.cacheShape;
    if (cacheShape) this.cacheShapeEmitted = true;
    notifyProviderRequest(this.opts, { phase, attempt: this.opts?.requestAttempt?.attempt ?? 1,
      maxAttempts: this.opts?.requestAttempt?.maxAttempts ?? 1,
      startedAt: this.startedAt, at, elapsedMs: at - this.startedAt, reason,
      ...(this.requestBytes !== undefined ? { requestBytes: this.requestBytes, requestFingerprint: this.requestFingerprint } : {}),
      ...(cacheShape ? { cacheShape } : {}),
      ...(this.output ? { output: { ...this.output } } : {}) });
  }

  measureBody(body: unknown, maxRequestBytes?: number, transport?: string): void {
    const json = JSON.stringify(body);
    this.cacheShape = requestCacheShape(body, transport);
    this.cacheShapeEmitted = false;
    this.requestBytes = Buffer.byteLength(json);
    this.requestFingerprint = createHash("sha256").update(json).digest("hex");
    if (maxRequestBytes !== undefined && Number.isFinite(maxRequestBytes) && maxRequestBytes > 0 && this.requestBytes > maxRequestBytes) {
      const error = new RequestBodyLimitError(this.requestBytes, maxRequestBytes);
      this.fail(error);
      throw error;
    }
  }

  private observeOutput(chunk: LLMChunk): void {
    const output = this.output;
    if (!output || !hasMeaningfulOutput(chunk)) return;
    const elapsedMs = Date.now() - this.startedAt;
    if (chunk.type === "thinking_delta") {
      output.firstThinkingMs ??= elapsedMs;
      output.thinkingChars += chunk.text.length;
    } else if (chunk.type === "text_delta") {
      output.firstTextMs ??= elapsedMs;
      output.textChars += chunk.text.length;
    } else {
      output.firstToolCallMs ??= elapsedMs;
      if (chunk.type === "tool_call_delta") output.toolArgumentChars += chunk.partialJson.length;
    }
  }

  private deadline(code: ProviderRequestTimeoutError["code"], ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new ProviderRequestTimeoutError(code, ms)), ms);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.emit("failed", error instanceof ProviderRequestTimeoutError ? error.code : error.name);
    this.close();
    // Reject before aborting: a synchronous transport abort must not obscure
    // the timeout reason with a generic AbortError (or a clean iterator end).
    this.rejectWait(error);
    this.controller.abort(error);
  }

  responseReceived = (): void => {
    if (this.closed || this.responded) return;
    this.responded = true;
    this.emit("waiting_output");
    this.deadline("FIRST_OUTPUT_TIMEOUT", timeoutMs(this.opts?.firstOutputTimeoutMs ?? process.env.ZAPCODE_FIRST_OUTPUT_TIMEOUT_MS, 180_000));
  };

  async wait<T>(promise: PromiseLike<T>): Promise<T> {
    try { return await Promise.race([promise, this.failure]); }
    catch (error) {
      if (!this.closed) this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /** A provider can report real tool-generation progress while withholding
   * executable arguments until its terminal response has been validated. */
  bufferedToolCallProgress(): void {
    if (this.closed) return;
    if (this.output) this.output.firstToolCallMs ??= Date.now() - this.startedAt;
    this.markMeaningfulOutput();
  }

  private markMeaningfulOutput(): void {
    if (!this.producedOutput) {
      this.responseReceived();
      this.producedOutput = true;
      clearTimeout(this.timer);
      this.emit("streaming");
    } else if (Date.now() - this.lastOutputEventAt >= 100) {
      this.emit("streaming");
    }
  }

  async *watch(source: AsyncIterable<LLMChunk>): AsyncIterable<LLMChunk> {
    this.output = { thinkingChars: 0, textChars: 0, toolArgumentChars: 0 };
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await this.wait(iterator.next());
        if (next.done) break;
        this.observeOutput(next.value);
        if (hasMeaningfulOutput(next.value)) this.markMeaningfulOutput();
        if (next.value.type === "done") clearTimeout(this.timer);
        yield next.value;
      }
      this.emit("completed");
    } catch (error) {
      // The tool executor needs a clean cancellation boundary to persist
      // already received text and already launched tools as a partial turn.
      if (!this.opts?.signal?.aborted) throw error;
    } finally {
      this.close();
      this.controller.abort();
      // A stalled generator may not implement interruptible return().
      void iterator.return?.().catch(() => {});
    }
  }

  complete(): void { this.emit("completed"); this.close(); }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.opts?.signal?.removeEventListener("abort", this.abort);
  }
}

import type { LLMProvider } from "../core/llm.js";
import { OutcomeProtocolError } from "./outcome.js";

export interface RepairBudgetLimits {
  /** Counts SDK provider calls, including fallback and summarization, not HTTP retries inside a provider. */
  modelCalls: number;
  /** Counts admitted executor invocations, including failed invocations. */
  toolCalls: number;
  /** One deadline for preflight, execution, verification and all repairs. */
  timeoutMs: number;
}

export function validateRepairBudget(limits: RepairBudgetLimits): void {
  if (!limits || Object.keys(limits).some(key => !["modelCalls", "toolCalls", "timeoutMs"].includes(key))
    || !Number.isSafeInteger(limits.modelCalls) || limits.modelCalls < 1
    || !Number.isSafeInteger(limits.toolCalls) || limits.toolCalls < 0
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 2_147_483_647) {
    throw new OutcomeProtocolError("INVALID_REPAIR_BUDGET", "Provide finite modelCalls, toolCalls and timeoutMs limits");
  }
}

/** Shared admission counters. Aborting once closes every subsequent admission. */
export class RepairBudget {
  readonly deadlineAt: number;
  private readonly controller = new AbortController();
  private readonly limits: RepairBudgetLimits;
  private modelCalls = 0;
  private toolCalls = 0;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;

  constructor(limits: RepairBudgetLimits, private readonly externalSignal?: AbortSignal) {
    validateRepairBudget(limits);
    this.limits = { ...limits };
    this.deadlineAt = Date.now() + limits.timeoutMs;
    this.abort = () => this.stop("REPAIR_CANCELLED");
    this.timer = setTimeout(() => this.stop("REPAIR_DEADLINE_EXCEEDED"), limits.timeoutMs);
    if (externalSignal?.aborted) this.abort();
    else externalSignal?.addEventListener("abort", this.abort, { once: true });
  }

  get signal(): AbortSignal { return this.controller.signal; }

  snapshot() { return { modelCalls: this.modelCalls, toolCalls: this.toolCalls, deadlineAt: this.deadlineAt }; }

  check(): void {
    if (Date.now() >= this.deadlineAt) this.stop("REPAIR_DEADLINE_EXCEEDED");
    this.signal.throwIfAborted();
  }

  admit(kind: "modelCalls" | "toolCalls"): void {
    this.check();
    if (this[kind] >= this.limits[kind]) this.stop(kind === "modelCalls" ? "REPAIR_MODEL_LIMIT" : "REPAIR_TOOL_LIMIT");
    this.signal.throwIfAborted();
    this[kind]++;
  }

  private stop(code: string): void {
    if (!this.signal.aborted) this.controller.abort(new OutcomeProtocolError(code, code));
  }

  /** Ignore late responses from a provider that does not honor cancellation. */
  async wait<T>(action: () => PromiseLike<T>, signal = this.signal): Promise<T> {
    this.check();
    signal.throwIfAborted();
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(action), interrupted]);
      this.check();
      signal.throwIfAborted();
      return result;
    } finally { signal.removeEventListener("abort", abort); }
  }

  wrap(inner: LLMProvider): LLMProvider {
    const budget = this;
    const call = inner.call.bind(inner);
    const stream = inner.stream?.bind(inner);
    const wrapped: LLMProvider = {
      call(messages, tools, options) {
        budget.admit("modelCalls");
        const signal = options?.signal ? AbortSignal.any([budget.signal, options.signal]) : budget.signal;
        return budget.wait(() => call(messages, tools, { ...options, signal }), signal);
      },
    };
    if (stream) wrapped.stream = async function* (messages, tools, options) {
      budget.admit("modelCalls");
      const signal = options?.signal ? AbortSignal.any([budget.signal, options.signal]) : budget.signal;
      signal.throwIfAborted();
      const iterator = stream(messages, tools, { ...options, signal })[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await budget.wait(() => iterator.next(), signal);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // A broken iterator's return() must not hold the deadline open.
        try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* best effort cleanup */ }
      }
    };
    wrapped.getImageTokenContext = options => inner.getImageTokenContext?.(options) ?? { model: options?.model };
    if (inner.setVisionSupported) wrapped.setVisionSupported = inner.setVisionSupported.bind(inner);
    return wrapped;
  }

  close(): void {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.abort);
    this.stop("REPAIR_CLOSED");
  }
}

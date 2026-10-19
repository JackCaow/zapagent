/** Raised by LoopAgent's budget planner when the estimated input + reserved
 *  output would exceed the model's context window. The loop's catch handler
 *  checks `err instanceof ContextOverflowError` (explicit contract — no
 *  string matching) and triggers auto-compaction before retry. */
export class ContextOverflowError extends Error {
  readonly inputTokens: number;
  readonly reservedOutput: number;
  readonly contextWindow: number;

  constructor(args: {
    inputTokens: number;
    reservedOutput: number;
    contextWindow: number;
  }) {
    super(
      `Estimated input ${args.inputTokens} tokens + reserved output ${args.reservedOutput} ` +
      `exceeds context window ${args.contextWindow}. Need to compact before sending.`
    );
    this.name = "ContextOverflowError";
    this.inputTokens = args.inputTokens;
    this.reservedOutput = args.reservedOutput;
    this.contextWindow = args.contextWindow;
  }
}

/** Detect provider error responses indicating image-content was rejected
 *  (most often a text-only model receiving image_url content blocks). */
export function looksLikeImageContentRejection(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    (lower.includes("image_url") && lower.includes("unknown variant")) ||
    (lower.includes("image_url") && lower.includes("expected `text`")) ||
    lower.includes("does not support image") ||
    lower.includes("vision is not supported") ||
    lower.includes("image input is not supported")
  );
}

/** Best-effort classifier for provider/gateway context-limit failures.
 *  Explicitly excludes auth/rate-limit and image-schema failures so recovery
 *  does not hide the real user action behind a misleading compaction retry. */
export function isLikelyContextLimitErrorMessage(msg: string): boolean {
  if (looksLikeImageContentRejection(msg) || isRequestBodyLimitError(msg)) return false;
  if (/\b(401|403|429)\b/.test(msg)) return false;

  const lower = msg.toLowerCase();
  const tokenOverflow = lower.includes("token") && (
    lower.includes("limit") ||
    lower.includes("exceed") ||
    lower.includes("maximum") ||
    lower.includes("too many") ||
    lower.includes("too long")
  );
  const scopedTooLong =
    /\b(prompt|context|input|messages?|conversation)\b.{0,40}\btoo long\b/.test(lower) ||
    /\btoo long\b.{0,40}\b(prompt|context|input|messages?|conversation)\b/.test(lower);

  return (
    tokenOverflow ||
    scopedTooLong ||
    lower.includes("context length") ||
    lower.includes("maximum context")
  );
}

/** HTTP payload limits are independent of the model token window. */
export function isRequestBodyLimitError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status : undefined;
  if (status === 413) return true;
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (status === 401 || status === 403 || status === 429) return false;
  if (/\b(401|403|429)\b/.test(text)) return false;
  // Numeric offsets/token counts in provider errors are not HTTP statuses.
  return text.trim() === "413" ||
    /\b(?:http(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?\s*[:=]?\s*)413\b/.test(text) ||
    /(?:request|payload|entity|body).{0,40}(?:too large|size limit|length limit exceeded)/.test(text);
}

export class RequestBodyLimitError extends Error {
  readonly status = 413;
  constructor(readonly requestBytes: number, readonly maxRequestBytes: number) {
    super(`Request body ${requestBytes} bytes exceeds configured limit ${maxRequestBytes} bytes`);
    this.name = "RequestBodyLimitError";
  }
}

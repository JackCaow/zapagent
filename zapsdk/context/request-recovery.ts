import { createHash } from "node:crypto";
import type { Message } from "../core/types.js";
import { ContextOverflowError, isLikelyContextLimitErrorMessage, isRequestBodyLimitError } from "../core/errors.js";
import { TokenCounter } from "./token-counter.js";
import { imagePayloadBytes, retireHistoricalImages } from "./historical-images.js";

export type RecoveryReason = "context_tokens" | "request_body";

/** Prevent exhausted recovery from re-entering another outer retry loop. */
export class RequestRecoveryError extends Error {
  constructor(readonly reason: RecoveryReason, readonly originalError: unknown, detail: string) {
    super(`${reason === "request_body" ? "Request body limit" : "Context length exceeded after compaction"}: ${detail}. ${originalError instanceof Error ? originalError.message : String(originalError)}`);
    this.name = "RequestRecoveryError";
  }
}

export function recoveryReason(error: unknown): RecoveryReason | undefined {
  if (error instanceof RequestRecoveryError) return undefined;
  if (isRequestBodyLimitError(error)) return "request_body";
  if (error instanceof ContextOverflowError || isLikelyContextLimitErrorMessage(error instanceof Error ? error.message : String(error))) return "context_tokens";
  return undefined;
}

export function measureRecoveryInput(messages: Message[], counter = new TokenCounter()) {
  return {
    // SDK message bytes, not a claim about a provider's final wire encoding.
    messageBytes: Buffer.byteLength(JSON.stringify(messages)),
    estimatedTokens: counter.countMessages(messages),
    imageBytes: imagePayloadBytes(messages),
  };
}

export function contextFingerprint(messages: Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

/** Elide previously observed tool images first, retaining all text, user
 * attachments, and the latest tool image group. Original evidence stays in
 * the transcript/files; the digest makes a later re-read version explicit. */
export function reduceHistoricalImages(messages: Message[]): Message[] {
  return retireHistoricalImages(messages, imagePayloadBytes(messages) / 2, 1).messages;
}

/** Reconcile only the leading system prefix and contiguous history tail that
 * were actually sent. A budgeted provider view must not replace unseen history. */
export function mergeRecoveredProviderView(canonical: Message[], requested: Message[], recovered: Message[]) {
  const before = requested.filter(m => !m.cache?.transient);
  const after = recovered.filter(m => !m.cache?.transient);
  let systemCount = 0;
  while (before[systemCount]?.role === "system") systemCount++;
  const tailStart = canonical.length - (before.length - systemCount);
  if (tailStart < systemCount ||
    contextFingerprint(before.slice(0, systemCount)) !== contextFingerprint(canonical.slice(0, systemCount)) ||
    contextFingerprint(before.slice(systemCount)) !== contextFingerprint(canonical.slice(tailStart)) ||
    contextFingerprint(after.slice(0, systemCount)) !== contextFingerprint(before.slice(0, systemCount))) {
    throw new Error("Recovery provider view no longer matches canonical history");
  }
  const unseen = canonical.slice(systemCount, tailStart);
  return {
    messages: [...after.slice(0, systemCount), ...unseen, ...after.slice(systemCount)],
    viewStart: systemCount + unseen.length,
    canonicalBoundary: (viewIndex: number) => viewIndex <= systemCount ? viewIndex : viewIndex + unseen.length,
  };
}

/** Preserve a boundary relative to surviving messages when history shrinks,
 * always backing up to the beginning of a tool group. */
export function rebaseMessageBoundary(before: Message[], after: Message[], index: number): number {
  const positions = new Map<string, number[]>();
  before.forEach((message, i) => {
    const key = contextFingerprint([message]);
    const indices = positions.get(key) ?? [];
    indices.push(i);
    positions.set(key, indices);
  });
  let next = after.length;
  let previous = before.length;
  // Match the surviving suffix in order, rather than letting repeated user
  // text (e.g. several "continue" inputs) overwrite an earlier anchor.
  for (let i = after.length - 1; i >= 0; i--) {
    const indices = positions.get(contextFingerprint([after[i]]));
    while (indices?.length && indices[indices.length - 1] >= previous) indices.pop();
    const original = indices?.pop();
    if (original === undefined) continue;
    previous = original;
    if (original >= index) next = i;
  }
  while (next > 0 && after[next]?.role === "tool_result") next--;
  return next;
}

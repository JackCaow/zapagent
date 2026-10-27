import { createHash } from "node:crypto";

const MAX_HASHES = 256;
export interface RequestCacheShape {
  scopeHash: string;
  staticHash: string;
  messageCount: number;
  messageHashes: string[];
  fullHash: string;
}
export interface RequestCacheObservation {
  change: "initial" | "unchanged" | "append" | "rewrite" | "scope_change" | "shape_change" | "unsampled_change";
  reason?: "prune" | "summary" | "recovery";
  commonPrefixMessages: number;
  previousMessages: number;
  messages: number;
  sampled: boolean;
  beforeHash?: string;
  afterHash: string;
  scopeHash: string;
  staticHash: string;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item) ?? "null").digest("hex");

/** Called with the adapter's final serialized body, never API headers/keys.
 * Cache placement hints are excluded; the existing requestFingerprint records
 * the exact JSON, including placement changes. Digests describe local wire shape, not provider cache hits or token savings. */
export function requestCacheShape(body: unknown, transport = "unknown"): RequestCacheShape | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : undefined;
  if (!messages) return undefined;
  // Output limits, streaming and usage controls change independently of the
  // cacheable prefix. System/instructions and schemas are part of its shape.
  const staticPart = { system: record.system, instructions: record.instructions, tools: record.tools,
    tool_choice: record.tool_choice, reasoning: record.reasoning, reasoning_effort: record.reasoning_effort };
  return { scopeHash: hash([transport, record.model]), staticHash: hash(staticPart),
    messageCount: messages.length, messageHashes: messages.slice(0, MAX_HASHES).map(hash), fullHash: hash(messages) };
}

export function scopeRequestCacheShape(shape: RequestCacheShape, providerScope?: string): RequestCacheShape {
  return providerScope === undefined ? shape : { ...shape, scopeHash: hash([providerScope, shape.scopeHash]) };
}

/** Bounded per-conversation baseline, reused when the Host rebuilds LoopAgent. */
export class RequestCacheTracker {
  private previous?: RequestCacheShape;
  private pending?: RequestCacheObservation["reason"];
  markMaintenance(reason: NonNullable<RequestCacheObservation["reason"]>): void { this.pending = reason; }
  clear(): void { this.previous = undefined; this.pending = undefined; }
  observe(shape: RequestCacheShape): RequestCacheObservation {
    const previous = this.previous;
    let common = 0;
    if (previous && previous.scopeHash === shape.scopeHash && previous.staticHash === shape.staticHash) {
      while (common < Math.min(previous.messageHashes.length, shape.messageHashes.length)
        && previous.messageHashes[common] === shape.messageHashes[common]) common++;
    }
    const sampled = shape.messageCount > shape.messageHashes.length
      || !!previous && previous.messageCount > previous.messageHashes.length;
    const change: RequestCacheObservation["change"] = !previous ? "initial"
      : previous.scopeHash !== shape.scopeHash ? "scope_change"
      : previous.staticHash !== shape.staticHash ? "shape_change"
      : previous.fullHash === shape.fullHash ? "unchanged"
      : common === previous.messageCount && shape.messageCount > previous.messageCount ? "append"
      : sampled && common === Math.min(previous.messageHashes.length, shape.messageHashes.length) ? "unsampled_change" : "rewrite";
    const observation: RequestCacheObservation = { change,
      ...(this.pending ? { reason: this.pending } : {}), commonPrefixMessages: common,
      previousMessages: previous?.messageCount ?? 0, messages: shape.messageCount, sampled,
      ...(previous ? { beforeHash: previous.fullHash } : {}), afterHash: shape.fullHash,
      scopeHash: shape.scopeHash, staticHash: shape.staticHash };
    this.previous = { ...shape, messageHashes: shape.messageHashes.slice() };
    this.pending = undefined;
    return observation;
  }
}

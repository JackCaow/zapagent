import { createHash } from "node:crypto";
import { TokenCounter } from "../context/token-counter.js";
import type { Message } from "../core/types.js";
import type {
  ConversationCacheDiagnostics,
  ConversationCacheSliceDiagnostics,
} from "./events.js";


/**
 * Describe the app-level conversation cache boundary without retaining any
 * message content. This mirrors the cache-placement hints consumed by the
 * Anthropic adapter and remains useful for auto-prefix-cache providers:
 * everything through the last eligible message is the reusable history,
 * while the current user turn and transient context remain in the fresh tail.
 */
export function buildConversationCacheDiagnostics(
  messages: readonly Message[],
  tokenCounter = new TokenCounter(),
): ConversationCacheDiagnostics {
  const firstConversationMessage = leadingSystemMessageCount(messages);
  let boundary = firstConversationMessage - 1;
  for (let i = firstConversationMessage; i < messages.length; i++) {
    if (isCacheBreakpointCandidate(messages[i])) boundary = i;
  }

  const prefix = boundary >= firstConversationMessage
    ? messages.slice(firstConversationMessage, boundary + 1)
    : [];
  const tail = messages.slice(Math.max(firstConversationMessage, boundary + 1));
  const prefixSlice = sliceDiagnostics(prefix, tokenCounter);
  return {
    prefix: {
      ...prefixSlice,
      messageHashes: prefix.map(messageFingerprint),
    },
    tail: sliceDiagnostics(tail, tokenCounter),
  };
}

function leadingSystemMessageCount(messages: readonly Message[]): number {
  let count = 0;
  while (messages[count]?.role === "system") count++;
  return count;
}

function isCacheBreakpointCandidate(message: Message): boolean {
  if (message.cache?.transient || message.cache?.skipBreakpoint) return false;
  if (message.content.trim().length > 0) return true;
  if (message.toolCalls?.length) return true;
  return message.contentBlocks?.some((block) =>
    block.type === "text" ? block.text.trim().length > 0 : false,
  ) ?? false;
}

function sliceDiagnostics(messages: readonly Message[], tokenCounter: TokenCounter): ConversationCacheSliceDiagnostics {
  const serialized = stableStringify(messages.map(canonicalMessage));
  return {
    messageCount: messages.length,
    chars: Array.from(serialized).length,
    estimatedTokens: tokenCounter.countMessages([...messages]),
    hash: shortHash(serialized),
  };
}

function messageFingerprint(message: Message): string {
  return shortHash(stableStringify(canonicalMessage(message)));
}

function canonicalMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.contentBlocks?.length
      ? { contentBlocks: message.contentBlocks.map(canonicalContentBlock) }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls?.length
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            ...(call.argumentParseError ? { argumentParseError: call.argumentParseError } : {}),
          })),
        }
      : {}),
    ...(message.raw ? { raw: message.raw } : {}),
  };
}

function canonicalContentBlock(block: NonNullable<Message["contentBlocks"]>[number]): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  const base64 = block.base64 ?? "";
  return {
    type: "image",
    mediaType: block.mediaType,
    ...(block.detail ? { detail: block.detail } : {}),
    base64Chars: base64.length,
    base64Hash: shortHash(base64),
  };
}

function stableStringify(value: unknown): string {
  return stableSerialize(value, new WeakSet<object>(), false) ?? "null";
}

function stableSerialize(
  value: unknown,
  seen: WeakSet<object>,
  inArray: boolean,
): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return inArray ? "null" : undefined;
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return JSON.stringify("[Circular]");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableSerialize(entry, seen, true) ?? "null").join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = stableSerialize(record[key], seen, false);
      if (encoded === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

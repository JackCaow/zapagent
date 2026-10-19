import type { Message } from "../core/types.js";
import { estimateImageTokens, type ImageTokenContext } from "./image-tokens.js";
import { countCodePoints } from "../utils/logical-lines.js";

const MESSAGE_OVERHEAD = 4; // role, framing tokens per message
const TOOL_CALL_OVERHEAD = 8; // id, name, arguments framing

export class TokenCounter {
  constructor(private readonly imageContext: ImageTokenContext | (() => ImageTokenContext) = {}) {}

  /**
   * Estimate token count for a text string.
   * Uses heuristics based on character classes:
   * - English/Latin: ~4 chars per token
   * - CJK: ~1.5 chars per token
   * - Code symbols: ~2 chars per token
   * - Whitespace: contributes to token boundaries
   */
  countText(text: string): number {
    if (!text) return 0;

    let tokens = 0;
    let i = 0;

    while (i < text.length) {
      const char = text.charCodeAt(i);

      if (this.isCJK(char)) {
        // CJK characters: ~1.5 chars per token
        tokens += 0.7;
        i++;
      } else if (this.isWhitespace(char)) {
        // Whitespace usually marks token boundary
        tokens += 0.25;
        i++;
      } else if (this.isSymbol(char)) {
        // Symbols/punctuation: often 1 token each
        tokens += 0.5;
        i++;
      } else if (this.isAlphanumeric(char)) {
        // Latin/alphanumeric: ~4 chars per token, count word
        let wordLen = 0;
        while (i < text.length && this.isAlphanumeric(text.charCodeAt(i))) {
          wordLen++;
          i++;
        }
        tokens += wordLen <= 3 ? 1 : Math.ceil(wordLen / 3.5);
      } else {
        // Any other character (fullwidth punctuation, emoji, etc.)
        tokens += 0.5;
        i++;
      }
    }

    return Math.max(1, Math.ceil(tokens));
  }

  /** Estimate tokens for a single Message including framing overhead. */
  countMessage(message: Message): number {
    let tokens = MESSAGE_OVERHEAD;
    tokens += this.countText(message.content);
    tokens += this.countText(messageSidecar(message));

    // Image bytes are transport data; vision tokenization is model-specific.
    if (message.contentBlocks) {
      for (const block of message.contentBlocks) {
        if (block.type === "image") tokens += estimateImageTokens(block,
          typeof this.imageContext === "function" ? this.imageContext() : this.imageContext).tokens;
      }
    }

    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        tokens += TOOL_CALL_OVERHEAD;
        tokens += this.countText(tc.name);
        tokens += this.countText(JSON.stringify(tc.arguments));
      }
    }

    if (message.toolCallId) {
      tokens += this.countText(message.toolCallId);
    }

    return tokens;
  }

  /** Keep the historical content-character threshold, including assistant
   * replay sidecars. Image transport bytes are not model text; tool arguments
   * and images continue to contribute to the separate token estimate. */
  countMessageChars(message: Message): number {
    return countCodePoints(message.content) + countCodePoints(messageSidecar(message));
  }

  /** Estimate total tokens for an array of messages. */
  countMessages(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + this.countMessage(m), 0);
  }

  private isCJK(code: number): boolean {
    return (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af)    // Hangul
    );
  }

  private isWhitespace(code: number): boolean {
    return code === 32 || code === 9 || code === 10 || code === 13;
  }

  private isSymbol(code: number): boolean {
    return (
      (code >= 33 && code <= 47) ||   // ! " # $ % & ' ( ) * + , - . /
      (code >= 58 && code <= 64) ||   // : ; < = > ? @
      (code >= 91 && code <= 96) ||   // [ \ ] ^ _ `
      (code >= 123 && code <= 126)    // { | } ~
    );
  }

  private isAlphanumeric(code: number): boolean {
    return (
      (code >= 48 && code <= 57) ||   // 0-9
      (code >= 65 && code <= 90) ||   // A-Z
      (code >= 97 && code <= 122)     // a-z
    );
  }
}

function messageSidecar(message: Message): string {
  if (message.role !== "assistant" || !message.raw) return "";
  // Replay fields can contain substantial input (for example reasoning text).
  // Measure their serialized payload without interpreting or rewriting it.
  // This remains a heuristic: provider-reported usage is authoritative.
  try { return JSON.stringify(message.raw) ?? ""; }
  catch { return ""; } // Invalid non-JSON sidecars remain a provider validation concern.
}

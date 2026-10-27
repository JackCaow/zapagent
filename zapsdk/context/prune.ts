import { formatExecutionObservation } from "../execution/failure.js";
import type { Message } from "../core/types.js";
import { assertProviderRequestAllowed } from "../core/provider-deadline.js";
import { TokenCounter } from "./token-counter.js";
import { compactDecision, compactMessageGroups, compactRequestTokens, protectedCompactGroups, type CompactOptions } from "./compact.js";
import { headTailPreview } from "./compact-summary.js";
import { countCodePoints } from "../utils/logical-lines.js";
import { Microcompact, TOOL_RESULT_COMPACTED_MARKER } from "./microcompact.js";
import { redactTextSecrets } from "../utils/redact.js";
import { contextFingerprint } from "./request-recovery.js";

export interface PruneResult {
  messages: Message[];
  status: "pruned" | "not_needed" | "no_change";
  inputTokens: number;
  outputTokens: number;
  messagesPruned: number;
  bytesBefore: number;
  bytesAfter: number;
  firstChangedMessage?: number;
  beforeHash: string;
  afterHash: string;
}

/** Pure, pressure-gated candidate construction. No tool, provider or file I/O. */
export function planPrune(messages: Message[], options: CompactOptions = {}): PruneResult {
  assertProviderRequestAllowed(options);
  const counter = options.counter ?? new TokenCounter();
  const measure = (candidate: Message[]) => compactRequestTokens(candidate, options, counter);
  const inputTokens = measure(messages);
  const beforeHash = contextFingerprint(messages);
  const bytesBefore = Buffer.byteLength(JSON.stringify(messages));
  const unchanged = (status: "not_needed" | "no_change"): PruneResult => ({ messages, status,
    inputTokens, outputTokens: inputTokens, messagesPruned: 0, bytesBefore, bytesAfter: bytesBefore,
    beforeHash, afterHash: beforeHash });
  if (!compactDecision(messages, { ...options, autoEnabled: true, force: false }).shouldCompact) return unchanged("not_needed");

  const candidate = structuredClone(messages);
  const groups = compactMessageGroups(candidate);
  const protectedGroups = protectedCompactGroups(groups, options.protectedUserText);
  const protectedMessages = new Set(groups.flatMap((group, index) => protectedGroups.has(index) ? group : []));
  const original = [...candidate];
  new Microcompact().compact(candidate);
  for (let i = 0; i < candidate.length; i++) {
    const message = original[i]!;
    // Persisted-output markers are already bounded and carry the only recovery
    // reference. Never shorten that reference or invent a new read authority.
    if (message.role === "tool_result" && candidate[i] !== message) {
      // Short results are cheap evidence, especially failures whose cause may
      // be in the tail. Prune bulky bodies, not a few hundred useful characters.
      if (countCodePoints(message.content) <= 500) {
        const observation = formatExecutionObservation(message.executionObservation);
        const content = observation && !message.content.includes(observation) ? `${observation}\n${message.content}` : message.content;
        candidate[i] = { ...candidate[i]!, content: content + ` [historical blocks omitted by prune] ${TOOL_RESULT_COMPACTED_MARKER}` };
        if (!message.contentBlocks?.length) candidate[i] = message;
      }
      const independentText = message.contentBlocks?.flatMap(block => block.type === "text" && block.text !== message.content
        ? [block.text] : []) ?? [];
      if (independentText.length && candidate[i] !== message) {
        candidate[i]!.content += "\n[Historical independent tool text blocks; bounded preview]\n"
          + headTailPreview(independentText.join("\n"), 4000);
      }
    }
    if (message.role === "user" && message.content !== candidate[i]!.content && message.contentBlocks?.length) {
      const textBlocks = message.contentBlocks.filter(block => block.type === "text");
      if (textBlocks.length === 1 && textBlocks[0]!.text === message.content) {
        candidate[i]!.contentBlocks = message.contentBlocks.map(block => block.type === "text"
          ? { type: "text", text: candidate[i]!.content } : block);
      } else candidate[i] = message; // Don't drop independent multimodal text.
    }
    if (message.role === "system" || protectedMessages.has(message) || message.cache?.transient
      || message.content.includes("<persisted-output")) candidate[i] = message;
  }
  for (let i = 0; i < candidate.length; i++) {
    const images = original[i]!.contentBlocks?.filter(block => block.type === "image");
    if (images?.length && !candidate[i]!.contentBlocks && candidate[i] !== original[i]) {
      candidate[i]!.content += "\n[Historical image references; pixels omitted, not visual evidence] "
        + JSON.stringify(images.map(image => ({ filePath: redactTextSecrets(image.filePath), source: redactTextSecrets(image.source), mediaType: image.mediaType })));
    }
  }
  for (let i = 0; i < candidate.length; i++) {
    if (counter.countMessage(candidate[i]!) >= counter.countMessage(original[i]!)) candidate[i] = original[i]!;
  }
  compactMessageGroups(candidate); // No orphan tool calls/results may be committed.
  const outputTokens = measure(candidate);
  const bytesAfter = Buffer.byteLength(JSON.stringify(candidate));
  if (outputTokens >= inputTokens || bytesAfter >= bytesBefore) return unchanged("no_change");
  const changed = candidate.flatMap((message, index) => contextFingerprint([message]) !== contextFingerprint([original[index]!]) ? [index] : []);
  assertProviderRequestAllowed(options);
  return { messages: candidate, status: "pruned", inputTokens, outputTokens,
    messagesPruned: changed.length, bytesBefore, bytesAfter, firstChangedMessage: changed[0],
    beforeHash, afterHash: contextFingerprint(candidate) };
}

/** Hysteresis survives Host Loop reconstruction. New history must grow by 10%
 * of the pressure threshold (at least 256 tokens) before another soft prune. */
export class PruneGate {
  private last?: { hash: string; tokens: number; threshold: number };
  clear(): void { this.last = undefined; }
  canAttempt(hash: string, tokens: number, threshold: number, hardLimit?: number): boolean {
    return !this.last || this.last.threshold !== threshold || (this.last.hash !== hash
      && (tokens >= this.last.tokens + Math.max(256, Math.floor(threshold * 0.1))
        || hardLimit !== undefined && tokens > hardLimit));
  }
  record(hash: string, tokens: number, threshold: number): void { this.last = { hash, tokens, threshold }; }
}

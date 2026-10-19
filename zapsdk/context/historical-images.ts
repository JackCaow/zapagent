import { createHash } from "node:crypto";
import type { Message } from "../core/types.js";

export interface HistoricalImagePolicy {
  /** Base64 bytes, not tokens or a provider's advertised HTTP limit. */
  highWaterBytes: number;
  lowWaterBytes: number;
  keepRecentGroups: number;
}

export const DEFAULT_HISTORICAL_IMAGE_POLICY: Readonly<HistoricalImagePolicy> = Object.freeze({
  highWaterBytes: 32 * 1024 * 1024,
  lowWaterBytes: 16 * 1024 * 1024,
  keepRecentGroups: 2,
});

export function imagePayloadBytes(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + (m.contentBlocks ?? []).reduce(
    (n, b) => n + (b.type === "image" ? b.base64?.length ?? 0 : 0), 0), 0);
}

/** Change complete, oldest-first tool groups at one explicit cache boundary.
 * User attachments, transient host input, and recent groups are protected.
 * No age-based sliding window: already retired images are never reconsidered. */
export function retireHistoricalImages(messages: Message[], targetBytes: number, keepRecentGroups: number) {
  const groups = new Map<number, number[]>();
  let group = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") group = i;
    if (group >= 0 && m.role === "tool_result" && !m.cache?.transient && imagePayloadBytes([m]) > 0) {
      const indices = groups.get(group) ?? [];
      indices.push(i);
      groups.set(group, indices);
    }
  });
  const beforeImageBytes = imagePayloadBytes(messages);
  let afterImageBytes = beforeImageBytes;
  let retiredGroups = 0;
  const result = [...messages];
  const eligible = [...groups.values()].slice(0, Math.max(0, groups.size - keepRecentGroups));
  for (const indices of eligible) {
    if (afterImageBytes <= targetBytes) break;
    for (const i of indices) {
      const message = messages[i];
      const notes: string[] = [];
      const contentBlocks = message.contentBlocks!.map(block => {
        if (block.type !== "image" || !block.base64) return block;
        afterImageBytes -= block.base64.length;
        const digest = createHash("sha256").update(block.base64).digest("hex");
        const note = `[Historical image omitted from this request: ${JSON.stringify(block.source || block.filePath || "source unavailable")}; base64-sha256=${digest}. Re-read the source if needed; its contents may have changed.]`;
        notes.push(note);
        return { type: "text" as const, text: note };
      });
      result[i] = { ...message, content: [message.content, ...notes].join("\n"), contentBlocks };
    }
    retiredGroups++;
  }
  return { messages: retiredGroups ? result : messages, beforeImageBytes, afterImageBytes, retiredGroups };
}

/** Session-owned hysteresis. Even when protected media exceeds the budget,
 * wait for another full growth interval instead of rewriting history each step. */
export class HistoricalImageRetention {
  readonly policy: Readonly<HistoricalImagePolicy>;
  private nextSweepAtBytes: number;

  constructor(policy: Partial<HistoricalImagePolicy> = {}) {
    this.policy = Object.freeze({ ...DEFAULT_HISTORICAL_IMAGE_POLICY, ...policy });
    const { highWaterBytes, lowWaterBytes, keepRecentGroups } = this.policy;
    if (!Number.isSafeInteger(highWaterBytes) || !Number.isSafeInteger(lowWaterBytes) ||
      lowWaterBytes < 0 || highWaterBytes <= lowWaterBytes ||
      !Number.isSafeInteger(keepRecentGroups) || keepRecentGroups < 1) {
      throw new Error("Invalid historical image watermarks or protected group count");
    }
    this.nextSweepAtBytes = highWaterBytes;
  }

  prepare(messages: Message[]) {
    if (imagePayloadBytes(messages) < this.nextSweepAtBytes) return undefined;
    const result = retireHistoricalImages(messages, this.policy.lowWaterBytes, this.policy.keepRecentGroups);
    this.nextSweepAtBytes = Math.max(this.policy.highWaterBytes,
      result.afterImageBytes + this.policy.highWaterBytes - this.policy.lowWaterBytes);
    return { ...result, nextSweepAtBytes: this.nextSweepAtBytes };
  }

  reset(): void {
    this.nextSweepAtBytes = this.policy.highWaterBytes;
  }
}

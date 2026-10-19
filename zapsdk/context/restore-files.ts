/** Post-compact restoration reuses only successful, already-visible read
 * results. It never opens a host path or treats a tool attempt as permission.
 * Current file contents must be obtained through the normal authorized tool. */
import type { Message } from "../core/types.js";
import { TokenCounter } from "./token-counter.js";

export interface RestoreFilesOptions { maxTokens?: number; counter?: TokenCounter }
export async function restoreRecentFiles(messages: Message[], options: RestoreFilesOptions = {}): Promise<string | null> {
  const counter = options.counter ?? new TokenCounter();
  const limit = Math.max(0, Math.floor(options.maxTokens ?? 2048));
  if (!Number.isFinite(limit) || limit === 0) return null;
  const chunks: string[] = [];
  const seen = new Set<string>();
  const header = "[Context compacted. Recorded read results below are historical snapshots, not current file contents:]";
  const footer = "[End of restored files]";
  const render = () => [header, ...chunks, footer].join("\n\n");
  for (let i = messages.length - 1; i >= 0 && chunks.length < 5; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !message.toolCalls) continue;
    // Match only the immediately following result group; reused IDs elsewhere
    // in a session cannot lend another attempt their successful result.
    const results = new Map<string, Message>();
    for (let j = i + 1; j < messages.length && messages[j]!.role === "tool_result"; j++) {
      const result = messages[j]!;
      if (result.toolCallId) results.set(result.toolCallId, result);
    }
    for (const call of message.toolCalls) {
      const path = call.arguments?.path;
      if (call.name !== "read_file" || typeof path !== "string" || seen.has(path)) continue;
      const result = results.get(call.id);
      // A duplicate notice did not read or deny access: retain the real snapshot.
      if (result?.toolResultSuppression === "duplicate") continue;
      seen.add(path); // A newer denied/failed read must not revive an older one.
      if (result?.toolResultSuccess !== true || !result.content) continue;
      const fence = "`".repeat(Math.max(3, ...Array.from(result.content.matchAll(/`+/g), m => m[0].length + 1)));
      const prefix = `### ${path.replace(/\s+/g, " ").trim()}\n${fence}\n`;
      const points = Array.from(result.content);
      let lo = 0, hi = points.length;
      const candidate = (n: number) => prefix + points.slice(0, n).join("")
        + (n < points.length ? "\n…(historical result truncated to fit restore budget)" : "") + `\n${fence}`;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (counter.countText([header, ...chunks, candidate(mid), footer].join("\n\n")) <= limit) lo = mid;
        else hi = mid - 1;
      }
      if (lo > 0) chunks.push(candidate(lo));
      if (chunks.length >= 5) break;
    }
  }
  return chunks.length ? render() : null;
}

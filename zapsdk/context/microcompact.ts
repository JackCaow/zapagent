import { formatExecutionObservation } from "../execution/failure.js";
import type { Message } from "../core/types.js";
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints } from "../utils/logical-lines.js";

export interface MicrocompactOptions {
  /** Keep the last N tool results uncompacted (default: 4) */
  keepRecent?: number;
}

const INLINE_CONTEXT_BLOCK_RE = /<(file_content|mcp_resource)\b([^>]*)>([\s\S]+?)<\/\1>/g;
const FILE_COMPACTED_MARKER = "chars compacted; use read_file tool for full content";
const MCP_COMPACTED_MARKER = "chars compacted; re-read MCP resource for full content";
const TOOL_RESULT_COMPACTED_MARKER = "<!-- zap-microcompact:v1 -->";
const LEGACY_TOOL_RESULT_COMPACTED_RE = /(?:…\[\d+ chars compacted\]…|\[\d+ chars\](?:\s|$))/u;

export class Microcompact {
  private compactedIds = new Set<string>();
  private keepRecent: number;

  constructor(options: MicrocompactOptions = {}) {
    this.keepRecent = options.keepRecent ?? 4;
  }

  /**
   * Compact old tool_result messages AND user-message inline context
   * blocks (the body inlined by @-file and @MCP references) in place. Returns the
   * number of messages mutated.
   *
   * Two parallel pipelines, both gated by `keepRecent`:
   *
   *   1. tool_result messages — replace bulky outputs (bash stdout, read_file
   *      blobs, search hits) with `head … [N chars] … tail`. Tracked via
   *      `toolCallId` so repeated calls don't re-compact the same message.
   *   2. user messages with `<file_content>` or `<mcp_resource>` blocks —
   *      replace the body with the same head/tail summary plus a hint
   *      pointing the model at the appropriate source if it needs the rest.
   *      No tracking — the marker text itself acts as the idempotency
   *      check (already-compacted blocks have it; skip).
   *
   *  The user-message branch is what catches large @-file and @MCP inlines,
   *  which the tool_result-only implementation couldn't touch.
   */
  compact(messages: Message[]): number {
    let compacted = 0;
    compacted += this.compactToolResults(messages);
    compacted += this.compactUserInlineBlocks(messages);
    return compacted;
  }

  private compactToolResults(messages: Message[]): number {
    const toolResults: { index: number; id: string }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "tool_result" && msg.toolCallId) {
        toolResults.push({ index: i, id: msg.toolCallId });
      }
    }

    const toCompact = toolResults.slice(0, Math.max(0, toolResults.length - this.keepRecent));
    let compacted = 0;

    for (const { index, id } of toCompact) {
      if (this.compactedIds.has(id)) continue;

      const msg = messages[index];
      const observation = formatExecutionObservation(msg.executionObservation);
      const content = observation ? msg.content.replace(observation, "").trim() : msg.content;
      const omittedBlockNote = renderOmittedContentBlocks(msg);
      // LoopAgent is rebuilt for every user turn, so compactedIds alone cannot
      // make this operation idempotent across runs. Keep a persistent marker in
      // the compacted content and recognize pre-marker output from older builds.
      // If contentBlocks still exist, continue so they are actually removed.
      if (!omittedBlockNote && isPersistentlyCompactedToolResult(content)
        && (!observation || msg.content.includes(observation))) {
        this.compactedIds.add(id);
        continue;
      }
      const charCount = countCodePoints(content);
      if (charCount <= 100 && !omittedBlockNote) continue; // Already short enough

      // Head + tail placeholder — first-line-only loses bash/test tails
      // (error, exit code, summary) which are the pieces a resumed agent
      // needs most. Keep ~150 chars from each end, whitespace-normalized.
      const head = compactEdgeText(content, "head", 200, 150);
      const tail = charCount > 500
        ? compactEdgeText(content, "tail", 200, 150)
        : "";
      const compactedSummary = charCount <= 100
        ? `${content}${omittedBlockNote}`
        : tail
          ? `${head}  …[${charCount} chars compacted]…  ${tail}${omittedBlockNote}`
          : `${head} [${charCount} chars]${omittedBlockNote}`;
      const compactedContent = [observation, `${compactedSummary} ${TOOL_RESULT_COMPACTED_MARKER}`]
        .filter(part => part !== undefined).join("\n");
      const { contentBlocks: _omitted, ...rest } = msg;
      messages[index] = {
        ...rest,
        content: compactedContent,
      };

      this.compactedIds.add(id);
      compacted++;
    }

    return compacted;
  }

  /** Find user messages that contain inline context blocks. Older than
   *  keepRecent get their body collapsed to head+tail. The block stays in
   *  place so the model still sees the source reference — only the bytes
   *  shrink. */
  private compactUserInlineBlocks(messages: Message[]): number {
    const inlineMsgs: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        msg.role === "user" &&
        (msg.content.includes("<file_content") || msg.content.includes("<mcp_resource"))
      ) {
        inlineMsgs.push(i);
      }
    }

    const toCompact = inlineMsgs.slice(0, Math.max(0, inlineMsgs.length - this.keepRecent));
    let compacted = 0;

    for (const index of toCompact) {
      const msg = messages[index];
      let changed = false;
      const newContent = msg.content.replace(INLINE_CONTEXT_BLOCK_RE, (full, tag: string, attrs: string, body: string) => {
        const marker = tag === "mcp_resource" ? MCP_COMPACTED_MARKER : FILE_COMPACTED_MARKER;
        // Already compacted (carries the marker) or already short — skip.
        const charCount = countCodePoints(body);
        if (body.includes(marker) || charCount <= 500) return full;
        const head = compactEdgeText(body, "head", 200, 150);
        const tail = compactEdgeText(body, "tail", 200, 150);
        changed = true;
        return `<${tag}${attrs}>${head}\n…[${charCount} ${marker}]…\n${tail}</${tag}>`;
      });
      if (changed) {
        messages[index] = { ...msg, content: newContent };
        compacted++;
      }
    }

    return compacted;
  }

  /** Reset tracking (e.g., for a new run) */
  reset(): void {
    this.compactedIds.clear();
  }
}

function isPersistentlyCompactedToolResult(content: string): boolean {
  return content.includes(TOOL_RESULT_COMPACTED_MARKER) ||
    content.includes("omitted by microcompact") ||
    LEGACY_TOOL_RESULT_COMPACTED_RE.test(content);
}

function compactEdgeText(
  text: string,
  edge: "head" | "tail",
  sourceChars: number,
  outputChars: number,
): string {
  const source = edge === "head"
    ? sliceHeadCodePoints(text, sourceChars)
    : sliceTailCodePoints(text, sourceChars);
  const normalized = source.replace(/\s+/g, " ").trim();
  return edge === "head"
    ? sliceHeadCodePoints(normalized, outputChars)
    : sliceTailCodePoints(normalized, outputChars);
}

function renderOmittedContentBlocks(msg: Message): string {
  const blocks = msg.contentBlocks ?? [];
  if (blocks.length === 0) return "";
  const imageCount = blocks.filter((block) => block.type === "image").length;
  if (imageCount === blocks.length) {
    return ` [${imageCount} image block${imageCount === 1 ? "" : "s"} omitted by microcompact; rerun the tool if needed]`;
  }
  return ` [${blocks.length} content block${blocks.length === 1 ? "" : "s"} omitted by microcompact; rerun the tool if needed]`;
}

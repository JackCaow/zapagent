import type { LLMProvider, LLMCallOptions } from "../core/llm.js";
import { assertProviderRequestAllowed } from "../core/provider-deadline.js";
import type { Message } from "../core/types.js";
import { createSystemMessage, createUserMessage } from "../core/types.js";
import { redactJsonSecrets, redactTextSecrets } from "../utils/redact.js";
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints, splitLogicalLines } from "../utils/logical-lines.js";
import { TokenCounter } from "./token-counter.js";

/**
 * Structured compaction prompt — required sections plus `<analysis>` scratchpad.
 *
 * A single-sentence "summarize this" prompt produces vague prose that loses
 * the information the next turn actually needs: what the task is, what was
 * tried, which files changed, what's pending. This template (ported from
 * Claude Code's `getCompactPrompt`, trimmed for zap's scope) forces the
 * summarizer to enumerate the operationally useful facts.
 *
 * Sections intentionally overlap (tasks / current-work / files-changed)
 * because each foregrounds a different axis — an LLM reading the summary
 * to resume work should find whichever angle it's looking for without
 * having to re-derive.
 */
export const STRUCTURED_COMPACT_PROMPT = `You are compacting a coding-agent conversation for context-window reasons. The next turn of the agent will resume from your summary alone, so DON'T omit actionable detail. Produce your summary using the exact sections below. Keep each section tight — facts, no filler.

<analysis>
Briefly reason about what the user's overall goal was, what progress was made, and what remains. This scratchpad lets you plan the summary; users never see it.
</analysis>

# Primary Request and Intent
The user's actual requests, goals, and intent — in their own framing, not paraphrased into agent-speak. If the user changed direction mid-session, note each intent with its trigger turn.

# All user messages (verbatim)
Every non-tool-result user message, preserved verbatim when short. For long user messages, keep opening + closing intact and elide only the middle. Critically: preserve any shorthand or labels the user introduces (e.g. "P1", "the auth bug", "option A", file/path references) EXACTLY as written — future turns refer back to these by nickname. If a prior agent response defined such a label (e.g. "P1 = items 4-7: ScrollBox, Textarea, Select, truecolor"), include that label→value mapping right after the user message that first used it.

# Current task status
What is the agent working on right now? What was the last concrete step? Is a tool call in flight or a decision pending?

# Files read / modified
Bulleted list. For each: path + a ≤ 120-char description of what was inspected or changed. Include exact paths, not paraphrases.

# Commands run
Bulleted list of non-trivial shell / bash invocations and their outcome (success / what it revealed / what failed).

# Key facts discovered
Findings from web searches, file inspection, test output, etc. Bullet list.

# Decisions made
Choices that the agent or user committed to that future-you needs to honor. E.g. "use jsdiff not myers", "write to docs/specs/…, not docs/".

# Errors encountered and their resolution
Any error messages + what fixed them (or that they're still blocking). Include user feedback on attempted fixes — that's where the best corrections come from.

# Code changes summary
If files were edited or written, describe the change semantically (not diff-verbatim). One bullet per file.

# Next steps
What the agent was about to do when compaction happened. Bullet list, imperative form. If possible, include a direct quote from the most recent user message to anchor the next step to the user's actual framing.

Output the summary as plain markdown with these section headers. Do not wrap in \`\`\` fences. Do not prefix with "Summary:" or similar.`;

export const REPAIR_COMPACT_SUMMARY_PROMPT = `You are repairing a failed coding-agent compact summary. Rewrite the prior summary so it follows the exact required section contract. Use the original compact input as the source of truth. Preserve actionable details and user wording where possible. If a required section has no evidence, write "_(none captured)_" instead of leaving it empty.

Required sections, in this exact order:
# Primary Request and Intent
# All user messages (verbatim)
# Current task status
# Files read / modified
# Commands run
# Key facts discovered
# Decisions made
# Errors encountered and their resolution
# Code changes summary
# Next steps

Output only the repaired markdown summary. Do not wrap it in code fences.`;

export interface AutoCompactOptions {
  /**
   * Rough character-count threshold for triggering compaction.
   * 1 token ≈ 4 chars, so the default 320_000 chars ≈ 80k tokens.
   */
  charThreshold?: number;
  /** Number of most-recent messages to keep verbatim after compaction (default: 10) */
  keepRecent?: number;
}

/** Head + tail preview for long strings. Prior code took only `slice(0, N)`,
 *  which drops the tail of tool_results where error/exit-code/summary live.
 *  Keeping both ends preserves the decisive information at both boundaries. */
export function headTailPreview(content: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  const totalChars = countCodePoints(content);
  if (totalChars <= limit) return content;
  const half = Math.max(0, Math.floor(limit / 2) - 30);
  const head = sliceHeadCodePoints(content, half);
  const tail = sliceTailCodePoints(content, half);
  const elidedChars = Math.max(0, totalChars - countCodePoints(head) - countCodePoints(tail));
  return (
    head +
    `\n…[${elidedChars} chars elided]…\n` +
    tail
  );
}

/** Role-aware preview used when feeding a conversation to the compaction
 *  summarizer.
 *
 *  tool_result content is dense with noise (file bodies, search hits) and
 *  the decisive signal lives at the boundaries — command name/args at the
 *  head, exit code / error / summary at the tail. Aggressive 2000-char
 *  head+tail is fine.
 *
 *  assistant / user narratives are the opposite: structured lists,
 *  numbered plans, and user-introduced shorthand typically live in the
 *  middle of longer turns. Truncating to 2000 chars silently drops those
 *  definitions, which breaks later references (e.g. user says "fix P1"
 *  after the agent defined P0-P3 mid-turn). Give narrative messages a
 *  larger budget — they're rarer than tool_result so the total input
 *  stays manageable even at 3× the cap. */
export function previewMessageForCompact(
  role: string,
  content: string,
): string {
  const cap = role === "tool_result" ? 2000 : 6000;
  return headTailPreview(redactTextSecrets(content), cap);
}

function previewHistoryMessage(message: Message): string {
  const parts = [`[${message.role}]: ${previewMessageForCompact(message.role, message.content)}`];
  if (message.role === "assistant" && message.toolCalls?.length) {
    // Tool-only turns often have no prose. Preserve the invocation evidence
    // alongside its results, without copying opaque provider replay fields.
    let calls: string;
    try {
      calls = JSON.stringify(message.toolCalls.map(({ id, name, arguments: args }) => ({
        id, name, arguments: args,
      })), redactJsonSecrets);
    } catch {
      calls = JSON.stringify(message.toolCalls.map(({ id, name }) => ({
        id, name, arguments: "[unserializable arguments]",
      })));
    }
    parts.push(`[tool_calls]: ${previewMessageForCompact("assistant", calls)}`);
  }
  if (message.role === "tool_result" && message.toolCallId) {
    parts.unshift(`[tool_result reference]: ${previewMessageForCompact("tool_result", JSON.stringify({ id: message.toolCallId }))}`);
  }
  return parts.join("\n");
}

/** Remove the prompt's private scratchpad from a compaction response before
 *  it enters persistent conversation history. The compact prompt explicitly
 *  tells the summarizer that `<analysis>` is for planning and users never see
 *  it; persisting it would leak low-quality reasoning into future turns. */
export function sanitizeCompactSummary(text: string): string {
  return redactTextSecrets(text)
    .replace(/<analysis\b[^>]*>[\s\S]*?(?:<\/analysis>|$)/gi, "")
    .replace(/<\/analysis>/gi, "")
    .trim();
}

export const REQUIRED_COMPACT_SUMMARY_HEADINGS = [
  "Primary Request and Intent",
  "All user messages (verbatim)",
  "Current task status",
  "Files read / modified",
  "Commands run",
  "Key facts discovered",
  "Decisions made",
  "Errors encountered and their resolution",
  "Code changes summary",
  "Next steps",
] as const;

const COMPACT_HEADING_ALIASES = new Map<string, string>(
  [
    ["主要请求和意图", "Primary Request and Intent"],
    ["主要请求与意图", "Primary Request and Intent"],
    ["请求和意图", "Primary Request and Intent"],
    ["请求与意图", "Primary Request and Intent"],
    ["所有用户消息", "All user messages (verbatim)"],
    ["所有用户消息（原文）", "All user messages (verbatim)"],
    ["所有用户消息(原文)", "All user messages (verbatim)"],
    ["用户消息", "All user messages (verbatim)"],
    ["用户消息（原文）", "All user messages (verbatim)"],
    ["用户消息(原文)", "All user messages (verbatim)"],
    ["user messages", "All user messages (verbatim)"],
    ["user messages verbatim", "All user messages (verbatim)"],
    ["当前任务状态", "Current task status"],
    ["当前状态", "Current task status"],
    ["任务状态", "Current task status"],
    ["读取 / 修改的文件", "Files read / modified"],
    ["读取/修改的文件", "Files read / modified"],
    ["已读 / 修改文件", "Files read / modified"],
    ["已读/修改文件", "Files read / modified"],
    ["文件读写", "Files read / modified"],
    ["文件读取和修改", "Files read / modified"],
    ["文件读取与修改", "Files read / modified"],
    ["运行的命令", "Commands run"],
    ["执行的命令", "Commands run"],
    ["命令", "Commands run"],
    ["发现的关键事实", "Key facts discovered"],
    ["关键事实", "Key facts discovered"],
    ["关键发现", "Key facts discovered"],
    ["已做决定", "Decisions made"],
    ["做出的决定", "Decisions made"],
    ["决策", "Decisions made"],
    ["决定", "Decisions made"],
    ["遇到的错误及解决", "Errors encountered and their resolution"],
    ["遇到的错误和解决", "Errors encountered and their resolution"],
    ["错误及解决", "Errors encountered and their resolution"],
    ["错误和解决", "Errors encountered and their resolution"],
    ["错误及其解决", "Errors encountered and their resolution"],
    ["errors encountered and resolution", "Errors encountered and their resolution"],
    ["代码变更摘要", "Code changes summary"],
    ["代码修改摘要", "Code changes summary"],
    ["代码更改摘要", "Code changes summary"],
    ["变更摘要", "Code changes summary"],
    ["下一步", "Next steps"],
    ["后续步骤", "Next steps"],
    ["接下来的步骤", "Next steps"],
  ].map(([alias, canonical]) => [normalizeHeadingText(alias), normalizeHeadingText(canonical)]),
);

export interface CompactSummaryQuality {
  ok: boolean;
  missingHeadings: string[];
  emptyHeadings: string[];
}

/** Validate that a model followed the structured compaction contract. A short
 *  prose summary is worse than no compact: it frees tokens by discarding the
 *  exact operational anchors the next turn needs. */
export function validateCompactSummary(summary: string): CompactSummaryQuality {
  const sections = new Map<string, string[]>();
  let currentHeading: string | null = null;
  for (const line of splitLogicalLines(summary)) {
    const match = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (match) {
      const heading = normalizeCompactHeadingTitle(match[1]);
      if (!sections.has(heading)) sections.set(heading, []);
      currentHeading = heading;
      continue;
    }
    if (currentHeading) sections.get(currentHeading)?.push(line);
  }
  const missingHeadings = REQUIRED_COMPACT_SUMMARY_HEADINGS
    .filter((heading) => !sections.has(normalizeCompactHeadingTitle(heading)));
  const emptyHeadings = REQUIRED_COMPACT_SUMMARY_HEADINGS
    .filter((heading) => {
      if (missingHeadings.includes(heading)) return false;
      const body = sections.get(normalizeCompactHeadingTitle(heading)) ?? [];
      return body.join("\n").trim().length === 0;
    });
  return {
    ok: missingHeadings.length === 0 && emptyHeadings.length === 0,
    missingHeadings,
    emptyHeadings,
  };
}

export function isUsableCompactSummary(summary: string): boolean {
  return summary.trim().length > 0 && validateCompactSummary(summary).ok;
}

export function compactSummaryFailureReason(summary: string): string | null {
  if (!summary.trim()) return "summarizer returned an empty compact summary";
  const quality = validateCompactSummary(summary);
  if (quality.ok) return null;
  const parts: string[] = [];
  if (quality.missingHeadings.length > 0) {
    parts.push(`missing required sections: ${formatHeadingList(quality.missingHeadings)}`);
  }
  if (quality.emptyHeadings.length > 0) {
    parts.push(`empty required sections: ${formatHeadingList(quality.emptyHeadings)}`);
  }
  return `summarizer returned an unusable compact summary (${parts.join("; ")})`;
}

function formatHeadingList(headings: string[]): string {
  return headings.slice(0, 3).join(", ") + (headings.length > 3 ? `, +${headings.length - 3} more` : "");
}

export function normalizeCompactHeadingTitle(value: string): string {
  const normalized = normalizeHeadingText(value);
  return COMPACT_HEADING_ALIASES.get(normalized) ?? normalized;
}

function normalizeHeadingText(value: string): string {
  return value
    .trim()
    .replace(/[:：]\s*$/u, "")
    .trim()
    .replace(/^\*{1,3}(.+?)\*{1,3}$/u, "$1")
    .replace(/^_{1,3}(.+?)_{1,3}$/u, "$1")
    .replace(/[:：]\s*$/u, "")
    .trim()
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function leadingSystemMessageCount(messages: Message[]): number {
  let count = 0;
  while (messages[count]?.role === "system") count++;
  return count;
}

export class AutoCompact {
  private charThreshold: number;
  private keepRecent: number;
  private readonly counter = new TokenCounter();

  constructor(options: AutoCompactOptions = {}) {
    this.charThreshold = options.charThreshold ?? 320_000;
    this.keepRecent = options.keepRecent ?? 10;
  }

  /** Total character count across all messages */
  totalChars(messages: Message[]): number {
    return messages.reduce((sum, message) => sum + this.counter.countMessageChars(message), 0);
  }

  shouldCompact(messages: Message[]): boolean {
    return this.totalChars(messages) > this.charThreshold;
  }

  /**
   * Compact by LLM summarization.
   * Keeps leading system messages + last keepRecent messages verbatim.
   * The tail boundary is adjusted to never start on a tool_result message —
   * doing so would orphan its tool_use (in the compacted middle) and cause API errors.
   * Summarizes everything in between via an LLM call.
   * If summarization fails or violates the structured-summary contract, leaves
   * messages unchanged and returns an empty summary so callers can surface a
   * failed compaction instead of persisting a low-information placeholder.
   */
  async compact(
    messages: Message[],
    provider: LLMProvider,
    options: Pick<LLMCallOptions, "signal" | "deadline"> = {},
  ): Promise<{ messages: Message[]; summary: string; failureReason?: string }> {
    const systemLen = leadingSystemMessageCount(messages);
    const systemMsgs = messages.slice(0, systemLen);

    // Tail boundary picked by TWO bounds — whichever is more aggressive:
    //   1. Count-based: keep at most keepRecent messages (legacy behaviour).
    //   2. Char-based: keep messages whose combined content fits in half
    //      the charThreshold. Catches the "few but huge messages" case
    //      (e.g. user inlined a 1600-line file via @-ref). Without the
    //      char bound, 10 × 16k-token messages = 160k total but each fits
    //      under keepRecent=10, so middle is empty and compact no-ops.
    const countTail = Math.max(systemLen, messages.length - this.keepRecent);
    const tailBudget = Math.floor(this.charThreshold / 2);
    let charTail = messages.length;
    let charsSoFar = 0;
    while (charTail > systemLen + 1) {
      const m = messages[charTail - 1];
      const len = m ? this.counter.countMessageChars(m) : 0;
      if (charsSoFar + len > tailBudget && charTail < messages.length) break;
      charsSoFar += len;
      charTail--;
    }
    let tailStart = Math.max(countTail, charTail);
    // Safety net: even after both bounds, if the conversation is non-
    // trivially long but middle would still be empty, force AT LEAST one
    // non-system message into the summary. Otherwise we'd just no-op and
    // the autocompact trigger keeps firing on every subsequent step.
    if (tailStart === systemLen && messages.length - systemLen > 1) {
      tailStart = systemLen + 1;
    }
    // Find a safe tail boundary: never start on a tool_result, because its
    // matching tool_use would be in the compacted portion, causing an API error.
    while (tailStart > systemLen && messages[tailStart]?.role === "tool_result") {
      tailStart--;
    }

    const tail = messages.slice(tailStart);
    const middle = messages.slice(systemLen, tailStart);

    if (middle.length === 0) {
      // Genuinely nothing to compact — system-only message or single non-
      // system turn that can't be safely split. Return an explicit "no-op"
      // sentinel so the caller can surface useful UI ("compact had no
      // effect, free space manually") instead of pretending it worked.
      return { messages, summary: "" };
    }

    const historyText = middle.map(previewHistoryMessage).join("\n\n");

    let summary = "";
    try {
      assertProviderRequestAllowed(options);
      const response = await provider.call(
        [
          createSystemMessage(STRUCTURED_COMPACT_PROMPT),
          createUserMessage(historyText),
        ],
        [],
        options,
      );
      summary = sanitizeCompactSummary(response.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { messages, summary: "", failureReason: `summarizer failed: ${message}` };
    }

    const failureReason = compactSummaryFailureReason(summary);
    if (failureReason) {
      const repaired = await repairCompactSummary(provider, historyText, summary, failureReason, options);
      if (!repaired.ok) {
        return { messages, summary: "", failureReason: repaired.failureReason };
      }
      summary = repaired.summary;
    }

    const summaryMsg = createUserMessage(
      `[Context compacted — ${middle.length} earlier messages summarized]\n${summary}`
    );

    return {
      messages: [...systemMsgs, summaryMsg, ...tail],
      summary,
    };
  }
}

async function repairCompactSummary(
  provider: LLMProvider,
  historyText: string,
  invalidSummary: string,
  failureReason: string,
  options: Pick<LLMCallOptions, "signal" | "deadline">,
): Promise<
  | { ok: true; summary: string }
  | { ok: false; failureReason: string }
> {
  let summary = "";
  try {
    assertProviderRequestAllowed(options);
    const response = await provider.call(
      [
        createSystemMessage(REPAIR_COMPACT_SUMMARY_PROMPT),
        createUserMessage([
          "The previous compact summary failed validation:",
          failureReason,
          "",
          "Original compact input:",
          historyText,
          "",
          "Previous invalid summary:",
          invalidSummary || "_(empty)_",
        ].join("\n")),
      ],
      [],
      options,
    );
    summary = sanitizeCompactSummary(response.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failureReason: `${failureReason}; repair attempt failed: ${message}`,
    };
  }

  const repairedFailure = compactSummaryFailureReason(summary);
  if (repairedFailure) {
    return {
      ok: false,
      failureReason: `${failureReason}; repair attempt still invalid: ${repairedFailure}`,
    };
  }
  return { ok: true, summary };
}

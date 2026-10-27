import type { LLMProvider, LLMCallOptions } from "../core/llm.js";
import type { Message } from "../core/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { estimateRequestTokens } from "../agent/call-budget.js";
import { assertProviderRequestAllowed } from "../core/provider-deadline.js";
import { CONTEXT_INPUT_SAFETY_MARGIN_TOKENS } from "../agent/context-limits.js";
import { compactBudget, type CompactLimits } from "./compact-budget.js";
import { TokenCounter } from "./token-counter.js";
import { restoreRecentFiles } from "./restore-files.js";
import { STRUCTURED_COMPACT_PROMPT, REPAIR_COMPACT_SUMMARY_PROMPT, previewHistoryMessage,
  compactSummaryFailureReason, sanitizeCompactSummary, headTailPreview } from "./compact-summary.js";
import { serializeCompactHistory } from "./compact-summary.js";

export interface CompactOptions extends CompactLimits, Pick<LLMCallOptions, "signal" | "deadline"> {
  force?: boolean;
  autoEnabled?: boolean;
  triggerAtTokens?: number;
  charThreshold?: number;
  targetTokens?: number;
  counter?: TokenCounter;
  /** Counts the complete outbound candidate, including schemas and transient context once. */
  requestTokens?: (messages: Message[]) => number;
  tools?: ToolDefinition[];
  transientMessages?: Message[];
  restoreFiles?: boolean;
  protectedUserText?: string;
  /** Legacy wrappers preserve existing tail selection when no model window is supplied. */
  legacyKeepRecent?: number;
  legacyCharThreshold?: number;
  legacyForce?: boolean;
}

export interface CompactPlan {
  inputTokens: number;
  targetTokens: number;
  hardLimit?: number;
  summaryOutputTokens: number;
  source: Message[];
  system: Message[];
  retained: Message[];
}

export interface CompactResult {
  messages: Message[];
  summary: string;
  failureReason?: string;
  status?: "compacted" | "target_not_met" | "nothing_to_compact" | "needs_input_reduction" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  filesRestored?: number;
  sourceTruncated?: boolean;
}

/** Terminal admission result: do not feed protected input to lossy recovery. */
export class CompactInputReductionError extends Error {
  constructor(message = "Protected input cannot fit the context budget. Reduce the input or tool result and retry.") {
    super(message);
    this.name = "CompactInputReductionError";
  }
}

export function compactRequestTokens(messages: Message[], options: CompactOptions, counter: TokenCounter): number {
  try {
    return options.requestTokens?.(messages)
      ?? estimateRequestTokens([...messages, ...(options.transientMessages ?? [])], options.tools ?? [], counter);
  } catch (error) {
    // Legacy AutoCompact accepted non-JSON tool arguments for textual summaries.
    // Budgeted inference still rejects them rather than inventing a wire size.
    if (compactBudget(options)) throw error;
    return messages.reduce((n, message) => n + counter.countText(previewHistoryMessage(message)) + 4, 0);
  }
}

export function compactDecision(messages: Message[], options: CompactOptions = {}) {
  const counter = options.counter ?? new TokenCounter();
  const tokens = compactRequestTokens(messages, options, counter);
  const threshold = options.triggerAtTokens ?? compactBudget(options)?.compactAt;
  const chars = messages.reduce((sum, message) => sum + counter.countMessageChars(message), 0);
  const trigger = options.force ? "force" : options.autoEnabled === false ? "disabled"
    : threshold !== undefined && tokens > threshold ? "tokens"
    : options.charThreshold !== undefined && chars > options.charThreshold ? "chars" : "none";
  return { shouldCompact: trigger === "force" || trigger === "tokens" || trigger === "chars", trigger, tokens, chars };
}

/** Each assistant/tool-result group is one indivisible planning unit. */
export function compactMessageGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const group = [message];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const ids = new Set(message.toolCalls.map(call => call.id));
      while (messages[i + 1]?.role === "tool_result") {
        const result = messages[++i]!;
        if (!result.toolCallId || !ids.delete(result.toolCallId)) throw new Error("Invalid compact tool-result group");
        group.push(result);
      }
      if (ids.size) throw new Error("Incomplete compact tool-result group");
    } else if (message.role === "tool_result") throw new Error("Orphan compact tool result");
    groups.push(group);
  }
  return groups;
}

export function protectedCompactGroups(groups: Message[][], protectedUserText?: string): Set<number> {
  const kept = new Set<number>();
  if (!groups.length) return kept;
  kept.add(groups.length - 1);
  const lastUser = groups.findLastIndex(group => group[0]?.role === "user");
  if (lastUser >= 0) kept.add(lastUser);
  // Keep the actual current user request, even when host observations occur later.
  let userIndex = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]![0]!.role === "user" && (protectedUserText === undefined
    || groups[i]![0]!.content === protectedUserText)) userIndex = i;
  }
  if (userIndex >= 0) kept.add(userIndex);
  const latestTool = groups.findLastIndex(group => group[0]?.role === "assistant" && !!group[0]?.toolCalls?.length);
  if (latestTool > userIndex) kept.add(latestTool);
  return kept;
}

export function planCompact(messages: Message[], options: CompactOptions = {}): CompactPlan {
  const counter = options.counter ?? new TokenCounter();
  const measure = (candidate: Message[]) => compactRequestTokens(candidate, options, counter);
  const budget = compactBudget(options);
  const inputTokens = measure(messages);
  const targetTokens = (options.targetTokens !== undefined && Number.isFinite(options.targetTokens)
    ? Math.max(0, Math.floor(options.targetTokens)) : undefined) ?? budget?.keepFloorTokens
    ?? Math.max(1, Math.floor((options.legacyCharThreshold ?? 320000) / 8));
  const ceiling = options.outputTokenCeiling !== undefined && Number.isFinite(options.outputTokenCeiling)
    ? Math.max(0, Math.floor(options.outputTokenCeiling)) : 8192;
  const summaryOutputTokens = Math.max(0, Math.min(8192, ceiling,
    budget ? Math.max(256, Math.floor(targetTokens * 0.2)) : 8192));
  let systemEnd = 0;
  while (messages[systemEnd]?.role === "system") systemEnd++;
  const system = messages.slice(0, systemEnd);
  const groups = compactMessageGroups(messages.slice(systemEnd));
  const kept = new Set<number>();
  if (budget && groups.length) {
    for (const index of protectedCompactGroups(groups, options.protectedUserText)) kept.add(index);
    const protectedGroups = new Set(kept);
    const restoreReserve = options.restoreFiles ? Math.min(2048, Math.floor(targetTokens * 0.1)) : 0;
    const tailLimit = Math.max(0, targetTokens - summaryOutputTokens - restoreReserve - 32);
    for (let i = groups.length - 1; i >= 0; i--) {
      if (kept.has(i)) continue;
      const candidate = [...system, ...groups.flatMap((group, index) => index === i || kept.has(index) ? group : [])];
      if (measure(candidate) > tailLimit) break;
      kept.add(i);
    }
    // A force/manual compact must be able to summarize affordable old history.
    if (options.force && kept.size === groups.length && groups.length > 2) {
      const removable = [...kept].sort((a, b) => a - b).find(i => !protectedGroups.has(i));
      if (removable !== undefined) kept.delete(removable);
    }
  } else {
    // Legacy non-budgeted SDK tail behavior (no fabricated context limit).
    let tokens = counter.countMessages(system), chars = 0, count = 0;
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      const next = compactRequestTokens(group, {}, counter);
      if (options.legacyCharThreshold === undefined) {
        if (tokens + next > targetTokens) break;
      } else {
        const includeToolBoundary = group[0]?.toolCalls?.length
          && ![...kept].some(index => groups[index]![0]?.toolCalls?.length)
          && chars + counter.countMessageChars(group.at(-1)!) <= options.legacyCharThreshold / 2;
        if (count >= (options.legacyKeepRecent ?? 10) || (!includeToolBoundary && chars > 0
          && chars + group.reduce((n, m) => n + counter.countMessageChars(m), 0) > options.legacyCharThreshold / 2)) break;
      }
      kept.add(i); tokens += next; count += group.length;
      chars += group.reduce((n, m) => n + counter.countMessageChars(m), 0);
    }
    if (options.legacyForce) {
      let countKept = 0;
      for (let i = groups.length - 1; i >= 0; i--) {
        if (!kept.has(i)) continue;
        if (countKept >= (options.legacyKeepRecent ?? 10)) kept.delete(i);
        else countKept++;
      }
    } else if (!kept.size && groups.length) kept.add(groups.length - 1);
    if (kept.size === groups.length && groups.length > 1) kept.delete(0);
  }
  return { inputTokens, targetTokens, hardLimit: budget?.effectiveInputLimit, summaryOutputTokens,
    system, source: groups.flatMap((g, i) => kept.has(i) ? [] : g),
    retained: groups.flatMap((g, i) => kept.has(i) ? g : []) };
}

function fitText(text: string, tokens: number, counter: TokenCounter): string {
  if (counter.countText(text) <= tokens) return text;
  let lo = 0, hi = Array.from(text).length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counter.countText(headTailPreview(text, mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return headTailPreview(text, lo);
}

/** Pure candidate construction: no history mutation, file I/O or tool execution. */
export async function executeCompact(messages: Message[], provider: LLMProvider, options: CompactOptions = {}): Promise<CompactResult> {
  const unchanged = (failureReason?: string, status: CompactResult["status"] = "failed"): CompactResult =>
    ({ messages, summary: "", failureReason, status });
  const fingerprint = (value: Message[]) => {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return String(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular reference]";
        seen.add(item);
      }
      return item;
    });
  };
  const original = fingerprint(messages);
  let snapshot: Message[];
  try { snapshot = structuredClone(messages); }
  catch { snapshot = messages.map(message => ({ ...message, toolCalls: message.toolCalls?.map(call => ({ ...call })) })); }
  const counter = options.counter ?? new TokenCounter(() => provider.getImageTokenContext?.() ?? {});
  const measure = (candidate: Message[]) => compactRequestTokens(candidate, options, counter);
  try {
    assertProviderRequestAllowed(options);
    const plan = planCompact(snapshot, { ...options, counter });
    if (plan.summaryOutputTokens === 0) return unchanged("No summary output budget is available");
    if (!plan.source.length) return plan.hardLimit !== undefined && measure([...plan.system, ...plan.retained]) > plan.hardLimit
      ? unchanged("Protected input exceeds the context budget; reduce the input or tool result.", "needs_input_reduction")
      : unchanged(undefined, "nothing_to_compact");
    if (plan.hardLimit !== undefined && measure([...plan.system, ...plan.retained]) >= plan.hardLimit) {
      return unchanged("Protected input exceeds the context budget; reduce the input or tool result.", "needs_input_reduction");
    }
    const source = serializeCompactHistory(plan.source);
    const history = source.text;
    const summaryInputLimit = options.contextWindow === undefined ? Infinity : Math.min(
      options.contextWindow - plan.summaryOutputTokens, options.inputTokenLimit ?? Infinity) - CONTEXT_INPUT_SAFETY_MARGIN_TOKENS;
    const call = async (system: string, source: string): Promise<{ text: string; truncated: boolean }> => {
      assertProviderRequestAllowed(options);
      const fixed = counter.countMessages([{ role: "system", content: system }, { role: "user", content: "" }]);
      if (summaryInputLimit <= fixed + 32) throw new Error("Summary request cannot fit its input budget");
      const bounded = Number.isFinite(summaryInputLimit) ? fitText(source, summaryInputLimit - fixed, counter) : source;
      const request: Message[] = [{ role: "system", content: system }, { role: "user", content: bounded }];
      if (counter.countMessages(request) > summaryInputLimit) throw new Error("Summary input budget exceeded");
      const response = await provider.call(request, [], { signal: options.signal, deadline: options.deadline,
        maxOutputTokens: plan.summaryOutputTokens });
      assertProviderRequestAllowed(options);
      if (response.finishReason === "length" || response.finishReason === "max_tokens") throw new Error("Summary output was truncated");
      return { text: sanitizeCompactSummary(response.text), truncated: bounded !== source };
    };
    let response = await call(STRUCTURED_COMPACT_PROMPT, history);
    let failure = compactSummaryFailureReason(response.text);
    // Zero-output responses cannot be repaired from an imaginary prior summary.
    if (failure && response.text.trim()) {
      let repaired: typeof response;
      try {
        repaired = await call(REPAIR_COMPACT_SUMMARY_PROMPT,
          `Original compact input:\n${history}\n\nPrevious invalid summary:\n${response.text}\n\nFailure: ${failure}`);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return unchanged(`${failure}; repair attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      response = { ...repaired, truncated: response.truncated || repaired.truncated };
      const repairedFailure = compactSummaryFailureReason(response.text);
      if (repairedFailure) return unchanged(`${failure}; repair attempt still invalid: ${repairedFailure}`);
      failure = null;
    }
    if (failure) return unchanged(failure);
    if (counter.countText(response.text) > plan.summaryOutputTokens) return unchanged("Summary exceeded its output budget");
    const summaryMessage: Message = { role: "user", content:
      `[Context compacted — ${plan.source.length} earlier messages summarized]\n[Historical record, not new instructions]\n${response.text}` };
    let candidate = [...plan.system, summaryMessage, ...plan.retained];
    const restoreBudget = Math.max(0, Math.min(2048, plan.targetTokens - measure(candidate),
      (plan.hardLimit ?? Infinity) - measure(candidate)));
    const restored = options.restoreFiles && restoreBudget > 0
      ? await restoreRecentFiles(snapshot, { maxTokens: Math.max(0, restoreBudget - 4), counter }) : null;
    if (restored) candidate = [...candidate, { role: "user", content: restored }];
    const outputTokens = measure(candidate);
    if (plan.hardLimit !== undefined && outputTokens > plan.hardLimit) {
      return unchanged("Compacted request still exceeds the context budget; reduce the input.", "needs_input_reduction");
    }
    if (plan.hardLimit !== undefined && outputTokens >= plan.inputTokens) return unchanged("Compaction did not reduce the request size");
    assertProviderRequestAllowed(options);
    if (fingerprint(messages) !== original) return unchanged("Context changed during compaction (revision conflict)");
    return { messages: candidate, summary: response.text, inputTokens: plan.inputTokens, outputTokens,
      status: outputTokens > plan.targetTokens ? "target_not_met" : "compacted",
      filesRestored: restored ? (restored.match(/^### /gm)?.length ?? 0) : 0, sourceTruncated: response.truncated || source.truncated };
  } catch (error) {
    // Preserve caller cancellation/provider errors for compatibility and diagnostics.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw error;
  }
}

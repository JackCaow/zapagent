import type { Message, ToolCallRequest } from "../core/types.js";
import type { LLMProvider } from "../core/llm.js";
import { HistoricalImageRetention, type HistoricalImagePolicy } from "../context/historical-images.js";
import { mergeRecoveredProviderView } from "../context/request-recovery.js";
import { TokenCounter } from "../context/token-counter.js";
import { STRUCTURED_COMPACT_PROMPT, compactSummaryFailureReason, previewMessageForCompact, sanitizeCompactSummary } from "../context/autocompact.js";
import {
  type Turn,
  type CompletedCall,
  type IncompleteCall,
  buildToolTurn,
  turnToMessages,
  turnsToMessages,
} from "../core/turn.js";

export interface CompressResult {
  summary: string;
  /** Total non-system messages (in derived Message view) that existed at compression entry. */
  before: number;
  /** Surviving non-system messages (tail kept), excluding the new summary message. */
  after: number;
}

export interface ConversationManagerOptions {
  tokenCounter?: TokenCounter;
  /**
   * Maximum derived messages retained/sent. Use Infinity when an outer
   * token-aware compactor owns the history boundary. In that mode this
   * manager keeps the complete backing store even above maxTokens and only
   * returns a bounded provider view until the outer compactor establishes a
   * new cache epoch.
   */
  maxMessages: number;
  /** Session media hysteresis; false disables proactive retirement, not 413 recovery. */
  imageRetention?: Partial<HistoricalImagePolicy> | false;
  /** Hard ceiling — exceeding this triggers synchronous truncate when no summarizer. */
  maxTokens?: number;
  /**
   * Soft trigger — when exceeded, compression is scheduled (deferred to waitForCompression).
   * Should match the outer user-turn trigger. Defaults to maxTokens for backwards compat.
   */
  triggerAtTokens?: number;
  /** Target token floor after compression (passed to compress). Defaults to 50% of triggerAtTokens. */
  targetTokensAfterCompress?: number;
  summarizer?: LLMProvider;
  autoCompress?: boolean;
}

interface CompressOptions {
  force?: boolean;
  targetTokens?: number;
  signal?: AbortSignal;
}

/** Buffer state for the legacy `add(assistant_with_toolCalls)` →
 *  `add(tool_result)*` sequence. Production code paths use `commitTurn`
 *  directly and never trigger this; the buffer exists for tests + any
 *  legacy caller that still emits assistant + tool_results separately.
 *  Auto-flushed (with synthesized failure results for missing tool_results)
 *  on the next non-tool_result message, on commitTurn, on getMessages, or
 *  any read/mutate/clear operation. */
interface PendingToolTurn {
  text: string;
  raw?: Record<string, unknown>;
  toolCalls: ToolCallRequest[];
  /** toolCallId → received tool_result Message body. */
  received: Map<string, { content: string; contentBlocks?: Message["contentBlocks"]; executionObservation?: Message["executionObservation"]; toolResultSuccess?: boolean; toolResultSuppression?: Message["toolResultSuppression"] }>;
}

/**
 * Phase 2 of the Turn-based history refactor (issue #12). The internal
 * source of truth is now `Turn[]` — a sequence of atomically-committed
 * conversational turns where every assistant tool_use is paired with its
 * tool_result by construction. Orphans are unrepresentable in this storage.
 *
 * `getMessages()` is a derived view computed via `turnsToMessages(turns)` —
 * the wire shape is now a pure projection of internal state, not the
 * canonical state itself. This eliminates an entire class of "we forgot
 * to keep these in sync" bugs (issue #12 was one of them).
 */
export class ConversationManager {
  private turns: Turn[] = [];
  private pending: PendingToolTurn | null = null;
  /** Recovery keeps omitted history readable without reintroducing it into requests. */
  private providerViewFloor = 0;
  private historicalImages?: HistoricalImageRetention;
  private maxMessages: number;
  private maxTokens?: number;
  private triggerAtTokens?: number;
  private targetTokensAfterCompress?: number;
  private summarizer?: LLMProvider;
  private autoCompress: boolean;
  private counter: TokenCounter;
  private _estimatedTokens = 0;
  private needsCompression = false;
  private _lastCompressionFailureReason: string | undefined;

  constructor(options: ConversationManagerOptions) {
    if (options.imageRetention !== false) this.historicalImages = new HistoricalImageRetention(options.imageRetention);
    this.maxMessages = messageLimitOrDefault(options.maxMessages, 100);
    this.maxTokens = nonNegativeInteger(options.maxTokens);
    this.triggerAtTokens = nonNegativeInteger(options.triggerAtTokens) ?? this.maxTokens;
    this.targetTokensAfterCompress = nonNegativeInteger(options.targetTokensAfterCompress)
      ?? (this.triggerAtTokens ? Math.floor(this.triggerAtTokens * 0.5) : undefined);
    this.summarizer = options.summarizer;
    this.autoCompress = options.autoCompress ?? false;
    this.counter = options.tokenCounter ?? new TokenCounter();
  }

  /**
   * Atomic-commit a Turn into history. The Turn type guarantees by
   * construction that every tool_use has a paired result, so this CANNOT
   * introduce orphan tool_use ↔ tool_result references — unlike the prior
   * pattern of `add(assistant)` followed by `add(tool_result)*` which
   * could leave history half-written on partial-failure paths.
   */
  commitTurn(turn: Turn): void {
    this.flushPending();
    this.turns.push(turn);
    this.afterMutate();
  }

  /**
   * Legacy single-message append. Kept for tests + any caller that hasn't
   * migrated to `commitTurn` yet. The handler routes by role:
   *   - system / user / assistant_text → wrapped in a single Turn and committed
   *   - assistant with `toolCalls` → starts a buffer waiting for tool_results
   *   - tool_result → appended to the buffer, which auto-flushes when
   *     `received.size === toolCalls.length`. If a non-tool_result message
   *     arrives while the buffer is incomplete (or `getMessages` / etc is
   *     called), the buffer flushes anyway with synthesized failure
   *     `ToolResult`s for missing tool_results — same Turn invariant
   *     enforcement as `buildToolTurn`'s incomplete-call path.
   *   - orphan tool_result (no pending buffer) → dropped silently.
   */
  add(message: Message): void {
    if (message.role === "tool_result") {
      if (this.pending && message.toolCallId) {
        this.pending.received.set(message.toolCallId, {
          content: message.content,
          contentBlocks: message.contentBlocks,
          executionObservation: message.executionObservation,
          toolResultSuccess: message.toolResultSuccess,
          toolResultSuppression: message.toolResultSuppression,
        });
        if (this.pending.received.size >= this.pending.toolCalls.length) {
          this.flushPending();
        }
        return;
      }
      // No pending assistant to attach to — orphan. Drop silently rather
      // than propagate it into wire-shape history.
      return;
    }

    // Anything that's not a tool_result flushes a buffered assistant first.
    this.flushPending();

    if (message.role === "assistant" && message.toolCalls?.length) {
      this.pending = {
        text: message.content,
        raw: message.raw,
        toolCalls: message.toolCalls,
        received: new Map(),
      };
      return;
    }

    // system / user / assistant_text → wrap in a single Turn.
    this.commitTurn(messageToTurn(message));
  }

  /** If a tool_use ↔ tool_result buffer is open, finalize it now —
   *  synthesizing failure ToolResults for any missing tool_results so the
   *  resulting Turn satisfies the Turn invariants. Recalculates the token
   *  cache before returning because `_estimatedTokens` was computed without
   *  the buffered turn's contribution and is now stale. */
  private flushPending(): void {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    const completed: CompletedCall[] = [];
    const incomplete: IncompleteCall[] = [];
    for (const tc of p.toolCalls) {
      const got = p.received.get(tc.id);
      if (got) {
        completed.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          result: { success: got.toolResultSuccess ?? true, output: got.content, contentBlocks: got.contentBlocks,
            ...(got.toolResultSuppression ? { runtime: { suppression: got.toolResultSuppression } } : {}) },
          ...(tc.name === "read_file" && got.toolResultSuccess === undefined ? { resultStatusUnknown: true as const } : {}),
          formattedOutput: got.content,
          executionObservation: got.executionObservation,
        });
      } else {
        incomplete.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          reason: "tool_result missing in legacy add() sequence",
        });
      }
    }
    this.turns.push(buildToolTurn({ text: p.text, raw: p.raw, completed, incomplete }));
    this.recalculateTokens();
  }

  /** Hook called after any mutation that might shift size. Recomputes the
   *  token estimate and applies the count-based or token-based truncation
   *  rules. Mirrors the prior `add()` tail. */
  private afterMutate(): void {
    this._lastCompressionFailureReason = undefined;
    this.recalculateTokens();

    const softTrigger = this.triggerAtTokens ?? this.maxTokens;
    if (this.autoCompress && softTrigger && this._estimatedTokens > softTrigger) {
      if (this.summarizer) {
        this.needsCompression = true;
      } else if (
        this.maxTokens
        && this._estimatedTokens > this.maxTokens
        && Number.isFinite(this.maxMessages)
      ) {
        this.truncateToTokenBudget();
      }
      return;
    }
    if (!this.summarizer && this.derivedMessageCount() > this.maxMessages) {
      this.truncate();
    }
  }

  private derivedMessageCount(): number {
    let n = 0;
    for (const t of this.turns) n += turnLength(t);
    if (this.pending) {
      // Count what the buffer WILL flush as, not its current state. The
      // pending turn always emits 1 assistant + N tool_results where N is
      // toolCalls.length (any unreceived become synthesized failures), so
      // the eventual size is `1 + toolCalls.length`. Counting received.size
      // instead would underestimate while args were still streaming in and
      // delay soft-trigger checks by a step or two.
      n += 1 + this.pending.toolCalls.length;
    }
    return n;
  }

  getMessages(): Message[] {
    this.flushPending();
    const all = turnsToMessages(this.turns);
    if (this.providerViewFloor === 0 && all.length <= this.maxMessages && !this.isOverTokenBudget()) {
      return all;
    }
    return this.getTruncatedView();
  }

  /** Retire media only in the outbound view, preserving hidden backing history.
   * Commit before dispatch so subsequent tools/runs reuse identical tombstones. */
  maintainHistoricalImages() {
    const requested = this.getMessages();
    const result = this.historicalImages?.prepare(requested);
    if (!result?.retiredGroups) return undefined;
    const merged = mergeRecoveredProviderView(this.getAllMessages(), requested, result.messages);
    this.turns = rederiveTurns(merged.messages);
    this.recalculateTokens();
    this.setProviderViewStart(merged.viewStart);
    const { messages: _messages, ...notice } = result;
    return notice;
  }

  /** Pin the first non-system provider turn after a successful recovery.
   * The full backing history remains available to maintenance and rewind. */
  setProviderViewStart(messageIndex: number): void {
    this.flushPending();
    let messages = 0;
    let floor = 0;
    for (const turn of this.turns) {
      if (messages >= messageIndex || messages + turnLength(turn) > messageIndex) break;
      messages += turnLength(turn);
      floor++;
    }
    this.providerViewFloor = floor;
  }

  /**
   * Full wire-shape projection of the backing Turn[] store. Unlike
   * `getMessages()`, this never applies count/token truncation. Use it for
   * internal maintenance that must see the complete persisted history
   * (compaction input, diagnostics, pre-compact file restoration), not for
   * outbound provider calls.
   */
  getAllMessages(): Message[] {
    this.flushPending();
    return turnsToMessages(this.turns);
  }

  /**
   * Direct read access to the Turn-shaped storage. Use this for any new code
   * that wants to operate at turn granularity (e.g. microcompact rewriting
   * tool_result bodies on old `tool_turn` entries). Returns a defensive
   * snapshot — mutating the array does NOT mutate internal state.
   */
  getTurns(): Turn[] {
    this.flushPending();
    return [...this.turns];
  }

  /**
   * Apply an in-place mutation to the FULL message array (legacy API).
   * Snapshots the turn-derived Message[] view, lets the mutator modify
   * fields in place, then re-derives turns from the mutated messages
   * (the same buffer-and-coalesce logic as `add()`) and replaces internal
   * state.
   *
   * **Important contract**: the snapshot the mutator sees is NOT the truth
   * source. After the mutator returns, the array gets re-coalesced into
   * Turn[] form, and any structural break (deleted tool_result without
   * deleting its assistant.toolCalls entry, or vice versa) gets healed by
   * synthesizing a failure ToolResult / dropping the orphan. Mutations
   * that only change content strings (Microcompact's pattern: rewriting
   * old tool_result bodies in place) round-trip exactly. Mutations that
   * change structure may produce a different shape than the mutator
   * intended.
   *
   * For new code, prefer `mutateTurnsInPlace` — it skips the round-trip
   * and gives the mutator the actual storage to work with.
   */
  mutateInPlace<T>(fn: (messages: Message[]) => T): T {
    this.flushPending();
    const snapshot = turnsToMessages(this.turns);
    const original = [...snapshot];
    const result = fn(snapshot);
    // Field edits (such as clearing cache hints) retain this view. Replacing
    // messages can load another session with the same roles, so reset its floor.
    if (snapshot.length !== original.length || snapshot.some((m, i) => m !== original[i])) {
      this.providerViewFloor = 0;
      this.historicalImages?.reset();
    }
    // Re-derive turns from the mutated message array. Use a fresh
    // ConversationManager-style buffer to coalesce assistant + tool_results
    // back into tool_turns with the new content.
    this.turns = rederiveTurns(snapshot);
    this._lastCompressionFailureReason = undefined;
    this.recalculateTokens();
    return result;
  }

  /**
   * Direct turn-level mutation. The mutator gets the live `Turn[]` and
   * may modify in place (push/splice/replace). After it returns, token
   * counts are recomputed.
   */
  mutateTurnsInPlace<T>(fn: (turns: Turn[]) => T): T {
    this.flushPending();
    const anchor = this.turns[this.providerViewFloor];
    const result = fn(this.turns);
    this.providerViewFloor = anchor ? Math.max(0, this.turns.indexOf(anchor)) : 0;
    this._lastCompressionFailureReason = undefined;
    this.recalculateTokens();
    return result;
  }

  /** Number of messages in the derived view (diagnostics/testing). */
  get messageCount(): number {
    this.flushPending();
    return this.derivedMessageCount();
  }

  /** Most recent failed compression reason. Diagnostic only; cleared at the
   *  start of each compress() attempt and left undefined for genuine no-ops. */
  get lastCompressionFailureReason(): string | undefined {
    return this._lastCompressionFailureReason;
  }

  /**
   * Compress conversation by LLM summarization. Keeps the most recent turns
   * whose total token count fits under `targetTokens` (defaults to
   * `targetTokensAfterCompress`, which defaults to 50% of the trigger);
   * earlier turns become a single summary turn.
   */
  async compress(
    provider?: LLMProvider,
    options: CompressOptions = {},
  ): Promise<CompressResult | null> {
    this.flushPending();
    this._lastCompressionFailureReason = undefined;

    const force = options.force ?? false;
    const targetTokens = nonNegativeInteger(options.targetTokens)
      ?? this.targetTokensAfterCompress
      ?? (this.triggerAtTokens ? Math.floor(this.triggerAtTokens * 0.5) : undefined);

    const summarizer = provider ?? this.summarizer;
    if (!summarizer) return null;

    const allMessages = turnsToMessages(this.turns);

    const overMessages = allMessages.length > this.maxMessages;
    const overTokens = this.maxTokens ? this._estimatedTokens > this.maxTokens : false;
    const overSoftTrigger = this.triggerAtTokens ? this._estimatedTokens > this.triggerAtTokens : false;

    if (!force && !overMessages && !overTokens && !overSoftTrigger) return null;
    if (targetTokens === undefined) return null;

    // Preserve only the leading system prefix. Non-leading system turns are
    // historical content and must not be hoisted ahead of earlier user turns.
    const { systemTurns, nonSystemTurns: nonSystem } = splitLeadingSystemPrefix(this.turns);

    // Greedy keep-from-tail: include turns at the end while we fit under
    // targetTokens. Each turn is treated as an indivisible unit (matches
    // the wire-level pairing invariant — never split an assistant from
    // its tool_results).
    const systemMsgsTokens = systemTurns.reduce((sum, t) => sum + countTurnTokens(this.counter, t), 0);
    let keepStart = nonSystem.length;
    let keepTokens = systemMsgsTokens;
    while (keepStart > 0) {
      const next = keepStart - 1;
      const t = nonSystem[next];
      const tTokens = countTurnTokens(this.counter, t);
      if (keepTokens + tTokens > targetTokens) break;
      keepStart = next;
      keepTokens += tTokens;
    }
    if (!force && keepStart === nonSystem.length && nonSystem.length > 0) {
      keepStart = nonSystem.length - 1;
    }
    if (force && nonSystem.length > 1) {
      const cap = Math.max(0, nonSystem.length - 10);
      if (keepStart < cap) keepStart = cap;
    }

    const toSummarize = nonSystem.slice(0, keepStart);
    const toKeep = nonSystem.slice(keepStart);

    if (toSummarize.length === 0) return null;

    // Convert summarized turns to messages for the LLM input. Counting
    // before/after at the message level keeps backward-compat with the
    // CompressResult shape consumers display.
    const summarizedMsgs = toSummarize.flatMap((t) => turnToMessages(t));
    const before = nonSystem.flatMap((t) => turnToMessages(t)).length;

    const historyText = summarizedMsgs
      .map((m) => {
        const role = m.role === "tool_result" ? "tool_result" : m.role;
        return `[${role}]: ${previewMessageForCompact(role, m.content)}`;
      })
      .join("\n\n");

    let response: Awaited<ReturnType<LLMProvider["call"]>>;
    try {
      response = await summarizer.call([
        { role: "system", content: STRUCTURED_COMPACT_PROMPT },
        { role: "user", content: historyText },
      ], undefined, { signal: options.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._lastCompressionFailureReason = `summarizer failed: ${message}`;
      throw err;
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("compression aborted");
    }
    const summary = sanitizeCompactSummary(response.text);
    const failureReason = compactSummaryFailureReason(summary);
    if (failureReason) {
      this._lastCompressionFailureReason = failureReason;
      return null;
    }

    const summaryTurn: Turn = {
      kind: "user",
      content: `[Context compacted — ${summarizedMsgs.length} earlier messages summarized]\n${summary}`,
    };

    this.turns = [...systemTurns, summaryTurn, ...toKeep];
    this.providerViewFloor = 0;
    this.recalculateTokens();

    const after = toKeep.flatMap((t) => turnToMessages(t)).length;

    return { summary, before, after };
  }

  async waitForCompression(provider?: LLMProvider, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.needsCompression) return;
    const summarizer = provider ?? this.summarizer;
    if (!summarizer) {
      this.needsCompression = false;
      return;
    }
    this.needsCompression = false;

    const trigger = this.triggerAtTokens ?? this.maxTokens ?? Infinity;
    const target = this.targetTokensAfterCompress ?? Math.floor(trigger * 0.5);
    let iterations = 0;
    while (this._estimatedTokens > trigger && iterations < 10) {
      const before = this._estimatedTokens;
      let result: CompressResult | null;
      try {
        result = await this.compress(summarizer, { force: true, targetTokens: target, signal: options.signal });
      } catch {
        result = null;
      }
      iterations++;
      if (!result || this._estimatedTokens >= before) break;
    }
    if (this._estimatedTokens > trigger) {
      this.needsCompression = true;
    }
  }

  get estimatedTokens(): number {
    return this._estimatedTokens;
  }

  setTargetTokensAfterCompress(value: number): void {
    this.targetTokensAfterCompress = nonNegativeInteger(value);
  }

  clear(): void {
    this.historicalImages?.reset();
    this.providerViewFloor = 0;
    this.turns = [];
    this.pending = null;
    this._estimatedTokens = 0;
    this.needsCompression = false;
    this._lastCompressionFailureReason = undefined;
  }

  /**
   * Drop all messages at or after the given message-shape index. Used by
   * rewind to revert the conversation to the state at the start of a
   * previous turn. Translates the message index to a turn index using
   * `turnLength` so a single tool_turn (which fans out into 1+N messages)
   * is treated as an atomic unit — you can't rewind to "after the
   * assistant but before the tool_results".
   */
  truncateAfter(index: number): void {
    if (index < 0) return;
    this.flushPending();
    let cumulative = 0;
    for (let i = 0; i < this.turns.length; i++) {
      const len = turnLength(this.turns[i]);
      if (cumulative + len > index) {
        // The cut falls inside this turn (or exactly at its start). Cut at
        // the turn boundary BEFORE this turn — atomicity over precision.
        // If the cut is exactly at the turn's start (cumulative === index),
        // we cut here too; if mid-turn, we still cut here (drop the partial).
        this.turns = this.turns.slice(0, i);
        this.historicalImages?.reset();
        if (this.providerViewFloor >= i) this.providerViewFloor = 0;
        this.recalculateTokens();
        this.needsCompression = false;
        this._lastCompressionFailureReason = undefined;
        return;
      }
      cumulative += len;
    }
    // index >= total length — nothing to do
  }

  /** Recount existing history when the active model changes, without truncating it. */
  setTokenCounter(counter: TokenCounter): void {
    this.flushPending();
    this.counter = counter;
    this.recalculateTokens();
    this.needsCompression = !!(this.autoCompress && this.summarizer &&
      this._estimatedTokens > (this.triggerAtTokens ?? this.maxTokens ?? Infinity));
  }

  setMaxTokens(value: number): void {
    this.maxTokens = nonNegativeInteger(value);
  }

  setTriggerAtTokens(value: number): void {
    this.triggerAtTokens = nonNegativeInteger(value);
  }

  private truncate(): void {
    const { systemTurns, nonSystemTurns: nonSystem } = splitLeadingSystemPrefix(this.turns);

    // Convert message-count limit to "approximate keep-this-many turns from tail":
    // greedily keep turns from the tail until adding the next one would push
    // the total derived-message count over `maxMessages`.
    const keepLimit = this.maxMessages - systemTurns.reduce((s, t) => s + turnLength(t), 0);
    let kept: Turn[] = [];
    let total = 0;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const len = turnLength(nonSystem[i]);
      if (total + len > keepLimit) break;
      kept.unshift(nonSystem[i]);
      total += len;
    }
    kept = dropPromotedLeadingSystemTurns(kept, kept.length < nonSystem.length);
    const removedTurns = this.turns.length - systemTurns.length - kept.length;
    this.providerViewFloor = Math.max(0, this.providerViewFloor - removedTurns);
    this.turns = [...systemTurns, ...kept];
    this.recalculateTokens();
  }

  private truncateToTokenBudget(): void {
    if (!this.maxTokens) return;
    const { systemTurns, nonSystemTurns: nonSystem } = splitLeadingSystemPrefix(this.turns);

    // Compute per-turn token contribution once, then shift incrementally.
    // The previous loop re-counted the entire candidate every iteration —
    // O(N²) on the keep-tail length, painful when token-budget pressure
    // forces dropping a long history. Per-turn counting is cheap because
    // each turn's messages are a small fixed-size group.
    const systemTokens = systemTurns.reduce(
      (sum, t) => sum + this.counter.countMessages(turnToMessages(t)),
      0,
    );
    const turnTokens = nonSystem.map((t) => this.counter.countMessages(turnToMessages(t)));
    let total = systemTokens + turnTokens.reduce((a, b) => a + b, 0);

    let kept = [...nonSystem];
    let head = 0;
    while (kept.length - head > 1 && total > this.maxTokens) {
      total -= turnTokens[head];
      head++;
    }
    if (head > 0) kept = kept.slice(head);
    kept = dropPromotedLeadingSystemTurns(kept, head > 0);

    const removedTurns = this.turns.length - systemTurns.length - kept.length;
    this.providerViewFloor = Math.max(0, this.providerViewFloor - removedTurns);
    this.turns = [...systemTurns, ...kept];
    this.recalculateTokens();
  }

  private getTruncatedView(): Message[] {
    // Walk turns from the tail, emit messages in original order, stop when
    // we hit maxMessages or maxTokens. Leading system turns are always retained at head.
    const { systemTurns, nonSystemTurns: nonSystem } = splitLeadingSystemPrefix(this.turns);
    const systemMsgs = systemTurns.flatMap((t) => turnToMessages(t));
    const keepLimit = this.maxMessages - systemMsgs.length;
    if (keepLimit <= 0) return systemMsgs;

    const hasTokenLimit = !!this.maxTokens;
    const tokenLimit = this.maxTokens ?? Infinity;
    const systemTokens = hasTokenLimit ? this.counter.countMessages(systemMsgs) : 0;
    let tailTokens = 0;
    let tailMessageCount = 0;
    let tailTurns: Turn[] = [];
    const floor = Math.max(0, this.providerViewFloor - systemTurns.length);
    let droppedPrefix = floor > 0;
    for (let i = nonSystem.length - 1; i >= floor; i--) {
      const ms = turnToMessages(nonSystem[i]);
      if (tailMessageCount + ms.length > keepLimit) {
        droppedPrefix = true;
        break;
      }

      const turnTokens = hasTokenLimit ? this.counter.countMessages(ms) : 0;
      if (hasTokenLimit && systemTokens + tailTokens + turnTokens > tokenLimit) {
        // Preserve at least the latest complete turn when it alone exceeds the
        // configured budget; returning only system context is less useful and
        // differs from truncateToTokenBudget's "keep one" behavior.
        if (tailTurns.length === 0) {
          tailTurns.unshift(nonSystem[i]);
        }
        droppedPrefix = true;
        break;
      }

      tailTurns.unshift(nonSystem[i]);
      tailTokens += turnTokens;
      tailMessageCount += ms.length;
    }
    tailTurns = dropPromotedLeadingSystemTurns(tailTurns, droppedPrefix);
    return [...systemMsgs, ...tailTurns.flatMap((t) => turnToMessages(t))];
  }

  private isOverTokenBudget(): boolean {
    return this.maxTokens ? this._estimatedTokens > this.maxTokens : false;
  }

  private recalculateTokens(): void {
    const msgs = turnsToMessages(this.turns);
    this._estimatedTokens = this.counter.countMessages(msgs);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

/** How many wire-shape Messages a Turn produces. */
function turnLength(t: Turn): number {
  if (t.kind === "tool_turn") return 1 + t.calls.length;
  return 1;
}

/** Sum of token counts over the messages a single turn produces. */
function countTurnTokens(counter: TokenCounter, t: Turn): number {
  return counter.countMessages(turnToMessages(t));
}

function splitLeadingSystemPrefix(turns: Turn[]): {
  systemTurns: Turn[];
  nonSystemTurns: Turn[];
} {
  let systemEnd = 0;
  while (turns[systemEnd]?.kind === "system") systemEnd++;
  return {
    systemTurns: turns.slice(0, systemEnd),
    nonSystemTurns: turns.slice(systemEnd),
  };
}

function dropPromotedLeadingSystemTurns(turns: Turn[], droppedPrefix: boolean): Turn[] {
  if (!droppedPrefix) return turns;
  let start = 0;
  while (turns[start]?.kind === "system") start++;
  return start > 0 ? turns.slice(start) : turns;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function nonNegativeIntegerOrDefault(value: number | undefined, fallback: number): number {
  return nonNegativeInteger(value) ?? fallback;
}

function messageLimitOrDefault(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  return nonNegativeIntegerOrDefault(value, fallback);
}

/** Wrap a single non-tool Message in a Turn. tool_result messages are not
 *  expected here — those go through the buffer in `add()`. */
function messageToTurn(m: Message): Turn {
  switch (m.role) {
    case "system":
      return { kind: "system", content: m.content };
    case "user": {
      const turn: Turn = { kind: "user", content: m.content };
      if (m.cache) turn.cache = { ...m.cache };
      // Pull image blocks out of contentBlocks (text block is reproduced
      // from `content` by `turnToMessages`).
      const images = m.contentBlocks?.filter((b) => b.type === "image") ?? [];
      if (images.length > 0) (turn as any).images = images;
      return turn;
    }
    case "assistant": {
      // The role dispatcher in `add()` routes assistant+toolCalls to the
      // pending buffer; this code path is for text-only assistants.
      // Reaching here with toolCalls is a programmer error — silently
      // dropping them would lose intent and produce a half-correct turn.
      // Throw loudly so the bug surfaces in tests instead of corrupting
      // history.
      if (m.toolCalls?.length) {
        throw new Error(
          "messageToTurn: assistant with toolCalls reached the message-shape " +
          "wrapper; route through ConversationManager.add() (which buffers + " +
          "coalesces) or commitTurn(buildToolTurn(...)) directly.",
        );
      }
      const turn: Turn = { kind: "assistant", text: m.content };
      if (m.raw) turn.raw = m.raw;
      return turn;
    }
    case "tool_result":
      // The role dispatcher in `add()` routes tool_result to the pending
      // buffer; this code path is for non-tool messages. A standalone
      // tool_result here is an orphan we'd silently drop — instead, throw.
      throw new Error(
        "messageToTurn: standalone tool_result reached the message-shape " +
        "wrapper. Use ConversationManager.add() so the buffer matches it " +
        "with the prior assistant.toolCalls, or drop the message at the " +
        "call site.",
      );
  }
}

/** Re-derive Turn[] from a (possibly-mutated) Message[] using the same
 *  buffer-and-coalesce logic as `add()`. Used by `mutateInPlace` to reflect
 *  message-level mutations back into Turn-shape storage. */
function rederiveTurns(msgs: Message[]): Turn[] {
  const out: Turn[] = [];
  let pending: PendingToolTurn | null = null;
  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    const completed: CompletedCall[] = [];
    const incomplete: IncompleteCall[] = [];
    for (const tc of p.toolCalls) {
      const got = p.received.get(tc.id);
      if (got) {
        completed.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          result: { success: got.toolResultSuccess ?? true, output: got.content, contentBlocks: got.contentBlocks,
            ...(got.toolResultSuppression ? { runtime: { suppression: got.toolResultSuppression } } : {}) },
          ...(tc.name === "read_file" && got.toolResultSuccess === undefined ? { resultStatusUnknown: true as const } : {}),
          formattedOutput: got.content,
          executionObservation: got.executionObservation,
        });
      } else {
        incomplete.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          reason: "tool_result missing in re-derived sequence",
        });
      }
    }
    out.push(buildToolTurn({ text: p.text, raw: p.raw, completed, incomplete }));
  };
  for (const m of msgs) {
    if (m.role === "tool_result") {
      if (pending && m.toolCallId) {
        pending.received.set(m.toolCallId, { content: m.content, contentBlocks: m.contentBlocks, executionObservation: m.executionObservation, toolResultSuccess: m.toolResultSuccess, toolResultSuppression: m.toolResultSuppression });
        if (pending.received.size >= pending.toolCalls.length) flush();
      }
      continue;
    }
    flush();
    if (m.role === "assistant" && m.toolCalls?.length) {
      pending = { text: m.content, raw: m.raw, toolCalls: m.toolCalls, received: new Map() };
      continue;
    }
    out.push(messageToTurn(m));
  }
  flush();
  return out;
}

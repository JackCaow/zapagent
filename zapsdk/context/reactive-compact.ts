import { TokenCounter } from "./token-counter.js";
import type { LLMProvider } from "../core/llm.js";
import { assertProviderRequestAllowed } from "../core/provider-deadline.js";
import type { LLMResponse, Message } from "../core/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { contextFingerprint, measureRecoveryInput, recoveryReason, reduceHistoricalImages, RequestRecoveryError, type RecoveryReason } from "./request-recovery.js";
import { Microcompact } from "./microcompact.js";
import { redactTextSecrets } from "../utils/redact.js";
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints } from "../utils/logical-lines.js";
import { CompactInputReductionError } from "./compact.js";

const MAX_REACTIVE_MESSAGE_CHARS = 12_000;
const REACTIVE_MESSAGE_EDGE_CHARS = 3_000;
const DROPPED_MESSAGE_PREVIEW_CHARS = 360;
const DROPPED_SUMMARY_MAX_CHARS = 4_000;

export interface RecoveryNotice {
  attempt: number;
  maxAttempts: number;
  reason: RecoveryReason;
  errorPreview: string;
  before: ReturnType<typeof measureRecoveryInput>;
  after: ReturnType<typeof measureRecoveryInput>;
}

export interface RecoveryCallOptions {
  /** The active user request is not a disposable historical preview. */
  protectedUserText?: string;
  /** A stream already failed. Transform before making another request. */
  initialError?: unknown;
  /** Snapshot the actual failed provider view before preparing a retry. */
  recoveryMessages?: () => Message[];
  /** Called before recovered response tools can execute. */
  onRecovered?: (messages: Message[], notice: RecoveryNotice) => void;
  optionsForRetry?: (messages: Message[]) => import("../core/llm.js").LLMCallOptions;
}

export interface ReactiveCompactOptions {
  /** Max retry attempts after compacting (default: 2) */
  maxCompactRetries?: number;
  /** Custom compaction function. Default: aggressive microcompact */
  onCompact?: (messages: Message[]) => Message[];
  /** Optional notify-on-retry callback. Invoked when a token-overflow
   *  error has been caught and the messages have been re-compacted just
   *  before the retry. UI layers wire this to surface a visible system
   *  log so the user knows context was overflowed and self-healed,
   *  instead of seeing a silent ~3s pause. */
  onRetry?: (info: RecoveryNotice) => void;
}

export class ReactiveCompact {
  private maxRetries: number;
  private onCompact?: (messages: Message[]) => Message[];
  private onRetry?: (info: RecoveryNotice) => void;

  constructor(options: ReactiveCompactOptions = {}) {
    this.maxRetries = options.maxCompactRetries ?? 2;
    this.onCompact = options.onCompact;
    this.onRetry = options.onRetry;
  }

  compactMessages(messages: Message[], counter = new TokenCounter(), protectedUserText?: string): { messages: Message[]; compacted: boolean } {
    const before = measureRecoveryInput(messages, counter);
    const beforeLength = messages.length;
    const protectedFingerprints = protectedRecoveryMessages(messages, protectedUserText)
      .map(message => contextFingerprint([message]));
    const compactedMessages = this.onCompact
      // A custom reducer must not mutate the source or the protection baseline.
      // The spread retains local origin symbols used to position transient data.
      ? this.onCompact(messages.map(message => ({ ...message, ...structuredClone(message) })))
      : this.defaultCompact(messages, protectedUserText);
    for (const fingerprint of protectedFingerprints) {
      if (!compactedMessages.some(candidate => contextFingerprint([candidate]) === fingerprint)) {
        throw new CompactInputReductionError();
      }
    }
    return {
      messages: compactedMessages,
      compacted:
        compactedMessages.length < beforeLength ||
        measureRecoveryInput(compactedMessages, counter).estimatedTokens < before.estimatedTokens,
    };
  }

  /**
   * Call the LLM provider with automatic compaction on token limit errors.
   * If the call fails with a prompt-too-long error, compact messages and retry.
   */
  async callWithCompaction(
    provider: LLMProvider,
    messages: Message[],
    tools?: ToolDefinition[],
    opts?: import("../core/llm.js").LLMCallOptions,
    recovery: RecoveryCallOptions = {},
  ): Promise<{ response: LLMResponse; compacted: boolean; messages: Message[] }> {
    const counter = new TokenCounter(() => provider.getImageTokenContext?.(opts) ?? { model: opts?.model });
    let attempt = 0;
    let currentMessages = [...messages];
    let failure = recovery.initialError;
    let notice: RecoveryNotice | undefined;
    const attempted = new Set<string>();

    while (true) {
      assertProviderRequestAllowed(opts);
      if (failure !== undefined) {
        const reason = recoveryReason(failure);
        if (!reason) throw failure;
        if (attempt >= this.maxRetries) throw new RequestRecoveryError(reason, failure, "recovery retry budget exhausted");
        attempted.add(contextFingerprint(currentMessages));
        const source = attempt === 0 ? recovery.recoveryMessages?.() ?? currentMessages : currentMessages;
        const candidate = reason === "request_body"
          ? reduceHistoricalImages(source)
          : this.compactWithTransientAnchors(source, counter, recovery.protectedUserText);
        assertProviderRequestAllowed(opts);
        const before = measureRecoveryInput(currentMessages, counter);
        const after = measureRecoveryInput(candidate, counter);
        const fingerprint = contextFingerprint(candidate);
        const improved = reason === "request_body"
          ? after.messageBytes < before.messageBytes
          : after.estimatedTokens < before.estimatedTokens;
        if (!improved || attempted.has(fingerprint)) {
          if (reason === "context_tokens" && recovery.protectedUserText !== undefined) throw new CompactInputReductionError();
          throw new RequestRecoveryError(reason, failure,
            reason === "request_body"
              ? "no further safe media reduction; latest images and user attachments retained"
              : "no smaller valid context available");
        }
        attempt++;
        currentMessages = candidate;
        notice = { attempt, maxAttempts: this.maxRetries, reason,
          errorPreview: (failure instanceof Error ? failure.message : String(failure)).slice(0, 120), before, after };
        opts = recovery.optionsForRetry?.(currentMessages) ?? opts;
        this.onRetry?.(notice);
        failure = undefined;
      }
      assertProviderRequestAllowed(opts);
      let response: LLMResponse;
      try {
        response = await provider.call(currentMessages, tools, opts);
      } catch (error) {
        failure = error;
        continue;
      }
      assertProviderRequestAllowed(opts);
      if (notice) {
        try { recovery.onRecovered?.(currentMessages, notice); }
        catch (error) { throw new RequestRecoveryError(notice.reason, error, "recovered context could not be committed"); }
      }
      return { response, compacted: attempt > 0, messages: currentMessages };
    }
  }

  private compactWithTransientAnchors(messages: Message[], counter: TokenCounter, protectedUserText?: string): Message[] {
    // Symbols survive object spreads inside compaction but never enter JSON.
    // This lets transient host messages retain their position even when their
    // neighbouring persistent message was shortened or an earlier range dropped.
    const origin = Symbol("recovery-origin");
    const tagged = messages.map((message, index) => ({ ...message, [origin]: index }));
    const persistent = tagged.filter(m => !m.cache?.transient);
    const result = this.compactMessages(persistent, counter, protectedUserText).messages as Array<Message & { [origin]?: number }>;
    for (const message of tagged.filter(m => m.cache?.transient)) {
      const compacted = this.compactMessages([message], counter).messages[0] as Message & { [origin]?: number };
      const next = result.findIndex(m => m[origin] !== undefined && m[origin]! > message[origin]);
      result.splice(next < 0 ? result.length : next, 0, compacted);
    }
    return result.map(message => {
      const { [origin]: _origin, ...clean } = message;
      return clean;
    });
  }

  private defaultCompact(messages: Message[], protectedUserText?: string): Message[] {
    const result = [...messages];
    const protectedMessages = new Set(protectedRecoveryMessages(messages, protectedUserText));

    // Step 1: Microcompact all tool results aggressively
    new Microcompact({ keepRecent: 2 }).compact(result);
    messages.forEach((message, index) => { if (protectedMessages.has(message)) result[index] = message; });

    // Step 2: Shrink any single oversized narrative message, including the
    // latest user paste. Dropping the middle cannot help when the overflow is
    // caused by the tail message itself, so preserve its head/tail and retry.
    this.compactOversizedMessages(result, protectedMessages);

    // Step 3: If still overflowing, drop middle messages.
    // Keep: leading system messages, last 6 messages, drop the middle. Trigger whenever
    // at least one old non-system message can be replaced; context overflows can
    // come from a few huge messages, not only from long message counts.
    const keepRecent = 6;
    const systemLen = leadingSystemMessageCount(result);
    if (result.length > systemLen + keepRecent) {
      const system = result.slice(0, systemLen);
      let tailStart = result.length - keepRecent;
      // Don't start tail on a tool_result — back up to include its assistant
      while (tailStart > system.length && result[tailStart]?.role === "tool_result") {
        tailStart--;
      }
      const tail = result.slice(tailStart);
      const middle = result.slice(system.length, tailStart);
      const droppedMessages = middle.filter(message => !protectedMessages.has(message));
      const pinned = middle.filter(message => protectedMessages.has(message));
      if (!droppedMessages.length) return result;
      return [
        ...system,
        { role: "user" as const, content: summarizeDroppedMessages(droppedMessages) },
        ...pinned,
        ...tail,
      ];
    }

    return result;
  }

  private compactOversizedMessages(messages: Message[], protectedMessages = new Set<Message>()): number {
    const systemLen = leadingSystemMessageCount(messages);
    let compacted = 0;
    for (let i = systemLen; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || msg.role === "tool_result" || protectedMessages.has(msg)) continue;
      const contentChars = countCodePoints(msg.content);
      if (contentChars <= MAX_REACTIVE_MESSAGE_CHARS) continue;
      const head = sliceHeadCodePoints(msg.content, REACTIVE_MESSAGE_EDGE_CHARS);
      const tail = sliceTailCodePoints(msg.content, REACTIVE_MESSAGE_EDGE_CHARS);
      messages[i] = {
        ...msg,
        content:
          `${head}\n` +
          `…[${contentChars} chars compacted to fit context limit]…\n` +
          tail,
      };
      compacted++;
    }
    return compacted;
  }
}

function protectedRecoveryMessages(messages: Message[], protectedUserText?: string): Message[] {
  if (protectedUserText === undefined) return [];
  const persistent = messages.filter(message => !message.cache?.transient);
  const user = persistent.findLast(message => message.role === "user" && message.content === protectedUserText);
  const lastUser = persistent.findLast(message => message.role === "user");
  const protectedMessages = [user, lastUser].filter((message): message is Message => !!message);
  const lastTool = persistent.findLastIndex(message => message.role === "assistant" && !!message.toolCalls?.length);
  if (user && lastTool > persistent.indexOf(user)) {
    protectedMessages.push(persistent[lastTool]!);
    for (let i = lastTool + 1; persistent[i]?.role === "tool_result"; i++) protectedMessages.push(persistent[i]!);
  }
  return protectedMessages;
}

function leadingSystemMessageCount(messages: Message[]): number {
  let count = 0;
  while (messages[count]?.role === "system") count++;
  return count;
}

function summarizeDroppedMessages(messages: Message[]): string {
  const lines = [
    `[${messages.length} earlier messages compacted to fit context limit]`,
    "Key previews from compacted range:",
  ];
  const previewEntries = edgeEntries(messages, 3);
  for (const entry of previewEntries) {
    if (entry === "omitted") {
      lines.push(`- ... ${Math.max(0, messages.length - 6)} middle messages omitted ...`);
      continue;
    }
    lines.push(`- ${formatMessagePreview(entry)}`);
  }
  return capText(lines.join("\n"), DROPPED_SUMMARY_MAX_CHARS);
}

function edgeEntries(messages: Message[], edgeCount: number): Array<Message | "omitted"> {
  if (messages.length <= edgeCount * 2) return messages;
  return [
    ...messages.slice(0, edgeCount),
    "omitted" as const,
    ...messages.slice(-edgeCount),
  ];
}

function formatMessagePreview(message: Message): string {
  const role = message.role === "tool_result"
    ? `tool_result${message.toolCallId ? `(${message.toolCallId})` : ""}`
    : message.role;
  const toolCalls = message.toolCalls?.length
    ? ` tools=${message.toolCalls.map((call) => call.name).join(",")}`
    : "";
  const text = previewText(message.content, DROPPED_MESSAGE_PREVIEW_CHARS);
  return `${role}${toolCalls}: ${text || "(empty)"}`;
}

function previewText(text: string, maxChars: number): string {
  const redacted = redactTextSecrets(text).replace(/\s+/g, " ").trim();
  const redactedChars = countCodePoints(redacted);
  if (redactedChars <= maxChars) return redacted;
  const edge = Math.max(40, Math.floor((maxChars - 32) / 2));
  const head = sliceHeadCodePoints(redacted, edge);
  const tail = sliceTailCodePoints(redacted, edge);
  const omittedChars = Math.max(0, redactedChars - countCodePoints(head) - countCodePoints(tail));
  return `${head} ...[${omittedChars} chars omitted]... ${tail}`;
}

function capText(text: string, maxChars: number): string {
  if (countCodePoints(text) <= maxChars) return text;
  return `${sliceHeadCodePoints(text, maxChars - 48)}\n...[summary capped at ${maxChars} chars]`;
}

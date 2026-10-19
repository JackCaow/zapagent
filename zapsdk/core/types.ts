import type { ServiceModelReceipt, ServiceModelOperation } from "../services/contracts.js";
// ─── Multimodal content blocks ──────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** Absolute path to image file on disk */
  filePath: string;
  /** MIME type: image/png, image/jpeg, etc. */
  mediaType: string;
  /** Base64-encoded data (populated lazily before API call) */
  base64?: string;
  /** Vision detail sent to OpenAI-compatible providers; omitted means auto. */
  detail?: "auto" | "low" | "high" | "original";
  /** Original reference as typed by user (path, URL, "clipboard") */
  source: string;
}

export type ContentBlock = TextContent | ImageContent;

// ─── Message ────────────────────────────────────────────────────────────────

/** Bounded process facts kept separately from lossy diagnostic text. */
export interface ExecutionObservation {
  service?: ServiceModelReceipt;
  serviceOperation?: ServiceModelOperation;
  command?: { exitCode?: number; timedOut?: boolean; aborted?: boolean };
  selfChecks?: { passed: boolean; observedSteps: number; stepExitCodes: Array<number | null> };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string;
  /** Multimodal content — when present, providers use this instead of plain content */
  contentBlocks?: ContentBlock[];
  toolCallId?: string;
  /** Host-recorded result status; absent legacy results are not restoration evidence. */
  toolResultSuccess?: boolean;
  /** Host-only provenance for a synthetic result that did not execute the tool. */
  toolResultSuppression?: "duplicate";
  /** Internal context metadata; never inferred from tool output prose. */
  executionObservation?: ExecutionObservation;
  toolCalls?: ToolCallRequest[];
  /** Internal cache-placement hints. Transient messages are sent to the
   *  provider but should not become explicit prompt-cache breakpoints. */
  cache?: {
    transient?: boolean;
    /** Send and persist the message normally, but do not place an explicit
     *  provider prompt-cache breakpoint on this message. Used for the current
     *  user turn so the conversation breakpoint lands on reusable history
     *  instead of a per-turn-changing request. */
    skipBreakpoint?: boolean;
  };
  /** Opaque passthrough for provider-emitted sidecar fields (e.g. DeepSeek's
   *  `reasoning_content`, Kimi's `thinking`, future vendors' whatever). Zap
   *  doesn't interpret these — the rule is "capture what the server sent,
   *  replay it verbatim next turn". Lets multi-turn thinking-mode providers
   *  work with zero provider-brand branching in the code. */
  raw?: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider returned a tool call, but its arguments string could not be
   *  parsed into a JSON object. Agent layers should surface this as a failed
   *  tool result instead of executing the tool with guessed arguments. */
  argumentParseError?: string;
}

export interface TokenUsage {
  /** Fresh prompt tokens that were not served from prompt cache. */
  inputTokens: number;
  outputTokens: number;
  /** False when an adapter had to synthesize zero usage because the provider omitted usage. */
  providerUsageReported?: boolean;
  /** At least one failed or abandoned request has no accounted final usage; reported totals
   * remain valid lower bounds, not complete billed usage. */
  usageIncomplete?: boolean;
  /** Tokens written to cache this request (billed at 1.25x) */
  cacheCreationInputTokens?: number;
  /** Tokens read from cache this request (billed at 0.1x) */
  cacheReadInputTokens?: number;
  /** Provider-reported prompt cache misses. Automatic caches such as
   * DeepSeek persist request prefixes on miss instead of exposing a separate
   * cache-creation field, so this is their cache-write churn denominator. */
  cacheMissInputTokens?: number;
}

export interface LLMResponse {
  type: "text" | "tool_call";
  text: string;
  toolCalls?: ToolCallRequest[];
  usage: TokenUsage;
  /** "stop" | "tool_calls" | "length" (OpenAI) / "end_turn" | "max_tokens" | "tool_use" (Anthropic) */
  finishReason?: string;
  /** Mirror of `LLMChunk.done.raw` for the non-streaming path: provider-emitted
   *  sidecar fields from `response.message` (e.g. DeepSeek's `reasoning_content`),
   *  preserved verbatim so the loop can stash them on the assistant Message
   *  and the next turn's serializer can echo them back. */
  raw?: Record<string, unknown>;
}

export function createUserMessage(content: string, images?: ImageContent[]): Message {
  if (images?.length) {
    const blocks: ContentBlock[] = [
      { type: "text", text: content },
      ...images,
    ];
    return { role: "user", content, contentBlocks: blocks };
  }
  return { role: "user", content };
}

export function createSystemMessage(content: string): Message {
  return { role: "system", content };
}

export function createToolResultMessage(
  toolCallId: string,
  content: string,
  contentBlocks?: ContentBlock[],
): Message {
  if (contentBlocks?.length) {
    return { role: "tool_result", content, toolCallId, contentBlocks };
  }
  return { role: "tool_result", content, toolCallId };
}

export type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string; rawDelta?: Record<string, string> }
  | { type: "thinking_reset"; attempt: number; reason: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string; toolCallIndex?: number }
  | { type: "tool_call_delta"; toolCallId: string; partialJson: string; toolCallIndex?: number }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "done"; usage: TokenUsage; finishReason?: string; raw?: Record<string, unknown> };

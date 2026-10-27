import { canonicalModelId } from "../model-identity.js";
import type { ImageTokenContext, ImageTokenRule } from "../../context/image-tokens.js";
import OpenAI from "openai";
import type { LLMProvider, LLMCallOptions } from "../llm.js";
import { ProviderRequest } from "../provider-request.js";
import type { LLMResponse, LLMChunk, Message, ToolCallRequest, TokenUsage } from "../types.js";
import type { ToolDefinition } from "../../tools/types.js";
import { canonicalizeJsonSchema, zodToJsonSchema } from "../../tools/schema.js";
import { stripBoundary } from "../prompt-boundary.js";
import { withStreamIdleTimeout, getStreamIdleMs } from "../stream-idle.js";
import { sanitizeProviderText } from "../text-sanitize.js";

/** Split inline <think>...</think> out of a streamed content channel.
 *  MiniMax M2.7 (and some older open-weights thinking models) emit
 *  reasoning inline in `delta.content` instead of `delta.reasoning_content`.
 *  Feed each chunk; receive clean text + thinking pieces. Handles tag
 *  markers split across chunks by retaining a trailing partial match. */
class InlineThinkSplitter {
  private inThink = false;
  private buf = "";

  feed(chunk: string): { text: string; thinking: string } {
    this.buf += chunk;
    let text = "";
    let thinking = "";
    for (;;) {
      const needle = this.inThink ? "</think>" : "<think>";
      const idx = this.buf.indexOf(needle);
      if (idx >= 0) {
        const seg = this.buf.slice(0, idx);
        if (this.inThink) thinking += seg; else text += seg;
        this.buf = this.buf.slice(idx + needle.length);
        this.inThink = !this.inThink;
        continue;
      }
      // No full match: hold back bytes that could be the start of `needle`.
      let cut = this.buf.length;
      for (let k = Math.min(needle.length - 1, this.buf.length); k > 0; k--) {
        if (needle.startsWith(this.buf.slice(this.buf.length - k))) {
          cut = this.buf.length - k;
          break;
        }
      }
      const emit = this.buf.slice(0, cut);
      if (this.inThink) thinking += emit; else text += emit;
      this.buf = this.buf.slice(cut);
      break;
    }
    return { text, thinking };
  }

  flush(): { text: string; thinking: string } {
    const rem = this.buf;
    this.buf = "";
    return this.inThink ? { text: "", thinking: rem } : { text: rem, thinking: "" };
  }
}

function compareToolDefinitions(a: ToolDefinition, b: ToolDefinition): number {
  return a.name.localeCompare(b.name);
}

/** Non-streaming counterpart: drop every <think>...</think> span from a
 *  full content string. Leaves a stray unmatched opener as-is (defensive;
 *  real completions always close). */
function stripInlineThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
}

function parseToolCallArguments(value: unknown): {
  arguments: Record<string, unknown>;
  parseError?: string;
} {
  if (typeof value !== "string" || value.trim() === "") return { arguments: {} };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { arguments: parsed as Record<string, unknown> };
    }
    return {
      arguments: {},
      parseError: "Tool arguments JSON must be an object.",
    };
  } catch {
    return {
      arguments: {},
      parseError: "Malformed tool arguments JSON from provider.",
    };
  }
}

export interface OpenAICompatibleProviderOptions {
  model: string;
  /** Local vision-budget rule override for custom model aliases. */
  imageTokenRule?: ImageTokenRule;
  /** Canonical identities keyed by endpoint model ID, including child overrides. */
  canonicalModelIds?: Readonly<Record<string, string>>;
  client?: OpenAI;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  /** Known endpoint JSON body limit. Omit when unknown. */
  maxRequestBytes?: number;
  /** Per-request extra params spread into the OpenAI-compatible request body.
   *  User-configurable (not baseURL-sniffed) — e.g. for DeepSeek v4:
   *    { thinking: { type: "enabled" } }
   *  Unknown providers that don't recognize the keys will typically ignore them;
   *  keep the object small and specific to what the endpoint documents. */
  extraRequestParams?: Record<string, unknown>;
  /** HTTP headers merged into every outgoing request. Used to spoof a
   *  recognized client identity for endpoints that gate access by User-Agent
   *  (e.g. Moonshot's "Kimi For Coding" tier rejects anything that isn't on
   *  its coding-agent allow-list). Ignored when `client` is supplied. */
  defaultHeaders?: Record<string, string>;
  /** Whether the active model accepts image content. `false` rewrites every
   *  `{type:"image"}` block to a `[Referenced image in conversation]` text
   *  breadcrumb at serialize time — the original Message[] is untouched, so
   *  switching to a vision-capable model later restores the image. Undefined
   *  = pass through (assume support). LoopAgent flips this to `false` via
   *  `setVisionSupported` if a 400 image rejection comes back at runtime. */
  supportsVision?: boolean;
  /** Override the stream-idle watchdog window. Primarily useful for tests and
   *  embedded SDK callers; when omitted, ZAPCODE_STREAM_IDLE_MS/default apply. */
  streamIdleMs?: number;
}

/** Streamed delta fields that aren't part of the standard OpenAI chat schema
 *  but that thinking-mode providers emit and expect echoed back on multi-turn
 *  tool-call requests. We accumulate them as strings per key and store the
 *  assembled bag on the assistant `Message.raw` — serialization then spreads
 *  `msg.raw` back out on the next request. No provider-brand knowledge needed. */
const ROUNDTRIP_SIDECAR_KEYS = ["reasoning_content"] as const;

export class OpenAICompatibleProvider implements LLMProvider {
  private model: string;
  private imageTokenRule?: ImageTokenRule;
  private canonicalModelIds: Readonly<Record<string, string>>;
  private client: OpenAI;
  private maxTokens: number;
  private maxRequestBytes?: number;
  private requestCacheScope: string;
  private extraRequestParams: Record<string, unknown>;
  private supportsVision?: boolean;
  private streamIdleMs?: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.model = options.model;
    this.imageTokenRule = options.imageTokenRule;
    this.canonicalModelIds = { ...options.canonicalModelIds };
    this.maxRequestBytes = options.maxRequestBytes;
    this.requestCacheScope = `chat:${options.baseURL ?? options.client?.baseURL ?? "default"}`;
    this.client =
      options.client ??
      new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
        defaultHeaders: options.defaultHeaders,
        maxRetries: 0,
      });
    this.maxTokens = options.maxTokens ?? 4096;
    this.extraRequestParams = options.extraRequestParams ?? {};
    this.supportsVision = options.supportsVision;
    const streamIdleMs = options.streamIdleMs;
    this.streamIdleMs = typeof streamIdleMs === "number" && Number.isFinite(streamIdleMs) && streamIdleMs > 0
      ? streamIdleMs
      : undefined;
  }

  /** Mutate the vision flag at runtime. Called by LoopAgent's image-rejection
   *  fallback after a 400: future serialization will strip image blocks. The
   *  original Message[] (held by the conversation singleton) is untouched. */
  setVisionSupported(supported: boolean): void {
    this.supportsVision = supported;
  }

  private buildToolsParam(tools: ToolDefinition[]): unknown[] {
    return [...tools].sort(compareToolDefinitions).map((t) => ({
      type: "function",
      function: {
          name: t.name,
          description: t.description,
          parameters: canonicalizeJsonSchema(t.rawSchema ?? zodToJsonSchema(t.parameters)),
        },
      }));
  }

  getImageTokenContext(options?: LLMCallOptions): ImageTokenContext {
    // Match the same precedence as the serialized request body.
    const model = typeof this.extraRequestParams.model === "string"
      ? this.extraRequestParams.model : options?.model ?? this.model;
    return { model,
      canonicalModelId: canonicalModelId(this.canonicalModelIds[model]),
      imageTokenRule: model === this.model ? this.imageTokenRule : undefined,
      supportsVision: this.supportsVision,
    };
  }

  async call(
    messages: Message[],
    tools?: ToolDefinition[],
    opts?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const apiMessages = this.serializeMessages(messages);

    const params: Record<string, unknown> = {
      model: opts?.model ?? this.model,
      max_tokens: opts?.maxOutputTokens ?? this.maxTokens,
      messages: apiMessages,
      ...this.extraRequestParams,
    };
    if (opts?.stopSequences?.length) params.stop = opts.stopSequences;

    if (tools && tools.length > 0) {
      params.tools = this.buildToolsParam(tools);
    }

    const request = new ProviderRequest(opts);
    try {
      request.measureBody(params, this.maxRequestBytes, this.requestCacheScope);
      const response = await request.wait(this.client.chat.completions.create(params as any, {
        signal: request.signal, maxRetries: 0,
      }));
      const parsed = this.parseResponse(response as any);
      request.complete();
      return parsed;
    } finally { request.close(); }
  }

  async *stream(
    messages: Message[],
    tools?: ToolDefinition[],
    opts?: LLMCallOptions,
  ): AsyncIterable<LLMChunk> {
    const request = new ProviderRequest(opts);
    yield* request.watch(this.streamResponse(messages, tools, { ...opts, signal: request.signal }, request.responseReceived, body => request.measureBody(body, this.maxRequestBytes, this.requestCacheScope)));
  }

  private async *streamResponse(
    messages: Message[], tools: ToolDefinition[] | undefined, opts: LLMCallOptions,
    responseReceived: () => void,
    measureBody: (body: unknown) => void,
  ): AsyncIterable<LLMChunk> {
    const apiMessages = this.serializeMessages(messages);

    const params: Record<string, unknown> = {
      model: opts?.model ?? this.model,
      max_tokens: opts?.maxOutputTokens ?? this.maxTokens,
      messages: apiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...this.extraRequestParams,
    };
    if (opts?.stopSequences?.length) params.stop = opts.stopSequences;

    if (tools && tools.length > 0) {
      params.tools = this.buildToolsParam(tools);
    }

    measureBody(params);

    // Forward AbortSignal to the SDK so Ctrl+C also tears down the underlying
    // HTTPS request (not just our local watchdog wait). OpenAI SDK accepts
    // `{signal}` as the second arg of create(); RetryProvider plumbs it down
    // via opts.
    const stream = await this.client.chat.completions.create(
      params as any,
      { signal: opts.signal, maxRetries: 0 },
    );
    responseReceived();

    // Wrap the SDK iterator (NOT our typed yield) with the stream-idle
    // watchdog. The adapter intentionally drops several frame types (empty-
    // delta keep-alives, tool-call sidecar without args, etc.); wrapping our
    // typed yield instead would silently lose those frames as liveness
    // signals and produce false StreamIdleTimeoutErrors against healthy
    // upstreams that batch deltas. Issue #10.
    // OpenAI SDK's `create()` overloads conflate streaming + non-streaming
    // returns; with `stream: true` the actual return is an AsyncIterable, but
    // TS resolves to the non-streaming `ChatCompletion`. Double-cast to
    // bypass the unsound overload while keeping the behavior correct.
    const liveStream = withStreamIdleTimeout(
      stream as unknown as AsyncIterable<unknown>,
      this.streamIdleMs ?? getStreamIdleMs(),
      opts?.signal,
    );

    // Track finish_reason separately: with stream_options.include_usage=true,
    // OpenAI splits finish_reason (chunk A, usage=null) and usage (chunk B,
    // choices=[]) into two separate chunks. We must carry finish_reason forward
    // so the final done event includes both.
    let pendingFinishReason: string | undefined;
    let doneEmitted = false;
    const thinkSplitter = new InlineThinkSplitter();

    // Accumulate known roundtrip sidecar keys (e.g. reasoning_content). Each
    // key's deltas are string-concatenated. On `done`, the assembled bag is
    // attached so the loop can stash it on the assistant Message and spread it
    // back out on the next turn — this is what makes DeepSeek V4 thinking
    // multi-turn work without any provider-brand code.
    const rawAccum: Record<string, string> = {};
    const finalizeRaw = (): Record<string, unknown> | undefined =>
      Object.keys(rawAccum).length > 0 ? { ...rawAccum } : undefined;

    // Emptiness detection: some proxies (e.g. sub2api on a bad day) accept the
    // request with HTTP 200 but close the SSE stream without any chunks.
    // Without this check the loop just exits cleanly, the agent sees 0 tokens
    // 0 toolcalls and silently gives up — user sees nothing happen on screen.
    // Throwing here surfaces an error event the UI can display.
    let chunkCount = 0;
    let emittedAnything = false;

    for await (const rawChunk of liveStream) {
      const chunk = rawChunk as any;
      chunkCount++;
      const choice = chunk.choices?.[0];
      if (!choice) {
        // Final chunk: contains usage, no choices. Emit done with the
        // finish_reason recorded from the previous chunk.
        if (chunk.usage) {
          yield {
            type: "done",
            usage: this.extractUsage(chunk.usage),
            finishReason: pendingFinishReason,
            raw: finalizeRaw(),
          };
          emittedAnything = true;
          doneEmitted = true;
        }
        continue;
      }

      const delta = choice.delta;

      for (const key of ROUNDTRIP_SIDECAR_KEYS) {
        const piece = delta?.[key];
        if (typeof piece === "string" && piece.length > 0) {
          rawAccum[key] = (rawAccum[key] ?? "") + piece;
          if (key === "reasoning_content") {
            yield { type: "thinking_delta", text: piece, rawDelta: { [key]: piece } };
            emittedAnything = true;
          }
        }
      }

      if (delta?.content) {
        const { text, thinking } = thinkSplitter.feed(delta.content);
        if (thinking) { yield { type: "thinking_delta", text: thinking }; emittedAnything = true; }
        if (text) { yield { type: "text_delta", text }; emittedAnything = true; }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const toolCallId = tc.id ?? `tc_${tc.index ?? 0}`;
          if (tc.function?.name) {
            yield {
              type: "tool_call_start",
              toolCallId,
              toolName: tc.function.name,
            };
            emittedAnything = true;
          }
          if (tc.function?.arguments) {
            yield {
              type: "tool_call_delta",
              toolCallId,
              partialJson: tc.function.arguments,
              toolCallIndex: tc.index,
            };
            emittedAnything = true;
          }
        }
      }

      if (choice.finish_reason) {
        pendingFinishReason = choice.finish_reason;
        // Flush any tail the splitter was still holding (e.g. a buffer that
        // never matched a `</think>` close, or trailing text without a tag).
        const tail = thinkSplitter.flush();
        if (tail.thinking) { yield { type: "thinking_delta", text: tail.thinking }; emittedAnything = true; }
        if (tail.text) { yield { type: "text_delta", text: tail.text }; emittedAnything = true; }
        // If this chunk also carries usage (no include_usage split), emit done now.
        if (chunk.usage) {
          yield {
            type: "done",
            usage: this.extractUsage(chunk.usage),
            finishReason: pendingFinishReason,
            raw: finalizeRaw(),
          };
          emittedAnything = true;
          doneEmitted = true;
        }
      }
    }

    // Some OpenAI-compatible gateways accept stream_options.include_usage but
    // never emit the final usage-only chunk. Still surface a terminal `done`
    // event so the loop can see finishReason/raw sidecars and close the turn
    // deterministically. Token accounting remains explicitly zero/unknown.
    if (!doneEmitted && (pendingFinishReason !== undefined || emittedAnything)) {
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, providerUsageReported: false },
        finishReason: pendingFinishReason,
        raw: finalizeRaw(),
      };
      emittedAnything = true;
    }

    if (!emittedAnything) {
      throw new Error(
        `Provider returned empty stream — ${chunkCount} chunk(s) received, no content/usage/tool_call. ` +
        `Likely proxy or upstream issue; try again or switch provider.`
      );
    }
  }

  /**
   * Pull a TokenUsage out of a provider-reported usage object. Different
   * OpenAI-compatible backends report prompt-cache stats under different
   * field names — handle the three we've actually seen in the wild:
   *   - OpenAI Chat      : usage.prompt_tokens_details.cached_tokens
   *                         plus camelCase promptTokensDetails.cachedTokens
   *   - OpenAI Responses : usage.input_tokens_details.cached_tokens
   *                         plus camelCase inputTokensDetails.cachedTokens
   *   - DeepSeek / Kimi  : usage.prompt_cache_hit_tokens (and _miss_tokens)
   *                         plus camelCase promptCacheHitTokens variants
   *   - LiteLLM/proxies  : Anthropic-style cache_read_input_tokens /
   *                         cache_creation_input_tokens, plus camelCase
   *                         variants from JS SDK-style gateways
   *   - Everything else  : no cache fields
   */
  private extractUsage(u: any): TokenUsage {
    if (!u || typeof u !== "object") {
      return { inputTokens: 0, outputTokens: 0, providerUsageReported: false };
    }

    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
    const hasOwn = (obj: unknown, key: string): boolean =>
      !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
    const cachedTokensDetail = (details: unknown): number | undefined => {
      const record = details && typeof details === "object"
        ? details as Record<string, unknown>
        : undefined;
      return num(record?.cached_tokens) ?? num(record?.cachedTokens);
    };
    const cacheCreationBreakdown = (details: unknown): number | undefined => {
      const record = details && typeof details === "object"
        ? details as Record<string, unknown>
        : undefined;
      if (!record) return undefined;
      const values = [
        num(record.ephemeral_5m_input_tokens),
        num(record.ephemeral5mInputTokens),
        num(record.ephemeral_1h_input_tokens),
        num(record.ephemeral1hInputTokens),
      ].filter((value): value is number => value !== undefined);
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
    };
    const hasPromptTokenTotal = hasOwn(u, "prompt_tokens") || hasOwn(u, "promptTokens");
    const hasInputTokenField = hasOwn(u, "input_tokens") || hasOwn(u, "inputTokens");
    const hasDirectAnthropicCacheFields =
      hasOwn(u, "cache_read_input_tokens") ||
      hasOwn(u, "cacheReadInputTokens") ||
      hasOwn(u, "cache_creation_input_tokens") ||
      hasOwn(u, "cacheCreationInputTokens") ||
      hasOwn(u, "cache_creation") ||
      hasOwn(u, "cacheCreation");
    const usageReported =
      hasPromptTokenTotal ||
      hasInputTokenField ||
      hasOwn(u, "completion_tokens") ||
      hasOwn(u, "completionTokens") ||
      hasOwn(u, "output_tokens") ||
      hasOwn(u, "outputTokens") ||
      hasOwn(u, "total_tokens") ||
      hasOwn(u, "totalTokens") ||
      hasOwn(u, "prompt_tokens_details") ||
      hasOwn(u, "promptTokensDetails") ||
      hasOwn(u, "input_tokens_details") ||
      hasOwn(u, "inputTokensDetails") ||
      hasOwn(u, "prompt_cache_hit_tokens") ||
      hasOwn(u, "promptCacheHitTokens") ||
      hasOwn(u, "prompt_cache_miss_tokens") ||
      hasOwn(u, "promptCacheMissTokens") ||
      hasOwn(u, "cache_read_input_tokens") ||
      hasOwn(u, "cacheReadInputTokens") ||
      hasOwn(u, "cache_creation_input_tokens") ||
      hasOwn(u, "cacheCreationInputTokens") ||
      hasOwn(u, "cache_creation") ||
      hasOwn(u, "cacheCreation");
    if (!usageReported) {
      return { inputTokens: 0, outputTokens: 0, providerUsageReported: false };
    }

    const outputTokens =
      num(u.completion_tokens) ??
      num(u.completionTokens) ??
      num(u.output_tokens) ??
      num(u.outputTokens) ??
      0;
    const promptTotal = num(u.prompt_tokens)
      ?? num(u.promptTokens)
      ?? num(u.input_tokens)
      ?? num(u.inputTokens)
      ?? Math.max(0, (num(u.total_tokens) ?? num(u.totalTokens) ?? 0) - outputTokens);
    const cacheCandidates = [
      cachedTokensDetail(u?.prompt_tokens_details),
      cachedTokensDetail(u?.promptTokensDetails),
      cachedTokensDetail(u?.input_tokens_details),
      cachedTokensDetail(u?.inputTokensDetails),
      num(u?.prompt_cache_hit_tokens),
      num(u?.promptCacheHitTokens),
      num(u?.cache_read_input_tokens),
      num(u?.cacheReadInputTokens),
    ].filter((value): value is number => value !== undefined);
    const explicitMiss = num(u?.prompt_cache_miss_tokens) ?? num(u?.promptCacheMissTokens);
    const cacheCreation =
      num(u?.cache_creation_input_tokens) ??
      num(u?.cacheCreationInputTokens) ??
      cacheCreationBreakdown(u?.cache_creation) ??
      cacheCreationBreakdown(u?.cacheCreation);
    const cacheReported =
      cacheCandidates.length > 0 ||
      explicitMiss !== undefined ||
      cacheCreation !== undefined;
    const cached = cacheCandidates.length > 0 ? Math.max(0, ...cacheCandidates) : 0;
    const created = Math.max(0, cacheCreation ?? 0);
    const cacheAccounted = cached + created;
    const inputTokensAreAnthropicFreshTail =
      cacheReported &&
      hasDirectAnthropicCacheFields &&
      hasInputTokenField &&
      !hasPromptTokenTotal;
    let freshInput: number;
    if (explicitMiss !== undefined) {
      freshInput = Math.max(0, explicitMiss - created);
    } else if (!cacheReported) {
      freshInput = promptTotal;
    } else if (inputTokensAreAnthropicFreshTail) {
      // Anthropic-native usage reports input_tokens as the fresh tail after
      // the last cache breakpoint. Total prompt input is input_tokens +
      // cache_read_input_tokens + cache_creation_input_tokens.
      freshInput = promptTotal;
    } else {
      // Standard OpenAI-compatible usage reports prompt_tokens as total prompt
      // input, including cache read/write tokens. Some Anthropic-style proxies
      // instead report prompt_tokens as fresh input and cache fields
      // separately. When cache accounting already exceeds prompt_tokens, the
      // latter interpretation is the only coherent one.
      freshInput = cacheAccounted > promptTotal
        ? promptTotal
        : Math.max(0, promptTotal - cacheAccounted);
    }

    const usage: TokenUsage = {
      inputTokens: freshInput,
      outputTokens,
      providerUsageReported: true,
    };
    if (cacheCandidates.length > 0 || explicitMiss !== undefined) {
      usage.cacheReadInputTokens = cached;
    }
    if (explicitMiss !== undefined) {
      usage.cacheMissInputTokens = explicitMiss;
    }
    if (cacheCreation !== undefined) {
      usage.cacheCreationInputTokens = created;
    }
    return usage;
  }

  // Replace lone surrogates with U+FFFD — Bun's JSON.stringify emits \uD800 etc.
  // which some strict parsers (e.g. Python json.loads) reject as invalid JSON.
  // Valid surrogate pairs must survive: they carry emoji and other non-BMP
  // text that users may paste into prompts.
  private sanitize(s: string): string {
    return sanitizeProviderText(s);
  }

  /** Serialize the full Message[] to wire format. Entry point for call/stream.
   *
   *  Two responsibilities:
   *    1. Per-message expansion: a single Message may expand into multiple wire
   *       messages (e.g. a tool_result with an image attachment becomes a
   *       `tool` stub + a `user` image_url follow-up).
   *    2. Whole-conversation invariants: some providers require fields to be
   *       consistent across the whole history. Currently one rule — the
   *       "reasoning roundtrip" invariant — is enforced here; see below. */
  serializeMessages(messages: Message[]): Record<string, unknown>[] {
    // Responses-only state must not leak when a session switches protocols.
    messages = messages.map(message => {
      if (!message.raw?.openaiResponses) return message;
      const { openaiResponses: _, ...raw } = message.raw;
      return { ...message, raw };
    });
    let leadingSystemEnd = 0;
    while (messages[leadingSystemEnd]?.role === "system") leadingSystemEnd++;

    // Reasoning-roundtrip invariant: if ANY assistant in history carries a
    // reasoning-side sidecar key (e.g. DeepSeek V4's `reasoning_content`),
    // then EVERY subsequent assistant must carry that same key — empty string
    // OK, missing → provider 400. Docs describe this inconsistently so we
    // derive it from actual data: only providers that emitted the key get
    // the invariant applied. Generic OpenAI / non-thinking models never
    // populate `raw`, so no empty fields leak onto their requests.
    const seenRawKeys = new Set<string>();
    let firstRawAt = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "assistant" || !m.raw) continue;
      for (const [k, v] of Object.entries(m.raw)) {
        if (typeof v === "string" && v.length > 0) {
          if (firstRawAt < 0) firstRawAt = i;
          seenRawKeys.add(k);
        }
      }
    }

    const out: Record<string, unknown>[] = [];
    const toolImages: Record<string, unknown>[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = this.normalizeSystemMessage(messages[i], i < leadingSystemEnd);
      // OpenAI-compatible APIs require every result in a parallel tool group
      // before any user/assistant message. Attach images after the whole group,
      // not immediately after the result that supplied them.
      if (m.role !== "tool_result") out.push(...toolImages.splice(0));
      for (const wire of this.expandToWire(m)) {
        if (wire.role === "assistant" && firstRawAt >= 0 && i >= firstRawAt) {
          for (const k of seenRawKeys) if (!(k in wire)) wire[k] = "";
        }
        if (m.role === "tool_result" && wire.role === "user") toolImages.push(wire);
        else out.push(wire);
      }
    }
    out.push(...toolImages);
    return out;
  }

  private normalizeSystemMessage(msg: Message, isLeadingSystem: boolean): Message {
    if (msg.role !== "system" || isLeadingSystem) return msg;
    return {
      role: "user",
      content: `[system]: ${stripBoundary(msg.content)}`,
    };
  }

  /** One Message → 1+ wire messages. Dispatches by role; the only fan-out
   *  case is a `tool_result` carrying image attachments. */
  private expandToWire(msg: Message): Record<string, unknown>[] {
    if (msg.role === "tool_result") {
      const base: Record<string, unknown> = {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: this.sanitize(msg.content),
      };
      const images = msg.contentBlocks?.filter(b => b.type === "image" && b.base64) ?? [];
      if (images.length === 0) return [base];
      // Text-only model: collapse image attachments into a breadcrumb appended
      // to the tool stub. No fan-out user message — keeps the strict tool→
      // assistant alternation that text-only providers expect.
      if (this.supportsVision === false) {
        const note = ` [${images.length} image${images.length > 1 ? "s" : ""} attached from tool — omitted, current model has no vision]`;
        base.content = this.sanitize(msg.content + note);
        return [base];
      }
      const followUp: Record<string, unknown> = {
        role: "user",
        content: [
          { type: "text", text: `(Image${images.length > 1 ? "s" : ""} attached from tool call ${msg.toolCallId}.)` },
          ...images.map(b => ({
            type: "image_url",
            image_url: { url: `data:${(b as any).mediaType};base64,${(b as any).base64}`, ...((b as any).detail ? { detail: (b as any).detail } : {}) },
          })),
        ],
      };
      return [base, followUp];
    }
    return [this.toApiMessage(msg)];
  }

  private toApiMessage(msg: Message): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      // Spread `msg.raw` first so any keys we set below (role/content/tool_calls)
      // authoritatively override, never the other way around.
      return {
        ...(msg.raw ?? {}),
        role: "assistant",
        content: msg.content ? this.sanitize(msg.content) : msg.content,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    // Multimodal: contentBlocks with images
    if (msg.contentBlocks?.length) {
      // Text-only model: collapse the contentBlocks back into a single text
      // string with an inline breadcrumb where each image was. Keeps the
      // wire shape simple (role + content string) — some strict OpenAI-compat
      // gateways reject the array-content form even for text-only blocks.
      if (this.supportsVision === false) {
        const parts = msg.contentBlocks.map(block => {
          if (block.type === "text") return block.text
          if (block.type === "image") return "[Referenced image in conversation — current model has no vision]"
          return ""
        }).filter(Boolean)
        return { role: msg.role, content: this.sanitize(parts.join("\n\n")) }
      }
      const content = msg.contentBlocks.map(block => {
        if (block.type === "text") return { type: "text", text: this.sanitize(block.text) }
        if (block.type === "image" && block.base64) {
          return { type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.base64}`, ...(block.detail ? { detail: block.detail } : {}) } }
        }
        return null
      }).filter(Boolean)
      return { role: msg.role, content }
    }

    // System messages: strip the static/dynamic boundary marker before send.
    // The marker is internal metadata — most OpenAI-compat providers do
    // automatic byte-level prefix caching, so leaving it in is harmless but
    // leaks an impl detail into what the model sees.
    const content = msg.role === "system"
      ? stripBoundary(msg.content)
      : msg.content;
    const base: Record<string, unknown> = { role: msg.role, content: this.sanitize(content) };
    // Pure-text assistant may still carry raw sidecar (e.g. reasoning_content
    // from a text-only thinking turn). Spread it so DeepSeek V4's "every
    // assistant after tool_calls needs the key" rule is satisfied. Harmless
    // for providers that don't read the field.
    if (msg.role === "assistant" && msg.raw) {
      for (const [k, v] of Object.entries(msg.raw)) base[k] = v;
    }
    return base;
  }

  private parseResponse(response: any): LLMResponse {
    const choice = response.choices[0];
    const message = choice.message;
    const toolCalls: ToolCallRequest[] = [];

    // Capture roundtrip sidecar fields from the non-streaming response so the
    // loop can re-echo them on the next turn (parity with the streaming path's
    // `done.raw`). Mirror ROUNDTRIP_SIDECAR_KEYS exactly.
    const raw: Record<string, unknown> = {};
    for (const key of ROUNDTRIP_SIDECAR_KEYS) {
      const value = message?.[key];
      if (typeof value === "string" && value.length > 0) raw[key] = value;
    }

    if (message.tool_calls?.length) {
      for (const tc of message.tool_calls) {
        const parsedArgs = parseToolCallArguments(tc.function.arguments);
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs.arguments,
          ...(parsedArgs.parseError ? { argumentParseError: parsedArgs.parseError } : {}),
        });
      }
    }

    return {
      type: toolCalls.length > 0 ? "tool_call" : "text",
      text: stripInlineThink(message.content ?? ""),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: this.extractUsage(response.usage),
      finishReason: choice.finish_reason ?? "stop",
      raw: Object.keys(raw).length > 0 ? raw : undefined,
    };
  }
}

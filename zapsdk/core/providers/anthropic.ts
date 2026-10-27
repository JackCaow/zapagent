import { canonicalModelId } from "../model-identity.js";
import type { ImageTokenContext, ImageTokenRule } from "../../context/image-tokens.js";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMCallOptions } from "../llm.js";
import { ProviderRequest } from "../provider-request.js";
import type { LLMResponse, LLMChunk, Message, ToolCallRequest, TokenUsage } from "../types.js";
import type { ToolDefinition } from "../../tools/types.js";
import { canonicalizeJsonSchema, zodToJsonSchema } from "../../tools/schema.js";
import { DYNAMIC_BOUNDARY, splitAtBoundary, stripBoundary } from "../prompt-boundary.js";
import { withStreamIdleTimeout, getStreamIdleMs } from "../stream-idle.js";
import { sanitizeProviderText } from "../text-sanitize.js";

const TRANSIENT_CACHE_MESSAGE = Symbol("zap.transientCacheMessage");
const SKIP_CACHE_BREAKPOINT_MESSAGE = Symbol("zap.skipCacheBreakpointMessage");
type ApiMessage = Record<string, unknown> & {
  [TRANSIENT_CACHE_MESSAGE]?: boolean;
  [SKIP_CACHE_BREAKPOINT_MESSAGE]?: boolean;
};

export interface AnthropicProviderOptions {
  model: string;
  /** Local vision-budget rule override for custom model aliases. */
  imageTokenRule?: ImageTokenRule;
  /** Canonical identities keyed by endpoint model ID, including child overrides. */
  canonicalModelIds?: Readonly<Record<string, string>>;
  client?: Anthropic;
  maxTokens?: number;
  /** Known endpoint JSON body limit. Omit when unknown. */
  maxRequestBytes?: number;
  /** Enable prompt caching for system prompt, tools, and conversation history */
  promptCaching?: boolean;
  /** Override the stream-idle watchdog window. Primarily useful for tests and
   *  embedded SDK callers; when omitted, ZAPCODE_STREAM_IDLE_MS/default apply. */
  streamIdleMs?: number;
}

export class AnthropicProvider implements LLMProvider {
  private model: string;
  private imageTokenRule?: ImageTokenRule;
  private canonicalModelIds: Readonly<Record<string, string>>;
  private client: Anthropic;
  private maxTokens: number;
  private maxRequestBytes?: number;
  private requestCacheScope: string;
  private promptCaching: boolean;
  private streamIdleMs?: number;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.imageTokenRule = options.imageTokenRule;
    this.canonicalModelIds = { ...options.canonicalModelIds };
    this.maxRequestBytes = options.maxRequestBytes;
    this.requestCacheScope = `anthropic:${options.client?.baseURL ?? "default"}`;
    this.client = options.client ?? new Anthropic({ maxRetries: 0 });
    this.maxTokens = options.maxTokens ?? 4096;
    this.promptCaching = options.promptCaching ?? true;
    const streamIdleMs = options.streamIdleMs;
    this.streamIdleMs = typeof streamIdleMs === "number" && Number.isFinite(streamIdleMs) && streamIdleMs > 0
      ? streamIdleMs
      : undefined;
  }

  getImageTokenContext(options?: LLMCallOptions): ImageTokenContext {
    const model = options?.model ?? this.model;
    return { model, supportsImageDetail: false,
      canonicalModelId: canonicalModelId(this.canonicalModelIds[model]),
      imageTokenRule: !options?.model || options.model === this.model ? this.imageTokenRule : undefined,
    };
  }

  async call(
    messages: Message[],
    tools?: ToolDefinition[],
    opts?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const { systemContent, apiMessages: normalizedMessages } = normalizeAnthropicMessages(messages);
    const apiMessages = this.buildApiMessages(normalizedMessages);

    const params: Record<string, unknown> = {
      model: opts?.model ?? this.model,
      max_tokens: opts?.maxOutputTokens ?? this.maxTokens,
      messages: apiMessages,
    };
    if (opts?.stopSequences?.length) params.stop_sequences = opts.stopSequences;

    if (systemContent) {
      params.system = this.buildSystemParam(systemContent);
    }

    if (tools && tools.length > 0) {
      params.tools = this.buildToolsParam(tools);
    }

    if (this.promptCaching && apiMessages.length > 0) {
      this.injectConversationCacheBreakpoint(apiMessages);
    }
    this.clearLocalCacheMarkers(apiMessages);

    const request = new ProviderRequest(opts);
    try {
      request.measureBody(params, this.maxRequestBytes, this.requestCacheScope);
      const response = await request.wait(this.client.messages.create(params as any, {
        signal: request.signal, maxRetries: 0,
      }));
      const parsed = this.parseResponse(response);
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
    const { systemContent, apiMessages: normalizedMessages } = normalizeAnthropicMessages(messages);
    const apiMessages = this.buildApiMessages(normalizedMessages);

    const params: Record<string, unknown> = {
      model: opts?.model ?? this.model,
      max_tokens: opts?.maxOutputTokens ?? this.maxTokens,
      messages: apiMessages,
    };
    if (opts?.stopSequences?.length) params.stop_sequences = opts.stopSequences;

    if (systemContent) {
      params.system = this.buildSystemParam(systemContent);
    }

    if (tools && tools.length > 0) {
      params.tools = this.buildToolsParam(tools);
    }

    if (this.promptCaching && apiMessages.length > 0) {
      this.injectConversationCacheBreakpoint(apiMessages);
    }
    this.clearLocalCacheMarkers(apiMessages);

    // Pass AbortSignal to the SDK so Ctrl+C tears down the underlying HTTPS
    // request, not just our local watchdog wait.
    // MessageStream adds this field before serialization. Include it here so
    // byte accounting and the local limit match the SDK's actual wire body.
    params.stream = true;
    measureBody(params);
    const stream = await (this.client.messages as any).stream(
      params,
      { signal: opts.signal, maxRetries: 0 },
    );
    // MessageStream is constructed before HTTP headers arrive. Its connect
    // event, not construction, is the response boundary. Custom iterators
    // without this event are confirmed by their first raw frame below.
    stream.on?.("connect", responseReceived);

    // Wrap the SDK iterator (NOT our typed yield) with the stream-idle
    // watchdog. Anthropic's `ping`, `message_start`, `content_block_stop`
    // and `message_delta` events count as liveness even though this adapter
    // chooses not to forward them as typed LLMChunks. Wrapping the typed
    // yield instead would discard those frames as liveness signals and
    // produce false StreamIdleTimeoutErrors against healthy upstreams that
    // batch deltas. Issue #10.
    const liveStream = withStreamIdleTimeout(
      stream as AsyncIterable<unknown>,
      this.streamIdleMs ?? getStreamIdleMs(),
      opts?.signal,
    );

    for await (const rawEvent of liveStream) {
      responseReceived();
      const event = rawEvent as any;
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        yield {
          type: "tool_call_start",
          toolCallId: event.content_block.id,
          toolName: event.content_block.name,
          toolCallIndex: typeof event.index === "number" ? event.index : undefined,
        };
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta?.type === "input_json_delta") {
          yield {
            type: "tool_call_delta",
            toolCallId: "",
            partialJson: event.delta.partial_json,
            toolCallIndex: typeof event.index === "number" ? event.index : undefined,
          };
        }
      } else if (event.type === "message_stop") {
        const final = await stream.finalMessage();
        yield {
          type: "done",
          usage: anthropicUsageToTokenUsage(final.usage),
          finishReason: final.stop_reason ?? "end_turn",
        };
      }
    }
  }

  /**
   * Prompt Caching Strategy — uses up to 3 of the 4 allowed cache breakpoints:
   *
   * 1. System prompt (stable across all turns)
   * 2. Last tool definition (stable across all turns)
   * 3. Last message in conversation history (moves forward each turn,
   *    so the growing prefix is cached)
   */

  private buildSystemParam(content: string): unknown {
    // Split at the app-level static/dynamic boundary. Static prefix is
    // cacheable (stable across turns in a session); dynamic suffix (env,
    // AGENTS.md, per-turn data) is not. Setting cache_control only on the
    // static block gives us a cache that survives turn boundaries even when
    // env info (today's date, cwd changes, branch switches) churns the tail.
    const [staticPart, dynamicPart] = splitAtBoundary(content);
    const cleanDynamicPart = stripBoundary(dynamicPart);

    // With caching off: flatten back to a single string, marker stripped.
    if (!this.promptCaching) {
      return sanitizeProviderText(stripBoundary(content));
    }

    const hasStatic = staticPart.trim().length > 0;
    const hasDynamic = cleanDynamicPart.trim().length > 0;

    if (!hasStatic && !hasDynamic) return "";

    // No dynamic content — single cacheable block (pre-refactor behavior).
    if (!hasDynamic) {
      return [
        { type: "text", text: sanitizeProviderText(staticPart), cache_control: { type: "ephemeral" } },
      ];
    }

    if (!hasStatic) {
      return [
        { type: "text", text: sanitizeProviderText(cleanDynamicPart) },
      ];
    }

    // Both halves present — cache the prefix, leave suffix uncached.
    return [
      { type: "text", text: sanitizeProviderText(staticPart), cache_control: { type: "ephemeral" } },
      { type: "text", text: sanitizeProviderText(cleanDynamicPart) },
    ];
  }

  private buildToolsParam(tools: ToolDefinition[]): unknown[] {
    const mapped = [...tools].sort(compareToolDefinitions).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: canonicalizeJsonSchema(t.rawSchema ?? zodToJsonSchema(t.parameters)),
    }));
    if (!this.promptCaching || mapped.length === 0) return mapped;
    // Mark the last tool with cache_control — caches the entire tools array
    const last = mapped[mapped.length - 1];
    (last as any).cache_control = { type: "ephemeral" };
    return mapped;
  }

  private injectConversationCacheBreakpoint(apiMessages: Record<string, unknown>[]): void {
    // Find the last non-transient user or assistant message and mark it for caching.
    // This caches the entire conversation prefix up to this point.
    for (let i = apiMessages.length - 1; i >= 0; i--) {
      const msg = apiMessages[i] as ApiMessage;
      if (msg[TRANSIENT_CACHE_MESSAGE]) continue;
      if (msg[SKIP_CACHE_BREAKPOINT_MESSAGE]) continue;
      const content = msg.content;

      if (typeof content === "string") {
        if (content.trim().length === 0) continue;
        // Convert to block format so we can add cache_control
        msg.content = [
          { type: "text", text: content, cache_control: { type: "ephemeral" } },
        ];
        return;
      }

      if (Array.isArray(content) && content.length > 0) {
        // Add cache_control to the last cacheable block. Empty text blocks
        // and image blocks are invalid cache breakpoints in Anthropic's API.
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j] as Record<string, unknown>;
          if (!isCacheableContentBlock(block)) continue;
          block.cache_control = { type: "ephemeral" };
          return;
        }
      }
    }
  }

  private clearLocalCacheMarkers(apiMessages: Record<string, unknown>[]): void {
    for (const msg of apiMessages) {
      delete (msg as ApiMessage)[TRANSIENT_CACHE_MESSAGE];
      delete (msg as ApiMessage)[SKIP_CACHE_BREAKPOINT_MESSAGE];
    }
  }

  /** Build the inner `tool_result` block for a single tool_result Message.
   *  Kept separate from {@link toApiMessage} so {@link buildApiMessages} can
   *  pack multiple consecutive tool_results into one wire `role:"user"`
   *  message — which is the Anthropic Messages API's required shape (and
   *  what stricter compatible gateways like Bedrock/Vertex enforce). */
  private toolResultBlock(msg: Message): Record<string, unknown> {
    // Anthropic accepts an array of {type:"text"|"image"} blocks inside tool_result.
    // When the tool emitted contentBlocks (e.g. read_file on an image), stitch them
    // in alongside the text stub so the model sees both the caption and the image.
    let content: unknown = sanitizeProviderText(msg.content)
    if (msg.contentBlocks?.length) {
      const blocks: Record<string, unknown>[] = []
      if (msg.content) blocks.push({ type: "text", text: sanitizeProviderText(msg.content) })
      for (const b of msg.contentBlocks) {
        if (b.type === "text") blocks.push({ type: "text", text: sanitizeProviderText(b.text) })
        else if (b.type === "image" && b.base64) {
          blocks.push({ type: "image", source: { type: "base64", media_type: b.mediaType, data: b.base64 } })
        }
      }
      content = blocks
    }
    return {
      type: "tool_result",
      tool_use_id: msg.toolCallId,
      content,
    }
  }

  /** Pack the message array into wire shape, merging runs of consecutive
   *  tool_result Messages into a single `{role:"user", content:[...]}` so we
   *  don't emit one user message per parallel tool call. The Anthropic API
   *  documents tool_results as blocks inside one user message; splitting them
   *  breaks prompt-cache breakpoints and gets rejected by some compatible
   *  proxies (Bedrock, Vertex Anthropic, etc.). */
  private buildApiMessages(messages: Message[]): Record<string, unknown>[] {
    const out: ApiMessage[] = []
    let buffer: Record<string, unknown>[] | null = null
    let bufferTransient = false
    let bufferSkipBreakpoint = false
    const flushBuffer = () => {
      if (buffer && buffer.length > 0) {
        const wire: ApiMessage = { role: "user", content: buffer }
        if (bufferTransient) wire[TRANSIENT_CACHE_MESSAGE] = true
        if (bufferSkipBreakpoint) wire[SKIP_CACHE_BREAKPOINT_MESSAGE] = true
        out.push(wire)
      }
      buffer = null
      bufferTransient = false
      bufferSkipBreakpoint = false
    }
    for (const msg of messages) {
      if (msg.role === "tool_result") {
        if (!buffer) buffer = []
        buffer.push(this.toolResultBlock(msg))
        if (msg.cache?.transient) bufferTransient = true
        if (msg.cache?.skipBreakpoint) bufferSkipBreakpoint = true
        continue
      }
      flushBuffer()
      const wire = this.toApiMessage(msg) as ApiMessage
      if (msg.cache?.transient) wire[TRANSIENT_CACHE_MESSAGE] = true
      if (msg.cache?.skipBreakpoint) wire[SKIP_CACHE_BREAKPOINT_MESSAGE] = true
      out.push(wire)
    }
    flushBuffer()
    return out
  }

  private toApiMessage(msg: Message): Record<string, unknown> {
    if (msg.role === "tool_result") {
      // Direct callers (none in this file post-refactor — kept for safety)
      // get the legacy single-tool-result shape so external behavior is
      // preserved if anyone reaches in.
      return { role: "user", content: [this.toolResultBlock(msg)] }
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const content: Record<string, unknown>[] = [];
      if (msg.content) {
        content.push({ type: "text", text: sanitizeProviderText(msg.content) });
      }
      for (const tc of msg.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      return { role: "assistant", content };
    }
    // Multimodal: contentBlocks with images
    if (msg.contentBlocks?.length) {
      const content = msg.contentBlocks.map(block => {
        if (block.type === "text") return { type: "text", text: sanitizeProviderText(block.text) }
        if (block.type === "image" && block.base64) {
          return { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.base64 } }
        }
        return null
      }).filter(Boolean)
      return { role: msg.role, content }
    }

    return { role: msg.role, content: sanitizeProviderText(msg.content) };
  }

  private parseResponse(response: any): LLMResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      type: toolCalls.length > 0 ? "tool_call" : "text",
      text: textParts.join(""),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: anthropicUsageToTokenUsage(response.usage),
      finishReason: response.stop_reason ?? "end_turn",
    };
  }
}

function compareToolDefinitions(a: ToolDefinition, b: ToolDefinition): number {
  return a.name.localeCompare(b.name);
}

function normalizeAnthropicMessages(messages: Message[]): {
  systemContent: string;
  apiMessages: Message[];
} {
  const systemContents: string[] = [];
  let index = 0;
  while (messages[index]?.role === "system") {
    const content = messages[index]!.content;
    if (content.trim()) systemContents.push(content);
    index++;
  }

  return {
    systemContent: combineLeadingSystemContent(systemContents),
    apiMessages: messages.slice(index).map((message) => {
      if (message.role !== "system") return message;
      return {
        ...message,
        role: "user",
        content: `[system]: ${stripBoundary(message.content)}`,
      };
    }),
  };
}

function combineLeadingSystemContent(systemContents: string[]): string {
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];

  for (const content of systemContents) {
    const [staticPart, dynamicPart] = splitAtBoundary(content);
    if (staticPart.trim()) staticParts.push(staticPart);
    const cleanDynamicPart = stripBoundary(dynamicPart);
    if (cleanDynamicPart.trim()) dynamicParts.push(cleanDynamicPart);
  }

  if (dynamicParts.length === 0) return staticParts.join("\n\n");
  return [
    staticParts.join("\n\n"),
    DYNAMIC_BOUNDARY,
    dynamicParts.join("\n\n"),
  ].filter((part) => part.length > 0).join("\n\n");
}

export function anthropicUsageToTokenUsage(usage: Record<string, unknown>): TokenUsage {
  const cacheCreation = usage.cache_creation_input_tokens ?? cacheCreationBreakdown(usage.cache_creation);
  const cacheRead = usage.cache_read_input_tokens;
  return {
    inputTokens: nonNegativeFinite(usage.input_tokens),
    outputTokens: nonNegativeFinite(usage.output_tokens),
    providerUsageReported: true,
    ...(typeof cacheCreation === "number" ? { cacheCreationInputTokens: nonNegativeFinite(cacheCreation) } : {}),
    ...(typeof cacheRead === "number" ? { cacheReadInputTokens: nonNegativeFinite(cacheRead) } : {}),
  };
}

function cacheCreationBreakdown(details: unknown): number | undefined {
  const record = details && typeof details === "object"
    ? details as Record<string, unknown>
    : undefined;
  if (!record) return undefined;
  const values = [
    nonNegativeFiniteOrUndefined(record.ephemeral_5m_input_tokens),
    nonNegativeFiniteOrUndefined(record.ephemeral_1h_input_tokens),
  ].filter((value): value is number => value !== undefined);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function nonNegativeFiniteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function isCacheableContentBlock(block: Record<string, unknown>): boolean {
  if (block.type === "text") {
    return typeof block.text === "string" && block.text.trim().length > 0;
  }
  if (block.type === "tool_result") {
    const content = block.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return content !== undefined && content !== null;
  }
  if (block.type === "tool_use") {
    return typeof block.id === "string" && block.id.length > 0;
  }
  if (block.type === "image") return false;
  return Object.keys(block).length > 0;
}

import OpenAI from "openai";
import type { Response as APIResponse, ResponseInputItem, ResponseCreateParams } from "openai/resources/responses/responses";
import type { LLMProvider, LLMCallOptions } from "../llm.js";
import type { LLMChunk, LLMResponse, Message, ToolCallRequest } from "../types.js";
import type { ToolDefinition } from "../../tools/types.js";
import { canonicalizeJsonSchema, zodToJsonSchema } from "../../tools/schema.js";
import { ProviderRequest } from "../provider-request.js";
import { getStreamIdleMs, withStreamIdleTimeout } from "../stream-idle.js";
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from "./openai-compatible.js";

export type OpenAIResponsesProviderOptions = OpenAICompatibleProviderOptions;
type LayoutItem =
  | { type: "reasoning"; [key: string]: unknown }
  | { type: "message"; length: number; phase?: "commentary" | "final_answer" | null }
  | { type: "function_call"; call_id: string };

/** Stateless Responses transport. Only reasoning and output layout live in raw;
 * current conversation text/tool arguments remain authoritative after editing. */
export class OpenAIResponsesProvider implements LLMProvider {
  private client: OpenAI;
  private formatter: OpenAICompatibleProvider;

  constructor(private options: OpenAIResponsesProviderOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseURL, defaultHeaders: options.defaultHeaders, maxRetries: 0 });
    this.formatter = new OpenAICompatibleProvider({ ...options, client: this.client });
  }

  setVisionSupported(supported: boolean): void { this.formatter.setVisionSupported(supported); }
  getImageTokenContext(options?: LLMCallOptions) { return this.formatter.getImageTokenContext(options); }

  serializeMessages(messages: Message[]): ResponseInputItem[] {
    // Reuse image degradation, tool-image grouping, text sanitization and late
    // system-message normalization; never pass Chat sidecars into Responses.
    const assistants = messages.filter(message => message.role === "assistant");
    let assistantIndex = 0;
    const input: Record<string, unknown>[] = [];
    for (const wire of this.formatter.serializeMessages(messages.map(message => ({ ...message, raw: undefined })))) {
      if (wire.role === "tool") {
        input.push({ type: "function_call_output", call_id: wire.tool_call_id, output: wire.content });
      } else if (wire.role === "assistant") {
        const message = assistants[assistantIndex++];
        const sidecar = message.raw?.openaiResponses as { items?: LayoutItem[] } | undefined;
        const layout = Array.isArray(sidecar?.items) ? sidecar.items : [];
        const text = typeof wire.content === "string" ? wire.content : message.content;
        const calls = (wire.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
        const pending = new Map(calls.map(call => [call.id, call]));
        const addCall = (id: string) => {
          const call = pending.get(id);
          if (!call) return;
          input.push({ type: "function_call", call_id: id, name: call.function.name, arguments: call.function.arguments });
          pending.delete(id);
        };
        const intact = layout.reduce((sum, item) => sum + (item.type === "message" ? item.length : 0), 0) === text.length;
        let offset = 0;
        for (const item of layout) {
          if (item.type === "reasoning") input.push(item);
          else if (item.type === "function_call" && intact) addCall(item.call_id);
          else if (item.type === "message" && intact) {
            input.push({ role: "assistant", content: text.slice(offset, offset + item.length),
              ...(item.phase ? { phase: item.phase } : {}) });
            offset += item.length;
          }
        }
        if (!intact && text) {
          const phase = layout.findLast(item => item.type === "message")?.phase;
          input.push({ role: "assistant", content: text, ...(phase ? { phase } : {}) });
        }
        for (const id of pending.keys()) addCall(id);
      } else {
        const content = Array.isArray(wire.content) ? wire.content.map(part => part.type === "image_url"
          ? { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" }
          : { type: "input_text", text: part.text }) : wire.content;
        input.push({ role: wire.role, content });
      }
    }
    return input as unknown as ResponseInputItem[];
  }

  private body(messages: Message[], tools: ToolDefinition[] | undefined, opts: LLMCallOptions | undefined, stream: boolean): ResponseCreateParams {
    if (opts?.stopSequences?.length) throw new Error("Responses API does not support stopSequences.");
    const extra = { ...this.options.extraRequestParams };
    // /effort uses a protocol-neutral stored setting. Responses nests it.
    if (typeof extra.reasoning_effort === "string") {
      extra.reasoning = { ...(extra.reasoning as object ?? {}), effort: extra.reasoning_effort };
    }
    delete extra.reasoning_effort;
    delete extra.max_tokens;
    delete extra.max_completion_tokens;
    delete extra.messages;
    delete extra.stream_options;
    // Local history is authoritative, including compaction and edited turns.
    delete extra.previous_response_id;
    delete extra.conversation;
    delete extra.background;
    const include = Array.isArray(extra.include) ? extra.include.filter(value => typeof value === "string") : [];
    return {
      model: opts?.model ?? this.options.model,
      max_output_tokens: opts?.maxOutputTokens ?? this.options.maxTokens ?? 4096,
      ...extra,
      input: this.serializeMessages(messages),
      tools: tools?.length ? [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({
        type: "function", name: tool.name, description: tool.description, strict: false,
        parameters: canonicalizeJsonSchema(tool.rawSchema ?? zodToJsonSchema(tool.parameters)),
      })) : undefined,
      include: [...new Set([...include, "reasoning.encrypted_content"])],
      store: false,
      stream,
    } as ResponseCreateParams;
  }

  private parse(response: APIResponse): LLMResponse {
    const truncated = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens";
    if (response.status !== "completed" && !truncated) {
      throw new Error(`Responses API ${response.status}: ${response.error?.message ?? response.incomplete_details?.reason ?? "response did not complete"}`);
    }
    let text = "";
    const toolCalls: ToolCallRequest[] = [];
    const layout: LayoutItem[] = [];
    for (const item of response.output) {
      if (item.type === "reasoning") layout.push({ ...item });
      else if (item.type === "message") {
        const content = item.content.map(part => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "").join("");
        text += content;
        layout.push({ type: "message", length: content.length, phase: item.phase });
      } else if (item.type === "function_call" && !truncated) {
        if (!item.call_id || !item.name) throw new Error("Responses API returned a function call without call_id or name");
        if (toolCalls.some(call => call.id === item.call_id)) throw new Error("Responses API returned duplicate call_id");
        let args: Record<string, unknown> = {};
        let argumentParseError: string | undefined;
        try {
          const parsed: unknown = JSON.parse(item.arguments);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          args = parsed as Record<string, unknown>;
        } catch { argumentParseError = "Malformed tool arguments JSON from provider: expected an object."; }
        toolCalls.push({ id: item.call_id, name: item.name, arguments: args, ...(argumentParseError ? { argumentParseError } : {}) });
        layout.push({ type: "function_call", call_id: item.call_id });
      }
    }
    const usage = response.usage;
    const cached = usage?.input_tokens_details?.cached_tokens;
    return {
      type: toolCalls.length ? "tool_call" : "text", text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: truncated ? "length" : toolCalls.length ? "tool_calls" : "stop",
      usage: { inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - (cached ?? 0)), outputTokens: usage?.output_tokens ?? 0,
        providerUsageReported: !!usage, ...(cached !== undefined ? { cacheReadInputTokens: cached } : {}) },
      raw: layout.length ? { openaiResponses: { items: layout } } : undefined,
    };
  }

  async call(messages: Message[], tools?: ToolDefinition[], opts?: LLMCallOptions): Promise<LLMResponse> {
    const request = new ProviderRequest(opts);
    try {
      const body = this.body(messages, tools, opts, false);
      request.measureBody(body, this.options.maxRequestBytes);
      const response = await request.wait(this.client.responses.create({ ...body, stream: false }, { signal: request.signal, maxRetries: 0 }));
      const parsed = this.parse(response);
      request.complete();
      return parsed;
    } finally { request.close(); }
  }

  async *stream(messages: Message[], tools?: ToolDefinition[], opts?: LLMCallOptions): AsyncIterable<LLMChunk> {
    const request = new ProviderRequest(opts);
    yield* request.watch(this.streamResponse(messages, tools, opts, request));
  }

  private async *streamResponse(messages: Message[], tools: ToolDefinition[] | undefined, opts: LLMCallOptions | undefined, request: ProviderRequest): AsyncIterable<LLMChunk> {
    const body = this.body(messages, tools, opts, true);
    request.measureBody(body, this.options.maxRequestBytes);
    const stream = await this.client.responses.create({ ...body, stream: true }, { signal: request.signal, maxRetries: 0 });
    request.responseReceived();
    let emittedText = "";
    try {
      for await (const event of withStreamIdleTimeout(stream, getStreamIdleMs(this.options.streamIdleMs === undefined ? process.env.ZAPCODE_STREAM_IDLE_MS : String(this.options.streamIdleMs)), request.signal)) {
        if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
          emittedText += event.delta;
          yield { type: "text_delta", text: event.delta };
        } else if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
          yield { type: "thinking_delta", text: event.delta };
        } else if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
          const response = this.parse(event.response);
          // The terminal payload is authoritative. Some compatible servers send
          // only terminal output; never silently duplicate mismatching deltas.
          if (!response.text.startsWith(emittedText)) throw new Error("Responses API terminal text does not match streamed text");
          if (response.text.length > emittedText.length) yield { type: "text_delta", text: response.text.slice(emittedText.length) };
          // The executor speculatively executes complete JSON deltas. Hold all
          // function arguments until terminal success to prevent partial writes.
          for (const [index, call] of (response.toolCalls ?? []).entries()) {
            const item = event.response.output.find(item => item.type === "function_call" && item.call_id === call.id);
            yield { type: "tool_call_start", toolCallId: call.id, toolName: call.name, toolCallIndex: index };
            yield { type: "tool_call_delta", toolCallId: call.id,
              partialJson: item?.type === "function_call" ? (item.arguments.trim() || "null") : "null", toolCallIndex: index };
            yield { type: "tool_call_end", toolCallId: call.id };
          }
          yield { type: "done", usage: response.usage, finishReason: response.finishReason, raw: response.raw };
          return;
        } else if (event.type === "error") {
          throw new Error(`Responses API error (${event.code}): ${event.message}`);
        }
      }
      throw new Error("Responses API stream ended before a terminal response event");
    } finally { stream.controller?.abort(); }
  }
}

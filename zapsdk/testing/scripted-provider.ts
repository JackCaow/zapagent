import type { LLMCallOptions, LLMProvider } from "../core/llm.js";
import type {
  LLMChunk,
  LLMResponse,
  Message,
  TokenUsage,
} from "../core/types.js";
import type { ToolDefinition } from "../tools/types.js";

export type ScriptedProviderTransport = "call" | "stream";

export interface ScriptedProviderRequest {
  index: number;
  transport: ScriptedProviderTransport;
  messages: Message[];
  toolNames: string[];
  options: Omit<LLMCallOptions, "signal"> & { aborted: boolean };
}

export type ScriptedTurnResult =
  | LLMResponse
  | { chunks: readonly LLMChunk[] };

export type ScriptedTurn =
  | ScriptedTurnResult
  | { error: Error | string }
  | ((request: Readonly<ScriptedProviderRequest>) =>
      ScriptedTurnResult | Promise<ScriptedTurnResult>);

export interface ScriptedProviderOptions {
  turns: readonly ScriptedTurn[];
  /** Controls whether LoopAgent sees a stream method. Defaults to stream. */
  transport?: ScriptedProviderTransport;
}

export interface ScriptedProviderController {
  provider: LLMProvider;
  requests(): ScriptedProviderRequest[];
  remainingTurns(): number;
  assertConsumed(): void;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function snapshotRequest(
  index: number,
  transport: ScriptedProviderTransport,
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  options: LLMCallOptions | undefined,
): ScriptedProviderRequest {
  return {
    index,
    transport,
    messages: cloneValue(messages),
    toolNames: (tools ?? []).map((tool) => tool.name),
    options: {
      model: options?.model,
      maxOutputTokens: options?.maxOutputTokens,
      stopSequences: cloneValue(options?.stopSequences),
      aborted: options?.signal?.aborted ?? false,
    },
  };
}

function isChunkResult(result: ScriptedTurnResult): result is { chunks: readonly LLMChunk[] } {
  return "chunks" in result;
}

function responseToChunks(response: LLMResponse): LLMChunk[] {
  const chunks: LLMChunk[] = [];
  if (response.text) chunks.push({ type: "text_delta", text: response.text });
  for (const call of response.toolCalls ?? []) {
    chunks.push({
      type: "tool_call_start",
      toolCallId: call.id,
      toolName: call.name,
    });
    chunks.push({
      type: "tool_call_delta",
      toolCallId: call.id,
      partialJson: JSON.stringify(call.arguments),
    });
    chunks.push({ type: "tool_call_end", toolCallId: call.id });
  }
  chunks.push({
    type: "done",
    usage: cloneValue(response.usage),
    finishReason: response.finishReason,
    raw: cloneValue(response.raw),
  });
  return chunks;
}

function exhaustedMessage(index: number, transport: ScriptedProviderTransport): string {
  return `Scripted provider exhausted before request #${index + 1} (${transport})`;
}

async function resolveWithAbort<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) throw new Error("aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createScriptedProvider(
  options: ScriptedProviderOptions,
): ScriptedProviderController {
  const configuredTransport = options.transport ?? "stream";
  const pending = [...options.turns];
  const captured: ScriptedProviderRequest[] = [];

  const takeTurn = async (
    transport: ScriptedProviderTransport,
    messages: Message[],
    tools?: ToolDefinition[],
    callOptions?: LLMCallOptions,
  ): Promise<ScriptedTurnResult> => {
    const request = snapshotRequest(
      captured.length,
      transport,
      messages,
      tools,
      callOptions,
    );
    captured.push(request);
    const turn = pending.shift();
    if (!turn) throw new Error(exhaustedMessage(request.index, transport));
    if ("error" in turn) {
      throw typeof turn.error === "string" ? new Error(turn.error) : turn.error;
    }
    const result = typeof turn === "function"
      ? await resolveWithAbort(turn(cloneValue(request)), callOptions?.signal)
      : turn;
    return cloneValue(result);
  };

  const provider: LLMProvider = {
    async call(messages, tools, callOptions): Promise<LLMResponse> {
      const result = await takeTurn("call", messages, tools, callOptions);
      if (isChunkResult(result)) {
        throw new Error("Scripted chunk turns require the streaming transport");
      }
      return result;
    },
  };

  if (configuredTransport === "stream") {
    provider.stream = async function* (messages, tools, callOptions) {
      const result = await takeTurn("stream", messages, tools, callOptions);
      const chunks = isChunkResult(result) ? result.chunks : responseToChunks(result);
      for (const chunk of chunks) {
        if (callOptions?.signal?.aborted) throw new Error("aborted");
        yield cloneValue(chunk);
      }
    };
  }

  return {
    provider,
    requests: () => cloneValue(captured),
    remainingTurns: () => pending.length,
    assertConsumed: () => {
      if (pending.length > 0) {
        throw new Error(`Scripted provider has ${pending.length} unconsumed turn(s)`);
      }
    },
  };
}

export function scriptedTextResponse(
  text: string,
  usage: TokenUsage = { inputTokens: 1, outputTokens: 1 },
): LLMResponse {
  return {
    type: "text",
    text,
    usage: cloneValue(usage),
    finishReason: "stop",
  };
}

export function scriptedToolCallResponse(
  toolCalls: NonNullable<LLMResponse["toolCalls"]>,
  usage: TokenUsage = { inputTokens: 1, outputTokens: 1 },
): LLMResponse {
  return {
    type: "tool_call",
    text: "",
    toolCalls: cloneValue(toolCalls),
    usage: cloneValue(usage),
    finishReason: "tool_calls",
  };
}

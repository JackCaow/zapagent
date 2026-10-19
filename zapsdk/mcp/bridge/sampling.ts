// Sampling bridge.
//
// MCP servers can request LLM completions from the host (us) by sending a
// `sampling/createMessage` request. We:
//   1. only honour the request if the server config opted in (allowSampling),
//   2. delegate to a host-supplied SamplingHandler that runs the actual
//      LLM call + user approval inside zapcode's existing approval UX,
//   3. translate the result back into the JSON-RPC envelope the SDK expects.

import type {
  CreateMessageRequest,
  CreateMessageResult,
  SamplingMessage,
  ModelPreferences,
} from "@modelcontextprotocol/sdk/types.js";

/** Plain-text content + stop reason — the v0 shape every modern provider
 *  can emit. Future iterations can extend this to support tool use inside
 *  the sampling response. */
export interface SamplingHandlerResult {
  /** Always plain text in this implementation. */
  text: string;
  /** Which model produced the response — surfaced for telemetry / receipts. */
  model: string;
  /** "endTurn" | "stopSequence" | "maxTokens" */
  stopReason?: string;
}

export interface SamplingRequestPayload {
  messages: SamplingMessage[];
  systemPrompt?: string;
  maxTokens: number;
  modelPreferences?: ModelPreferences;
  stopSequences?: string[];
  temperature?: number;
  includeContext?: "none" | "thisServer" | "allServers";
}

export type SamplingHandler = (
  serverName: string,
  payload: SamplingRequestPayload,
  signal: AbortSignal,
) => Promise<SamplingHandlerResult>;

/**
 * Adapter: turns the SDK's `sampling/createMessage` request handler into a
 * call into our host-provided SamplingHandler. The SDK validates payload
 * shape against `CreateMessageRequestSchema` before invoking us, so we can
 * trust the field types.
 */
export function createSamplingRequestHandler(
  serverName: string,
  handler: SamplingHandler,
): (req: CreateMessageRequest, extra: { signal: AbortSignal }) => Promise<CreateMessageResult> {
  return async (req, extra) => {
    const params = req.params;
    const result = await handler(
      serverName,
      {
        messages: params.messages,
        systemPrompt: params.systemPrompt,
        maxTokens: params.maxTokens,
        modelPreferences: params.modelPreferences,
        stopSequences: params.stopSequences,
        temperature: params.temperature,
        includeContext: params.includeContext,
      },
      extra.signal,
    );

    const r: CreateMessageResult = {
      role: "assistant",
      content: { type: "text", text: result.text },
      model: result.model,
      stopReason: result.stopReason ?? "endTurn",
    };
    return r;
  };
}

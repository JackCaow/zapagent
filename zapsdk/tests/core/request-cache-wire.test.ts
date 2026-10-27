import { expect, it } from "bun:test";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { OpenAIResponsesProvider } from "../../core/providers/openai-responses.js";
import { AnthropicProvider } from "../../core/providers/anthropic.js";
import Anthropic from "@anthropic-ai/sdk";
import type { ProviderRequestEvent } from "../../core/llm.js";
import { requestCacheShape } from "../../context/request-cache.js";

for (const protocol of ["chat", "responses", "anthropic"]) it(`captures final ${protocol} wire prefix after adapter conversion`, async () => {
  let received: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received = await request.json();
    if (protocol === "responses") return Response.json({ id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 1 } });
    if (protocol === "anthropic") return Response.json({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } });
    return Response.json({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  } });
  try {
    const baseURL = `http://127.0.0.1:${server.port}/v1`;
    const provider = protocol === "chat" ? new OpenAICompatibleProvider({ baseURL, model: "fixture", apiKey: "test-only" })
      : protocol === "responses" ? new OpenAIResponsesProvider({ baseURL, model: "fixture", apiKey: "test-only" })
      : new AnthropicProvider({ model: "fixture", client: new Anthropic({ baseURL, apiKey: "test-only" }) });
    const events: ProviderRequestEvent[] = [];
    await provider.call([{ role: "system", content: "stable" }, { role: "user", content: "private prompt" }],
      [{ name: "read", description: "Read", parameters: z.object({ path: z.string() }) }], { onRequestEvent: e => events.push(e) });
    const observed = events.find(e => e.cacheShape)?.cacheShape;
    expect(observed).toBeDefined();
    expect(events.filter(event => event.cacheShape)).toHaveLength(1);
    const expected = requestCacheShape(received, `${protocol}:${baseURL}`);
    expect(observed).toEqual(expected);
    expect(observed?.messageCount).toBe((received.messages ?? received.input).length);
    expect(JSON.stringify(events)).not.toContain("private prompt");
    expect(JSON.stringify(events)).not.toContain("test-only");
  } finally { server.stop(); }
});

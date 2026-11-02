import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { StreamingToolExecutor } from "../../agent/streaming-tool-executor.js";
import { AgentEventEmitter } from "../../agent/events.js";

function clientFor(deltas: unknown[]) {
  const frames = deltas.map(delta => ({
    id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  const terminal = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } };
  return new OpenAI({ apiKey: "fixture", fetch: async () => new Response(
    [...frames, terminal].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  ) });
}

const start = (index: number) => ({ index, id: `call_${index}`, type: "function",
  function: { name: `tool_${index}`, arguments: "" } });
const args = (index: number, value: string) => ({ index, function: { arguments: value } });

describe("Chat tool-call index routing", () => {
  for (const order of [[0, 1], [1, 0]]) {
    for (const separateStarts of [false, true]) {
      test(`matches official SDK for start order ${order} (separate=${separateStarts})`, async () => {
        const starts = separateStarts
          ? order.map(index => ({ role: "assistant", tool_calls: [start(index)] }))
          : [{ role: "assistant", tool_calls: order.map(start) }];
        const client = clientFor([...starts,
          { tool_calls: [args(0, '{"value":"for_')] },
          { tool_calls: [args(1, '{"value":"for_')] },
          { tool_calls: [args(1, '1"}')] },
          { tool_calls: [args(0, '0"}')] },
        ]);
        // Independent control: the official SDK uses each explicit index, not
        // the arrival order, to assemble the exact same mocked SSE response.
        const standard = await client.chat.completions.stream({ model: "fixture",
          messages: [{ role: "user", content: "fixture" }] }).finalChatCompletion();
        const expected = standard.choices[0].message.tool_calls!.map(call => {
          if (call.type !== "function") throw new Error("Unexpected fixture tool type");
          return { id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) };
        });
        expect(expected).toEqual([0, 1].map(index => ({ id: `call_${index}`, name: `tool_${index}`,
          arguments: { value: `for_${index}` } })));
        const provider = new OpenAICompatibleProvider({ model: "fixture", client });
        const executed: { name: string; arguments: unknown }[] = [];
        const executor = new StreamingToolExecutor({
          execute: async (name: string, arguments_: unknown) => {
            executed.push({ name, arguments: arguments_ });
            return { success: true, output: "mocked" };
          },
          isReadOnly: () => false,
        } as any, new AgentEventEmitter());
        const result = await executor.consumeStream(provider.stream([{ role: "user", content: "fixture" }]), 0);
        expect([...result.toolCalls].sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
        expect(executed.sort((a, b) => a.name.localeCompare(b.name)))
          .toEqual(expected.map(({ name, arguments: arguments_ }) => ({ name, arguments: arguments_ })));
      });
    }
  }

  test("preserves ID routing for compatible streams that omit indices", async () => {
    const client = clientFor([
      { role: "assistant", tool_calls: [{ id: "call_a", type: "function", function: { name: "tool_a", arguments: "" } }] },
      { tool_calls: [{ id: "call_a", function: { arguments: '{"value":"a"}' } }] },
    ]);
    const chunks = [];
    for await (const chunk of new OpenAICompatibleProvider({ model: "fixture", client }).stream([])) chunks.push(chunk);
    expect(chunks[0]).toMatchObject({ type: "tool_call_start", toolCallId: "call_a", toolName: "tool_a" });
    if (chunks[0].type !== "tool_call_start") throw new Error("Expected tool start");
    expect(chunks[0].toolCallIndex).toBeUndefined();
    expect(chunks[1]).toMatchObject({ type: "tool_call_delta", toolCallId: "call_a", partialJson: '{"value":"a"}' });
  });
});

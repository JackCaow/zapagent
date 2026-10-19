import { expect, test } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse } from "../../core/types.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

for (const mode of ["stream", "call", "xml"] as const) {
  test(`${mode} does not execute a tool delivered after the run deadline`, async () => {
    let now = 0, effects = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "read_file", description: "fixture", parameters: z.object({}), readOnly: true },
      handler: async () => { effects++; return { success: true, output: "unexpected" }; } });
    const response = (): LLMResponse => {
      now = 3000;
      return { type: "tool_call", text: "", toolCalls: [{ id: "late", name: "read_file", arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const provider: LLMProvider = { async call() { return response(); } };
    if (mode !== "call") provider.stream = async function* (): AsyncIterable<LLMChunk> {
      response();
      if (mode === "xml") yield { type: "text_delta", text: "<tool_call>read_file</tool_call>" };
      else {
        yield { type: "tool_call_start", toolCallId: "late", toolName: "read_file" };
        yield { type: "tool_call_delta", toolCallId: "late", partialJson: "{}" };
      }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      timeoutMs: 1000, forceFinishTimeoutMs: 100, now: () => now });
    const result = await agent.run("synthetic late response");
    expect(result.stopped).toBe("timeout");
    expect(effects).toBe(0);
  });
}

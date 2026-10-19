import { test, expect } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse } from "../../core/types.js";

for (const mode of ["stream", "call", "xml"] as const) for (const inherited of [false, true]) {
  test(`${mode} tool receives ${inherited ? "shorter inherited" : "parent execution"} deadline`, async () => {
    const registry = new ToolRegistry();
    const deadlines: number[] = [];
    registry.register({ definition: { name: "read_file", description: "fixture", parameters: z.object({}), readOnly: true, timeoutMs: 20_000 },
      handler: async (_args, _signal, context) => { deadlines.push(context!.deadlineAtMs! - Date.now()); return { success: true, output: "observed" }; } });
    let calls = 0;
    const response = (): LLMResponse => ++calls === 1
      ? { type: "tool_call", text: "", toolCalls: [{ id: "read", name: "read_file", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
      : { type: "text", text: "Done.", usage: { inputTokens: 1, outputTokens: 1 } };
    const provider: LLMProvider = { async call() { return response(); } };
    if (mode !== "call") provider.stream = async function* (): AsyncIterable<LLMChunk> {
      const r = response();
      if (r.toolCalls) {
        if (mode === "xml") yield { type: "text_delta", text: "<tool_call>read_file</tool_call>" };
        else {
          yield { type: "tool_call_start", toolCallId: "read", toolName: "read_file" };
          yield { type: "tool_call_delta", toolCallId: "read", partialJson: "{}" };
        }
      } else yield { type: "text_delta", text: r.text };
      yield { type: "done", usage: r.usage };
    };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 4, timeoutMs: 10_000, forceFinishTimeoutMs: 1_000 });
    await agent.run("Inspect fixture.", inherited ? { deadlineAtMs: Date.now() + 1_500 } : undefined);
    expect(deadlines.length).toBe(1);
    expect(deadlines[0]).toBeGreaterThan(inherited ? 1_000 : 8_000);
    expect(deadlines[0]).toBeLessThanOrEqual(inherited ? 1_500 : 9_000);
    expect(calls).toBe(2);
  });
}

test("unknown deadlines add no feedback and expired deadlines add no new runtime control", async () => {
  for (const deadlineAtMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Date.now() - 1_000]) {
    const registry = new ToolRegistry();
    let calls = 0;
    const provider: LLMProvider = { async call(messages) {
      calls++;
      const context = messages.map(m => m.content).join("\n");
      if (Number.isFinite(deadlineAtMs)) expect(context).toContain("At most 0ms remain");
      else expect(context).not.toContain("Delegated execution deadline");
      return { type: "text", text: "Available observation.", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry) });
    const result = await agent.run("Report.", { deadlineAtMs });
    expect(calls).toBe(1);
    expect(result.text).toBe("Available observation.");
  }
});

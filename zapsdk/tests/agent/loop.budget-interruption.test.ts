import { expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { LLMProvider } from "../../core/llm.js";

for (const ending of ["cancel", "provider-error", "done"] as const) {
  it(`preserves a streamed tool batch after its budget is exhausted (${ending})`, async () => {
    const controller = new AbortController();
    const conversation = new ConversationManager({ maxMessages: 100 });
    let handlers = 0;
    let firstFinished!: () => void;
    const firstResult = new Promise<void>(resolve => { firstFinished = resolve; });
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "probe", description: "fixture", parameters: z.object({ item: z.number() }), readOnly: true },
      handler: async () => {
        handlers++;
        firstFinished();
        return { success: true, output: "first tool completed" };
      },
    });
    const provider: LLMProvider = {
      async call() { throw new Error("stream-only fixture"); },
      async *stream() {
        for (const item of [1, 2]) {
          yield { type: "tool_call_start", toolCallId: `probe-${item}`, toolName: "probe" };
          yield { type: "tool_call_delta", toolCallId: `probe-${item}`, partialJson: JSON.stringify({ item }) };
          yield { type: "tool_call_end", toolCallId: `probe-${item}` };
          if (item === 1) await firstResult;
        }
        // The second call has reached the real admission hook, closing the
        // meter. A subsequent cancellation/failure must keep its own meaning.
        if (ending === "cancel") controller.abort();
        if (ending === "provider-error") throw new Error("invalid response schema");
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      adaptiveBudget: { toolCalls: 1, modelTurns: 5 } });
    const run = agent.run("Run both probes", { signal: controller.signal });
    if (ending === "done") {
      expect((await run).stopped).toBe("budget");
    } else {
      await expect(run).rejects.toThrow(ending === "cancel" ? "aborted" : "invalid response schema");
    }
    expect(handlers).toBe(1);
    const messages = conversation.getMessages();
    const turn = messages.find(message => message.role === "assistant" && message.toolCalls?.length === 2);
    expect(turn?.toolCalls?.map(call => call.id)).toEqual(["probe-1", "probe-2"]);
    expect(messages.find(message => message.toolCallId === "probe-1")?.content).toContain("first tool completed");
    expect(messages.find(message => message.toolCallId === "probe-2")?.content).toContain("budget exhausted");
    expect(messages.some(message => message.role === "user" && message.content === "[Request interrupted by user]"))
      .toBe(ending === "cancel");
  });
}

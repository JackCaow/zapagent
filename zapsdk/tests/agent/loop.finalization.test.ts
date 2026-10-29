import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const failures = ["timeout", "error", "empty", "whitespace", "tool_text", "deadline"] as const;
type FinishMode = typeof failures[number] | "success";

async function runWithFinalizer(mode: FinishMode, earlierText: string, emptyTurn = false) {
  let now = 0;
  let writes = 0;
  let finishCalls = 0;
  let turns = 0;
  let finishSignal: AbortSignal | undefined;
  const provider: LLMProvider = {
    async call(messages, tools, options): Promise<LLMResponse> {
      finishCalls++;
      finishSignal = options?.signal;
      expect(tools).toEqual([]);
      expect(messages.some(message => message.role === "tool_result"
        && message.content.includes("saved revision 2; validation failed"))).toBe(true);
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "error") throw new Error("provider unavailable");
      return {
        type: "text",
        text: mode === "success" ? "Saved revision 2; validation failed."
          : mode === "tool_text" ? '<tool_call>{"name":"write_revision","arguments":{}}</tool_call>'
          : mode === "whitespace" ? " \n\t" : "",
        toolCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    },
    async *stream() {
      if (emptyTurn && turns++ > 0) {
        yield { type: "done" as const, usage: { inputTokens: 2, outputTokens: 1 } };
        return;
      }
      yield { type: "text_delta" as const, text: earlierText };
      yield { type: "tool_call_start" as const, toolCallId: "write-2", toolName: "write_revision" };
      yield { type: "tool_call_delta" as const, toolCallId: "write-2", partialJson: "{}" };
      yield { type: "done" as const, usage: { inputTokens: 2, outputTokens: 1 }, finishReason: "tool_use" };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "write_revision", description: "write fixture revision", parameters: z.object({}) },
    handler: async () => {
      writes++;
      if (mode === "deadline") now = 1_000;
      return { success: true, output: "saved revision 2; validation failed" };
    },
  });
  const conversation = new ConversationManager({ maxMessages: 100 });
  const agent = new LoopAgent({
    provider, registry, executor: new ToolExecutor(registry), conversation,
    systemPrompt: "test", maxSteps: mode === "deadline" || emptyTurn ? 3 : 1,
    timeoutMs: 1_000, forceFinishTimeoutMs: 15, now: () => now,
  });
  const result = await agent.run("update the fixture and report validation");
  return { result, messages: conversation.getMessages(), writes, finishCalls, finishSignal };
}

describe("LoopAgent finalization evidence", () => {
  for (const earlierText of ["Next I will write the program.", "All checks passed; work is complete."]) {
    for (const failure of failures) {
      it(`does not promote historical text after ${failure}: ${earlierText}`, async () => {
        const { result, messages, writes, finishCalls, finishSignal } = await runWithFinalizer(failure, earlierText);
        expect(result.stopped).toBe(failure === "deadline" ? "timeout" : "max_steps");
        expect(result.text).toContain("final summary");
        expect(result.text).toContain("unverified");
        expect(result.text).toContain(failure === "deadline" ? "wall-clock limit" : "step limit");
        expect(result.text).not.toContain(earlierText);
        expect(messages.at(-1)?.content).toBe(result.text);
        expect(messages.some(message => message.role === "assistant" && message.content === earlierText)).toBe(true);
        expect(messages.some(message => message.role === "tool_result"
          && message.content.includes("saved revision 2; validation failed"))).toBe(true);
        expect(writes).toBe(1);
        expect(finishCalls).toBe(failure === "deadline" ? 0 : 1);
        if (failure === "timeout") expect(finishSignal?.aborted).toBe(true);
      });
    }
  }

  it("reports missing synthesis after an empty natural turn without replaying old claims", async () => {
    const { result, messages, writes, finishCalls } = await runWithFinalizer("error", "All checks passed.", true);
    expect(result.stopped).toBeUndefined();
    expect(result.text).toContain("previous model turn returned no final text");
    expect(result.text).toContain("unverified");
    expect(result.text).not.toContain("All checks passed.");
    expect(messages.at(-1)?.content).toBe(result.text);
    expect(writes).toBe(1);
    expect(finishCalls).toBe(1);
  });

  it("preserves a fresh final summary and its usage", async () => {
    const { result, messages, writes, finishCalls } = await runWithFinalizer("success", "Next I will write the program.");
    expect(result.stopped).toBe("max_steps");
    expect(result.text).toBe("Saved revision 2; validation failed.");
    expect(messages.at(-1)?.content).toBe(result.text);
    expect(result.totalUsage.inputTokens).toBe(4);
    expect(result.totalUsage.outputTokens).toBe(2);
    expect(writes).toBe(1);
    expect(finishCalls).toBe(1);
  });
});

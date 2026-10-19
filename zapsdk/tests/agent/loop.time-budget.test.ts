import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  buildRuntimeTimeBudgetContext,
  LoopAgent,
  type RuntimeTimeBudget,
} from "../../agent/loop.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("LoopAgent runtime time budget", () => {
  it("keeps deadline advice in the dynamic tail, not the cacheable prefix", () => {
    const budget: RuntimeTimeBudget = {
      totalMs: 840_000,
      elapsedMs: 700_000,
      remainingMs: 140_000,
      remainingPercent: 17,
      stage: "converge",
    };
    const context = buildRuntimeTimeBudgetContext(budget);
    expect(context).toContain("2m 20s remaining (17%)");
    expect(context).toContain("stage: converge");
    expect(context).toContain("Implement the smallest remaining change and verify it");
    expect(context).not.toContain("Model/tool execution window");
  });

  it("caps final synthesis to the actual remaining hard deadline", async () => {
    let now = 0;
    let calls = 0;
    let signal: AbortSignal | undefined;
    const provider: LLMProvider = {
      async call(_messages, _tools, options) {
        calls++;
        signal = options?.signal;
        return new Promise<LLMResponse>(() => {});
      },
      async *stream(): AsyncIterable<LLMChunk> {
        now = 995;
        yield { type: "text_delta", text: "partial evidence" };
        yield { type: "tool_call_start", toolCallId: "work", toolName: "read" };
        yield { type: "tool_call_delta", toolCallId: "work", partialJson: "{}" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "read", description: "read", readOnly: true, parameters: z.object({}) },
      handler: async () => ({ success: true, output: "observed" }) });
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 3,
      timeoutMs: 1_000, forceFinishTimeoutMs: 200, now: () => now });
    const timeouts: number[] = [];
    agent.on("observation", event => {
      if (event.type === "observation" && event.kind === "force_finish_timeout") timeouts.push(Number(event.detail?.timeoutMs));
    });
    expect((await agent.run("work")).stopped).toBe("timeout");
    expect(calls).toBe(1);
    expect(timeouts).toEqual([5]);
    expect(signal?.aborted).toBe(true);
  });

  it("publishes the remaining budget every step and reserves the final synthesis window", async () => {
    let now = 0;
    const streamedMessages: Message[][] = [];
    const finalMessages: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages): Promise<LLMResponse> {
        finalMessages.push(messages);
        return {
          type: "text",
          text: "partial work summarized before timeout",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *stream(messages): AsyncIterable<LLMChunk> {
        streamedMessages.push(messages);
        yield { type: "tool_call_start", toolCallId: "read-1", toolName: "read" };
        yield { type: "tool_call_delta", toolCallId: "read-1", partialJson: "{}" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "read", description: "read", parameters: z.object({}), readOnly: true },
      handler: async () => {
        now = 850;
        return { success: true, output: "observed" };
      },
    });
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
      systemPrompt: "cacheable system protocol",
      maxSteps: 3,
      timeoutMs: 1_000,
      forceFinishTimeoutMs: 200,
      now: () => now,
    });
    const budgets: RuntimeTimeBudget[] = [];
    agent.on("run_step", (event) => {
      if (event.type === "run_step" && event.timeBudget) budgets.push(event.timeBudget);
    });

    const result = await agent.run("inspect then finish");

    expect(streamedMessages).toHaveLength(1);
    expect(streamedMessages[0].find((message) => message.role === "system")?.content)
      .not.toContain("Runtime time budget");
    expect(streamedMessages[0].at(-1)?.content).toContain("1s remaining (100%)");
    expect(streamedMessages[0].at(-1)?.content).toContain("Model/tool execution window: 800ms");
    expect(streamedMessages[0].at(-1)?.content).toContain("final response without tools: 200ms");
    expect(budgets).toEqual([{
      totalMs: 1_000,
      elapsedMs: 0,
      remainingMs: 1_000,
      remainingPercent: 100,
      executionRemainingMs: 800,
      finalizationReserveMs: 200,
      stage: "execute",
    }]);
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0].at(-2)?.content).toContain("1s remaining (15%)");
    expect(finalMessages[0].at(-2)?.content).toContain("Model/tool execution window: 0ms");
    expect(finalMessages[0].at(-2)?.content).toContain("final response without tools: 150ms");
    expect(finalMessages[0].at(-2)?.content).toContain("report completed work and unresolved checks from available evidence");
    expect(result.stopped).toBe("timeout");
    expect(result.text).toBe("partial work summarized before timeout");
  });
});


it("does not reserve a normal reasoning turn's latency as forced final synthesis time", async () => {
  let now = 0;
  let turns = 0;
  let forcedCalls = 0;
  const provider: LLMProvider = {
    async call(): Promise<LLMResponse> {
      forcedCalls++;
      return { type: "text", text: "forced", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream(): AsyncIterable<LLMChunk> {
      turns++;
      if (turns === 1) { now = 500; yield { type: "text_delta", text: "first response" }; }
      else if (turns === 2) {
        yield { type: "tool_call_start", toolCallId: "read", toolName: "read" };
        yield { type: "tool_call_delta", toolCallId: "read", partialJson: "{}" };
      } else yield { type: "text_delta", text: "second response" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "read", description: "read", readOnly: true, parameters: z.object({}) },
    handler: async () => { now = 1_050; return { success: true, output: "new evidence" }; } });
  const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 10,
    timeoutMs: 1_000, forceFinishTimeoutMs: 100, now: () => now });
  await agent.run("first task");
  const result = await agent.run("second task");
  expect(result.stopped).toBeUndefined();
  expect(result.text).toBe("second response");
  expect(forcedCalls).toBe(0);
});

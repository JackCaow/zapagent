import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import type { AgentEvent } from "../../agent/events.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, TokenUsage } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

function makeUsageProvider(usage: TokenUsage): LLMProvider {
  return {
    async call(): Promise<LLMResponse> {
      throw new Error("not used");
    },
    async *stream(): AsyncIterable<LLMChunk> {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", usage, finishReason: "stop" };
    },
  };
}

async function runWithUsage(usage: TokenUsage): Promise<{
  events: AgentEvent[];
  totalUsage: TokenUsage;
}> {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor(registry, {});
  const conversation = new ConversationManager({ maxMessages: 20 });
  const agent = new LoopAgent({
    provider: makeUsageProvider(usage),
    registry,
    executor,
    conversation,
    systemPrompt: "test",
    maxSteps: 1,
  });
  const events: AgentEvent[] = [];
  agent.on("run_usage", (event) => {
    if (event.type === "run_usage") events.push(event);
  });

  const result = await agent.run("hello");
  return { events, totalUsage: result.totalUsage };
}

async function collectUsageEvents(usage: TokenUsage): Promise<AgentEvent[]> {
  return (await runWithUsage(usage)).events;
}

describe("LoopAgent run_usage emission", () => {
  it("emits per-call usage while keeping totalUsage cumulative across tool steps", async () => {
    let call = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("not used");
      },
      async *stream(): AsyncIterable<LLMChunk> {
        call++;
        if (call === 1) {
          yield { type: "tool_call_start", toolCallId: "echo_1", toolName: "echo" };
          yield {
            type: "tool_call_delta",
            toolCallId: "echo_1",
            partialJson: JSON.stringify({ value: "ok" }),
          };
          yield {
            type: "done",
            usage: {
              inputTokens: 10,
              outputTokens: 1,
              cacheReadInputTokens: 80,
              cacheCreationInputTokens: 2,
            },
            finishReason: "tool_calls",
          };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield {
          type: "done",
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            cacheReadInputTokens: 90,
            cacheCreationInputTokens: 0,
          },
          finishReason: "stop",
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "echo",
        description: "Echo a value",
        parameters: z.object({ value: z.string() }),
      },
      handler: async (args) => ({ success: true, output: String(args.value) }),
    });
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation: new ConversationManager({ maxMessages: 20 }),
      systemPrompt: "test",
      maxSteps: 3,
    });
    const events: AgentEvent[] = [];
    agent.on("run_usage", (event) => {
      if (event.type === "run_usage") events.push(event);
    });

    const result = await agent.run("use echo");

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      step: 0,
      inputTokens: 10,
      outputTokens: 1,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 2,
    });
    expect(events[1]).toMatchObject({
      step: 1,
      inputTokens: 5,
      outputTokens: 3,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 0,
    });
    expect(result.totalUsage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheReadInputTokens: 170,
      cacheCreationInputTokens: 2,
    });
  });

  it("emits provider usage when only output tokens are non-zero", async () => {
    const events = await collectUsageEvents({ inputTokens: 0, outputTokens: 7 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 7,
    });
  });

  it("does not emit synthetic all-zero usage when cache accounting is absent", async () => {
    const events = await collectUsageEvents({ inputTokens: 0, outputTokens: 0 });

    expect(events).toHaveLength(0);
  });

  it("does not emit adapter-synthesized missing usage", async () => {
    const events = await collectUsageEvents({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: false,
    });

    expect(events).toHaveLength(0);
  });

  it("emits provider-reported all-zero usage so unknown and zero remain distinct", async () => {
    const events = await collectUsageEvents({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
    });
  });

  it("emits explicit zero cache accounting even when token counts are zero", async () => {
    const events = await collectUsageEvents({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("sanitizes invalid provider usage before emitting events and totals", async () => {
    const { events, totalUsage } = await runWithUsage({
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      cacheReadInputTokens: -80,
      cacheCreationInputTokens: 10,
      providerUsageReported: true,
    });

    expect(totalUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 10,
      providerUsageReported: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 10,
      providerUsageReported: true,
    });
  });
});

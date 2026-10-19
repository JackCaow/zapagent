import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { SingleCallAgent } from "../../agent/single-call.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse, Message } from "../../core/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ExecutionObservationSchema } from "../../execution/contracts.js";
import { operationFailure } from "../../execution/failure.js";

describe("SingleCallAgent usage accounting", () => {
  it("passes host-authored execution context to tool handlers", async () => {
    const registry = new ToolRegistry();
    let receivedContext: unknown;
    registry.register({
      definition: {
        name: "capture_context",
        description: "Captures execution context",
        parameters: z.object({}),
      },
      handler: async (_args, _signal, context) => {
        receivedContext = context;
        return { success: true, output: "ok" };
      },
    });
    const provider = providerFromResponses([
      {
        type: "tool_call",
        text: "",
        toolCalls: [{ id: "tc_context", name: "capture_context", arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        type: "text",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = new SingleCallAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
      sessionId: "session-1",
    });

    await agent.run("use tool");

    expect(receivedContext).toMatchObject({
      sessionId: "session-1",
      toolCallId: "tc_context",
      step: 1,
    });
    expect((receivedContext as any)?.grant?.callId).toBe("tc_context");
  });

  it("keeps cache usage absent when the provider omits cache accounting", async () => {
    const registry = new ToolRegistry();
    const provider = providerFromResponses([
      {
        type: "text",
        text: "done",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    ]);
    const agent = new SingleCallAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
    });

    const result = await agent.run("hello");

    expect(result.totalUsage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("aggregates cache usage across the tool call and final response", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "echo",
        description: "Echoes input",
        parameters: z.object({ value: z.string() }),
      },
      handler: async (args) => ({ success: true, output: String(args.value) }),
    });
    const provider = providerFromResponses([
      {
        type: "tool_call",
        text: "",
        toolCalls: [{ id: "tc_1", name: "echo", arguments: { value: "ok" } }],
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cacheReadInputTokens: 80,
        },
      },
      {
        type: "text",
        text: "final",
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          cacheCreationInputTokens: 20,
        },
      },
    ]);
    const agent = new SingleCallAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
    });

    const result = await agent.run("use tool");

    expect(result.text).toBe("final");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({ success: true, output: "ok" });
    expect(ExecutionObservationSchema.safeParse(result.toolResults[0]?.runtime?.execution).success).toBe(true);
    expect(result.totalUsage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 20,
    });
  });

  it("does not execute a tool call whose provider arguments failed to parse", async () => {
    const registry = new ToolRegistry();
    let called = false;
    registry.register({
      definition: {
        name: "echo",
        description: "Echoes input",
        parameters: z.object({}),
      },
      handler: async () => {
        called = true;
        return { success: true, output: "should not run" };
      },
    });
    const provider = providerFromResponses([
      {
        type: "tool_call",
        text: "",
        toolCalls: [{
          id: "tc_bad",
          name: "echo",
          arguments: {},
          argumentParseError: "Malformed tool arguments JSON from provider.",
        }],
        usage: { inputTokens: 10, outputTokens: 1 },
      },
      {
        type: "text",
        text: "fixed",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);
    const agent = new SingleCallAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
    });

    const result = await agent.run("use tool");

    expect(called).toBe(false);
    expect(result.toolResults).toEqual([{
      success: false,
      output: "",
      error: "Malformed tool arguments JSON from provider.",
      failure: operationFailure("INVALID_ARGUMENTS", "executor"),
    }]);
    expect(result.text).toBe("fixed");
  });

  it("clamps negative usage values to zero", async () => {
    const registry = new ToolRegistry();
    const provider = providerFromResponses([
      {
        type: "text",
        text: "done",
        usage: {
          inputTokens: -10,
          outputTokens: -2,
          cacheReadInputTokens: -80,
          cacheCreationInputTokens: -20,
          providerUsageReported: true,
        },
      },
    ]);
    const agent = new SingleCallAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
    });

    const result = await agent.run("hello");

    expect(result.totalUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerUsageReported: true,
    });
  });

  it("ignores non-finite usage values so totals never become NaN", async () => {
    const registry = new ToolRegistry();
    const provider = providerFromResponses([
      {
        type: "text",
        text: "done",
        usage: {
          inputTokens: Number.NaN,
          outputTokens: Number.POSITIVE_INFINITY,
          cacheReadInputTokens: Number.NaN,
          cacheCreationInputTokens: 25,
        },
      },
    ]);
    const agent = new SingleCallAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry),
    });

    const result = await agent.run("hello");

    expect(result.totalUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 25,
    });
  });
});

function providerFromResponses(responses: LLMResponse[]): LLMProvider {
  let index = 0;
  return {
    async call(_messages: Message[]) {
      const response = responses[index++];
      if (!response) throw new Error("unexpected provider call");
      return response;
    },
  };
}

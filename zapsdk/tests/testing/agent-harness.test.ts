import { describe, expect, it } from "bun:test";
import { ExecutionObservationSchema } from "../../execution/contracts.js";
import { z } from "zod";
import { ToolRegistry } from "../../tools/registry.js";
import {
  AgentHarness,
  AgentHarnessTimeoutError,
  runAgentScenario,
  scriptedTextResponse,
  scriptedToolCallResponse,
  type ScriptedProviderTransport,
} from "../../testing/index.js";

describe("AgentHarness", () => {
  for (const transport of ["call", "stream"] as ScriptedProviderTransport[]) {
    it(`runs a deterministic text scenario over ${transport}`, async () => {
      const run = await runAgentScenario({
        input: "say hello",
        transport,
        turns: [scriptedTextResponse("hello")],
        agentOptions: { maxSteps: 2, systemPrompt: "Be concise." },
      });

      expect(run.result.text).toBe("hello");
      expect(run.result.totalUsage).toEqual({ inputTokens: 1, outputTokens: 1 });
      expect(run.providerRequests).toHaveLength(1);
      expect(run.providerRequests[0]!.transport).toBe(transport);
      expect(run.providerRequests[0]!.messages.some((message) =>
        message.role === "user" && message.content === "say hello"
      )).toBe(true);
      expect(run.events[0]).toMatchObject({ type: "run_started", input: "say hello" });
      expect(run.events.at(-1)).toMatchObject({
        type: "run_ended",
        steps: run.result.steps,
      });
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
    });
  }

  it("accepts raw chunks for streaming boundary scenarios", async () => {
    const run = await runAgentScenario({
      input: "stream text",
      transport: "stream",
      turns: [{
        chunks: [
          { type: "text_delta", text: "hel" },
          { type: "text_delta", text: "lo" },
          {
            type: "done",
            usage: { inputTokens: 2, outputTokens: 2 },
            finishReason: "stop",
          },
        ],
      }],
    });

    expect(run.result.text).toBe("hello");
    expect(run.events.filter((event) =>
      event.type === "content_delta" && event.kind === "text"
    )).toHaveLength(2);
  });

  it("captures a paired tool trace from the production loop", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "lookup",
        description: "Look up a value",
        parameters: z.object({ key: z.string() }),
        readOnly: true,
      },
      handler: async ({ key }) => ({ success: true, output: `value:${key}` }),
    });

    const run = await runAgentScenario({
      input: "look up alpha",
      registry,
      turns: [
        scriptedToolCallResponse([
          { id: "lookup-1", name: "lookup", arguments: { key: "alpha" } },
        ]),
        (request) => {
          const toolResult = request.messages.find((message) => message.toolCallId === "lookup-1");
          expect(toolResult).toMatchObject({
            role: "tool_result",
            toolCallId: "lookup-1",
          });
          expect(toolResult?.content).toContain("value:alpha");
          expect(JSON.stringify(request.messages)).not.toContain("executionPlanDigest");
          return scriptedTextResponse("found alpha");
        },
      ],
      agentOptions: { maxSteps: 3 },
    });

    expect(run.result.text).toBe("found alpha");
    expect(run.toolTrace).toHaveLength(1);
    expect(run.toolTrace[0]).toMatchObject({
      id: "lookup-1",
      step: 0,
      name: "lookup",
      arguments: { key: "alpha" },
      result: { success: true, output: "value:alpha" },
      path: undefined,
    });
    expect(ExecutionObservationSchema.safeParse(run.toolTrace[0]?.result?.runtime?.execution).success).toBe(true);
    expect(run.providerRequests[0]!.toolNames).toEqual(["lookup", "read_tool_output"]);
  });

  it("keeps request snapshots stable after later turns", async () => {
    const harness = new AgentHarness({
      transport: "call",
      turns: [scriptedTextResponse("first"), scriptedTextResponse("second")],
    });

    const first = await harness.run("one");
    await harness.run("two");

    expect(first.providerRequests).toHaveLength(1);
    expect(first.providerRequests[0]!.messages.some((message) => message.content === "two")).toBe(false);
    harness.assertComplete();
  });

  it("fails clearly when the script is exhausted", async () => {
    const harness = new AgentHarness({ transport: "call", turns: [] });
    await expect(harness.run("unexpected")).rejects.toThrow(
      "Scripted provider exhausted before request #1 (call)",
    );
  });

  it("fails when expected turns remain unconsumed", async () => {
    const harness = new AgentHarness({
      transport: "call",
      turns: [scriptedTextResponse("done"), scriptedTextResponse("unused")],
    });
    await harness.run("finish early");
    expect(() => harness.assertComplete()).toThrow(
      "Scripted provider has 1 unconsumed turn(s)",
    );
  });

  it("releases a hung scripted turn at the harness deadline", async () => {
    const harness = new AgentHarness({
      transport: "call",
      turns: [async () => new Promise(() => {})],
      runTimeoutMs: 10,
    });

    await expect(harness.run("hang")).rejects.toBeInstanceOf(AgentHarnessTimeoutError);
  });

  it("rejects invalid harness deadlines before running", () => {
    expect(() => new AgentHarness({ turns: [], runTimeoutMs: 0 })).toThrow(
      "AgentHarness runTimeoutMs must be a positive finite number",
    );
  });
});

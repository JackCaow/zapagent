import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { SingleCallAgent } from "../../agent/single-call.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";
import { buildToolTurn, turnToMessages } from "../../core/turn.js";
import { formatToolResultForModel, operationFailure } from "../../execution/failure.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolResult } from "../../tools/types.js";

function fixture(result: ToolResult, streaming: boolean) {
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "probe", description: "probe", parameters: z.object({}) },
    handler: async () => result });
  const inputs: Message[][] = [];
  let calls = 0;
  const provider: LLMProvider = {
    async call(messages) {
      inputs.push(structuredClone(messages));
      return calls++ === 0
        ? { type: "tool_call", text: "", toolCalls: [{ id: "call-1", name: "probe", arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 } }
        : { type: "text", text: "blocked", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    ...(streaming ? { async *stream(messages: Message[]) {
      inputs.push(structuredClone(messages));
      if (calls++ === 0) {
        yield { type: "tool_call_start" as const, toolCallId: "call-1", toolName: "probe" };
        yield { type: "tool_call_delta" as const, toolCallId: "call-1", partialJson: "{}" };
        yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta" as const, text: "blocked" };
        yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    } } : {}),
  };
  return { provider, registry, executor: new ToolExecutor(registry), inputs };
}

describe("model-facing execution failure contract", () => {
  for (const streaming of [true, false]) {
    it(`passes authoritative failure through the ${streaming ? "streaming" : "non-streaming"} loop`, async () => {
      const f = fixture({ success: false, output: "", error: "permission denied; module not found; timeout",
        failure: operationFailure("BACKEND_UNAVAILABLE", "backend") }, streaming);
      await new LoopAgent({ ...f, maxSteps: 4 }).run("run probe");
      const body = f.inputs[1].find(message => message.role === "tool_result")!.content;
      expect(body).toContain('"code":"BACKEND_UNAVAILABLE"');
      expect(body).toContain('"source":"backend"');
      expect(body).toContain('"retryable":false');
      expect(body).toContain("Do not repeat the same failed operation unchanged");
      expect(body).not.toContain("Use a different approach");
      expect(body).not.toContain("File or resource not found");
    });
  }

  it("preserves the same structured cause in SingleCallAgent", async () => {
    const f = fixture({ success: false, output: "", error: "plan-mode is read-only",
      failure: operationFailure("POLICY_DENIED", "policy") }, false);
    await new SingleCallAgent(f).run("run probe");
    const body = f.inputs[1].find(message => message.role === "tool_result")!.content;
    expect(body).toContain('"code":"POLICY_DENIED"');
    expect(body).toContain('"source":"policy"');
    expect(body).toContain("Do not bypass the denied boundary");
    expect(body).not.toContain("denied by user");
  });

  it("retains unknown cause instead of classifying diagnostic keywords", async () => {
    const f = fixture({ success: false, output: "", error: "sandbox network permission denied" }, true);
    await new LoopAgent({ ...f, maxSteps: 4 }).run("run probe");
    const body = f.inputs[1].find(message => message.role === "tool_result")!.content;
    expect(body).toContain('"code":"EXECUTION_FAILED"');
    expect(body).toContain('"source":"unknown"');
    expect(body).toContain("Cause unconfirmed");
    expect(body).not.toContain("Permission denied. This operation is not allowed");
  });

  it("rejects malformed metadata before using it for model guidance", () => {
    const body = formatToolResultForModel({ success: false, output: "", error: "diagnostic",
      failure: { code: "SANDBOX_DENIED", source: "backend", retryable: true } as any });
    expect(body).toContain('"source":"unknown"');
    expect(body).not.toContain('"code":"SANDBOX_DENIED"');
  });

  it("does not erase an explicitly retryable failure or expose audit internals", () => {
    const body = formatToolResultForModel({ success: false, output: "", error: "not ready",
      failure: { ...operationFailure("SERVICE_NOT_READY", "backend"), retryable: true } });
    expect(body).toContain('"retryable":true');
    expect(body).not.toContain("Do not repeat the same failed operation unchanged");
    expect(body).not.toContain("grantDigest");
  });

  it("uses the shared projection in the unformatted turn fallback", () => {
    const result = { success: false, output: "", error: "offline",
      failure: operationFailure("BACKEND_UNAVAILABLE", "backend") };
    const turn = buildToolTurn({ text: "",
      completed: [{ id: "call", name: "probe", arguments: {}, result }] });
    expect(turnToMessages(turn)[1].content).toContain('"code":"BACKEND_UNAVAILABLE"');
    expect(formatToolResultForModel({ success: true, output: "unchanged" })).toBe("unchanged");
  });

  it("keeps authoritative failure outside a lossy diagnostic compressor", () => {
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry),
      provider: { async call() { throw new Error("unused"); } },
      resultCompressor: { compress: () => "diagnostics compressed" } as any }) as any;
    const body = agent.formatResult({ id: "call", name: "probe", arguments: {} },
      { success: false, output: "", error: "backend offline", failure: operationFailure("BACKEND_UNAVAILABLE", "backend") },
      new Map(), new Map()).formattedOutput;
    expect(body).toContain('"code":"BACKEND_UNAVAILABLE"');
    expect(body).toContain('"source":"backend"');
    expect(body).toContain("diagnostics compressed");
  });
});

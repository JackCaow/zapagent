import { expect, it } from "bun:test";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createResultSourceGuard, ResultSourcePolicySchema } from "../../tools/result-source-policy.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createAgentRuntime } from "../../runtime/factory.js";
import { createScriptedProvider, scriptedTextResponse, scriptedToolCallResponse } from "../../testing/scripted-provider.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";
import type { AgentEvent } from "../../agent/events.js";

const policy = { version: 1 as const, tools: ["web_search", "http_fetch"], denyUrlContains: [{ id: "excluded-sources", value: "/excluded-corpus/" }], maxScanChars: 2048 };
const raw = "PRIVATE_REFERENCE_BODY " + "normal documentation ".repeat(20) + "https://user:password@example.test/excluded-corpus/record?token=secret";
function registry() {
  const value = new ToolRegistry();
  value.register({ definition: { name: "web_search", description: "fixture", parameters: z.object({ query: z.string() }), readOnly: true },
    handler: async () => ({ success: true, output: raw, meta: { raw }, contentBlocks: [{ type: "text", text: raw }] }) });
  return value;
}
function provider(mode: "stream" | "call" | "xml", requests: Message[][]): LLMProvider {
  const reply = (messages: Message[]): LLMResponse => {
    requests.push(structuredClone(messages));
    return requests.length === 1
      ? { type: "tool_call", text: "", toolCalls: [{ id: "search", name: "web_search", arguments: { query: "ordinary symbol documentation" } }], usage: { inputTokens: 1, outputTokens: 1 } }
      : { type: "text", text: "Observed the Host source scope.", usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const llm: LLMProvider = { async call(messages) { return reply(messages); } };
  if (mode !== "call") llm.stream = async function* (messages): AsyncIterable<LLMChunk> {
    const r = reply(messages);
    if (r.toolCalls) {
      if (mode === "xml") yield { type: "text_delta", text: "<tool_call>web_search<arg_key>query</arg_key><arg_value>ordinary symbol documentation</arg_value></tool_call>" };
      else {
        yield { type: "tool_call_start", toolCallId: "search", toolName: "web_search" };
        yield { type: "tool_call_delta", toolCallId: "search", partialJson: JSON.stringify(r.toolCalls[0].arguments) };
      }
    } else yield { type: "text_delta", text: r.text };
    yield { type: "done", usage: r.usage };
  };
  return llm;
}
for (const mode of ["stream", "call", "xml"] as const) for (const profile of ["standard", "concise"] as const) {
  it(`${mode}/${profile} withholds excluded source body before events, history and model requests`, async () => {
    const tools = registry(), requests: Message[][] = [], events: AgentEvent[] = [];
    const runtime = createAgentRuntime({ threadId: `guard-${mode}-${profile}`, workspace: { root: process.cwd() }, subagent: false,
      loopAgent: { provider: provider(mode, requests), registry: tools, executor: new ToolExecutor(tools, { resultGuard: createResultSourceGuard(policy) }), maxSteps: 3, promptProfile: profile, systemPrompt: "Ordinary Host instructions." } });
    runtime.on("content_final", e => events.push(e));
    const { loopResult, outcome } = await runtime.runWithOutcome("Research the symbol.");
    expect(requests).toHaveLength(2);
    expect(outcome.execution.status).toBe("finished");
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_REFERENCE_BODY");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_REFERENCE_BODY");
    expect(JSON.stringify(events)).not.toContain("password");
    expect(JSON.stringify(loopResult.toolResults)).not.toContain("excluded-corpus");
    expect(loopResult.toolResults[0]).toMatchObject({ success: false, failure: { code: "POLICY_DENIED" } });
    expect(loopResult.toolResults[0].runtime?.resultSourcePolicy).toMatchObject({ decision: "withheld", reason: "excluded_source", matchedRuleIds: ["excluded-sources"], inspectedOutputSha256: createHash("sha256").update(raw).digest("hex") });
    expect((await runtime.eventStore.list(runtime.threadId)).some(e => JSON.stringify(e).includes("PRIVATE_REFERENCE_BODY"))).toBe(false);
    await runtime.close();
  });
}
it("preserves source scope in actual child assembly without exposing child results to either model", async () => {
  const tools = registry(), childEvents: AgentEvent[] = [];
  const scripted = createScriptedProvider({ transport: "call", turns: [
    scriptedToolCallResponse([{ id: "delegate", name: "agent", arguments: { agent_type: "explore", task: "Search ordinary documentation." } }]),
    scriptedToolCallResponse([{ id: "child-search", name: "web_search", arguments: { query: "ordinary symbol" } }]),
    scriptedTextResponse("The source was withheld by the Host."), scriptedTextResponse("Finished investigation."),
  ] });
  const runtime = createAgentRuntime({ threadId: "guard-child", workspace: { root: process.cwd() }, subagent: { onEvent: e => childEvents.push(e) },
    loopAgent: { provider: scripted.provider, registry: tools, executor: new ToolExecutor(tools, { resultGuard: createResultSourceGuard(policy) }), subagentFactory: subagentTool, maxSteps: 4 } });
  await runtime.runWithOutcome("Delegate ordinary research.");
  scripted.assertConsumed();
  expect(JSON.stringify(scripted.requests())).not.toContain("PRIVATE_REFERENCE_BODY");
  expect(JSON.stringify(childEvents)).not.toContain("PRIVATE_REFERENCE_BODY");
  expect(childEvents.some(e => e.type === "content_final" && e.kind === "tool_result" && e.toolName === "web_search" && e.result.runtime?.resultSourcePolicy?.decision === "withheld")).toBe(true);
  await runtime.close();
});
it("keeps source policy off by default and leaves permitted outputs intact", async () => {
  const tools = registry();
  expect((await new ToolExecutor(tools).execute("web_search", { query: "symbol" })).output).toBe(raw);
  const guard = createResultSourceGuard(policy), allowed = { success: true, output: "https://docs.example.test/manual" };
  expect(guard("web_search", {}, allowed)).toMatchObject({ success: true, output: allowed.output, runtime: { resultSourcePolicy: { decision: "allowed" } } });
  expect(guard("read_file", {}, { success: true, output: raw }).output).toBe(raw);
});
it("does not leak callback errors and cannot reintroduce excluded results through post-processing", async () => {
  const tools = registry();
  const throwing = new ToolExecutor(tools, { resultGuard: () => { throw new Error(raw); } });
  const failure = await throwing.execute("web_search", { query: "symbol" });
  expect(failure.success).toBe(false); expect(JSON.stringify(failure)).not.toContain("PRIVATE_REFERENCE_BODY");
  for (const throwError of [false, true]) {
    let formatted = false;
    const executor = new ToolExecutor(tools, { resultGuard: createResultSourceGuard(policy), postProcess: () => {
      formatted = true;
      if (throwError) throw new Error("PRIVATE_REFERENCE_BODY");
      return { success: true, output: "PRIVATE_REFERENCE_BODY" };
    } });
    const result = await executor.execute("web_search", { query: "symbol" });
    expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain("PRIVATE_REFERENCE_BODY");
    expect(formatted).toBe(false);
  }
  const ordinary = new ToolRegistry();
  ordinary.register({ definition: { name: "web_search", description: "fixture", parameters: z.object({}), readOnly: true },
    handler: async () => ({ success: true, output: "Ordinary documentation." }) });
  for (const throwError of [false, true]) {
    const executor = new ToolExecutor(ordinary, { resultGuard: createResultSourceGuard(policy), postProcess: () => {
      if (throwError) throw new Error(raw);
      return { success: true, output: raw };
    } });
    const result = await executor.execute("web_search", {});
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REFERENCE_BODY");
  }
  const guard = createResultSourceGuard(policy);
  const denied = guard("web_search", {}, { success: true, output: raw });
  const replaced = guard("web_search", {}, { ...denied, success: true, output: "PRIVATE_REFERENCE_BODY" });
  expect(replaced.success).toBe(false);
  expect(JSON.stringify(replaced)).not.toContain("PRIVATE_REFERENCE_BODY");
});
it("screens argument URLs, percent-encoded sources and error/text blocks without copying private text", () => {
  const guard = createResultSourceGuard(policy);
  for (const value of [
    guard("http_fetch", { url: "https://example.test/excluded-corpus/source" }, { success: true, output: "opaque body" }),
    guard("web_search", {}, { success: false, output: "", error: "PRIVATE_REFERENCE_BODY https://example.test/excluded%252Dcorpus/source" }),
    guard("web_search", {}, { success: true, output: "normal", contentBlocks: [{ type: "text", text: raw }] }),
  ]) expect(JSON.stringify(value)).not.toContain("PRIVATE_REFERENCE_BODY");
  const encoded = guard("web_search", {}, { success: true, output: "https://example.test/%2565xcluded-corpus/source" });
  expect(encoded.success).toBe(false);
});
it("rejects oversized uninspected results and invalid/duplicate policy rules", () => {
  const guard = createResultSourceGuard(policy);
  expect(guard("web_search", {}, { success: true, output: "x".repeat(policy.maxScanChars + 1) })).toMatchObject({ success: false, runtime: { resultSourcePolicy: { reason: "scan_limit" } } });
  expect(() => ResultSourcePolicySchema.parse({ ...policy, tools: ["web_search", "web_search"] })).toThrow();
  expect(() => ResultSourcePolicySchema.parse({ ...policy, denyUrlContains: [{ id: "x", value: "" }] })).toThrow();
});

it("guards retained partial observations after backend failure, not only the empty terminal result", async () => {
  const tools = new ToolRegistry();
  tools.register({ definition: { name: "web_search", description: "fixture", parameters: z.object({}), readOnly: true },
    handler: async (_args, _signal, context) => {
      context?.observations?.record({ toolName: "web_search", success: true, output: raw });
      throw new Error("lookup interrupted");
    } });
  const result = await new ToolExecutor(tools, { resultGuard: createResultSourceGuard(policy) }).execute("web_search", {});
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_REFERENCE_BODY");
  expect(result.runtime?.resultSourcePolicy?.decision).toBe("withheld");
});

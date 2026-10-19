import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LoopAgent, type LoopAgentOptions } from "../../agent/loop.js";
import { AgentBudget } from "../../agent/budget.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ConversationManager } from "../../memory/conversation.js";
import { RetryProvider } from "../../core/retry.js";
import { StreamIdleTimeoutError } from "../../core/stream-idle.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, Message } from "../../core/types.js";
import type { AgentEvent } from "../../agent/events.js";

const done: LLMChunk = { type: "done", usage: { inputTokens: 10, outputTokens: 3, providerUsageReported: true } };
function fixture(provider: LLMProvider, registry = new ToolRegistry(), options: Partial<LoopAgentOptions> = {}) {
  const conversation = new ConversationManager({ maxMessages: 100 });
  const agent = new LoopAgent({ provider: new RetryProvider(provider, { maxRetries: 2, initialDelayMs: 1 }),
    registry, executor: new ToolExecutor(registry, { onApproval: async () => true }),
    conversation, systemPrompt: "fixture", maxSteps: 10, ...options });
  const events: AgentEvent[] = [];
  agent.on("*", e => events.push(e));
  return { agent, conversation, events };
}

function results(messages: Message[]) { return messages.filter(m => m.role === "tool_result"); }

describe("partial stream continuation", () => {
  test("settles a real side effect before continuing and never launches truncated arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zap-stream-continuation-"));
    try {
      const path = join(dir, "counter.txt");
      let executions = 0;
      let requests = 0;
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "append", description: "append fixture", parameters: z.object({ value: z.string() }) },
        handler: async ({ value }) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          await appendFile(path, String(value));
          executions++;
          return { success: true, output: "append committed" };
        } });
      const provider: LLMProvider = { async call() { throw new Error("unexpected synthesis"); }, async *stream(messages) {
        requests++;
        if (requests === 1) {
          yield { type: "text_delta", text: "Writing now" };
          yield { type: "tool_call_start", toolCallId: "written", toolName: "append" };
          yield { type: "tool_call_delta", toolCallId: "written", partialJson: '{"value":"once"}' };
          yield { type: "tool_call_start", toolCallId: "unfinished", toolName: "append" };
          yield { type: "tool_call_delta", toolCallId: "unfinished", partialJson: '{"value":"never' };
          throw new StreamIdleTimeoutError(180_000);
        }
        expect(await readFile(path, "utf8")).toBe("once");
        expect(results(messages)).toHaveLength(2);
        expect(results(messages)[0]!.content).toContain("append committed");
        expect(results(messages)[1]!.content).toContain("not executed");
        expect(messages.at(-1)!.content).toContain("interrupted");
        yield { type: "text_delta", text: "Recovered" };
        yield done;
      } };
      const { agent, events } = fixture(provider, registry);
      const result = await agent.run("append once");
      expect(result.text).toBe("Recovered");
      expect(requests).toBe(2);
      expect(executions).toBe(1);
      expect(result.totalUsage).toMatchObject({ inputTokens: 10, outputTokens: 3, usageIncomplete: true });
      for (const id of ["written", "unfinished"]) {
        expect(events.filter(e => e.type === "content_final" && e.kind === "tool_result" && e.id === id)).toHaveLength(1);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("preserves interrupted text as history without executing embedded XML", async () => {
    let requests = 0;
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "append", description: "fixture", parameters: z.object({}) },
      handler: async () => { executions++; return { success: true, output: "bad" }; } });
    const partial = 'I will append. <tool_call>{"name":"append","arguments":{}}</tool_call>';
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream(messages) {
      if (++requests === 1) { yield { type: "text_delta", text: partial }; throw new Error("connection lost"); }
      expect(messages.some(m => m.role === "user" && m.content.includes("interrupted"))).toBe(true);
      expect(messages.some(m => m.role === "assistant" && m.content.includes("I will append."))).toBe(true);
      yield { type: "text_delta", text: "Recovered" }; yield done;
    } };
    const { agent } = fixture(provider, registry);
    expect((await agent.run("work")).text).toBe("Recovered");
    expect(executions).toBe(0);
    expect(requests).toBe(2);
  });

  test("bounds repeated partial failures across the entire run", async () => {
    let requests = 0;
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      requests++; yield { type: "text_delta", text: "partial" }; throw new Error("connection lost");
    } };
    const { agent, conversation, events } = fixture(provider);
    await expect(agent.run("work")).rejects.toThrow("connection lost");
    expect(requests).toBe(3);
    expect(conversation.getMessages().filter(m => m.role === "assistant" && m.content === "partial")).toHaveLength(3);
    expect(events.find(e => e.type === "run_ended")).toMatchObject({ usage: { usageIncomplete: true } });
  });

  for (const error of [Object.assign(new Error("unauthorized"), { status: 401 }), new Error("invalid arguments")]) {
    test(`retains partial history but terminates on ${error.message}`, async () => {
      let requests = 0;
      const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
        requests++; yield { type: "text_delta", text: "partial" }; throw error;
      } };
      const { agent, conversation } = fixture(provider);
      await expect(agent.run("work")).rejects.toThrow(error.message);
      expect(requests).toBe(1);
      expect(conversation.getMessages().some(m => m.content === "partial")).toBe(true);
    });
  }

  test("does not continue after done even if iterator closing fails", async () => {
    let requests = 0;
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      requests++; yield { type: "text_delta", text: "finished" }; yield done; throw new Error("connection lost");
    } };
    const { agent, events } = fixture(provider);
    await expect(agent.run("work")).rejects.toThrow("connection lost");
    expect(requests).toBe(1);
    expect(events.find(e => e.type === "run_ended")).toMatchObject({ usage: { inputTokens: 10, outputTokens: 3 } });
  });

  test("cancellation preserves partial text without continuing", async () => {
    let requests = 0;
    const controller = new AbortController();
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      requests++; yield { type: "text_delta", text: "partial" }; controller.abort(); throw new Error("connection lost");
    } };
    const { agent, conversation } = fixture(provider);
    await expect(agent.run("work", { signal: controller.signal })).rejects.toThrow("aborted");
    expect(requests).toBe(1);
    expect(conversation.getMessages().some(m => m.content === "partial")).toBe(true);
    expect(conversation.getMessages().at(-1)!.content).toBe("[Request interrupted by user]");
  });

  test("charges the existing model-turn budget for continuation", async () => {
    let requests = 0;
    const budget = new AgentBudget({ maxSteps: 1 });
    let finalCalls = 0;
    const provider: LLMProvider = { async call() { finalCalls++; throw new Error("No budget for synthesis"); }, async *stream() {
      requests++; yield { type: "text_delta", text: "partial" }; throw new Error("connection lost");
    } };
    const { agent } = fixture(provider, undefined, { budget });
    const result = await agent.run("work");
    expect(requests).toBe(1);
    expect(budget.stepsUsed).toBe(1);
    expect(result.stopped).toBe("budget");
    expect(finalCalls).toBe(0);
  });

  test("roundtrips provider reasoning fields after failure before the first done", async () => {
    let requests = 0;
    const adapter = new OpenAICompatibleProvider({ model: "fixture", client: {
      chat: { completions: { create: async (request: any) => {
        if (++requests === 1) return (async function* () {
          yield { choices: [{ delta: { reasoning_content: "First " } }] };
          yield { choices: [{ delta: { reasoning_content: "reasoning" } }] };
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "pending", type: "function",
            function: { name: "append", arguments: '{"value":' } }] } }] };
          throw new Error("socket connection closed");
        })();
        const assistant = request.messages.find((m: any) => m.tool_calls?.length);
        expect(assistant.reasoning_content).toBe("First reasoning");
        expect(request.messages.filter((m: any) => m.role === "tool")).toHaveLength(1);
        return (async function* () {
          yield { choices: [{ delta: { content: "Recovered" }, finish_reason: "stop" }] };
          yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } };
        })();
      } } },
    } as any });
    const { agent } = fixture(adapter);
    expect((await agent.run("work")).text).toBe("Recovered");
    expect(requests).toBe(2);
  });

  test("does not synthesize when another agent exhausts shared tokens during an interrupted request", async () => {
    let requests = 0;
    let finalCalls = 0;
    const budget = new AgentBudget({ maxSteps: 10, maxTokens: 14 });
    const provider: LLMProvider = { async call() { finalCalls++; throw new Error("No token budget"); }, async *stream() {
      if (++requests === 1) {
        yield { type: "tool_call_start", toolCallId: "read", toolName: "read" };
        yield { type: "tool_call_delta", toolCallId: "read", partialJson: "{}" };
        yield done;
        return;
      }
      // Another admitted agent can settle usage while this request is live.
      budget.chargeTokens(1, 0);
      yield { type: "text_delta", text: "partial" };
      throw new Error("connection lost");
    } };
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "read", description: "fixture", readOnly: true, parameters: z.object({}) },
      handler: async () => ({ success: true, output: "observed" }) });
    const { agent } = fixture(provider, registry, { budget });
    expect((await agent.run("work")).stopped).toBe("budget");
    expect(requests).toBe(2);
    expect(finalCalls).toBe(0);
    expect(budget.tokensUsed).toBe(14);
  });

  test("a successful intervening tool round does not reset the continuation cap", async () => {
    let requests = 0;
    const provider: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() {
      requests++;
      if (requests % 2) { yield { type: "text_delta", text: "partial" }; throw new Error("connection lost"); }
      yield { type: "tool_call_start", toolCallId: `read-${requests}`, toolName: "read" };
      yield { type: "tool_call_delta", toolCallId: `read-${requests}`, partialJson: "{}" };
      yield done;
    } };
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "read", description: "fixture", readOnly: true, parameters: z.object({}) },
      handler: async () => ({ success: true, output: "observed" }) });
    const { agent } = fixture(provider, registry);
    await expect(agent.run("work")).rejects.toThrow("connection lost");
    expect(requests).toBe(5);
  });

  test("retains tool results when the original deadline expires during settlement", async () => {
    let requests = 0;
    let executions = 0;
    let synthesisMessages: Message[] = [];
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "write", description: "fixture", parameters: z.object({}) },
      handler: async (_args, signal) => {
        executions++;
        if (!signal?.aborted) await new Promise<void>(resolve =>
          signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { success: false, output: "write began before deadline", error: "aborted" };
      } });
    const provider: LLMProvider = { async call(messages) {
      synthesisMessages = messages;
      return { type: "text", text: "Deadline reached", usage: { inputTokens: 0, outputTokens: 0 } };
    }, async *stream() {
      requests++;
      yield { type: "tool_call_start", toolCallId: "write", toolName: "write" };
      yield { type: "tool_call_delta", toolCallId: "write", partialJson: "{}" };
      throw new Error("connection lost");
    } };
    const { agent, conversation } = fixture(provider, registry, { timeoutMs: 150, forceFinishTimeoutMs: 40 });
    const result = await agent.run("work");
    expect(result.stopped).toBe("timeout");
    expect(result.text).toBe("Deadline reached");
    expect(results(synthesisMessages)).toHaveLength(1);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.success).toBe(false);
    // The loop's cancellation and the executor/broker absolute deadlines
    // protect the same window. Either may settle first; retain that typed
    // failure rather than requiring the other timer's diagnostic wording.
    const failureCode = result.toolResults[0]!.failure?.code;
    expect(["CANCELLED", "DEADLINE_EXCEEDED"]).toContain(failureCode);
    expect(results(synthesisMessages)[0]!.content).toContain(`"code":"${failureCode}"`);
    expect(requests).toBe(1);
    expect(executions).toBe(1);
    expect(results(conversation.getMessages())).toHaveLength(1);
    expect(results(conversation.getMessages())[0]!.content).toBe(results(synthesisMessages)[0]!.content);
  });
});

import { describe, expect, it } from "bun:test";
import { LoopAgent } from "../../agent/loop.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { ContextDiagnostics } from "../../agent/events.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";
import { buildToolTurn } from "../../core/turn.js";
import { DYNAMIC_BOUNDARY, splitAtBoundary } from "../../core/prompt-boundary.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { z } from "zod";

function makeRecordingProvider(calls: Message[][]): LLMProvider {
  return {
    async call(messages): Promise<LLMResponse> {
      calls.push(messages);
      return {
        type: "text",
        text: "ok",
        toolCalls: [],
        usage: {
          inputTokens: 10,
          cacheReadInputTokens: 90,
          outputTokens: 1,
        },
        finishReason: "stop",
      };
    },
  };
}

describe("LoopAgent context diagnostics", () => {
  it("evaluates stable run context once and sends only changed live state as a tail delta", async () => {
    const calls: Message[][] = [];
    let providerTurn = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("stream expected");
      },
      async *stream(messages): AsyncIterable<LLMChunk> {
        calls.push(messages);
        if (providerTurn++ === 0) {
          yield { type: "tool_call_start", toolCallId: "read-1", toolName: "read_file" };
          yield { type: "tool_call_delta", toolCallId: "read-1", partialJson: '{"path":"src/a.ts"}' };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "read_file",
        description: "read",
        parameters: z.object({ path: z.string() }),
        readOnly: true,
      },
      handler: async () => ({ success: true, output: "contents" }),
    });
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation: new ConversationManager({ maxMessages: 100 }),
      systemPrompt: "system",
      maxSteps: 3,
    });
    let prefixCalls = 0;
    let deltaCalls = 0;

    await agent.run("fresh request", {
      contextPrefix: () => {
        prefixCalls++;
        return "<repo_map>stable map</repo_map>";
      },
      contextDelta: () => ++deltaCalls === 1
        ? undefined
        : "<active_plan>changed todo only</active_plan>",
    });

    expect(prefixCalls).toBe(1);
    expect(calls).toHaveLength(2);
    const firstStableIndex = calls[0].findIndex((message) => message.content.includes("stable map"));
    const secondStableIndex = calls[1].findIndex((message) => message.content.includes("stable map"));
    expect(firstStableIndex).toBe(secondStableIndex);
    expect(calls[0].at(-1)?.content).toBe("fresh request");
    expect(calls[1].at(-1)?.content).toContain("changed todo only");
    expect(calls[1].at(-1)?.content).not.toContain("stable map");
  });

  it("keeps the agent protocol in the cacheable system prefix and relocates dynamic context to the tail", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: `# Stable\n\n${DYNAMIC_BOUNDARY}\n\n# Dynamic\nToday: 2026-07-03`,
      maxSteps: 1,
    });

    const effectivePrompt = agent.effectiveSystemPrompt();
    expect(effectivePrompt).toBeDefined();
    const [staticPart, dynamicPart] = splitAtBoundary(effectivePrompt!);
    expect(staticPart).toContain("# Stable");
    expect(staticPart).toContain("[AGENT PROTOCOL]");
    expect(staticPart).toContain("Budget: 1 steps");
    expect(dynamicPart).toContain("# Dynamic");
    expect(dynamicPart).toContain("Today: 2026-07-03");
    expect(dynamicPart).not.toContain("[AGENT PROTOCOL]");

    const runStepContexts: Array<ContextDiagnostics | undefined> = [];
    agent.on("run_step", (event) => {
      if (event.type === "run_step") runStepContexts.push(event.context);
    });

    await agent.run("hi");

    expect(providerCalls).toHaveLength(1);
    const system = providerCalls[0].find((message) => message.role === "system");
    expect(system).toBeDefined();
    expect(system!.content).toBe(staticPart);
    expect(system!.content).not.toContain(DYNAMIC_BOUNDARY);
    expect(system!.content).not.toContain("Today: 2026-07-03");

    const sentContext = providerCalls[0].find((message) => message.content.includes("Today: 2026-07-03"));
    expect(sentContext?.content).toContain('<system-context source="runtime_environment">');
    expect(sentContext?.content).toContain("Today: 2026-07-03");
    expect(sentContext?.cache?.transient).toBe(true);
    expect(runStepContexts[0]?.segments[0]).toMatchObject({
      name: "runtime_environment",
      meta: { source: "system_prompt_dynamic_suffix" },
    });

    const persisted = conversation.getAllMessages();
    expect(persisted[0]?.content).toBe(staticPart);
    expect(persisted.some((message) => message.content.includes("Today: 2026-07-03"))).toBe(false);
  });

  it("keeps the provider prefix stable when only the dynamic environment changes", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const makeAgent = (date: string) => new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: `# Stable\n\n${DYNAMIC_BOUNDARY}\n\n# Dynamic\nToday: ${date}`,
      maxSteps: 1,
    });

    await makeAgent("2026-07-03").run("first");
    await makeAgent("2026-07-04").run("second");

    expect(providerCalls).toHaveLength(2);
    const firstSystem = providerCalls[0].find((message) => message.role === "system");
    const secondSystem = providerCalls[1].find((message) => message.role === "system");
    expect(firstSystem?.content).toBe(secondSystem?.content);
    expect(firstSystem?.content).not.toContain("2026-07-03");
    expect(secondSystem?.content).not.toContain("2026-07-04");
    expect(providerCalls[0].some((message) => message.content.includes("2026-07-03"))).toBe(true);
    expect(providerCalls[1].some((message) => message.content.includes("2026-07-04"))).toBe(true);
  });

  it("keeps provider-visible tool history immutable across agent runs", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    conversation.commitTurn({ kind: "user", content: "seed history" });
    for (let i = 0; i < 5; i++) {
      conversation.commitTurn(buildToolTurn({
        text: `tool turn ${i}`,
        completed: [{
          id: `tool-${i}`,
          name: "read_file",
          arguments: { path: `/tmp/${i}.txt` },
          result: { success: true, output: i === 0 ? `start ${"x".repeat(600)} end` : `recent ${i}` },
          formattedOutput: i === 0 ? `start ${"x".repeat(600)} end` : `recent ${i}`,
        }],
      }));
    }
    const makeAgent = () => new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "stable system",
      maxSteps: 1,
    });

    const original = conversation.getAllMessages()
      .find((message) => message.role === "tool_result" && message.toolCallId === "tool-0")
      ?.content;
    await makeAgent().run("first turn");
    const firstVisible = providerCalls[0]
      .find((message) => message.role === "tool_result" && message.toolCallId === "tool-0")
      ?.content;
    expect(firstVisible).toBe(original);
    expect(firstVisible).toContain("x".repeat(600));
    expect(firstVisible).not.toContain("zap-microcompact");

    await makeAgent().run("second turn");
    const secondVisible = providerCalls[1]
      .find((message) => message.role === "tool_result" && message.toolCallId === "tool-0")
      ?.content;
    expect(secondVisible).toBe(firstVisible);
    expect(conversation.getAllMessages()
      .find((message) => message.role === "tool_result" && message.toolCallId === "tool-0")
      ?.content).toBe(original);
  });

  it("keeps more than 100 historical messages stable across follow-up runs", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({
      maxMessages: Number.POSITIVE_INFINITY,
      maxTokens: 1_000_000,
      triggerAtTokens: 800_000,
      autoCompress: true,
    });
    for (let i = 0; i < 55; i++) {
      conversation.commitTurn({ kind: "user", content: `seed-user-${i}` });
      conversation.commitTurn({ kind: "assistant", text: `seed-assistant-${i}` });
    }
    const makeAgent = () => new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "stable system",
      maxSteps: 1,
    });

    await makeAgent().run("first follow-up");
    await makeAgent().run("second follow-up");

    expect(providerCalls).toHaveLength(2);
    for (const call of providerCalls) {
      expect(call.some((message) => message.content === "seed-user-0")).toBe(true);
      expect(call.some((message) => message.content === "seed-assistant-54")).toBe(true);
    }
    expect(providerCalls[1].some((message) => message.content === "first follow-up")).toBe(true);
    expect(conversation.messageCount).toBe(115);
  });

  it("keeps tool-result history append-only during an active run", async () => {
    const providerCalls: Message[][] = [];
    let turn = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("stream expected");
      },
      async *stream(messages): AsyncIterable<LLMChunk> {
        providerCalls.push(messages);
        if (turn >= 6) {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        const id = `read-${turn}`;
        const path = `src/file-${turn}.ts`;
        turn++;
        yield { type: "tool_call_start", toolCallId: id, toolName: "read_file" };
        yield { type: "tool_call_delta", toolCallId: id, partialJson: JSON.stringify({ path }) };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "read_file",
        description: "read",
        parameters: z.object({ path: z.string() }),
        readOnly: true,
      },
      handler: async (args) => ({
        success: true,
        output: String(args.path).endsWith("file-0.ts")
          ? `first-result ${"x".repeat(600)} end`
          : `result for ${args.path}`,
      }),
    });
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation: new ConversationManager({ maxMessages: 100 }),
      systemPrompt: "stable system",
      maxSteps: 8,
    });

    await agent.run("inspect six files");

    const finalFirstResult = providerCalls.at(-1)?.find((message) =>
      message.role === "tool_result" && message.toolCallId === "read-0"
    );
    expect(providerCalls).toHaveLength(7);
    expect(finalFirstResult?.content).toContain("first-result");
    expect(finalFirstResult?.content).toContain("x".repeat(600));
    expect(finalFirstResult?.content).not.toContain("zap-microcompact");
  });

  it("emits transient context diagnostics on run_step without persisting the context message", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry, {});
    const agent = new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry,
      executor,
      conversation,
      systemPrompt: "system",
      maxSteps: 1,
    });

    const diagnostics: ContextDiagnostics = {
      totalChars: 37,
      estimatedTokens: 12,
      hash: "ctxhash",
      segments: [
        {
          name: "memory_working_pack",
          chars: 37,
          estimatedTokens: 12,
          hash: "memhash",
          meta: { included: ["cache.md"] },
        },
      ],
    };
    const runStepContexts: Array<ContextDiagnostics | undefined> = [];
    agent.on("run_step", (event) => {
      if (event.type === "run_step") runStepContexts.push(event.context);
    });

    await agent.run("hi", {
      contextPrefix: () => "<system-context>\ncache memory\n</system-context>",
      contextDiagnostics: () => diagnostics,
    });

    expect(runStepContexts[0]).toMatchObject({
      totalChars: diagnostics.totalChars,
      estimatedTokens: diagnostics.estimatedTokens,
      hash: diagnostics.hash,
      segments: diagnostics.segments,
    });
    expect(runStepContexts[0]?.conversationCache).toMatchObject({
      prefix: { messageCount: 0, messageHashes: [] },
      tail: { messageCount: 1 },
    });
    expect(providerCalls).toHaveLength(1);
    const sentContext = providerCalls[0].find((message) => message.content.includes("cache memory"));
    expect(sentContext?.content).toContain("cache memory");
    expect(sentContext?.cache?.transient).toBe(true);

    const persisted = conversation.getMessages();
    expect(persisted.some((m) => m.content.includes("cache memory"))).toBe(false);
  });

  it("emits conversation cache diagnostics even without transient context", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const contexts: ContextDiagnostics[] = [];
    const makeAgent = () => {
      const agent = new LoopAgent({
        provider: makeRecordingProvider(providerCalls),
        registry: new ToolRegistry(),
        executor: new ToolExecutor(new ToolRegistry(), {}),
        conversation,
        systemPrompt: "system",
        maxSteps: 1,
      });
      agent.on("run_step", (event) => {
        if (event.type === "run_step" && event.context) contexts.push(event.context);
      });
      return agent;
    };

    await makeAgent().run("first");
    await makeAgent().run("second");

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      totalChars: 0,
      estimatedTokens: 0,
      segments: [],
      conversationCache: {
        prefix: { messageCount: 0, messageHashes: [] },
        tail: { messageCount: 1 },
      },
    });
    expect(contexts[1]?.conversationCache?.prefix.messageCount).toBe(2);
    expect(contexts[1]?.conversationCache?.prefix.messageHashes).toHaveLength(2);
    expect(contexts[1]?.conversationCache?.tail.messageCount).toBe(1);
  });

  it("merges runtime environment diagnostics with host attachment diagnostics", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: `stable${DYNAMIC_BOUNDARY}Today: 2026-07-03`,
      maxSteps: 1,
    });
    const hostDiagnostics: ContextDiagnostics = {
      totalChars: 12,
      estimatedTokens: 4,
      hash: "hosthash",
      segments: [{
        name: "memory_index",
        chars: 12,
        estimatedTokens: 4,
        hash: "memoryhash",
      }],
    };
    const runStepContexts: Array<ContextDiagnostics | undefined> = [];
    agent.on("run_step", (event) => {
      if (event.type === "run_step") runStepContexts.push(event.context);
    });

    await agent.run("hi", {
      contextPrefix: "memory index",
      contextDiagnostics: () => hostDiagnostics,
    });

    const sentContext = providerCalls[0].find((message) => message.content.includes("Today: 2026-07-03"));
    expect(sentContext?.content).toContain("Today: 2026-07-03");
    expect(sentContext?.content).toContain("memory index");
    expect(runStepContexts[0]?.totalChars).toBe(sentContext?.content.length);
    expect(runStepContexts[0]?.hash).not.toBe(hostDiagnostics.hash);
    expect(runStepContexts[0]?.segments.map((segment) => segment.name)).toEqual([
      "runtime_environment",
      "memory_index",
    ]);
  });

  it("marks the current user turn to skip conversation cache breakpoints", async () => {
    const providerCalls: Message[][] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({
      provider: makeRecordingProvider(providerCalls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "system",
      maxSteps: 1,
    });

    await agent.run("fresh user request", {
      contextPrefix: () => "<system-context>\nvolatile memory\n</system-context>",
    });

    expect(providerCalls).toHaveLength(1);
    const sentUser = providerCalls[0].find((m) => m.role === "user" && m.content === "fresh user request");
    expect(sentUser?.cache?.skipBreakpoint).toBe(true);
    const sentContext = providerCalls[0].find((message) => message.content.includes("volatile memory"));
    expect(sentContext?.content).toContain("volatile memory");
    expect(sentContext?.cache?.transient).toBe(true);

    const persistedUser = conversation.getMessages().find((m) => m.role === "user" && m.content === "fresh user request");
    expect(persistedUser?.cache?.skipBreakpoint).toBeUndefined();
  });

  it("marks turn-end guard continuation messages to skip conversation cache breakpoints during the run", async () => {
    const providerCalls: Message[][] = [];
    let streamCalls = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("stream expected");
      },
      async *stream(messages): AsyncIterable<LLMChunk> {
        providerCalls.push(messages);
        streamCalls++;
        yield { type: "text_delta", text: streamCalls === 1 ? "needs follow-up" : "done" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "system",
      maxSteps: 5,
    });

    await agent.run("fresh user request", {
      turnEndGuard: () => "continue once",
    });

    expect(providerCalls).toHaveLength(2);
    const sentContinuation = providerCalls[1].find((m) => m.role === "user" && m.content === "continue once");
    expect(sentContinuation?.cache?.skipBreakpoint).toBe(true);

    const persistedContinuation = conversation.getMessages()
      .find((m) => m.role === "user" && m.content === "continue once");
    expect(persistedContinuation?.cache?.skipBreakpoint).toBeUndefined();
  });

  it("blocks leaks from the latest transient context, not only the run-start snapshot", async () => {
    let streamCalls = 0;
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("stream expected");
      },
      async *stream(): AsyncIterable<LLMChunk> {
        streamCalls++;
        if (streamCalls === 1) {
          yield { type: "text_delta", text: "first response" };
        } else {
          yield { type: "text_delta", text: "<active_plan>\nsecond secret\n</active_plan>" };
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    let deltaCalls = 0;
    const observations: string[] = [];
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "system",
      maxSteps: 5,
    });
    agent.on("observation", (event) => {
      if (event.type === "observation") observations.push(event.kind);
    });

    const result = await agent.run("hi", {
      contextPrefix: () => {
        return "<system-context>\nfirst context\n</system-context>";
      },
      contextDelta: () => ++deltaCalls === 1
        ? undefined
        : "<active_plan>\nsecond secret\n</active_plan>",
      turnEndGuard: () => "continue once",
    });

    expect(streamCalls).toBe(2);
    expect(result.text).toContain("I can't share my system instructions");
    expect(result.text).not.toContain("second secret");
    expect(observations).toContain("prompt_leak_blocked");
    expect(conversation.getMessages().some((m) => m.content.includes("second secret"))).toBe(false);
  });

  it("keeps transient context on the reactive retry after streaming overflow", async () => {
    const callMessages: Message[][] = [];
    const provider: LLMProvider = {
      async call(messages): Promise<LLMResponse> {
        callMessages.push(messages);
        return {
          type: "text",
          text: "recovered",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
        };
      },
      async *stream(): AsyncIterable<LLMChunk> {
        throw new Error("context length exceeded");
      },
    };
    const conversation = new ConversationManager({ maxMessages: 100 });
    const agent = new LoopAgent({
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "system",
      maxSteps: 1,
    });

    await agent.run(`fresh request ${"x".repeat(20000)}`, {
      contextPrefix: () => "<system-context>\nvolatile memory\n</system-context>",
    });

    expect(callMessages).toHaveLength(1);
    const retryContext = callMessages[0].find((message) => message.content.includes("volatile memory"));
    expect(retryContext?.content).toContain("volatile memory");
    expect(retryContext?.cache?.transient).toBe(true);
    expect(conversation.getMessages().some((m) => m.content.includes("volatile memory"))).toBe(false);
  });
});

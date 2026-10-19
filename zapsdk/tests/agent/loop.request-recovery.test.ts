import { expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";
import { measureRecoveryInput } from "../../context/request-recovery.js";

function conversationWithImages(): ConversationManager {
  const conversation = new ConversationManager({ maxMessages: 1000, maxTokens: 1000000 });
  conversation.add({ role: "user", content: "Create and verify the requested video; preserve the narration." });
  for (let i = 0; i < 30; i++) {
    conversation.add({ role: "assistant", content: `Seen frame ${i}`, toolCalls: [{ id: `image${i}`, name: "read_file", arguments: {} }] });
    conversation.add({ role: "tool_result", toolCallId: `image${i}`, content: "loaded", contentBlocks: [
      { type: "image", base64: "YQ==".repeat(4096), mediaType: "image/png", source: `${i}.png`, filePath: `/frames/${i}.png` },
    ] });
  }
  return conversation;
}

for (const streaming of [true, false]) {
  it(`commits body recovery before tools and reuses it on the next step and run (streaming=${streaming})`, async () => {
    const conversation = conversationWithImages();
    const originalBytes = measureRecoveryInput(conversation.getMessages()).imageBytes;
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({ definition: { name: "verify", description: "verify", parameters: z.object({}), readOnly: true }, handler: async () => {
      executions++;
      expect(measureRecoveryInput(conversation.getMessages()).imageBytes).toBeLessThan(originalBytes);
      return { success: true, output: "verified" };
    } });
    let requests = 0;
    let failures = 0;
    let responses = 0;
    const check = (messages: Message[]) => {
      requests++;
      expect(messages.some(m => m.content.includes("preserve the narration"))).toBe(true);
      expect(messages.some(m => m.content.includes("live task state") && m.cache?.transient)).toBe(true);
      if (measureRecoveryInput(messages).imageBytes > originalBytes * 0.7) {
        failures++;
        throw new Error("413 Failed to buffer the request body: length limit exceeded");
      }
    };
    const provider: LLMProvider = {
      async call(messages) {
        check(messages);
        const tool = responses++ === 0;
        return { type: tool ? "tool_call" : "text", text: tool ? "" : "done",
          ...(tool ? { toolCalls: [{ id: "verify-once", name: "verify", arguments: {} }] } : {}),
          usage: { inputTokens: 100, outputTokens: 1 }, finishReason: tool ? "tool_calls" : "stop" };
      },
      ...(streaming ? { async *stream(messages: Message[]) {
        check(messages);
        yield { type: "text_delta" as const, text: "done" };
        yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 1 }, finishReason: "stop" };
      } } : {}),
    };
    const makeAgent = () => new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      contextWindow: 1000000, autoCompactThreshold: 3170584, autoCompactTokenThreshold: 792646,
      maxSteps: 4, reserveSteps: 0 });
    const agent = makeAgent();
    const notices: string[] = [];
    agent.on("observation", e => { if (e.type === "observation") notices.push(e.kind); });
    await agent.run("continue", { contextPrefix: () => "live task state" });
    expect(executions).toBe(1);
    expect(failures).toBe(1);
    expect(requests).toBe(3);
    expect(notices.filter(k => k === "reactive_compact")).toHaveLength(1);
    expect(notices.filter(k => k === "request_recovered")).toHaveLength(1);
    expect(conversation.getAllMessages().some(m => m.content.includes("live task state"))).toBe(false);
    await makeAgent().run("continue again", { contextPrefix: () => "live task state" });
    expect(failures).toBe(1);
    expect(requests).toBe(4);
  });
}

it("refuses to overwrite new canonical input arriving during recovery", async () => {
  const conversation = conversationWithImages();
  const registry = new ToolRegistry();
  let calls = 0;
  const provider: LLMProvider = { async call() {
    if (calls++ === 0) throw new Error("413 request too large");
    conversation.add({ role: "user", content: "new instruction" });
    return { type: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation, maxSteps: 3 });
  await expect(agent.run("continue")).rejects.toThrow("refusing to overwrite newer input");
  expect(conversation.getAllMessages().some(m => m.content === "new instruction")).toBe(true);
});

it("retires images before dispatch once and keeps the prefix stable through new images and a new run", async () => {
  const source = conversationWithImages();
  const conversation = new ConversationManager({ maxMessages: Infinity, imageRetention: {
    highWaterBytes: 400_000, lowWaterBytes: 200_000, keepRecentGroups: 2,
  } });
  source.getAllMessages().forEach(m => conversation.add(m));
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "read_frame", description: "read", parameters: z.object({}), readOnly: true },
    handler: async () => ({ success: true, output: "new frame", contentBlocks: [
      { type: "image", base64: "YQ==".repeat(4096), mediaType: "image/png", source: "/new.png", filePath: "/new.png" },
    ] }) });
  let calls = 0;
  let batches = 0;
  let prefix: Message[] = [];
  const provider: LLMProvider = { async call(messages) {
    calls++;
    expect(measureRecoveryInput(messages).imageBytes).toBeLessThan(400_000);
    if (calls === 1) prefix = structuredClone(messages.slice(0, source.getAllMessages().length));
    else expect(messages.slice(0, prefix.length)).toEqual(prefix);
    return calls <= 2
      ? { type: "tool_call", text: "", toolCalls: [{ id: `new${calls}`, name: "read_frame", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
      : { type: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const makeAgent = () => {
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
      maxSteps: 5, reserveSteps: 0 });
    agent.on("observation", e => { if (e.type === "observation" && e.kind === "historical_images_retired") batches++; });
    return agent;
  };
  await makeAgent().run("continue");
  await makeAgent().run("continue again");
  expect(calls).toBe(4);
  expect(batches).toBe(1);
  expect(measureRecoveryInput(source.getAllMessages()).imageBytes).toBe(30 * 16384);
});

it("reuses a reduced stable transient context while refreshing live deltas", async () => {
  const conversation = new ConversationManager({ maxMessages: 100 });
  const registry = new ToolRegistry();
  let version = 0;
  let failures = 0;
  registry.register({ definition: { name: "advance", description: "advance", parameters: z.object({}), readOnly: true },
    handler: async () => { version++; return { success: true, output: "advanced" }; } });
  const huge = `stable marker ${"x".repeat(20000)} stable tail`;
  const provider: LLMProvider = {
    async *stream(messages) {
      if (messages.some(m => m.content === huge)) {
        failures++;
        throw new Error("context length exceeded");
      }
      expect(messages.some(m => m.content === "live version 1")).toBe(true);
      yield { type: "text_delta", text: "done" };
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 1 }, finishReason: "stop" };
    },
    async call(messages) {
      expect(messages.some(m => m.content.includes("stable tail"))).toBe(true);
      expect(messages.some(m => m.content === "live version 0")).toBe(true);
      return { type: "tool_call", text: "", toolCalls: [{ id: "advance1", name: "advance", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 1 }, finishReason: "tool_calls" };
    },
  };
  const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation, maxSteps: 4, reserveSteps: 0 });
  await agent.run("continue", { contextPrefix: () => huge, contextDelta: () => `live version ${version}` });
  expect(failures).toBe(1);
  expect(version).toBe(1);
  expect(conversation.getAllMessages().some(m => m.content.includes("stable marker") || m.content.includes("live version"))).toBe(false);
});

it("keeps stable context anchored outside tool groups after token recovery", async () => {
  const conversation = new ConversationManager({ maxMessages: Infinity });
  conversation.add({ role: "user", content: "original task" });
  for (let i = 0; i < 13; i++) conversation.add({ role: i % 2 ? "assistant" : "user", content: `history ${i} ${"x".repeat(3000)}` });
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({ definition: { name: "verify", description: "verify", parameters: z.object({ value: z.number() }), readOnly: true },
    handler: async () => ({ success: true, output: `verified ${++executions}` }) });
  let calls = 0;
  let runStart = -1;
  const agent = new LoopAgent({ provider: { async call(messages) {
    calls++;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].toolCalls?.length) expect(messages[i + 1]?.role).toBe("tool_result");
    }
    const prefixIndex = messages.findIndex(m => m.content === "stable context");
    expect(messages[prefixIndex + 1]?.content).toBe("continue");
    if (calls === 1) throw new Error("context length exceeded");
    if (calls >= 8) return { type: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    return { type: "tool_call", text: "", toolCalls: [{ id: `verify${calls}`, name: "verify", arguments: { value: calls } }],
      usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
  } }, registry, executor: new ToolExecutor(registry), conversation, maxSteps: 15, reserveSteps: 0,
    autoCompactThreshold: 100000000, autoCompactTokenThreshold: 100000000,
    onRunStart: async ({ turnStartIndex }) => { runStart = turnStartIndex; } });
  await agent.run("continue", { contextPrefix: () => "stable context" });
  expect(runStart).toBe(14);
  expect(calls).toBe(8);
  expect(executions).toBe(6);
});

it("recovers the failed bounded view without changing or resurrecting omitted history", async () => {
  const conversation = new ConversationManager({ maxMessages: Infinity, maxTokens: 15000 });
  conversation.add({ role: "user", content: "original task" });
  for (let i = 0; i < 100; i++) {
    conversation.add({ role: "assistant", content: `frame ${i}`, toolCalls: [{ id: `r${i}`, name: "read", arguments: {} }] });
    conversation.add({ role: "tool_result", toolCallId: `r${i}`, content: "loaded", contentBlocks: [
      { type: "image", base64: "YQ==".repeat(4096), mediaType: "image/png", source: `${i}.png`, filePath: `/frames/${i}.png` },
    ] });
  }
  const hidden = conversation.getAllMessages().slice(0, -conversation.getMessages().length);
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "verify", description: "verify", parameters: z.object({}), readOnly: true },
    handler: async () => ({ success: true, output: "verified" }) });
  let calls = 0;
  let firstViewImageIds: string[] = [];
  let recoveredBytes = Infinity;
  const provider: LLMProvider = { async call(messages) {
    calls++;
    const imageIds = messages.filter(m => m.contentBlocks?.some(b => b.type === "image")).map(m => m.toolCallId!);
    if (calls === 1) {
      firstViewImageIds = imageIds;
      throw new Error("413 request body too large");
    }
    expect(imageIds.every(id => firstViewImageIds.includes(id))).toBe(true);
    const bytes = measureRecoveryInput(messages).imageBytes;
    expect(bytes).toBeLessThanOrEqual(recoveredBytes);
    recoveredBytes = bytes;
    if (calls === 2) return { type: "tool_call", text: "", toolCalls: [{ id: "verify", name: "verify", arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
    return { type: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const makeAgent = () => new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
    maxSteps: 4, reserveSteps: 0, autoCompactThreshold: 100000000, autoCompactTokenThreshold: 100000000 });
  await makeAgent().run("continue", { contextPrefix: "stable context" });
  expect(calls).toBe(3);
  expect(conversation.getAllMessages().slice(0, hidden.length)).toEqual(hidden);
  conversation.setMaxTokens(1000000);
  await makeAgent().run("continue again", { contextPrefix: "stable context" });
  expect(calls).toBe(4);
  expect(conversation.getAllMessages().slice(0, hidden.length)).toEqual(hidden);
});

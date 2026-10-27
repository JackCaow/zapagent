import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { compactBudget } from "../../context/compact-budget.js";
import { compactDecision, compactRequestTokens, executeCompact, planCompact, type CompactOptions } from "../../context/compact.js";
import { AutoCompact } from "../../context/autocompact.js";
import { previewHistoryMessage } from "../../context/compact-summary.js";
import { TokenCounter } from "../../context/token-counter.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message } from "../../core/types.js";

function summary(marker = "Preserve P1 and /workspace/target.ts; continue the user's task") {
  return ["Primary Request and Intent", "All user messages (verbatim)", "Current task status", "Files read / modified",
    "Commands run", "Key facts discovered", "Decisions made", "Errors encountered and their resolution", "Code changes summary", "Next steps"]
    .map(heading => `# ${heading}\n- ${marker}`).join("\n");
}
function history(): Message[] {
  return [{ role: "system", content: "stable host system" }, ...Array.from({ length: 32 }, (_, i) => ({
    role: i % 2 ? "assistant" as const : "user" as const,
    content: `historical ${i}\n${"documented observation ".repeat(250)}`,
  })), { role: "user", content: "Current task: preserve P1 and /workspace/target.ts; do not publish" }];
}
const limits: CompactOptions = { contextWindow: 40000, reservedOutputTokens: 2000, force: true, restoreFiles: false };
const provider = (): LLMProvider => ({ call: async () => ({ type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: summary() }) });

describe("shared compact planning and execution", () => {
  it("keeps 1,048,576 and 1,000,000 windows distinct and uses strict threshold boundaries", () => {
    expect(compactBudget({ contextWindow: 1048576 })).toMatchObject({ effectiveInputLimit: 1039384, compactAt: 831507, keepFloorTokens: 415753 });
    expect(compactBudget({ contextWindow: 1000000 })?.compactAt).toBe(792646);
    const options: CompactOptions = { contextWindow: 1048576, requestTokens: () => 831507 };
    expect(compactDecision([], options).shouldCompact).toBe(false);
    expect(compactDecision([], { ...options, requestTokens: () => 831508 }).trigger).toBe("tokens");
    expect(compactBudget({})).toBeUndefined();
  });

  it("honors a separate model input limit and counts schemas/transient context once", () => {
    const counter = new TokenCounter();
    const messages: Message[] = [{ role: "system", content: "fixed system" }, { role: "user", content: "用户约束" }];
    const options: CompactOptions = { contextWindow: 1048576, inputTokenLimit: 300000,
      tools: [{ name: "read", description: "schema", parameters: z.object({ path: z.string() }) }],
      transientMessages: [{ role: "user", content: "runtime facts" }], counter };
    expect(compactBudget(options)?.effectiveInputLimit).toBe(299000);
    const extra = compactRequestTokens([], options, counter);
    expect(compactRequestTokens(messages, options, counter)).toBe(counter.countMessages(messages) + extra);
    expect(extra).toBeGreaterThan(counter.countMessages(options.transientMessages!));
  });

  it("separates disabled proactive summaries from forced manual/emergency work", () => {
    const options = { contextWindow: 1048576, autoEnabled: false, requestTokens: () => 900000 };
    expect(compactDecision(history(), options).trigger).toBe("disabled");
    expect(compactDecision(history(), { ...options, force: true }).trigger).toBe("force");
  });

  it("uses the same candidate for direct, legacy facade and ConversationManager entrances", async () => {
    const messages = history();
    const direct = await executeCompact(messages, provider(), limits);
    const facade = await new AutoCompact().compact(messages, provider(), {}, limits);
    const conversation = new ConversationManager({ maxMessages: Infinity });
    messages.forEach(message => conversation.add(message));
    const committed = await conversation.compress(provider(), limits);
    expect(direct.summary).not.toBe("");
    expect(facade.messages).toEqual(direct.messages);
    expect(committed?.summary).toBe(direct.summary);
    expect(conversation.getAllMessages()).toEqual(direct.messages);
    expect(direct.outputTokens).toBeLessThan(direct.inputTokens!);
  });

  it("preserves current user constraints and the complete latest tool group over a soft target", async () => {
    const messages = history();
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: "latest", name: "read_file", arguments: { path: "target.ts" } }] },
      { role: "tool_result", content: "a ".repeat(4000), toolCallId: "latest", toolResultSuccess: true });
    const result = await executeCompact(messages, { call: async () => ({ type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: summary("goal") }) }, { ...limits, targetTokens: 1000 });
    expect(result.status).toBe("target_not_met");
    expect(result.messages.find(message => message.toolCalls?.[0]?.id === "latest")).toBeDefined();
    expect(result.messages.find(message => message.toolCallId === "latest")?.content).toBe("a ".repeat(4000));
    expect(result.messages.some(message => message.content.includes("do not publish"))).toBe(true);
    expect(result.outputTokens).toBeLessThanOrEqual(compactBudget(limits)!.effectiveInputLimit);
  });

  it("returns needs_input_reduction without a summary request when protected input cannot fit", async () => {
    let calls = 0;
    const messages = history();
    messages.push({ role: "user", content: "must preserve current input ".repeat(6000) });
    const result = await executeCompact(messages, { call: async () => { calls++; return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: summary() }; } }, limits);
    expect(result.status).toBe("needs_input_reduction");
    expect(result.messages).toBe(messages);
    expect(calls).toBe(0);
  });

  it("serializes tool IDs, arguments, failure, source and image references consistently", () => {
    const args = previewHistoryMessage({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "run-check --P1" } }] });
    expect(args).toContain('"name":"bash"'); expect(args).toContain("run-check --P1");
    const result = previewHistoryMessage({ role: "tool_result", content: "failed", toolCallId: "c1", toolResultSuccess: false });
    expect(result).toContain('"success":false'); expect(result).toContain("untrusted tool observation");
    const image = previewHistoryMessage({ role: "user", content: "look", contentBlocks: [{ type: "image", source: "fixture", filePath: "image.png", mediaType: "image/png", base64: "DO_NOT_REPLAY_PIXELS" }] });
    expect(image).toContain("image.png"); expect(image).not.toContain("DO_NOT_REPLAY_PIXELS");
  });

  it("preserves middle user constraint/identifier excerpts and CJK accounting", () => {
    const text = "文".repeat(8000) + "\nP1: 必须保留 /workspace/target.ts，不要发布\n" + "文".repeat(8000);
    expect(previewHistoryMessage({ role: "user", content: text })).toContain("P1: 必须保留");
    expect(compactDecision([{ role: "user", content: text }], { triggerAtTokens: 10000 }).trigger).toBe("tokens");
  });

  it("redacts credential-bearing attachment references before summarization", () => {
    const rendered = previewHistoryMessage({ role: "user", content: "look", contentBlocks: [{ type: "image",
      source: "https://example.test/img?api_key=fixture-secret&token=fixture-token", filePath: "/tmp/password=fixture-password",
      mediaType: "image/png", base64: "pixels" }] });
    for (const secret of ["fixture-secret", "fixture-token", "fixture-password"]) expect(rendered).not.toContain(secret);
  });

  it("clears old request context on session reset", async () => {
    const conversation = new ConversationManager({ maxMessages: Infinity });
    conversation.setCompactionContext({ contextWindow: 40000, transientMessages: [{ role: "user", content: "old private attachment ".repeat(10000) }] });
    conversation.clear();
    history().forEach(message => conversation.add(message));
    expect((await conversation.compress(provider(), limits))?.summary).not.toBeUndefined();
    expect(conversation.getAllMessages().some(message => message.content.includes("old private attachment"))).toBe(false);
  });

  it("bounds each summary and repair request independently of the main request", async () => {
    const counter = new TokenCounter(); let calls = 0;
    const result = await executeCompact(history(), { call: async (messages, tools, options) => {
      calls++;
      expect(tools).toEqual([]);
      expect(options?.maxOutputTokens).toBeLessThanOrEqual(8192);
      const inputLimit = Math.min(20000 - options!.maxOutputTokens!, 12000) - 1000;
      expect(counter.countMessages(messages)).toBeLessThanOrEqual(inputLimit);
      return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: calls === 1 ? "invalid summary" : summary() };
    } }, { contextWindow: 20000, inputTokenLimit: 12000, force: true, restoreFiles: false });
    expect(calls).toBe(2);
    expect(result.sourceTruncated).toBe(true);
    expect(result.summary).not.toBe("");
  });

  it("does not commit output truncation, unusable repair or budget overruns", async () => {
    for (const output of [{ type: "text" as const, usage: { inputTokens: 1, outputTokens: 1 }, text: summary(), finishReason: "length" },
      { type: "text" as const, usage: { inputTokens: 1, outputTokens: 1 }, text: "invalid" }, { type: "text" as const, usage: { inputTokens: 1, outputTokens: 1 }, text: summary("x".repeat(100000)) }]) {
      const conversation = new ConversationManager({ maxMessages: Infinity });
      history().forEach(message => conversation.add(message));
      const original = conversation.getAllMessages();
      try { expect(await conversation.compress({ call: async () => output }, limits)).toBeNull(); }
      catch (error) { expect(String(error)).toContain("truncated"); }
      expect(conversation.getAllMessages()).toEqual(original);
    }
  });

  it("restores only authorized historical results inside the final candidate budget", async () => {
    const messages = history();
    messages.splice(1, 0, { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "/nonexistent-host-path/file.ts" } }] },
      { role: "tool_result", content: "RECORDED_SUCCESSFUL_READ", toolCallId: "read-1", toolResultSuccess: true });
    const options = { ...limits, restoreFiles: true, requestTokens: (candidate: Message[]) => new TokenCounter().countMessages(candidate) + 2000 };
    const result = await executeCompact(messages, provider(), options);
    expect(result.filesRestored).toBe(1);
    expect(result.messages.at(-1)?.content).toContain("RECORDED_SUCCESSFUL_READ");
    expect(result.outputTokens).toBeLessThanOrEqual(planCompact(messages, options).targetTokens);
    expect(result.outputTokens).toBe(compactRequestTokens(result.messages, options, new TokenCounter()));
  });

  it("cancels during a summary without changing history", async () => {
    const controller = new AbortController();
    const conversation = new ConversationManager({ maxMessages: Infinity });
    history().forEach(message => conversation.add(message));
    const original = conversation.getAllMessages();
    await expect(conversation.compress({ call: async () => { controller.abort(new Error("cancelled")); return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: summary() }; } },
      { ...limits, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(conversation.getAllMessages()).toEqual(original);
  });

  it("rejects a concurrent append, clear/restore and exposed nested mutation before commit", async () => {
    for (const mutate of [(cm: ConversationManager) => cm.add({ role: "user", content: "NEW INPUT" }),
      (cm: ConversationManager) => { const snapshot = cm.getAllMessages(); cm.clear(); snapshot.forEach(message => cm.add(message)); },
      (cm: ConversationManager) => { const turn = cm.getTurns()[1]!; if (turn.kind === "user") turn.content = "NEW MUTATION"; }]) {
      const conversation = new ConversationManager({ maxMessages: Infinity });
      history().forEach(message => conversation.add(message));
      const result = await conversation.compress({ call: async () => { mutate(conversation); return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: summary() }; } }, limits);
      expect(result).toBeNull();
      expect(conversation.lastCompressionFailureReason).toContain("revision conflict");
      expect(conversation.getAllMessages().some(message => message.content.includes("Context compacted"))).toBe(false);
    }
  });

  it("retains the backing conversation on provider errors", async () => {
    const conversation = new ConversationManager({ maxMessages: Infinity });
    history().forEach(message => conversation.add(message));
    const original = conversation.getAllMessages();
    await expect(conversation.compress({ call: async () => { throw new Error("network unavailable"); } }, limits)).rejects.toThrow("network unavailable");
    expect(conversation.getAllMessages()).toEqual(original);
  });

  it("summarizes a large completed old tool group before a new user request", async () => {
    const messages: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "old task" },
      { role: "assistant", content: "", toolCalls: [{ id: "old", name: "read_file", arguments: { path: "old.txt" } }] },
      { role: "tool_result", toolCallId: "old", content: "old result ".repeat(10000), toolResultSuccess: true },
      { role: "assistant", content: "Old task finished" }, { role: "user", content: "A new small request" }];
    const result = await executeCompact(messages, provider(), { ...limits, protectedUserText: "A new small request" });
    expect(result.summary).not.toBe("");
    expect(result.messages.some(message => message.toolCallId === "old")).toBe(false);
    expect(result.messages.at(-1)?.content).toBe("A new small request");
  });

  it("commits the same active-model image counter used for candidate admission", async () => {
    class ImageCounter extends TokenCounter {
      countMessage(message: Message) { return super.countMessage({ ...message, contentBlocks: undefined })
        + (message.contentBlocks?.some(block => block.type === "image") ? 123 : 0); }
    }
    const conversation = new ConversationManager({ maxMessages: Infinity });
    history().forEach(message => conversation.add(message));
    conversation.add({ role: "user", content: "current image", contentBlocks: [{ type: "image", filePath: "image.png", source: "fixture", mediaType: "image/png", base64: "pixels" }] });
    const counter = new ImageCounter();
    expect(await conversation.compress(provider(), { ...limits, counter })).not.toBeNull();
    expect(conversation.estimatedTokens).toBe(counter.countMessages(conversation.getAllMessages()));
    expect(conversation.estimatedTokens).not.toBe(new TokenCounter().countMessages(conversation.getAllMessages()));
  });

  it("keeps runtime schema context rather than replacing it with a raw registry", async () => {
    const conversation = new ConversationManager({ maxMessages: Infinity });
    history().forEach(message => conversation.add(message));
    const tools = [{ name: "runtime_agent", description: "runtime schema ".repeat(3000), parameters: z.object({ task: z.string() }) }];
    conversation.setCompactionContext({ ...limits, tools });
    const result = await conversation.compress(provider(), { ...limits, tools: conversation.getCompactionContext().tools });
    expect(result?.outputTokens).toBe(compactRequestTokens(conversation.getAllMessages(), { tools }, new TokenCounter()));
    expect(result!.outputTokens!).toBeGreaterThan(conversation.estimatedTokens);
  });

  it("reports per-message preview loss even without global input truncation", async () => {
    const messages = history();
    messages[1]!.content += "x".repeat(1000);
    const result = await executeCompact(messages, provider(), { ...limits, contextWindow: 1048576 });
    // Force summarizes at least one old message with a >6000 character body.
    expect(result.sourceTruncated).toBe(true);
  });
});

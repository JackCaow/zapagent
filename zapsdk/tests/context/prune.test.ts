import { describe, expect, it } from "bun:test";
import { planPrune, PruneGate } from "../../context/prune.js";
import { compactBudget } from "../../context/compact-budget.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { Message } from "../../core/types.js";

import { pruneHistory } from "../fixtures/prune-history.js";
const limits = { contextWindow: 20000, reservedOutputTokens: 1000 };

describe("pressure-gated prune planning", () => {
  it("shrinks old bodies once while keeping tool pairing, arguments, status and error evidence", () => {
    const messages = pruneHistory(), before = structuredClone(messages);
    const result = planPrune(messages, limits);
    expect(result.status).toBe("pruned");
    expect(messages).toEqual(before);
    expect(result.messages).toHaveLength(messages.length);
    expect(result.outputTokens).toBeLessThan(compactBudget(limits)!.compactAt);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.firstChangedMessage).toBe(3);
    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.messages[3]?.toolResultSuccess).toBe(false);
    expect(result.messages[3]?.executionObservation).toEqual({ command: { exitCode: 2 } });
    expect(result.messages[3]?.content).toContain("ERROR_TAIL_0");
    expect(result.messages[3]?.content).toContain("exit");
    expect(result.messages.slice(-9)).toEqual(messages.slice(-9));
  });

  it("does not prune low-pressure history even when force/manual flags are supplied", () => {
    const messages = pruneHistory();
    const result = planPrune(messages, { contextWindow: 1048576, force: true });
    expect(result.status).toBe("not_needed");
    expect(result.messages).toBe(messages);
  });

  it("retains the current user and its entire latest active tool group", () => {
    const messages = pruneHistory();
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: "active-a", name: "bash", arguments: { command: "test" } }, { id: "active-b", name: "bash", arguments: { command: "build" } }] },
      { role: "tool_result", toolCallId: "active-a", content: "ACTIVE " + "x ".repeat(1000) },
      { role: "tool_result", toolCallId: "active-b", content: "ACTIVE " + "y ".repeat(1000) });
    const result = planPrune(messages, { ...limits, protectedUserText: messages[22]!.content });
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
  });

  it("round-trips durable markers through a new ConversationManager without second damage", () => {
    const first = planPrune(pruneHistory(), limits);
    const restored = new ConversationManager({ maxMessages: Infinity });
    for (const message of JSON.parse(JSON.stringify(first.messages))) restored.add(message);
    const second = planPrune(restored.getAllMessages(), { ...limits, triggerAtTokens: 1 });
    expect(second.status).toBe("no_change");
    expect(second.messages).toEqual(first.messages);
    expect(second.messagesPruned).toBe(0);
  });

  it("preserves complete persisted-output references instead of shortening their paths", () => {
    const messages = pruneHistory();
    const marker = `<persisted-output>\npath: /stored/${"deep/".repeat(80)}result.txt\nhint: use read_tool_output\n</persisted-output>`;
    messages[3]!.content += marker;
    expect(planPrune(messages, limits).messages[3]).toEqual(messages[3]);
  });

  it("handles historical CJK inline blocks and keeps multimodal text in sync", () => {
    const messages = pruneHistory();
    const content = 'user wording before <file_content path="a.ts">' + "历史来源文本".repeat(1200) + "</file_content> user wording after";
    messages.splice(2, 0, { role: "user", content, contentBlocks: [{ type: "text", text: content }] });
    for (let i = 0; i < 4; i++) messages.splice(3, 0, { role: "user", content: `<file_content path="recent">recent ${i}</file_content>` });
    const result = planPrune(messages, limits);
    const old = result.messages[2]!;
    expect(old.content).toContain('path="a.ts"');
    expect(old.content).toContain("user wording after");
    expect(old.content.length).toBeLessThan(content.length);
    expect(old.contentBlocks?.[0]).toEqual({ type: "text", text: old.content });
  });

  it("records omitted historical images without retaining pixels or asserting visual evidence", () => {
    const messages = pruneHistory();
    messages[3]!.contentBlocks = [{ type: "image", filePath: "/old.png", mediaType: "image/png", source: "https://fixture/image?api_key=private-value", base64: "PIXELS" }];
    const result = planPrune(messages, { ...limits, triggerAtTokens: 1 });
    expect(result.messages[3]?.contentBlocks).toBeUndefined();
    expect(result.messages[3]?.content).toContain("/old.png");
    expect(result.messages[3]?.content).toContain("not visual evidence");
    expect(result.messages[3]?.content).not.toContain("private-value");
    expect(result.messages[3]?.content).not.toContain("PIXELS");
  });

  it("retains independent mixed tool text when old pixels are omitted", () => {
    const messages = pruneHistory();
    messages[3]!.contentBlocks = [
      { type: "text", text: "INDEPENDENT_TOOL_TEXT: validation failed in auth.ts" },
      { type: "image", filePath: "/old.png", source: "fixture", mediaType: "image/png", base64: "PIXELS" },
    ];
    const result = planPrune(messages, { ...limits, triggerAtTokens: 1 });
    expect(result.status).toBe("pruned");
    expect(result.messages[3]?.content).toContain("INDEPENDENT_TOOL_TEXT: validation failed in auth.ts");
    expect(result.messages[3]?.content).toContain("/old.png");
    expect(result.messages[3]?.contentBlocks).toBeUndefined();
  });

  it("keeps short mixed-result previews idempotent across serialization and a second prune", () => {
    const messages = pruneHistory();
    messages[3]!.content = "image observation";
    messages[3]!.contentBlocks = [
      { type: "text", text: "INDEPENDENT_IMPORTANT_DETAIL ".repeat(80) },
      { type: "image", filePath: "/old.png", source: "fixture", mediaType: "image/png", base64: "PIXELS" },
    ];
    const first = planPrune(messages, { ...limits, triggerAtTokens: 1 });
    const second = planPrune(JSON.parse(JSON.stringify(first.messages)), { ...limits, triggerAtTokens: 1 });
    expect(first.messages[3]?.contentBlocks).toBeUndefined();
    expect(first.messages[3]?.content).toContain("INDEPENDENT_IMPORTANT_DETAIL");
    expect(second.messages[3]).toEqual(first.messages[3]);
    expect(second.status).toBe("no_change");
  });

  for (const length of [150, 274, 400, 500]) it(`preserves the complete ${length}-character failure instead of losing its root-cause tail`, () => {
    const messages = pruneHistory();
    const tail = " ERROR_TAIL_ROOT_CAUSE";
    messages[5]!.content = "x".repeat(length - tail.length) + tail;
    messages[5]!.toolResultSuccess = false;
    const result = planPrune(messages, { ...limits, triggerAtTokens: 1 });
    expect(result.messages[5]).toEqual(messages[5]);
  });

  it("counts schemas/transient once and rejects malformed tool groups or cancellation", () => {
    const messages = pruneHistory(), signal = AbortSignal.abort();
    expect(() => planPrune(messages, { ...limits, signal })).toThrow();
    expect(() => planPrune(messages.filter((_, index) => index !== 3), { ...limits, triggerAtTokens: 1 })).toThrow("Incomplete");
    const extra = { transientMessages: [{ role: "user" as const, content: "Host context" }] };
    const first = planPrune(messages, limits), second = planPrune(messages, { ...limits, ...extra });
    expect(second.inputTokens - first.inputTokens).toBe(second.outputTokens - first.outputTokens);
  });

  it("uses pressure hysteresis, allowing genuine hard overflow while suppressing repeated rewrites", () => {
    const gate = new PruneGate();
    expect(gate.canAttempt("a", 15000, 14000)).toBe(true);
    gate.record("b", 12000, 14000);
    expect(gate.canAttempt("b", 12000, 14000)).toBe(false);
    expect(gate.canAttempt("c", 12100, 14000)).toBe(false);
    expect(gate.canAttempt("c", 13400, 14000)).toBe(true);
    expect(gate.canAttempt("c", 12100, 14000, 12000)).toBe(true);
    gate.clear(); expect(gate.canAttempt("b", 12000, 14000)).toBe(true);
  });
});

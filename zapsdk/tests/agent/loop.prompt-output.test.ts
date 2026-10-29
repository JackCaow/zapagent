import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import type { AgentEvent } from "../../agent/events.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";

const done: LLMChunk = { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
const privateText = "PRIVATE_FIXTURE=" + Array.from({ length: 320 }, (_, i) => String.fromCharCode(33 + i % 90)).join("");

function fixture(provider: LLMProvider, systemPrompt: string, registry = new ToolRegistry(), fallbackProvider?: LLMProvider) {
  const events: AgentEvent[] = [];
  const conversation = new ConversationManager({ maxMessages: 100 });
  const agent = new LoopAgent({ provider, fallbackProvider, systemPrompt, registry,
    executor: new ToolExecutor(registry, { onApproval: async () => true }), conversation, maxSteps: 4 });
  agent.on("*", event => events.push(event));
  return { agent, events, conversation };
}

function publicOutput(events: AgentEvent[]): string {
  return events.flatMap(event => (event.type === "content_delta" || event.type === "content_final")
    && (event.kind === "text" || event.kind === "thinking") ? [event.text] : []).join("");
}

describe("prompt confidentiality at the public event boundary", () => {
  for (const kind of ["text_delta", "thinking_delta"] as const) {
    for (const marker of ["# Persistent Memory", "<system-reminder>", "<active_plan>"]) {
      it(`blocks a split ${marker} in ${kind} before emitting it`, async () => {
        const secret = `${marker}\nPRIVATE_MARKER_FIXTURE`;
        const { agent, events } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
          for (const char of secret) yield { type: kind, text: char };
          if (kind === "thinking_delta") yield { type: "text_delta", text: "Capabilities described." };
          yield done;
        } }, secret);
        await agent.run("Describe capabilities.");
        expect(publicOutput(events)).not.toContain(marker);
        expect(publicOutput(events)).not.toContain("PRIVATE_MARKER_FIXTURE");
        expect(events.some(e => e.type === "observation" && e.kind === "prompt_leak_blocked")).toBe(true);
      });
    }
  }

  it("withholds an unaligned verbatim match across chunks after an already-streamed safe prefix", async () => {
    const prefix = "A safe public progress update. ".repeat(20) + "offset!";
    const { agent, events, conversation } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
      yield { type: "text_delta", text: prefix };
      for (let i = 0; i < privateText.length; i += 7) yield { type: "text_delta", text: privateText.slice(i, i + 7) };
      yield done;
    } }, privateText);
    const result = await agent.run("Report progress.");
    expect(result.text).toContain("I can't share my system instructions");
    expect(publicOutput(events)).not.toContain("PRIVATE_FIXTURE");
    expect(conversation.getAllMessages().filter(m => m.role === "assistant").map(m => m.content).join("")).not.toContain(privateText);
  });

  it("continues streaming safe output before completion and flushes its tail exactly once", async () => {
    const normal = "Normal public output. ".repeat(40) + "😀 tail";
    const { agent, events } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
      yield { type: "text_delta", text: normal.slice(0, 500) };
      expect(events.some(e => e.type === "content_delta" && e.kind === "text")).toBe(true);
      yield { type: "text_delta", text: normal.slice(500) };
      yield done;
    } }, "Keep private instructions private.");
    expect((await agent.run("Report progress.")).text).toBe(normal);
    const deltas = events.flatMap(e => e.type === "content_delta" && e.kind === "text" ? [e.text] : []);
    expect(deltas.join("")).toBe(normal);
    expect(deltas.every(delta => !/[\uD800-\uDBFF]$/.test(delta))).toBe(true);
  });

  it("guards a preamble before tool execution without losing or replaying the tool", async () => {
    let requests = 0, executions = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "inspect", description: "fixture inspection", parameters: z.object({}) },
      handler: async () => { executions++; return { success: true, output: "Observed fixture." }; } });
    const { agent, events } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
      if (++requests === 1) {
        yield { type: "text_delta", text: privateText };
        yield { type: "tool_call_start", toolCallId: "inspect-1", toolName: "inspect" };
        yield { type: "tool_call_delta", toolCallId: "inspect-1", partialJson: "{}" };
      } else yield { type: "text_delta", text: "Inspection complete." };
      yield done;
    } }, privateText, registry);
    const result = await agent.run("Inspect the fixture.");
    expect(executions).toBe(1);
    expect(result.toolResults).toHaveLength(1);
    expect(publicOutput(events)).not.toContain("PRIVATE_FIXTURE");
    const preamble = events.findIndex(e => e.type === "content_final" && e.kind === "text");
    const call = events.findIndex(e => e.type === "content_final" && e.kind === "tool_call");
    expect(preamble).toBeGreaterThanOrEqual(0);
    expect(preamble).toBeLessThan(call);
  });

  it("does not publish private partial text when cancellation interrupts the stream", async () => {
    const controller = new AbortController();
    const { agent, events, conversation } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
      yield { type: "text_delta", text: privateText };
      controller.abort();
      yield done;
    } }, privateText);
    await expect(agent.run("Inspect.", { signal: controller.signal })).rejects.toThrow("aborted");
    expect(publicOutput(events)).not.toContain("PRIVATE_FIXTURE");
    expect(conversation.getAllMessages().filter(m => m.role === "assistant").some(m => m.content.includes("PRIVATE_FIXTURE"))).toBe(false);
  });

  it("guards interrupted output before continuing the original tool lifecycle", async () => {
    let requests = 0;
    const { agent, events } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
      if (++requests === 1) {
        yield { type: "text_delta", text: privateText };
        throw new Error("fixture connection interrupted");
      }
      yield { type: "text_delta", text: "Recovered safely." };
      yield done;
    } }, privateText);
    expect((await agent.run("Report progress.")).text).toBe("Recovered safely.");
    expect(publicOutput(events)).not.toContain("PRIVATE_FIXTURE");
  });

  it("keeps the non-streaming provider path guarded", async () => {
    const { agent, events } = fixture({ async call() {
      return { type: "text", text: privateText, usage: { inputTokens: 1, outputTokens: 1 } };
    } }, privateText);
    expect((await agent.run("Describe capabilities.")).text).toContain("I can't share my system instructions");
    expect(publicOutput(events)).not.toContain("PRIVATE_FIXTURE");
  });

  it("guards the SDK protocol that was folded into the actual system prompt", async () => {
    const { agent, events } = fixture({ async call() { throw new Error("stream expected"); }, async *stream() {
      yield { type: "text_delta", text: "[AGENT PROTOCOL]\nTools: fixture" };
      yield done;
    } }, "Host instructions.");
    expect((await agent.run("Describe capabilities.")).text).toContain("I can't share my system instructions");
    expect(publicOutput(events)).not.toContain("[AGENT PROTOCOL]");
  });
});

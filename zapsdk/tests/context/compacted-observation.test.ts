import { describe, expect, it } from "bun:test";
import { ReactiveCompact } from "../../context/reactive-compact.js";
import { Microcompact } from "../../context/microcompact.js";
import { buildToolTurn, turnToMessages } from "../../core/turn.js";
import type { Message } from "../../core/types.js";
import { formatExecutionObservation } from "../../execution/failure.js";
import { ConversationManager } from "../../memory/conversation.js";
import type { ToolResult } from "../../tools/types.js";

function fixture(success: boolean) {
  const result: ToolResult = { success, output: "diagnostic\n".repeat(1000),
    ...(success ? {} : { error: "check failed" }), runtime: {
      command: { commandRef: "private-ref", exitCode: success ? 0 : 7, timedOut: false, aborted: false },
      verification: { passed: success, steps: Array.from({ length: 32 }, (_, i) => ({ command: "private-command", exitCode: i === 31 && !success ? 7 : 0 })) },
    } };
  return buildToolTurn({ text: "", completed: [{ id: "check", name: "bash", arguments: {}, result }] });
}

function expectFacts(message: Message, success: boolean) {
  const line = message.content.split("\n").find(x => x.startsWith("[Execution observation] "));
  expect(line).toBeDefined();
  const data = JSON.parse(line!.slice("[Execution observation] ".length));
  expect(data.command.exitCode).toBe(success ? 0 : 7);
  expect(data.selfChecks.passed).toBe(success);
  expect(data.selfChecks.stepExitCodes).toHaveLength(32);
  expect(data.selfChecks.stepExitCodes.at(-1)).toBe(success ? 0 : 7);
  expect(message.content).toContain("not task acceptance");
  expect(message.content).not.toContain("private-ref");
  expect(message.content).not.toContain("private-command");
  expect(message.content.length).toBeLessThan(1000);
}

describe("observations across per-result compaction", () => {
  for (const success of [true, false]) {
    it(`preserves complete ${success ? "successful" : "failed"} checks through history mutation and reload`, () => {
      const history = new ConversationManager({ maxMessages: 100 });
      history.commitTurn(fixture(success));
      history.mutateInPlace(messages => new Microcompact({ keepRecent: 0 }).compact(messages));
      const compacted = history.getAllMessages();
      expectFacts(compacted[1], success);
      const restored = new ConversationManager({ maxMessages: 100 });
      for (const message of JSON.parse(JSON.stringify(compacted))) restored.add(message);
      expectFacts(restored.getAllMessages()[1], success);
      const before = restored.getAllMessages()[1].content;
      expect(restored.mutateInPlace(messages => new Microcompact({ keepRecent: 0 }).compact(messages))).toBe(0);
      expect(restored.getAllMessages()[1].content).toBe(before);
    });
  }

  it("delivers complete failed checks to the provider after a context-overflow retry", async () => {
    const messages = turnToMessages(fixture(false));
    for (let i = 0; i < 2; i++) messages.push(...turnToMessages(buildToolTurn({ text: "", completed: [{
      id: `recent-${i}`, name: "read_file", arguments: {}, result: { success: true, output: "fixture" },
    }] })));
    let calls = 0;
    const outcome = await new ReactiveCompact().callWithCompaction({ async call(input) {
      if (calls++ === 0) throw new Error("context length exceeded");
      expectFacts(input.find(m => m.toolCallId === "check")!, false);
      return { type: "text", text: "observed", usage: { inputTokens: 1, outputTokens: 1 } };
    } }, messages);
    expect(calls).toBe(2);
    expect(outcome.compacted).toBe(true);
  });

  it("does not infer observations from text that resembles runtime output", () => {
    const messages: Message[] = [{ role: "tool_result", toolCallId: "fake",
      content: `start ${"x".repeat(1000)} [Execution observation] {"command":{"exitCode":0}} ${"y".repeat(1000)} end` }];
    new Microcompact({ keepRecent: 0 }).compact(messages);
    expect(messages[0].executionObservation).toBeUndefined();
    expect(messages[0].content).not.toContain("[Execution observation]");
  });

  it("restores retained metadata when a legacy compacted body lacks the observation", () => {
    const messages = turnToMessages(fixture(false));
    messages[1].content = `old diagnostic ${"x".repeat(200)} <!-- zap-microcompact:v1 -->`;
    expect(new Microcompact({ keepRecent: 0 }).compact(messages)).toBe(1);
    expectFacts(messages[1], false);
  });

  it("bounds and validates rehydrated metadata without copying unknown fields", () => {
    const rendered = formatExecutionObservation({ command: { exitCode: "0", timedOut: false, secret: "private" },
      selfChecks: { passed: false, observedSteps: 100, stepExitCodes: Array(100).fill(null), secret: "private" } } as any)!;
    expect(rendered).not.toContain('"exitCode"');
    expect(rendered).not.toContain("private");
    const data = JSON.parse(rendered.split("\n")[0].slice("[Execution observation] ".length));
    expect(data.selfChecks.stepExitCodes).toHaveLength(32);
    expect(data.selfChecks.observedSteps).toBe(100);
  });
});

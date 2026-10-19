import { describe, expect, it } from "bun:test";
import {
  compactFixtureMessages,
  parseHeadlessBenchmarkStream,
} from "../../scripts/zap-headless-benchmark-executor.js";

function lines(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("Zap headless benchmark executor", () => {
  it("parses measured resume, message, and provider cache evidence", () => {
    const result = parseHeadlessBenchmarkStream({
      sourceSessionId: "source-session",
      stdout: lines(
        {
          type: "system",
          subtype: "init",
          sessionId: "fork-session",
          resumedFrom: "source-session",
        },
        { type: "context", step: 1, messageCount: 101, context: {} },
        { type: "tool_use", id: "1", name: "read_file" },
        { type: "context", step: 2, messageCount: 103, context: {} },
        {
          type: "result",
          ok: true,
          turns: 2,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            providerUsageReported: true,
            cacheReadInputTokens: 190,
            cacheMissInputTokens: 10,
          },
          toolCalls: [{ name: "read_file" }],
          stopReason: "end_turn",
          error: null,
        },
      ),
    });

    expect(result).toEqual({
      steps: 2,
      toolCalls: 1,
      sessionMessages: 103,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 190,
      cacheMissTokens: 10,
      sessionResumed: true,
      compactOccurred: false,
    });
  });

  it("does not turn omitted provider cache accounting into zero", () => {
    const result = parseHeadlessBenchmarkStream({
      stdout: lines(
        { type: "system", subtype: "init", sessionId: "fresh", resumedFrom: null },
        { type: "context", step: 1, messageCount: 1, context: {} },
        {
          type: "result",
          ok: true,
          turns: 1,
          usage: { inputTokens: 0, outputTokens: 0, providerUsageReported: false },
          toolCalls: [],
          stopReason: "end_turn",
          error: null,
        },
      ),
    });

    expect(result.sessionMessages).toBe(1);
    expect(result.compactOccurred).toBe(false);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  it("uses the production compactor for post-compact fixtures", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `history-${index}`,
    }));

    const compacted = await compactFixtureMessages(messages);

    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0]?.role).toBe("user");
    expect(compacted[0]?.content).toContain("[Context compacted");
    expect(compacted[0]?.content).toContain("# Next steps");
  });

  it("rejects a false resume signal and failed headless runs", () => {
    const stdout = lines(
      { type: "system", subtype: "init", sessionId: "fork", resumedFrom: "other" },
      {
        type: "result",
        ok: false,
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0, providerUsageReported: false },
        toolCalls: [],
        stopReason: "error",
        error: "provider unavailable",
      },
    );

    expect(() => parseHeadlessBenchmarkStream({ stdout, sourceSessionId: "wanted" }))
      .toThrow("provider unavailable");
  });
});

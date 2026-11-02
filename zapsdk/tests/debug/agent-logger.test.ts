import { describe, expect, it } from "bun:test";
import { AgentLogger, formatUsageLogFields } from "../../debug/agent-logger.js";
import { AgentEventEmitter } from "../../agent/events.js";
import { Logger } from "../../debug/logger.js";

describe("formatUsageLogFields", () => {
  it("does not invent cache fields when the provider omitted cache accounting", () => {
    const fields = formatUsageLogFields({
      inputTokens: 123,
    });

    expect(fields).toEqual({
      inputTokens: 123,
      totalPromptInputTokens: 123,
    });
    expect("cacheReadInputTokens" in fields).toBe(false);
    expect("cacheCreationInputTokens" in fields).toBe(false);
    expect("cacheHitRatio" in fields).toBe(false);
    expect("cacheReuseRatio" in fields).toBe(false);
    expect("cacheWriteRatio" in fields).toBe(false);
  });

  it("keeps explicit zero cache accounting when the provider reported it", () => {
    const fields = formatUsageLogFields({
      inputTokens: 123,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    expect(fields).toEqual({
      inputTokens: 123,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalPromptInputTokens: 123,
      cacheHitRatio: 0,
      cacheReuseRatio: 0,
      cacheWriteRatio: 0,
    });
  });

  it("logs whether token usage itself was provider-reported", () => {
    const fields = formatUsageLogFields({
      inputTokens: 0,
      providerUsageReported: false,
    });

    expect(fields).toEqual({
      inputTokens: 0,
      providerUsageReported: false,
      totalPromptInputTokens: 0,
    });
  });
});

describe("usage completeness export", () => {
  for (const usageIncomplete of [true, false, undefined]) {
    it(`preserves ${String(usageIncomplete)} completeness on usage and terminal logs`, () => {
      const entries: Record<string, unknown>[] = [];
      // Exercise the event bridge without touching a user's log directory.
      const sink = Object.create(Logger.prototype) as Logger;
      sink.info = (event, fields) => { entries.push({ event, ...fields }); };
      const emitter = new AgentEventEmitter();
      new AgentLogger(sink).attach(emitter);
      const usage = { inputTokens: 10, outputTokens: 3, providerUsageReported: true,
        ...(usageIncomplete === undefined ? {} : { usageIncomplete }) };
      emitter.emit({ type: "run_usage", step: 0, ...usage });
      emitter.emit({ type: "run_ended", steps: 1, usage });
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry).toMatchObject({ inputTokens: 10, outputTokens: 3, providerUsageReported: true });
        expect(entry.usageIncomplete).toBe(usageIncomplete);
        expect(Object.hasOwn(entry, "usageIncomplete")).toBe(usageIncomplete !== undefined);
      }
    });
  }
});

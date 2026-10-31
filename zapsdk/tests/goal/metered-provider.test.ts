import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalBudgetLedger } from "../../goal/budget.js";
import { meterGoalProvider } from "../../goal/metered-provider.js";
import { RetryProvider } from "../../core/retry.js";
import type { LLMProvider } from "../../core/llm.js";

describe("Goal provider transport accounting", () => {
  test("retry attempts share a logical call but are individually accounted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-goal-meter-"));
    const ledger = new GoalBudgetLedger(join(dir, "ledger.sqlite"));
    try {
      ledger.create("g", 1, { maxModelCalls: 1, maxProviderAttempts: 2, strict: false });
      let calls = 0;
      const inner: LLMProvider = { async call() {
        if (++calls === 1) throw new Error("connection failed");
        return { type: "text", text: "ok", usage: { inputTokens: 11, cacheReadInputTokens: 5, cacheCreationInputTokens: 3, outputTokens: 2, providerUsageReported: true } };
      } };
      const normal = new RetryProvider(inner, { maxRetries: 1, initialDelayMs: 1 });
      const provider = normal.withInnerAdapter(raw => meterGoalProvider(raw, ledger, { goalId: "g", epoch: 1, role: "worker" }));
      expect((await provider.call([{ role: "user", content: "hello" }])).text).toBe("ok");
      const snap = ledger.snapshot("g");
      expect(snap.totals).toMatchObject({ modelCalls: 1, providerAttempts: 2, tokensUsed: 21, unknownUsage: 1 });
      expect(new Set(snap.reservations.map(r => r.logicalCallId)).size).toBe(1);
      await normal.call([{ role: "user", content: "ordinary turn" }]);
      expect(ledger.snapshot("g").totals.providerAttempts).toBe(2);
    } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("stream cancellation leaves the dispatched request uncertain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-goal-meter-"));
    const ledger = new GoalBudgetLedger(join(dir, "ledger.sqlite"));
    try {
      ledger.create("g", 1, { maxTokens: 10000 });
      const inner: LLMProvider = { async call() { throw new Error("unused"); }, async *stream() { yield { type: "text_delta", text: "partial" }; } };
      const provider = meterGoalProvider(inner, ledger, { goalId: "g", epoch: 1, role: "verifier" });
      for await (const _chunk of provider.stream!([{ role: "user", content: "hello" }])) break;
      expect(ledger.snapshot("g").totals.unknownUsage).toBe(1);
      await expect(provider.call([{ role: "user", content: "another" }])).rejects.toThrow("usage_unknown");
    } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

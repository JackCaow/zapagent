import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GoalBudgetLedger, type GoalBudgetUsage } from "../../goal/budget.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zap-goal-budget-"));
  dirs.push(dir);
  return join(dir, "budget.sqlite");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const usage: GoalBudgetUsage = {
  freshInputTokens: 8, cacheReadTokens: 5, cacheCreationTokens: 2, outputTokens: 4, costMicro: 2,
};
const request = (operationId: string, overrides: Partial<Parameters<GoalBudgetLedger["reserve"]>[2]> = {}) => ({
  operationId, logicalCallId: operationId, role: "worker" as const, estimatedTokens: 20, estimatedCostMicro: 3, ...overrides,
});

describe("GoalBudgetLedger", () => {
  it("survives reopen, counts fresh and cached tokens once, and rejects a duplicate or conflicting settlement", () => {
    const file = fixture();
    let ledger = new GoalBudgetLedger(file);
    ledger.create("g", 1, { maxTokens: 50, maxModelCalls: 3 });
    expect(ledger.reserve("g", 1, request("a", { scope: { providerId: "p", modelId: "m" } }))).toEqual({ ok: true, operationId: "a" });
    expect(ledger.dispatch("g", 1, "a").ok).toBe(true);
    expect(ledger.dispatch("g", 1, "a")).toEqual({ ok: false, reason: "operation_exists" });
    ledger.settle("g", "a", usage);
    ledger.settle("g", "a", usage);
    expect(() => ledger.settle("g", "a", { ...usage, outputTokens: 5 })).toThrow("Conflicting");
    ledger.close();
    ledger = new GoalBudgetLedger(file);
    const snapshot = ledger.snapshot("g");
    expect(snapshot.totals).toMatchObject({ tokensUsed: 19, tokensReserved: 0, modelCalls: 1, providerAttempts: 1, costMicroUsed: 2 });
    expect(snapshot.reservations[0]?.scope).toEqual({ providerId: "p", modelId: "m" });
    expect(ledger.reserve("g", 1, request("b", { estimatedTokens: 32 }))).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(() => ledger.create("g", 1, { maxTokens: 999 })).toThrow();
    ledger.close();
  });

  it("preserves dispatched unknown on recovery and accepts a late trustworthy receipt", () => {
    const file = fixture();
    const ledger = new GoalBudgetLedger(file);
    ledger.create("g", 1, { maxTokens: 100, maxCostMicro: 100 });
    ledger.reserve("g", 1, request("a"));
    ledger.dispatch("g", 1, "a");
    expect(ledger.advanceEpoch("g", 1, 2)).toBe(true);
    expect(ledger.recoverDispatched("g", 2)).toBe(1);
    expect(ledger.snapshot("g").totals).toMatchObject({ unknownUsage: 1, tokensReserved: 20 });
    expect(ledger.reserve("g", 2, request("b"))).toEqual({ ok: false, reason: "usage_unknown" });
    expect(ledger.releaseUnsent("g", 2, "a")).toBe(false);
    expect(ledger.dispatch("g", 1, "a")).toEqual({ ok: false, reason: "stale_epoch" });
    ledger.settle("g", "a", usage);
    expect(ledger.snapshot("g").totals).toMatchObject({ unknownUsage: 0, tokensUsed: 19, tokensReserved: 0 });
    expect(ledger.reserve("g", 2, request("b")).ok).toBe(true);
    ledger.close();
  });

  it("retains partial usage conservatively until a complete compatible settlement arrives", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("g", 1, { maxTokens: 100 });
    ledger.reserve("g", 1, request("a"));
    ledger.dispatch("g", 1, "a");
    ledger.settle("g", "a", { ...usage, freshInputTokens: 2, costMicro: null, usageIncomplete: true });
    expect(ledger.snapshot("g").totals).toMatchObject({ tokensUsed: 13, tokensReserved: 7, unknownUsage: 1, unknownPrice: 1 });
    expect(ledger.reserve("g", 1, request("b"))).toEqual({ ok: false, reason: "usage_unknown" });
    expect(() => ledger.settle("g", "a", { ...usage, freshInputTokens: 1 })).toThrow("Conflicting");
    ledger.settle("g", "a", usage);
    expect(ledger.snapshot("g").totals).toMatchObject({ tokensUsed: 19, tokensReserved: 0, unknownUsage: 0, unknownPrice: 0 });
    ledger.close();
  });

  it("keeps price and usage unknown separately and rejects unknown price under a cost limit", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("g", 1, { maxTokens: 100, maxCostMicro: 100 });
    expect(ledger.reserve("g", 1, request("a", { estimatedCostMicro: null }))).toEqual({ ok: false, reason: "price_unknown" });
    ledger.reserve("g", 1, request("a"));
    ledger.dispatch("g", 1, "a");
    ledger.settle("g", "a", { ...usage, costMicro: null });
    expect(ledger.snapshot("g").totals).toMatchObject({ unknownUsage: 0, unknownPrice: 1 });
    expect(ledger.reserve("g", 1, request("b"))).toEqual({ ok: false, reason: "price_unknown" });
    ledger.settle("g", "a", usage);
    expect(ledger.reserve("g", 1, request("b")).ok).toBe(true);
    ledger.close();
  });

  it("charges retries separately but counts the logical call once; role and verifier reserves apply", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("g", 1, { maxTokens: 100, reservedTokens: 25, maxModelCalls: 1, maxProviderAttempts: 2, roles: { worker: { maxProviderAttempts: 2 } } });
    ledger.reserve("g", 1, request("a", { estimatedTokens: 30, logicalCallId: "L" }));
    ledger.dispatch("g", 1, "a");
    ledger.settle("g", "a", usage);
    expect(ledger.reserve("g", 1, request("b", { estimatedTokens: 30, logicalCallId: "L" })).ok).toBe(true);
    expect(ledger.snapshot("g").totals).toMatchObject({ modelCalls: 1, providerAttempts: 2, tokensUsed: 19, tokensReserved: 30 });
    expect(ledger.reserve("g", 1, request("c"))).toEqual({ ok: false, reason: "budget_exhausted" });
    ledger.close();
  });

  it("protects reserved tokens for verification and applies independent tool/spawn caps", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("g", 1, { maxTokens: 100, reservedTokens: 30, maxToolCalls: 1, maxSpawns: 1, roles: { verifier: { maxTokens: 30 } } });
    expect(ledger.reserve("g", 1, request("w", { estimatedTokens: 71 })).ok).toBe(false);
    expect(ledger.reserve("g", 1, request("v", { role: "verifier", estimatedTokens: 30 })).ok).toBe(true);
    expect(ledger.admit("g", 1, { operationId: "tool1", role: "worker", kind: "tool" }).ok).toBe(true);
    expect(ledger.admit("g", 1, { operationId: "tool1", role: "worker", kind: "tool" })).toEqual({ ok: false, reason: "operation_exists" });
    expect(ledger.admit("g", 1, { operationId: "tool2", role: "worker", kind: "tool" })).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(ledger.admit("g", 1, { operationId: "spawn1", role: "worker", kind: "spawn" }).ok).toBe(true);
    expect(ledger.admit("g", 1, { operationId: "spawn2", role: "worker", kind: "spawn" })).toEqual({ ok: false, reason: "budget_exhausted" });
    ledger.close();
  });

  it("blocks opaque tools under strict model limits and records uncertainty in observation mode", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("strict", 1, { maxModelCalls: 5 });
    expect(ledger.admit("strict", 1, { operationId: "shell", role: "worker", kind: "tool", opaque: true })).toEqual({ ok: false, reason: "usage_unknown" });
    ledger.create("observe", 1, { maxModelCalls: 5, strict: false });
    expect(ledger.admit("observe", 1, { operationId: "shell", role: "worker", kind: "tool", opaque: true }).ok).toBe(true);
    expect(ledger.snapshot("observe").totals.opaqueToolCalls).toBe(1);
    expect(ledger.extend("observe", 1, { maxModelCalls: 5, strict: true })).toBe(true);
    expect(ledger.reserve("observe", 1, request("later"))).toEqual({ ok: false, reason: "usage_unknown" });
    ledger.close();
  });

  it("does not release dispatched calls and does not allow stale owners to extend or admit", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("g", 1, { maxTokens: 50, deadlineAt: Date.now() + 60_000 });
    ledger.reserve("g", 1, request("a"));
    ledger.reserve("g", 1, request("b"));
    ledger.dispatch("g", 1, "a");
    expect(ledger.releaseUnsent("g", 1, "a")).toBe(false);
    expect(ledger.advanceEpoch("g", 1, 2)).toBe(true);
    expect(ledger.releaseUnsent("g", 1, "b")).toBe(false);
    expect(ledger.releaseUnsent("g", 2, "b")).toBe(true);
    expect(ledger.extend("g", 1, { maxTokens: 100, deadlineAt: Date.now() + 120_000 })).toBe(false);
    expect(ledger.extend("g", 2, { maxTokens: 100, deadlineAt: Date.now() + 120_000 })).toBe(true);
    expect(() => ledger.extend("g", 2, { maxTokens: 60, deadlineAt: Date.now() + 120_000 })).toThrow("cannot restrict");
    ledger.close();
  });

  it("stops new admissions at the deadline but still accepts late usage", () => {
    const ledger = new GoalBudgetLedger(fixture());
    ledger.create("g", 1, { maxTokens: 100, deadlineAt: Date.now() + 200 });
    ledger.reserve("g", 1, request("a"));
    ledger.dispatch("g", 1, "a");
    const end = Date.now() + 220;
    while (Date.now() < end) { /* exercise absolute deadline */ }
    expect(ledger.reserve("g", 1, request("b"))).toEqual({ ok: false, reason: "deadline" });
    ledger.settle("g", "a", usage);
    expect(ledger.snapshot("g").totals.tokensUsed).toBe(19);
    ledger.close();
  });

  it("serializes competing reservations across distinct processes", async () => {
    const file = fixture();
    const ledger = new GoalBudgetLedger(file);
    ledger.create("g", 1, { maxTokens: 10 });
    const worker = join(dirname(file), "worker.ts");
    const modulePath = fileURLToPath(new URL("../../goal/budget.ts", import.meta.url));
    writeFileSync(worker, `import { GoalBudgetLedger } from ${JSON.stringify(modulePath)};\n` +
      `const l=new GoalBudgetLedger(process.argv[2]);\n` +
      `const result=l.reserve('g',1,{operationId:process.argv[3],logicalCallId:process.argv[3],role:'worker',estimatedTokens:7});\n` +
      `console.log(JSON.stringify(result));l.close();\n`);
    const run = promisify(execFile);
    const output = await Promise.all(["a", "b"].map(id => run(process.execPath, [worker, file, id])));
    const results = output.map(result => JSON.parse(result.stdout) as { ok: boolean });
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(ledger.snapshot("g").totals.tokensReserved).toBe(7);
    ledger.close();
  });
});

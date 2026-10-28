import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../../goal/controller.js";
import { GoalStore } from "../../goal/store.js";
import type { GoalCandidate, GoalHost, GoalReceipt, GoalTask } from "../../goal/contracts.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zap-goal-control-")); dirs.push(dir);
  const store = new GoalStore(join(dir, "state.sqlite"));
  const goal = store.create({ objective: "Write a report", cwd: dir, deadlineAt: Date.now() + 60_000 });
  return { dir, store, goal };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
function candidate(id: string): GoalCandidate { return { candidateId: id, snapshotId: `snapshot-${id}`, specDigest: `spec-${id}`, value: {} }; }
function receipt(c: GoalCandidate, t: Readonly<GoalTask>, status: GoalReceipt["status"] = "passed"): GoalReceipt {
  return { status, candidateId: c.candidateId, snapshotId: c.snapshotId, specDigest: c.specDigest, taskId: t.id, attempt: t.attempt, evidence: { independent: true } };
}
function host(overrides: Partial<GoalHost> = {}): GoalHost {
  return {
    async plan() { return { tasks: [{ id: "one", description: "Collect sources", acceptance: "Sources are cited" }, { id: "two", description: "Write", acceptance: "Report covers sources", dependencies: ["one"] }] }; },
    async execute(_c, task) { return candidate(task.id); },
    async verify(_c, task, c) { return receipt(c, task); },
    async integrate(_c, task) { return { integrated: task.id }; },
    async snapshotIntegration() { return candidate("final"); },
    async deliver() { return { status: "delivered", value: { path: "report" } }; },
    async seal() {},
    ...overrides,
  };
}
describe("GoalController", () => {
  it("executes dependency order and independently verifies the integrated outcome before delivery", async () => {
    const { store, goal } = fixture(); const events: string[] = [];
    const h = host({
      async execute(_c, t) { events.push(`execute:${t.id}`); return candidate(t.id); },
      async verify(_c, t, c, final) { events.push(`verify:${final ? "final" : t.id}`); return receipt(c, t); },
      async integrate(_c, t) { events.push(`integrate:${t.id}`); return { integrated: t.id }; },
      async deliver() { events.push("deliver"); return { status: "delivered" }; },
    });
    const result = await new GoalController(store, h, goal.id).run();
    expect(result.status).toBe("completed");
    expect(events).toEqual(["execute:one", "verify:one", "integrate:one", "execute:two", "verify:two", "integrate:two", "verify:final", "deliver"]);
    expect(result.finalReceipt?.snapshotId).toBe("snapshot-final"); store.close();
  });
  it("never integrates or delivers when the verifier does not establish a result", async () => {
    const { store, goal } = fixture(); let effects = 0;
    const h = host({ async verify(_c, t, c) { return receipt(c, t, "unverified"); }, async integrate() { effects++; return {}; }, async deliver() { effects++; return { status: "delivered" }; } });
    const result = await new GoalController(store, h, goal.id).run();
    expect(result.status).toBe("awaiting_acceptance"); expect(effects).toBe(0); store.close();
  });
  it("does not accept a verifier receipt for a different snapshot", async () => {
    const { store, goal } = fixture(); let integrated = false;
    const h = host({ async verify(_c, t, c) { return { ...receipt(c, t), snapshotId: "different" }; }, async integrate() { integrated = true; return {}; } });
    const result = await new GoalController(store, h, goal.id).run();
    expect(result.status).toBe("blocked"); expect(result.stopReason).toContain("INVALID_GOAL_ACCEPTANCE_RECEIPT"); expect(integrated).toBe(false);
    expect(result.inFlight?.phase).toBe("verifying"); store.close();
  });
  it("records an operation before invocation and refuses to replay an unknown effect", async () => {
    const { dir, store, goal } = fixture();
    const h = host({ async execute() { throw new Error("connection lost after effect"); } });
    const blocked = await new GoalController(store, h, goal.id).run();
    expect(blocked.status).toBe("blocked"); expect(blocked.inFlight?.phase).toBe("executing"); store.close();
    const reopened = new GoalStore(join(dir, "state.sqlite"));
    expect(() => reopened.claim(goal.id, "new", 123)).toThrow("GOAL_RECOVERY_REQUIRED");
    expect(reopened.get(goal.id)?.tasks[0]?.attempt).toBe(1); reopened.close();
  });
  it("repairs a failed receipt with a new attempt and never passes merely from worker text", async () => {
    const { store, goal } = fixture(); let count = 0;
    const h = host({ async verify(_c, task, c, final) { if (final) return receipt(c, task); return receipt(c, task, count++ === 0 ? "failed" : "passed"); } });
    const result = await new GoalController(store, h, goal.id).run();
    expect(result.status).toBe("completed"); expect(result.tasks[0]?.attempt).toBe(2); store.close();
  });
  it("requires explicit recovery and fencing for an unresolved prior owner", () => {
    const { store, goal } = fixture();
    const a = store.claim(goal.id, "old", 1);
    expect(() => store.claim(goal.id, "new", 2)).toThrow("GOAL_OWNER_ACTIVE_OR_UNRESOLVED");
    expect(() => store.recoverOwner(goal.id, "old", false)).toThrow("GOAL_OWNER_STOP_UNCONFIRMED");
    store.recoverOwner(goal.id, "old", true);
    const b = store.claim(goal.id, "new", 2);
    expect(b.ownerEpoch).toBe(a.ownerEpoch + 1);
    expect(() => store.update(goal.id, a.ownerEpoch, "old", () => {})).toThrow("GOAL_STALE_OWNER"); store.close();
  });
  it("resumes a candidate already accepted without rerunning the worker or verifier", async () => {
    const { store, goal } = fixture(); const claimed = store.claim(goal.id, "old", 1);
    const c = candidate("one");
    const task: GoalTask = { id: "one", description: "x", acceptance: "y", dependencies: [], revision: 1, status: "verifying", attempt: 1, candidate: c };
    task.receipt = receipt(c, task);
    store.update(goal.id, claimed.ownerEpoch, "old", state => { state.planRevision = 1; state.tasks = [task]; });
    store.release(goal.id, claimed.ownerEpoch, "old", "paused");
    let executions = 0; let taskChecks = 0; let integrations = 0;
    const h = host({ async execute() { executions++; return c; }, async verify(_ctx, t, value, final) { if (!final) taskChecks++; return receipt(value, t); }, async integrate() { integrations++; return {}; } });
    const result = await new GoalController(store, h, goal.id).run();
    expect(result.status).toBe("completed"); expect(executions).toBe(0); expect(taskChecks).toBe(0); expect(integrations).toBe(1); store.close();
  });
  it("resumes a frozen unverified candidate at verification instead of executing again", async () => {
    const { store, goal } = fixture(); const claimed = store.claim(goal.id, "old", 1); const c = candidate("one");
    store.update(goal.id, claimed.ownerEpoch, "old", state => { state.planRevision = 1; state.tasks = [{ id: "one", description: "x", acceptance: "y", dependencies: [], revision: 1, status: "verifying", attempt: 1, candidate: c }]; });
    store.release(goal.id, claimed.ownerEpoch, "old", "paused");
    let executions = 0;
    const result = await new GoalController(store, host({ async execute() { executions++; return c; } }), goal.id).run();
    expect(result.status).toBe("completed"); expect(executions).toBe(0); store.close();
  });
  it("rejects a cyclic or missing dependency without invoking workers", async () => {
    const { store, goal } = fixture(); let invoked = false;
    const h = host({ async plan() { return { tasks: [{ id: "a", description: "a", acceptance: "a", dependencies: ["b"] }, { id: "b", description: "b", acceptance: "b", dependencies: ["a"] }] }; }, async execute() { invoked = true; return candidate("x"); } });
    const result = await new GoalController(store, h, goal.id).run();
    expect(result.status).toBe("blocked"); expect(result.stopReason).toContain("CYCLIC_GOAL_PLAN"); expect(invoked).toBe(false); store.close();
  });
});

describe("Goal budget extension", () => {
  it("updates ledger and deadline atomically across reopening and preserves prior usage", async () => {
    const { GoalBudgetLedger } = await import("../../goal/budget.js");
    const { dir, store, goal } = fixture(); const db = join(dir, "state.sqlite");
    const ledger = new GoalBudgetLedger(db);
    ledger.create(goal.id, 0, { maxTokens: 100, maxModelCalls: 3, maxProviderAttempts: 5, maxToolCalls: 10, deadlineAt: goal.deadlineAt });
    const state = store.extendBudget(goal.id, { tokens: 50, modelCalls: 2, providerAttempts: 3, minutes: 5 });
    ledger.close(); store.close();
    const reopened = new GoalBudgetLedger(db); const snap = reopened.snapshot(goal.id);
    expect(snap.limits.maxTokens).toBe(150); expect(snap.limits.maxModelCalls).toBe(5); expect(snap.limits.maxProviderAttempts).toBe(8);
    expect(snap.limits.deadlineAt).toBe(goal.deadlineAt + 300_000); expect(state.deadlineAt).toBe(snap.limits.deadlineAt);
    reopened.close();
  });
});

describe("Goal recovery", () => {
  it("reconciles a paused, stopped operation before rerunning it", async () => {
    const { store, goal } = fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const h = host({
      recoveryMarker: () => 0,
      async execute(ctx, task) {
        if (task.id !== "one" || task.attempt > 1) return candidate(task.id);
        entered();
        await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("cancelled");
      },
      async reconcile() { return { kind: "retry" as const }; },
    });
    const running = new GoalController(store, h, goal.id).run();
    await started; store.requestControl(goal.id, "pause");
    const paused = await running;
    expect(paused.status).toBe("paused"); expect(paused.inFlight?.phase).toBe("executing");
    const recovered = await new GoalController(store, h, goal.id).recover();
    expect(recovered.inFlight).toBeUndefined(); expect(recovered.tasks[0]?.status).toBe("pending");
    const completed = await new GoalController(store, h, goal.id).run();
    expect(completed.status).toBe("completed"); store.close();
  });
  it("preserves an uncertain operation when the host cannot reconcile it", async () => {
    const { store, goal } = fixture();
    const h = host({ async execute() { throw new Error("lost response"); }, async reconcile() { return { kind: "blocked" as const, reason: "OPAQUE_EXTERNAL_EFFECT_REQUIRES_RECONCILIATION" }; } });
    const failed = await new GoalController(store, h, goal.id).run(); expect(failed.inFlight).toBeDefined();
    const recovered = await new GoalController(store, h, goal.id).recover();
    expect(recovered.status).toBe("blocked"); expect(recovered.inFlight).toBeDefined(); expect(recovered.stopReason).toContain("OPAQUE_EXTERNAL_EFFECT"); store.close();
  });
});

describe("atomic Goal ownership and budget epochs", () => {
  for (const failingTable of ["goal_budget_accounts", "goals"]) {
    it(`rolls back both epochs if a ${failingTable} update fails, then resumes after restart`, async () => {
      const { GoalBudgetLedger } = await import("../../goal/budget.js");
      const { Database } = await import("bun:sqlite");
      const { dir, store, goal } = fixture(); const dbPath = join(dir, "state.sqlite");
      const ledger = new GoalBudgetLedger(dbPath); ledger.create(goal.id, 0, { maxModelCalls: 10 }); ledger.close();
      const inject = new Database(dbPath); inject.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE ON ${failingTable} BEGIN SELECT RAISE(ABORT, 'INJECTED_FAILURE'); END`);
      expect(() => store.claim(goal.id, "broken", 101)).toThrow("INJECTED_FAILURE");
      expect(store.get(goal.id)?.ownerEpoch).toBe(0); expect(store.get(goal.id)?.owner).toBeUndefined();
      store.close(); inject.exec("DROP TRIGGER fail_claim"); inject.close();
      const reopened = new GoalStore(dbPath, { requireLedger: true });
      const priorLedger = new GoalBudgetLedger(dbPath); expect(priorLedger.snapshot(goal.id).epoch).toBe(0); priorLedger.close();
      const claimed = reopened.claim(goal.id, "recovered", 102); expect(claimed.ownerEpoch).toBe(1);
      const meter = new GoalBudgetLedger(dbPath); expect(meter.snapshot(goal.id).epoch).toBe(1); meter.close(); reopened.close();
    });
  }
  it("fails closed if the required Goal ledger account is absent", () => {
    const { dir, store, goal } = fixture(); store.close();
    const reopened = new GoalStore(join(dir, "state.sqlite"), { requireLedger: true });
    expect(() => reopened.claim(goal.id, "owner", 1)).toThrow("GOAL_BUDGET_ACCOUNT_MISSING");
    expect(reopened.get(goal.id)?.ownerEpoch).toBe(0); reopened.close();
  });
});

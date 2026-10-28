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

describe("objective-driven Goal completion", () => {
  it("persists an unlimited Goal without inventing a deadline", async () => {
    const { dir, store } = fixture();
    const goal = store.create({ objective: "Finish the report", cwd: dir });
    expect(goal.deadlineAt).toBeUndefined();
    store.close();
    const reopened = new GoalStore(join(dir, "state.sqlite"));
    expect(reopened.get(goal.id)?.deadlineAt).toBeUndefined();
    const result = await new GoalController(reopened, host(), goal.id).run();
    expect(result.status).toBe("completed"); reopened.close();
  });
  it("continues repairing beyond two failures until the independent verifier passes", async () => {
    const { store, goal } = fixture(); let checks = 0;
    const result = await new GoalController(store, host({
      async plan() { return { tasks: [{ id: "one", description: "Write", acceptance: "Correct" }] }; },
      async execute(_ctx, t, previous) {
        if (t.attempt > 1) expect(previous?.status).toBe("failed");
        return candidate(`attempt-${t.attempt}`);
      },
      async verify(_ctx, t, c, final) { return receipt(c, t, final || ++checks > 4 ? "passed" : "failed"); },
    }), goal.id).run();
    expect(result.status).toBe("completed"); expect(result.tasks[0]?.attempt).toBe(5);
    expect(result.finalReceipt?.status).toBe("passed"); store.close();
  });
  it("repairs final acceptance failures from integration without replaying accepted tasks", async () => {
    const { store, goal } = fixture(); let finalChecks = 0; const executed: string[] = [];
    const result = await new GoalController(store, host({
      async execute(ctx, t, previous) {
        executed.push(t.id);
        if (finalChecks > 0) {
          expect(t.description).toContain(`Missing requirement ${finalChecks}`);
          expect(t.acceptance).toBe(goal.objective);
          expect(previous).toBeUndefined(); // The final snapshot is not a worker repair candidate.
          expect(ctx.goal.tasks.filter(task => task.status === "passed").length).toBeGreaterThanOrEqual(2);
        }
        return candidate(t.id);
      },
      async verify(_ctx, t, c, final) {
        if (!final) return receipt(c, t);
        const status = ++finalChecks < 3 ? "failed" : "passed";
        return { ...receipt(c, t, status), detail: `Missing requirement ${finalChecks}` };
      },
      async deliver(ctx) {
        expect(finalChecks).toBe(3); expect(ctx.goal.finalReceipt?.status).toBe("passed");
        return { status: "delivered" };
      },
    }), goal.id).run();
    expect(result.status).toBe("completed"); expect(executed).toHaveLength(4);
    expect(new Set(executed).size).toBe(4); expect(result.tasks.every(t => t.status === "passed")).toBe(true);
    expect(result.planRevision).toBe(3); store.close();
  });
  for (const status of ["unverified", "error"] as const) {
    it(`keeps an indeterminate final ${status} blocked from delivery`, async () => {
      const { store, goal } = fixture(); let deliveries = 0;
      const result = await new GoalController(store, host({
        async verify(_ctx, t, c, final) { return receipt(c, t, final ? status : "passed"); },
        async deliver() { deliveries++; return { status: "delivered" }; },
      }), goal.id).run();
      expect(result.status).toBe("awaiting_acceptance"); expect(deliveries).toBe(0);
      expect(result.tasks).toHaveLength(2); store.close();
    });
  }
  it("still honors user cancellation while repeatedly repairing", async () => {
    const { store, goal } = fixture(); let sealed = false;
    const result = await new GoalController(store, host({
      async verify(_ctx, t, c) {
        if (t.attempt === 4) store.requestControl(goal.id, "cancel");
        return receipt(c, t, "failed");
      },
      async seal() { sealed = true; },
    }), goal.id).run();
    expect(result.status).toBe("cancelled"); expect(sealed).toBe(true);
    expect(result.stopReason).toBe("USER_CANCEL"); store.close();
  });
  it("honors an explicit deadline while Goals without one remain unlimited", async () => {
    const { dir, store } = fixture();
    const goal = store.create({ objective: "Explicitly timed", cwd: dir, deadlineAt: Date.now() + 30 });
    let executed = false, sealed = false;
    const result = await new GoalController(store, host({
      async plan() { await new Promise(resolve => setTimeout(resolve, 50)); return { tasks: [{ id: "one", description: "x", acceptance: "y" }] }; },
      async execute() { executed = true; return candidate("x"); },
      async seal() { sealed = true; },
    }), goal.id).run();
    expect(result.status).toBe("paused"); expect(result.stopReason).toBe("DEADLINE_EXCEEDED");
    expect(executed).toBe(false); expect(sealed).toBe(true); store.close();
  });
  it("preserves explicitly configured repair limits for SDK callers", async () => {
    const { store, goal } = fixture();
    const result = await new GoalController(store, host({ async verify(_ctx, t, c) { return receipt(c, t, "failed"); } }), goal.id, 1).run();
    expect(result.status).toBe("blocked"); expect(result.tasks[0]?.attempt).toBe(2); store.close();
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
    expect(snap.limits.deadlineAt).toBe(goal.deadlineAt! + 300_000); expect(state.deadlineAt).toBe(snap.limits.deadlineAt);
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

it("suppresses unchanged repeated failures and preserves the frozen candidate for explicit recovery", async () => {
  const { dir, store, goal } = fixture(); let executions = 0;
  const h = host({
    async plan() { return { tasks: [{ id: "one", description: "Report", acceptance: "Cited" }] }; },
    async execute() { executions++; return candidate("same-content"); },
    async verify(_ctx, t, c) { return { ...receipt(c, t, "failed"), detail: "Missing citations" }; },
  });
  const result = await new GoalController(store, h, goal.id).run();
  expect(result.status).toBe("blocked"); expect(result.stopReason).toContain("GOAL_NO_PROGRESS");
  expect(executions).toBe(4); expect(result.inFlight).toBeUndefined(); expect(result.tasks[0]?.candidate).toBeDefined();
  store.close();
  const reopened = new GoalStore(join(dir, "state.sqlite"));
  expect(reopened.get(goal.id)?.progress?.one?.stalled).toBe(3);
  reopened.prepareResume(goal.id); expect(reopened.get(goal.id)?.progress).toBeUndefined(); reopened.close();
});
it("stops a failed narrative-only attempt without falsely completing the Goal", async () => {
  const { store, goal } = fixture();
  const result = await new GoalController(store, host({
    async execute() { return { ...candidate("text-only"), activity: { toolCalls: 0, changed: false, fingerprint: "text" } }; },
    async verify(_ctx, t, c) { return receipt(c, t, "failed"); },
  }), goal.id).run();
  expect(result.status).toBe("blocked"); expect(result.stopReason).toContain("GOAL_NO_PROGRESS"); expect(result.delivery).toBeUndefined(); store.close();
});
it("resumes final verification after a confirmed read-only interruption without repeating development or snapshot creation", async () => {
  const { store, goal } = fixture(); let workers = 0, snapshots = 0, checks = 0;
  const h = host({
    async execute(_ctx, t) { workers++; return candidate(t.id); },
    async snapshotIntegration() { snapshots++; return candidate("final"); },
    async verify(_ctx, t, c, final) {
      if (final && checks++ === 0) throw new Error("read-only verifier lost connection");
      return receipt(c, t);
    },
    async reconcile() { return { kind: "retry" }; },
  });
  const blocked = await new GoalController(store, h, goal.id).run();
  expect(blocked.inFlight?.phase).toBe("final_verifying"); expect(blocked.finalCandidate?.candidateId).toBe("final");
  await new GoalController(store, h, goal.id).recover();
  const result = await new GoalController(store, h, goal.id).run();
  expect(result.status).toBe("completed"); expect(workers).toBe(2); expect(snapshots).toBe(1); store.close();
});
it("pauses only this chat's Goals for foreground input and keeps standalone Goals running", () => {
  const { dir, store } = fixture();
  const mine = store.create({ objective: "mine", cwd: dir, sessionId: "chat-a" });
  const other = store.create({ objective: "other", cwd: dir, sessionId: "chat-b" });
  const standalone = store.create({ objective: "cli", cwd: dir });
  expect(store.pauseForInput(dir, "chat-a")).toEqual([mine.id]);
  expect(store.get(mine.id)?.status).toBe("paused");
  expect(store.get(other.id)?.status).toBe("created"); expect(store.get(standalone.id)?.status).toBe("created"); store.close();
});
it("records a bounded stop separately from completion and retains operation/candidate diagnostics", async () => {
  const { store, goal } = fixture();
  const { GoalPhaseError } = await import("../../goal/errors.js");
  const result = await new GoalController(store, host({ async execute() { throw new GoalPhaseError("GOAL_BUDGET_LIMITED"); } }), goal.id).run();
  expect(result.status).toBe("budget_limited"); expect(result.failure?.code).toBe("GOAL_BUDGET_LIMITED");
  expect(result.failure?.phase).toBe("executing"); expect(result.inFlight).toBeDefined(); expect(result.delivery).toBeUndefined(); store.close();
});
it("yields to foreground input after sealing a phase and resumes verification without replaying the worker", async () => {
  const { dir, store } = fixture(); const goal = store.create({ objective: "Report", cwd: dir, sessionId: "chat" });
  let executions = 0;
  const h = host({
    async execute(ctx, t) {
      executions++;
      store.pauseForInput(dir, "chat");
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(ctx.signal.aborted).toBe(false); // Foreground input must not kill a live tool.
      return candidate(t.id);
    },
  });
  const paused = await new GoalController(store, h, goal.id).run();
  expect(paused.status).toBe("paused"); expect(paused.stopReason).toBe("USER_INPUT_PENDING");
  expect(paused.inFlight).toBeUndefined(); expect(paused.tasks[0]?.status).toBe("verifying");
  store.prepareResume(goal.id);
  const result = await new GoalController(store, host({ async execute(_ctx, t) { executions++; return candidate(t.id); } }), goal.id).run();
  expect(result.status).toBe("completed"); expect(executions).toBe(2); expect(result.tasks[0]?.attempt).toBe(1); store.close();
});
it("does not let an already-dispatched automatic runner override a user pause", async () => {
  const { dir, store } = fixture(); const goal = store.create({ objective: "Report", cwd: dir, sessionId: "chat" });
  store.pauseForInput(dir, "chat"); let planned = false;
  await expect(new GoalController(store, host({ async plan() { planned = true; return { tasks: [] }; } }), goal.id).run({ automatic: true })).rejects.toThrow("GOAL_AUTOMATIC_CONTINUATION_SUPPRESSED");
  expect(planned).toBe(false); expect(store.get(goal.id)?.status).toBe("paused"); store.close();
});
it("keeps plan-only work paused before invoking development or acceptance", async () => {
  const { dir, store } = fixture(); const goal = store.create({ objective: "Propose a report", cwd: dir, permissionMode: "plan" }); let effects = 0;
  const result = await new GoalController(store, host({ async execute() { effects++; return candidate("x"); } }), goal.id).run();
  expect(result.status).toBe("paused"); expect(result.stopReason).toBe("GOAL_PLAN_REQUIRES_EXECUTION_AUTHORIZATION"); expect(effects).toBe(0); store.close();
});

it("treats prototype-shaped model task ids as ordinary progress keys", async () => {
  const { store, goal } = fixture();
  const result = await new GoalController(store, host({
    async plan() { return { tasks: [{ id: "__proto__", description: "Report", acceptance: "Cited" }] }; },
    async execute() { return candidate("same"); },
    async verify(_ctx, t, c) { return receipt(c, t, "failed"); },
  }), goal.id).run();
  expect(result.status).toBe("blocked"); expect(result.stopReason).toContain("GOAL_NO_PROGRESS");
  expect(Object.hasOwn(result.progress!, "__proto__")).toBe(true);
  expect(result.progress?.["__proto__"]?.stalled).toBe(3); store.close();
});

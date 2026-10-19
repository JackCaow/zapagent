import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DeferredAcceptanceCoordinator, signDeferredAcceptanceResult, type DeferredAcceptanceResult } from "../../runtime/deferred-acceptance.js";
import { InMemoryWorkflowControlStore, SqliteWorkflowControlStore } from "../../runtime/workflow-store.js";
import { WorkflowActionRunner, type WorkflowActionAdapter, type WorkflowActionContext } from "../../runtime/workflow-action-runner.js";
import type { WorkflowActionReceipt, WorkflowControlStore } from "../../runtime/workflow-control.js";
import { OutcomeProtocolError, type AgentOutcomeV1 } from "../../runtime/outcome.js";

const directories: string[] = [];
const stores: SqliteWorkflowControlStore[] = [];
afterEach(async () => { stores.splice(0).forEach(s => s.close()); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "zap-action-")); directories.push(dir); return dir; }
function sqlite(file: string) { const store = new SqliteWorkflowControlStore(file); stores.push(store); return store; }
const key = new Uint8Array(32).fill(4);
const owner = { id: "runner", signingKey: key };
const grant = { actionId: "deliver-v1", grantId: "user-1" };
const outcome: AgentOutcomeV1 = { schema: "zap.outcome", schemaVersion: 1, threadId: "t", turnId: "turn", runId: "a", attemptId: "a", startedAt: 1, endedAt: 2,
  execution: { attemptId: "a", status: "finished", stopReason: "end_turn", finalResponse: "done", unresolvedActions: [] },
  acceptance: { attemptId: "a", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
  workflow: { attemptId: "a", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } };
function ready(store: WorkflowControlStore = new InMemoryWorkflowControlStore(), deadlineAt = Date.now() + 60_000) {
  const coordinator = new DeferredAcceptanceCoordinator(store, [owner]);
  let record = coordinator.register({ workflowId: "flow", ownerId: owner.id, outcome, deadlineAt,
    spec: { id: "s", revision: 1, subjects: [{ id: "file", path: "result.txt", expected: "exists" }], checks: [{ id: "check", verifierId: "v1", subjectIds: ["file"] }] },
    snapshot: { id: "commit-1", providerId: "git", proof: "immutable_snapshot", subjects: [{ subjectId: "file", exists: true, version: "blob-1" }] } });
  const payload: DeferredAcceptanceResult = { workflowId: record.id, requestId: record.requestId, ownerId: record.ownerId,
    attemptId: record.outcome.attemptId, specDigest: record.specDigest, snapshotId: record.snapshot!.id,
    result: { status: "completed", checks: [{ checkId: "check", attemptId: record.outcome.attemptId, specId: "s", specRevision: 1,
      snapshotId: record.snapshot!.id, dependencies: record.snapshot!.subjects, status: "passed", code: "OK", evidenceRefs: [] }] } };
  record = coordinator.accept(payload, signDeferredAcceptanceResult(payload, key));
  record = coordinator.authorizeAction(record.id, record.revision, grant);
  return { coordinator, store, record, decision: coordinator.read(record.id).decision };
}
function receipt(c: WorkflowActionContext, status: WorkflowActionReceipt["status"] = "succeeded"): WorkflowActionReceipt {
  return { operationId: c.claim.operationId, snapshotId: c.snapshot.id, status, code: status.toUpperCase(), evidenceRefs: ["target:receipt"] };
}
function adapter(overrides: Partial<WorkflowActionAdapter> = {}): WorkflowActionAdapter {
  return { actionId: grant.actionId, async execute(c) { return receipt(c); }, async reconcile(c) { return receipt(c); }, ...overrides };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("workflow action execution and reconciliation", () => {
  it("executes once with a persisted claim and fixed snapshot, and stores the result", async () => {
    const f = ready(); let calls = 0;
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) {
      calls++;
      expect(f.coordinator.read("flow").record.action).toEqual(c.claim);
      expect(c.snapshot).toEqual(f.record.snapshot);
      expect(Object.isFrozen(c.snapshot.subjects[0])).toBe(true);
      expect(c.deadlineAt).toBeLessThanOrEqual(f.record.deadlineAt);
      return receipt(c);
    } })]);
    const completed = await runner.dispatch(f.decision, grant, { timeoutMs: 1000 });
    expect(completed.actionResult).toMatchObject({ status: "succeeded", source: "execute" });
    expect(completed.outcome).toEqual(outcome);
    expect(completed.acceptance).toEqual(f.record.acceptance);
    await expect(runner.dispatch(f.decision, grant, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    expect(calls).toBe(1);
  });

  it("rejects absent adapters, bad budgets and pre-aborted calls before claiming", async () => {
    const f = ready();
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ actionId: "other" })]);
    await expect(runner.dispatch(f.decision, grant, { timeoutMs: 100 })).rejects.toMatchObject({ code: "ACTION_ADAPTER_UNAVAILABLE" });
    await expect(runner.dispatch(f.decision, grant, { timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_ACTION_CONFIG" });
    const aborted = AbortSignal.abort();
    await expect(runner.dispatch(f.decision, grant, { timeoutMs: 100, signal: aborted })).rejects.toThrow();
    expect(f.coordinator.read("flow").record.action).toBeUndefined();
    expect(() => new WorkflowActionRunner(f.coordinator, [adapter(), adapter()])).toThrow("INVALID_ACTION_CONFIG");
    expect(() => new WorkflowActionRunner(f.coordinator, [{ ...adapter(), reconcile: undefined } as unknown as WorkflowActionAdapter])).toThrow("INVALID_ACTION_CONFIG");
  });

  it("does not invoke an adapter if cancellation or revocation invalidated the candidate", async () => {
    for (const cancel of [true, false]) {
      const f = ready(); let calls = 0;
      const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { calls++; return receipt(c); } })]);
      if (cancel) f.coordinator.cancel("flow", f.record.revision);
      else f.coordinator.authorizeAction("flow", f.record.revision, undefined);
      await expect(runner.dispatch(f.decision, grant, { timeoutMs: 1000 })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  it("copies registered adapter methods so later replacement cannot alter dispatch", async () => {
    const f = ready();
    const registered = adapter();
    const runner = new WorkflowActionRunner(f.coordinator, [registered]);
    registered.execute = async () => { throw new Error("replaced"); };
    expect((await runner.dispatch(f.decision, grant, { timeoutMs: 1000 })).actionResult!.status).toBe("succeeded");
  });

  it("distinguishes definite failure from a lost response and rejects forged receipt identity", async () => {
    for (const mode of ["failed", "throw", "wrong-operation", "wrong-snapshot"] as const) {
      const f = ready();
      const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) {
        if (mode === "throw") throw new Error("network lost after commit");
        const r = receipt(c, "failed");
        if (mode === "wrong-operation") r.operationId = "another-operation";
        if (mode === "wrong-snapshot") r.snapshotId = "current-worktree";
        return r;
      } })]);
      const r = await runner.dispatch(f.decision, grant, { timeoutMs: 1000 });
      expect(r.actionResult!.status).toBe(mode === "failed" ? "failed" : "unknown");
      expect(r.actionResult!.code).toBe(mode === "failed" ? "FAILED" : mode === "throw" ? "ACTION_ADAPTER_ERROR" : "INVALID_ACTION_RECEIPT");
      expect(r.outcome.execution.status).toBe("finished");
    }
  });

  it("persists caller cancellation, signals the running adapter, and ignores late success", async () => {
    const f = ready(); const abort = new AbortController();
    let finish!: (r: WorkflowActionReceipt) => void;
    let context!: WorkflowActionContext;
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) {
      context = c;
      setTimeout(() => abort.abort(), 5);
      return new Promise(resolve => { finish = resolve; });
    } })]);
    const r = await runner.dispatch(f.decision, grant, { timeoutMs: 1000, signal: abort.signal });
    expect(r.cancelled).toBe(true);
    expect(context.signal.aborted).toBe(true);
    expect(r.actionResult).toMatchObject({ status: "unknown", code: "ACTION_CANCELLED" });
    finish(receipt(context)); await pause(5);
    expect(f.coordinator.read("flow").record.actionResult!.status).toBe("unknown");
  });

  it("observes durable cancellation written through a separate SQLite connection", async () => {
    const file = join(await directory(), "flow.sqlite");
    const f = ready(sqlite(file));
    const other = new DeferredAcceptanceCoordinator(sqlite(file), [owner]);
    let context!: WorkflowActionContext;
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) {
      context = c;
      const current = other.read("flow").record;
      other.cancel("flow", current.revision);
      return new Promise(() => {});
    } })], 2);
    const r = await runner.dispatch(f.decision, grant, { timeoutMs: 1000 });
    expect(context.signal.aborted).toBe(true);
    expect(r.cancelled).toBe(true);
    expect(r.actionResult!.code).toBe("ACTION_CANCELLED");
  });

  it("stops observing a non-cooperating adapter at the shared deadline", async () => {
    const f = ready(undefined, Date.now() + 80);
    let context!: WorkflowActionContext;
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { context = c; return new Promise(() => {}); } })]);
    const r = await runner.dispatch(f.decision, grant, { timeoutMs: 2000 });
    expect(context.deadlineAt).toBe(f.record.deadlineAt);
    expect(context.signal.aborted).toBe(true);
    expect(r.actionResult).toMatchObject({ status: "unknown", code: "ACTION_TIMEOUT" });
  });

  it("preserves the claim when result persistence fails and never retries execute", async () => {
    const backing = new InMemoryWorkflowControlStore(); let fail = false; let calls = 0;
    const store: WorkflowControlStore = { load: id => backing.load(id), compareAndSwap(rev, r) {
      if (fail) throw new Error("disk unavailable"); backing.compareAndSwap(rev, r);
    } };
    const f = ready(store);
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { calls++; fail = true; return receipt(c); } })]);
    await expect(runner.dispatch(f.decision, grant, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ACTION_RESULT_PERSISTENCE_FAILED" });
    const saved = backing.load("flow")!;
    expect(saved.action).toBeDefined(); expect(saved.actionResult).toBeUndefined();
    fail = false;
    const recovered = await runner.reconcile("flow", { timeoutMs: 1000 });
    expect(recovered.actionResult).toMatchObject({ status: "succeeded", source: "reconcile" });
    expect(calls).toBe(1);
  });

  it("recovers a real external effect by operationId without performing it again", async () => {
    const dir = await directory(); const file = join(dir, "flow.sqlite");
    const f = ready(sqlite(file)); let executions = 0; let queries = 0;
    const target = join(dir, "target.json");
    const external = adapter({ async execute(c) {
      executions++;
      await writeFile(target, JSON.stringify(receipt(c)), { flag: "wx" });
      throw new Error("response lost after external commit");
    }, async reconcile(c) {
      queries++;
      const saved = JSON.parse(await readFile(target, "utf8"));
      expect(saved.operationId).toBe(c.claim.operationId);
      return saved;
    } });
    const first = await new WorkflowActionRunner(f.coordinator, [external]).dispatch(f.decision, grant, { timeoutMs: 1000 });
    expect(first.actionResult!.status).toBe("unknown");
    const restored = new DeferredAcceptanceCoordinator(sqlite(file), [owner]);
    const runner = new WorkflowActionRunner(restored, [external]);
    const settled = await runner.reconcile("flow", { timeoutMs: 1000 });
    expect(settled.actionResult!.status).toBe("succeeded");
    expect(settled.action!.operationId).toBe(first.action!.operationId);
    expect(executions).toBe(1); expect(queries).toBe(1);
    expect(await runner.reconcile("flow", { timeoutMs: 1000 })).toEqual(settled);
    expect(queries).toBe(1);
  });

  it("reconciles a process killed after the external effect but before result publication", async () => {
    const dir = await directory(); const file = join(dir, "flow.sqlite");
    const f = ready(sqlite(file));
    const target = join(dir, "target.json");
    const script = join(dir, "crash.ts");
    await writeFile(script, `
      import { writeFile } from "node:fs/promises";
      import { DeferredAcceptanceCoordinator } from ${JSON.stringify(resolve(import.meta.dir, "../../runtime/deferred-acceptance.ts"))};
      import { SqliteWorkflowControlStore } from ${JSON.stringify(resolve(import.meta.dir, "../../runtime/workflow-store.ts"))};
      import { WorkflowActionRunner } from ${JSON.stringify(resolve(import.meta.dir, "../../runtime/workflow-action-runner.ts"))};
      const [file, target] = process.argv.slice(2);
      const coordinator = new DeferredAcceptanceCoordinator(new SqliteWorkflowControlStore(file), [{ id: "runner", signingKey: new Uint8Array(32).fill(4) }]);
      const runner = new WorkflowActionRunner(coordinator, [{ actionId: "deliver-v1", async execute(c) {
        await writeFile(target, JSON.stringify({ operationId: c.claim.operationId, snapshotId: c.snapshot.id,
          status: "succeeded", code: "TARGET_COMMITTED", evidenceRefs: [target] }), { flag: "wx" });
        console.log("EFFECT_COMMITTED");
        return new Promise(() => {});
      }, async reconcile() { throw new Error("not used in child"); } }]);
      await runner.dispatch(coordinator.read("flow").decision, { actionId: "deliver-v1", grantId: "user-1" }, { timeoutMs: 10000 });
    `);
    const child = spawn(process.execPath, [script, file, target], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", c => { errors += c; });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        timer = setTimeout(() => reject(new Error("child did not commit: " + errors)), 5000);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("child exited before kill: " + errors)));
        child.stdout.on("data", c => { output += c; if (output.includes("EFFECT_COMMITTED")) resolve(); });
      });
      child.kill("SIGKILL");
      await closed;
      const restored = new DeferredAcceptanceCoordinator(sqlite(file), [owner]);
      const interrupted = restored.read("flow").record;
      expect(interrupted.action).toBeDefined(); expect(interrupted.actionResult).toBeUndefined();
      let executions = 0;
      const runner = new WorkflowActionRunner(restored, [adapter({ async execute(c) { executions++; return receipt(c); },
        async reconcile() { return JSON.parse(await readFile(target, "utf8")); } })]);
      const settled = await runner.reconcile("flow", { timeoutMs: 1000 });
      expect(settled.actionResult).toMatchObject({ status: "succeeded", code: "TARGET_COMMITTED", source: "reconcile" });
      expect(settled.outcome).toEqual(f.record.outcome);
      expect(executions).toBe(0);
    } finally { if (timer) clearTimeout(timer); child.kill("SIGKILL"); await closed; }
  });

  it("queries an existing claim after cancellation/deadline without clearing cancellation", async () => {
    const f = ready(undefined, Date.now() + 80);
    const claim = f.coordinator.claimAction(f.decision, grant);
    f.coordinator.cancel("flow", claim.revision);
    await pause(90);
    let execute = 0;
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { execute++; return receipt(c); } })]);
    const r = await runner.reconcile("flow", { timeoutMs: 1000 });
    expect(r.actionResult!.status).toBe("succeeded"); expect(r.cancelled).toBe(true); expect(execute).toBe(0);
    expect(f.coordinator.read("flow").decision.code).toBe("WORKFLOW_CANCELLED");
  });

  it("bounds reconciliation and does not reinterpret an unknown query as a retry permission", async () => {
    const f = ready(); f.coordinator.claimAction(f.decision, grant);
    let calls = 0;
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { calls++; return receipt(c); }, async reconcile() { return new Promise(() => {}); } })]);
    const r = await runner.reconcile("flow", { timeoutMs: 10 });
    expect(r.actionResult).toMatchObject({ status: "unknown", code: "ACTION_TIMEOUT", source: "reconcile" });
    await expect(runner.dispatch(f.coordinator.read("flow").decision, grant, { timeoutMs: 1000 })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("does not let a late unknown query overwrite a concurrent conclusive result", async () => {
    const f = ready(); const claimed = f.coordinator.claimAction(f.decision, grant);
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async reconcile(c) {
      f.coordinator.recordActionResult("flow", claimed.revision, receipt(c), "reconcile");
      throw new Error("query interrupted");
    } })]);
    expect((await runner.reconcile("flow", { timeoutMs: 1000 })).actionResult!.status).toBe("succeeded");
  });

  it("retries result CAS against current control without undoing cancellation", async () => {
    const backing = new InMemoryWorkflowControlStore(); let clash = true;
    const store: WorkflowControlStore = { load: id => backing.load(id), compareAndSwap(rev, r) {
      if (r.actionResult && clash) {
        clash = false;
        const current = backing.load(r.id)!;
        backing.compareAndSwap(rev, { ...current, revision: rev + 1, cancelled: true });
        throw new OutcomeProtocolError("WORKFLOW_CONFLICT", "concurrent cancellation");
      }
      backing.compareAndSwap(rev, r);
    } };
    const f = ready(store);
    const r = await new WorkflowActionRunner(f.coordinator, [adapter()]).dispatch(f.decision, grant, { timeoutMs: 1000 });
    expect(r.cancelled).toBe(true);
    expect(r.actionResult!.status).toBe("succeeded");
  });

  it("seals conclusive results and validates stored result identity", async () => {
    const f = ready();
    const r = await new WorkflowActionRunner(f.coordinator, [adapter()]).dispatch(f.decision, grant, { timeoutMs: 1000 });
    const saved = r.actionResult!;
    expect(f.coordinator.recordActionResult("flow", r.revision, saved, "reconcile").revision).toBe(r.revision);
    expect(() => f.coordinator.recordActionResult("flow", r.revision, { ...saved, status: "failed" }, "reconcile")).toThrow("ACTION_RESULT_CONFLICT");
    expect(() => f.store.compareAndSwap(r.revision, { ...r, revision: r.revision + 1, actionResult: undefined })).toThrow("ACTION_RESULT_CONFLICT");
    expect(() => f.store.compareAndSwap(r.revision, { ...r, revision: r.revision + 1, actionResult: { ...saved, snapshotId: "other" } })).toThrow("INVALID_ACTION_RECEIPT");
  });

  it("never starts the adapter when the durable claim cannot be published", async () => {
    const backing = new InMemoryWorkflowControlStore(); let calls = 0;
    const store: WorkflowControlStore = { load: id => backing.load(id), compareAndSwap(rev, r) {
      if (r.action) throw new Error("claim storage unavailable"); backing.compareAndSwap(rev, r);
    } };
    const f = ready(store);
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { calls++; return receipt(c); } })]);
    await expect(runner.dispatch(f.decision, grant, { timeoutMs: 1000 })).rejects.toThrow("claim storage unavailable");
    expect(calls).toBe(0); expect(f.coordinator.read("flow").record.action).toBeUndefined();
  });

  it("rechecks persisted control between claiming and invoking the adapter", async () => {
    const backing = new InMemoryWorkflowControlStore(); let calls = 0;
    const store: WorkflowControlStore = { load: id => backing.load(id), compareAndSwap(rev, r) {
      backing.compareAndSwap(rev, r);
      if (r.action && !r.actionResult && !r.cancelled) backing.compareAndSwap(r.revision, { ...r, revision: r.revision + 1, cancelled: true });
    } };
    const f = ready(store);
    const runner = new WorkflowActionRunner(f.coordinator, [adapter({ async execute(c) { calls++; return receipt(c); } })]);
    const r = await runner.dispatch(f.decision, grant, { timeoutMs: 1000 });
    expect(r.cancelled).toBe(true); expect(r.actionResult!.status).toBe("unknown"); expect(calls).toBe(0);
  });
});

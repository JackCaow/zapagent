import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AgentEventEmitter } from "../../agent/events.js";
import { AgentRuntime } from "../../runtime/agent-runtime.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { DeferredAcceptanceCoordinator, signDeferredAcceptanceResult,
  type DeferredAcceptanceResult, type DeferredWorkflowRegistration } from "../../runtime/deferred-acceptance.js";
import { InMemoryWorkflowControlStore, SqliteWorkflowControlStore } from "../../runtime/workflow-store.js";
import { decideWorkflow, type DeferredWorkflowRecord, type WorkflowControlStore } from "../../runtime/workflow-control.js";
import type { AgentOutcomeV1 } from "../../runtime/outcome.js";

const directories: string[] = [];
const stores: SqliteWorkflowControlStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function path() { const dir = await mkdtemp(join(tmpdir(), "zap-workflow-")); directories.push(dir); return join(dir, "workflow.sqlite"); }
function sqlite(file: string) { const store = new SqliteWorkflowControlStore(file); stores.push(store); return store; }
const key = new Uint8Array(32).fill(7);
const owner = { id: "official-runner", signingKey: key };
const grant = { actionId: "deliver", grantId: "user-grant-1" };
const terminal: AgentOutcomeV1 = { schema: "zap.outcome", schemaVersion: 1, threadId: "thread", turnId: "turn", runId: "attempt", attemptId: "attempt", startedAt: 1, endedAt: 2,
  execution: { attemptId: "attempt", status: "finished", stopReason: "end_turn", finalResponse: "done", unresolvedActions: [] },
  acceptance: { attemptId: "attempt", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
  workflow: { attemptId: "attempt", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } };
function registration(overrides: Partial<DeferredWorkflowRegistration> = {}): DeferredWorkflowRegistration {
  return { workflowId: "workflow", ownerId: owner.id, outcome: structuredClone(terminal),
    spec: { id: "artifact", revision: 1, subjects: [{ id: "file", path: "result.txt", expected: "exists" }],
      checks: [{ id: "test", verifierId: "external-v1", subjectIds: ["file"] }] },
    snapshot: { id: "git:commit", providerId: "git", proof: "immutable_snapshot", subjects: [{ subjectId: "file", exists: true, version: "blob:abc" }] },
    deadlineAt: Date.now() + 60_000, ...overrides };
}
function result(record: DeferredWorkflowRecord): DeferredAcceptanceResult {
  return { workflowId: record.id, requestId: record.requestId, ownerId: record.ownerId, attemptId: record.outcome.attemptId,
    specDigest: record.specDigest, snapshotId: record.snapshot!.id,
    result: { status: "completed", checks: record.spec.checks.map(c => ({ checkId: c.id, attemptId: record.outcome.attemptId,
      specId: record.spec.id, specRevision: record.spec.revision, snapshotId: record.snapshot!.id,
      dependencies: c.subjectIds.map(id => structuredClone(record.snapshot!.subjects.find(s => s.subjectId === id)!)),
      status: "passed", code: "OK", evidenceRefs: ["external:report"] })) } };
}
function setup(store: WorkflowControlStore = new InMemoryWorkflowControlStore(), overrides: Partial<DeferredWorkflowRegistration> = {}) {
  const coordinator = new DeferredAcceptanceCoordinator(store, [owner]);
  const record = coordinator.register(registration(overrides));
  return { coordinator, record, store };
}
function accept(coordinator: DeferredAcceptanceCoordinator, payload: DeferredAcceptanceResult) { return coordinator.accept(payload, signDeferredAcceptanceResult(payload, key)); }
function ready(store?: WorkflowControlStore, overrides: Partial<DeferredWorkflowRegistration> = {}) {
  const f = setup(store, overrides);
  let record = accept(f.coordinator, result(f.record));
  record = f.coordinator.authorizeAction(record.id, record.revision, grant);
  return { ...f, record, decision: f.coordinator.read(record.id).decision };
}
function newAttempt(): AgentOutcomeV1 {
  const outcome = structuredClone(terminal);
  outcome.attemptId = outcome.runId = "attempt-2";
  outcome.execution.attemptId = outcome.acceptance.attemptId = outcome.workflow.attemptId = outcome.attemptId;
  return outcome;
}

describe("deferred acceptance and durable workflow control", () => {
  it("lets Runtime return and publish exactly one terminal before external verification", async () => {
    let calls = 0;
    class Executor extends AgentEventEmitter {
      async run() { calls++; return { text: "done", steps: 1, totalUsage: { inputTokens: 1, outputTokens: 1 }, toolResults: [] }; }
      toolDefinitions() { return []; }
      effectiveSystemPrompt() { return undefined; }
    }
    const events = new InMemoryRuntimeEventStore();
    const runtime = new AgentRuntime({ threadId: "thread", agent: new Executor(), eventStore: events });
    const execution = await runtime.runWithOutcome("make artifact");
    expect((await events.list("thread")).filter(e => e.payload.type === "attempt_ended")).toHaveLength(1);
    const f = setup(undefined, { outcome: execution.outcome });
    expect(f.record.acceptance.status).toBe("pending");
    accept(f.coordinator, result(f.record));
    expect(runtime.lastOutcome()).toEqual(execution.outcome);
    expect(calls).toBe(1);
    expect((await events.list("thread")).filter(e => e.payload.type === "attempt_ended")).toHaveLength(1);
  });

  it("requires explicit owner credentials, valid specs and a finite deadline", () => {
    for (const owners of [[{ ...owner, signingKey: new Uint8Array(4) }], [owner, owner], [{ ...owner, id: "host:inline" }]]) {
      expect(() => new DeferredAcceptanceCoordinator(new InMemoryWorkflowControlStore(), owners)).toThrow();
    }
    for (const config of [registration({ ownerId: "missing" }), registration({ deadlineAt: Infinity }), registration({ deadlineAt: 1 }),
      { ...registration(), repair: { maxAttempts: 1 } }, registration({ spec: { ...registration().spec, checks: [] } })]) {
      expect(() => setup(undefined, config)).toThrow();
    }
  });

  it("never invents a stable snapshot or success for an absent required subject", () => {
    expect(setup(undefined, { snapshot: undefined }).record.acceptance.status).toBe("unverified");
    const snapshot = registration().snapshot!;
    snapshot.subjects[0]!.exists = false;
    const f = setup(undefined, { snapshot });
    expect(f.record.acceptance).toMatchObject({ status: "failed", code: "SUBJECT_EXPECTATION_FAILED" });
    expect(() => accept(f.coordinator, result(f.record))).toThrow();
    expect(() => setup(undefined, { snapshot: { ...snapshot, subjects: [] } })).toThrow();
  });

  it("authenticates the whole result, pins keys, and tolerates JSON property ordering", () => {
    const mutableKey = new Uint8Array(key);
    const coordinator = new DeferredAcceptanceCoordinator(new InMemoryWorkflowControlStore(), [{ ...owner, signingKey: mutableKey }]);
    const record = coordinator.register(registration());
    mutableKey.fill(0);
    const payload = result(record);
    const signature = signDeferredAcceptanceResult(payload, key);
    const tampered = { ...payload, attemptId: "spoofed" };
    expect(() => coordinator.accept(tampered, signature)).toThrow("CALLBACK_UNAUTHORIZED");
    expect(() => coordinator.accept(payload, "00")).toThrow("CALLBACK_UNAUTHORIZED");
    expect(() => coordinator.accept(payload, signDeferredAcceptanceResult(payload, new Uint8Array(32)))).toThrow("CALLBACK_UNAUTHORIZED");
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as DeferredAcceptanceResult;
    expect(coordinator.accept(reordered, signature).acceptance.status).toBe("passed");
  });

  it("rejects signed callbacks for another owner, request, attempt, spec or snapshot", () => {
    const store = new InMemoryWorkflowControlStore();
    const coordinator = new DeferredAcceptanceCoordinator(store, [owner, { id: "other", signingKey: key }]);
    const record = coordinator.register(registration());
    for (const field of ["ownerId", "requestId", "attemptId", "specDigest", "snapshotId"] as const) {
      expect(() => accept(coordinator, { ...result(record), [field]: "other" })).toThrow("STALE_ACCEPTANCE_RESULT");
    }
    expect(coordinator.read(record.id).record.revision).toBe(1);
  });

  it("rejects incomplete, duplicate or stale check/dependency receipts", () => {
    const f = setup();
    const good = result(f.record);
    if (good.result.status !== "completed") throw new Error();
    const check = good.result.checks[0]!;
    for (const checks of [[], [check, check], [{ ...check, checkId: "unknown" }], [{ ...check, attemptId: "old" }],
      [{ ...check, specRevision: 2 }], [{ ...check, snapshotId: "old" }], [{ ...check, dependencies: [] }],
      [{ ...check, dependencies: [{ ...check.dependencies[0]!, version: "old" }] }]]) {
      expect(() => accept(f.coordinator, { ...good, result: { status: "completed", checks } })).toThrow();
    }
    expect(f.coordinator.read(f.record.id).record.revision).toBe(1);
  });

  it("keeps verifier failures and infrastructure errors separate from execution", () => {
    for (const status of ["failed", "error"] as const) {
      const f = setup();
      const payload = result(f.record);
      if (payload.result.status === "completed") payload.result.checks[0]!.status = status;
      const record = accept(f.coordinator, payload);
      expect(record.acceptance.status).toBe(status);
      expect(record.outcome).toEqual(terminal);
    }
    const f = setup();
    const record = accept(f.coordinator, { ...result(f.record), result: { status: "error", code: "CONTAINER_START_FAILED" } });
    expect(record.acceptance).toMatchObject({ status: "error", code: "CONTAINER_START_FAILED", checks: [] });
  });

  it("treats exact duplicate callbacks as idempotent and conflicting finals as errors", () => {
    const f = ready();
    const payload = result(f.record);
    expect(accept(f.coordinator, payload).revision).toBe(f.record.revision);
    if (payload.result.status === "completed") payload.result.checks[0]!.code = "different";
    expect(() => accept(f.coordinator, payload)).toThrow("ACCEPTANCE_CONFLICT");
  });

  it("persists cancellation and retains late evidence without reviving readiness", async () => {
    const file = await path();
    const f = setup(sqlite(file));
    let r = f.coordinator.authorizeAction(f.record.id, f.record.revision, grant);
    r = f.coordinator.cancel(r.id, r.revision);
    const restored = new DeferredAcceptanceCoordinator(sqlite(file), [owner]);
    r = accept(restored, result(r));
    expect(r.acceptance.status).toBe("passed");
    expect(restored.read(r.id).decision.code).toBe("WORKFLOW_CANCELLED");
    expect(() => restored.authorizeAction(r.id, r.revision, grant)).toThrow("WORKFLOW_CANCELLED");
    expect(() => restored.replaceAttempt(r.id, r.revision, { ...registration(), outcome: newAttempt() })).toThrow("WORKFLOW_CANCELLED");
  });

  it("requires an explicit action grant and rejects a mismatched or revoked grant", () => {
    const f = setup();
    let r = accept(f.coordinator, result(f.record));
    expect(f.coordinator.read(r.id).decision.status).toBe("not_requested");
    r = f.coordinator.authorizeAction(r.id, r.revision, grant);
    const candidate = f.coordinator.read(r.id).decision;
    expect(() => f.coordinator.claimAction(candidate, { ...grant, grantId: "wrong" })).toThrow("ACTION_NOT_AUTHORIZED");
    r = f.coordinator.authorizeAction(r.id, r.revision, undefined);
    expect(() => f.coordinator.claimAction(candidate, grant)).toThrow("WORKFLOW_CONFLICT");
    expect(f.coordinator.read(r.id).decision.status).toBe("not_requested");
  });

  it("rechecks cancellation and blockers at claim time rather than trusting old ready", () => {
    for (const change of ["cancel", "block"] as const) {
      const f = ready();
      if (change === "cancel") f.coordinator.cancel(f.record.id, f.record.revision);
      else f.coordinator.setBlockers(f.record.id, f.record.revision, ["approval-needed"]);
      expect(() => f.coordinator.claimAction(f.decision, grant)).toThrow("WORKFLOW_CONFLICT");
      expect(f.coordinator.read(f.record.id).decision.status).toBe("blocked");
    }
  });

  it("blocks limited outcomes unless the host explicitly opts in", () => {
    const outcome = structuredClone(terminal);
    outcome.execution.status = "limited"; outcome.execution.stopReason = "max_steps";
    expect(ready(undefined, { outcome }).decision.code).toBe("LIMITED_DELIVERY_DISABLED");
    expect(ready(undefined, { outcome, allowLimitedDelivery: true }).decision.status).toBe("ready");
  });

  it("blocks cancelled, failed and unresolved execution even when acceptance passes", () => {
    const cancelled = structuredClone(terminal);
    cancelled.execution.status = "cancelled"; cancelled.execution.stopReason = "aborted";
    expect(ready(undefined, { outcome: cancelled }).decision.code).toBe("WORKFLOW_CANCELLED");
    const failed = structuredClone(terminal);
    failed.execution.status = "failed"; failed.execution.stopReason = "error";
    failed.execution.error = { code: "FAILED", message: "failed", retryable: false };
    expect(ready(undefined, { outcome: failed }).decision.code).toBe("EXECUTION_NOT_ELIGIBLE");
    const blocked = structuredClone(terminal);
    blocked.execution.unresolvedActions = [{ kind: "approval", actionId: "approval", owner: "host", state: "pending", reason: "waiting" }];
    expect(ready(undefined, { outcome: blocked }).decision.code).toBe("EXECUTION_NOT_ELIGIBLE");
  });

  it("replaces attempts with a new correlation id, original deadline and no inherited grant", () => {
    const f = ready();
    const config = registration({ outcome: newAttempt() });
    const { workflowId, deadlineAt, ...input } = config;
    const next = f.coordinator.replaceAttempt(f.record.id, f.record.revision, input);
    expect(next.requestId).not.toBe(f.record.requestId);
    expect(next.deadlineAt).toBe(f.record.deadlineAt);
    expect(next.authorization).toBeUndefined();
    expect(next.acceptance.status).toBe("pending");
    expect(() => accept(f.coordinator, result(f.record))).toThrow("STALE_ACCEPTANCE_RESULT");
    expect(() => f.coordinator.claimAction(f.decision, grant)).toThrow("WORKFLOW_CONFLICT");
    expect(accept(f.coordinator, result(next)).outcome.attemptId).toBe("attempt-2");
  });

  it("does not allow replacing the same attempt or crossing thread/turn identity", () => {
    for (const outcome of [terminal, { ...newAttempt(), threadId: "other" }, { ...newAttempt(), turnId: "other" }]) {
      const f = setup();
      const { workflowId, deadlineAt, ...input } = registration({ outcome });
      expect(() => f.coordinator.replaceAttempt(f.record.id, f.record.revision, input)).toThrow("INVALID_WORKFLOW_TRANSITION");
    }
  });

  it("bounds deferred waits and timeout publication without rewriting execution", async () => {
    const f = setup(undefined, { deadlineAt: Date.now() + 80 });
    await expect(f.coordinator.wait(f.record.id, { timeoutMs: 5, pollMs: 1 })).rejects.toMatchObject({ code: "WORKFLOW_WAIT_TIMEOUT" });
    const controller = new AbortController();
    controller.abort();
    await expect(f.coordinator.wait(f.record.id, { timeoutMs: 100, signal: controller.signal })).rejects.toThrow();
    expect(f.coordinator.read(f.record.id).record.cancelled).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(() => accept(f.coordinator, result(f.record))).toThrow("ACCEPTANCE_TIMEOUT");
    const expired = f.coordinator.expire(f.record.id, f.record.revision);
    expect(expired.acceptance).toMatchObject({ status: "error", code: "ACCEPTANCE_TIMEOUT" });
    expect(expired.outcome).toEqual(terminal);
    expect(() => accept(f.coordinator, result(f.record))).toThrow("ACCEPTANCE_CONFLICT");
  });

  it("waits independently for an external callback without authorizing an action", async () => {
    const f = setup();
    const timer = setTimeout(() => accept(f.coordinator, result(f.record)), 10);
    try {
      const state = await f.coordinator.wait(f.record.id, { timeoutMs: 1000, pollMs: 5 });
      expect(state.record.acceptance.status).toBe("passed");
      expect(state.decision.status).toBe("not_requested");
    } finally { clearTimeout(timer); }
  });

  it("does not reset an existing workflow and copies host-owned inputs and outputs", () => {
    const f = setup();
    expect(() => f.coordinator.register(registration())).toThrow("WORKFLOW_CONFLICT");
    f.record.spec.checks.length = 0;
    const copy = f.coordinator.read(f.record.id).record;
    copy.cancelled = true;
    expect(f.coordinator.read(f.record.id).record.cancelled).toBe(false);
    expect(f.coordinator.read(f.record.id).record.spec.checks).toHaveLength(1);
  });

  it("makes action claims single-consumer and survives restart without automatic replay", async () => {
    const file = await path();
    const f = ready(sqlite(file));
    const claimed = f.coordinator.claimAction(f.decision, grant);
    expect(claimed.action).toMatchObject({ ...grant, snapshotId: f.record.snapshot!.id, controlRevision: f.record.revision });
    const restored = new DeferredAcceptanceCoordinator(sqlite(file), [owner]);
    expect(restored.read(claimed.id).decision.status).toBe("claimed");
    expect(() => restored.claimAction(f.decision, grant)).toThrow("WORKFLOW_CONFLICT");
    const cancelled = restored.cancel(claimed.id, claimed.revision);
    expect(cancelled.action).toEqual(claimed.action);
    expect(restored.read(claimed.id).decision.code).toBe("WORKFLOW_CANCELLED");
  });

  it("serializes conflicting control revisions across separate SQLite connections", async () => {
    const file = await path();
    const f = ready(sqlite(file));
    const other = new DeferredAcceptanceCoordinator(sqlite(file), [owner]);
    other.cancel(f.record.id, f.record.revision);
    expect(() => f.coordinator.claimAction(f.decision, grant)).toThrow("WORKFLOW_CONFLICT");
    expect(f.coordinator.read(f.record.id).record.cancelled).toBe(true);
  });

  it("arbitrates an actual cross-process cancellation versus action claim", async () => {
    const file = await path();
    const f = ready(sqlite(file));
    const dir = dirname(file);
    const inputPath = join(dir, "input.json");
    const startPath = join(dir, "start");
    const script = join(dir, "race.ts");
    await writeFile(inputPath, JSON.stringify({ decision: f.decision, grant }));
    await writeFile(script, `
      import { existsSync, writeFileSync } from "node:fs";
      import { DeferredAcceptanceCoordinator } from ${JSON.stringify(resolve(import.meta.dir, "../../runtime/deferred-acceptance.ts"))};
      import { SqliteWorkflowControlStore } from ${JSON.stringify(resolve(import.meta.dir, "../../runtime/workflow-store.ts"))};
      const [file, input, start, mode] = process.argv.slice(2);
      const store = new SqliteWorkflowControlStore(file);
      const coordinator = new DeferredAcceptanceCoordinator(store, [{ id: "official-runner", signingKey: new Uint8Array(32).fill(7) }]);
      const { decision, grant } = await Bun.file(input).json();
      writeFileSync(start + mode, "ready");
      const deadline = Date.now() + 10000;
      while (!existsSync(start)) { if (Date.now() > deadline) throw new Error("barrier timed out"); await Bun.sleep(5); }
      try {
        if (mode === "cancel") coordinator.cancel(decision.workflowId, decision.controlRevision);
        else coordinator.claimAction(decision, grant);
        console.log(mode);
      } catch (error) { console.log(error.code); }
      finally { store.close(); }
    `);
    const processes = ["cancel", "claim"].map(mode => {
      const child = spawn(process.execPath, [script, file, inputPath, startPath, mode], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { errors += chunk; });
      const done = new Promise<{ code: number | null; output: string; errors: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => resolve({ code, output: output.trim(), errors }));
      });
      return { child, done };
    });
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        const flags = await Promise.all(["cancel", "claim"].map(mode => access(startPath + mode).then(() => true, () => false)));
        if (flags.every(Boolean)) break;
        if (Date.now() > deadline) throw new Error("child startup timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await writeFile(startPath, "go");
      const results = await Promise.all(processes.map(process => process.done));
      expect(results.map(r => r.code)).toEqual([0, 0]);
      expect(results.filter(r => r.output === "WORKFLOW_CONFLICT")).toHaveLength(1);
      expect(results.filter(r => r.output === "cancel" || r.output === "claim")).toHaveLength(1);
      const persisted = f.coordinator.read(f.record.id).record;
      expect(Number(persisted.cancelled) + Number(Boolean(persisted.action))).toBe(1);
      expect(persisted.revision).toBe(f.record.revision + 1);
    } finally { for (const process of processes) process.child.kill(); }
  });

  it("fails closed on malformed disk records instead of recovering them as passed", async () => {
    const file = await path();
    const f = setup(sqlite(file));
    const corrupted = { ...f.record, acceptance: { status: "passed", code: "FAKE", checks: [] } };
    const db = new Database(file);
    try { db.query("UPDATE workflow_control_revisions SET record_json = ? WHERE workflow_id = ?").run(JSON.stringify(corrupted), f.record.id); }
    finally { db.close(); }
    expect(() => f.coordinator.read(f.record.id)).toThrow();
  });

  it("never exposes passed or a claim when persistence fails", () => {
    const memory = new InMemoryWorkflowControlStore();
    let fail = false;
    const store: WorkflowControlStore = { load: id => memory.load(id), compareAndSwap(revision, record) {
      if (fail) throw new Error("disk full"); memory.compareAndSwap(revision, record);
    } };
    const f = setup(store);
    fail = true;
    expect(() => accept(f.coordinator, result(f.record))).toThrow("disk full");
    expect(f.coordinator.read(f.record.id).record.acceptance.status).toBe("pending");
    fail = false;
    let r = accept(f.coordinator, result(f.record));
    r = f.coordinator.authorizeAction(r.id, r.revision, grant);
    fail = true;
    expect(() => f.coordinator.claimAction(f.coordinator.read(r.id).decision, grant)).toThrow("disk full");
    expect(f.coordinator.read(r.id).record.action).toBeUndefined();
  });

  it("rechecks deadlines after store contention before publishing a result or claim", () => {
    for (const operation of ["accept", "claim"] as const) {
      const backing = new InMemoryWorkflowControlStore();
      let delayed = false;
      const store: WorkflowControlStore = { load: id => backing.load(id), compareAndSwap(revision, record) {
        // Emulate a synchronous SQLite lock wait crossing the deadline.
        if (delayed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
        backing.compareAndSwap(revision, record);
      } };
      const f = setup(store, { deadlineAt: Date.now() + 80 });
      let r = f.record;
      if (operation === "claim") {
        r = accept(f.coordinator, result(r));
        r = f.coordinator.authorizeAction(r.id, r.revision, grant);
      }
      const candidate = f.coordinator.read(r.id).decision;
      delayed = true;
      expect(() => operation === "accept" ? accept(f.coordinator, result(r)) : f.coordinator.claimAction(candidate, grant)).toThrow();
      const unchanged = backing.load(r.id)!;
      expect(unchanged.revision).toBe(r.revision);
      expect(unchanged.action).toBeUndefined();
    }
  });

  it("protects cancellation and claimed identity even through the store CAS boundary", () => {
    const f = ready();
    const cancelled = f.coordinator.cancel(f.record.id, f.record.revision);
    expect(() => f.store.compareAndSwap(cancelled.revision, { ...cancelled, cancelled: false, revision: cancelled.revision + 1 })).toThrow();
    const g = ready();
    const claimed = g.coordinator.claimAction(g.decision, grant);
    expect(() => g.store.compareAndSwap(claimed.revision, { ...claimed, action: undefined, revision: claimed.revision + 1 })).toThrow();
    expect(decideWorkflow(claimed).status).toBe("claimed");
  });
});

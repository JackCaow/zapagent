import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { InlineAcceptanceCoordinator } from "../../runtime/inline-acceptance.js";
import { InMemoryAcceptanceStore } from "../../runtime/acceptance-store.js";
import { DeferredAcceptanceCoordinator, signDeferredAcceptanceResult, type DeferredAcceptanceResult } from "../../runtime/deferred-acceptance.js";
import { InMemoryWorkflowControlStore, SqliteWorkflowControlStore } from "../../runtime/workflow-store.js";
import { WorkflowDeliveryRunner } from "../../runtime/workflow-delivery.js";
import { WorkflowActionRunner } from "../../runtime/workflow-action-runner.js";
import { HostWorkflowController } from "../../host-protocol/workflows.js";
import { HostProtocolService, HostRuntimeRegistry } from "../../host-protocol/service.js";
import { runWorkflowCommand } from "../../../src/headless/workflow.js";
import type { AgentOutcomeV1 } from "../../runtime/outcome.js";

const dirs: string[] = [];
const dbs: SqliteWorkflowControlStore[] = [];
afterEach(async () => { dbs.splice(0).forEach(s => s.close()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function path() { const d = await mkdtemp(join(tmpdir(), "zap-delivery-")); dirs.push(d); return join(d, "workflow.sqlite"); }
function sqlite(p: string) { const s = new SqliteWorkflowControlStore(p); dbs.push(s); return s; }
const owner = { id: "owner", signingKey: new Uint8Array(32).fill(5) };
const terminal: AgentOutcomeV1 = { schema: "zap.outcome", schemaVersion: 1, threadId: "thread", turnId: "turn", runId: "a", attemptId: "a", startedAt: 1, endedAt: 2,
  execution: { attemptId: "a", status: "finished", stopReason: "end_turn", finalResponse: "done", unresolvedActions: [] },
  acceptance: { attemptId: "a", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
  workflow: { attemptId: "a", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } };
const spec = { id: "spec", revision: 1, subjects: [{ id: "file", path: "result", expected: "exists" as const }], checks: [{ id: "check", verifierId: "v1", subjectIds: ["file"] }] };
const snapshot = { id: "commit-1", providerId: "git", proof: "immutable_snapshot" as const, subjects: [{ subjectId: "file", exists: true, version: "blob-1" }] };
function pending(store = new InMemoryWorkflowControlStore() as InMemoryWorkflowControlStore | SqliteWorkflowControlStore) {
  const c = new DeferredAcceptanceCoordinator(store, [owner]);
  const r = c.register({ workflowId: "flow", ownerId: owner.id, outcome: terminal, spec, snapshot, deadlineAt: Date.now() + 60_000 });
  return { c, r, store };
}
async function inline(store = new InMemoryWorkflowControlStore() as InMemoryWorkflowControlStore | SqliteWorkflowControlStore) {
  const reports = new InMemoryAcceptanceStore();
  const report = await new InlineAcceptanceCoordinator({ mode: "required", timing: "inline", spec, store: reports, timeoutMs: 1000,
    snapshotProvider: { id: "git", async preflight() {}, async capture() { return { ...snapshot, async readFile() { return new Uint8Array(); } }; } },
    verifiers: [{ id: "v1", async verify() { return [{ checkId: "check", attemptId: "a", specId: "spec", specRevision: 1,
      snapshotId: snapshot.id, dependencies: snapshot.subjects, status: "passed", code: "OK", evidenceRefs: [] }]; } }] }).evaluate(terminal);
  const c = new DeferredAcceptanceCoordinator(store, []);
  const r = await c.registerInline({ workflowId: "flow", deadlineAt: Date.now() + 60_000, recordId: report.id, store: reports });
  return { c, r, reports, report, store };
}
function actions(c: DeferredAcceptanceCoordinator, count: () => void) {
  return new WorkflowActionRunner(c, [{ actionId: "publish-v1", async execute(ctx) {
    count(); return { operationId: ctx.claim.operationId, snapshotId: ctx.snapshot.id, status: "succeeded", code: "OK", evidenceRefs: [] };
  }, async reconcile(ctx) { return { operationId: ctx.claim.operationId, snapshotId: ctx.snapshot.id, status: "unknown", code: "NOT_FOUND", evidenceRefs: [] }; } }]);
}
function request(method: string, params: Record<string, unknown> = {}) { return { version: 2, id: "req", method, threadId: "thread", params: { workflowId: "flow", ...params } }; }

describe("workflow host integration and delivery recovery", () => {
  it("imports a persisted inline report without changing execution or authorizing an action", async () => {
    const f = await inline();
    expect(f.r.acceptance.status).toBe("passed"); expect(f.r.outcome).toEqual(terminal);
    expect(f.c.read("flow").decision.status).toBe("not_requested");
    expect(await f.reports.load(f.report.id)).toEqual(f.report);
    await expect(f.c.registerInline({ workflowId: "missing", deadlineAt: Date.now() + 1000, recordId: "bad", store: f.reports })).rejects.toMatchObject({ code: "ACCEPTANCE_NOT_FOUND" });
    expect(() => f.c.beginDelivery("flow", f.r.revision)).toThrow("DELIVERY_NOT_PENDING");
  });

  it("rejects a corrupt inline report and a reserved external owner identity", async () => {
    const f = await inline();
    f.reports.load = async () => ({ ...f.report, specDigest: "stale" });
    await expect(f.c.registerInline({ workflowId: "other", deadlineAt: Date.now() + 1000, recordId: f.report.id, store: f.reports })).rejects.toThrow();
    expect(() => new DeferredAcceptanceCoordinator(f.store, [{ ...owner, id: "host:inline" }])).toThrow();
  });

  it("reopens the persisted outbox and retries with the same request id after a lost ack", async () => {
    const file = await path(); const f = pending(sqlite(file));
    const accepted = new Map<string, string>(); let calls = 0;
    const adapter = { ownerId: owner.id, async publish(job: { requestId: string }) {
      calls++; const receiptId = accepted.get(job.requestId) ?? "queue:1"; accepted.set(job.requestId, receiptId);
      if (calls === 1) throw new Error("response lost after enqueue");
      return { requestId: job.requestId, receiptId };
    } };
    await expect(new WorkflowDeliveryRunner(f.c, [adapter]).deliver("flow", { timeoutMs: 1000 })).rejects.toThrow();
    const restoredStore = sqlite(file); const restored = new DeferredAcceptanceCoordinator(restoredStore, [owner]);
    const listed = restoredStore.list().filter(r => r.acceptance.status === "pending" && !r.cancelled && !r.delivery?.receiptId);
    expect(listed).toHaveLength(1); expect(listed[0]!.requestId).toBe(f.r.requestId);
    const runner = new WorkflowDeliveryRunner(restored, [adapter]);
    const delivered = await runner.deliver(listed[0]!.id, { timeoutMs: 1000 });
    expect(delivered.delivery).toEqual({ attempts: 2, receiptId: "queue:1" });
    await runner.deliver("flow", { timeoutMs: 1000 });
    expect(calls).toBe(2); expect(accepted.size).toBe(1); expect(delivered.outcome).toEqual(terminal);
  });

  it("does not publish without a saved delivery intent or after cancellation", async () => {
    const f = pending(); let calls = 0;
    const runner = new WorkflowDeliveryRunner(f.c, [{ ownerId: owner.id, async publish(job) { calls++; return { requestId: job.requestId, receiptId: "q" }; } }]);
    f.c.cancel("flow", f.r.revision);
    await expect(runner.deliver("flow", { timeoutMs: 1000 })).rejects.toMatchObject({ code: "DELIVERY_NOT_PENDING" });
    expect(calls).toBe(0);
    const g = pending(); g.store.compareAndSwap = () => { throw new Error("disk full"); };
    await expect(new WorkflowDeliveryRunner(g.c, [{ ownerId: owner.id, async publish() { calls++; throw new Error(); } }]).deliver("flow", { timeoutMs: 1000 })).rejects.toThrow("disk full");
    expect(calls).toBe(0);
  });

  it("times out delivery, ignores late acks, and leaves a recoverable request", async () => {
    const f = pending(); let finish!: (r: { requestId: string; receiptId: string }) => void;
    const runner = new WorkflowDeliveryRunner(f.c, [{ ownerId: owner.id, async publish() { return new Promise(resolve => { finish = resolve; }); } }]);
    await expect(runner.deliver("flow", { timeoutMs: 10 })).rejects.toMatchObject({ code: "DELIVERY_TIMEOUT" });
    finish({ requestId: f.r.requestId, receiptId: "late" }); await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.c.read("flow").record.delivery).toEqual({ attempts: 1 });
  });

  it("rejects old delivery acks after attempt replacement", () => {
    const f = pending(); const begun = f.c.beginDelivery("flow", f.r.revision);
    const next = structuredClone(terminal); next.runId = next.attemptId = "b";
    next.execution.attemptId = next.acceptance.attemptId = next.workflow.attemptId = "b";
    const replaced = f.c.replaceAttempt("flow", begun.revision, { ownerId: owner.id, outcome: next, spec, snapshot });
    expect(() => f.c.acknowledgeDelivery("flow", replaced.revision, begun.requestId, "old")).toThrow("STALE_DELIVERY_RESULT");
  });

  it("allows the authenticated verifier callback to arrive before the queue ack", async () => {
    const f = pending();
    const runner = new WorkflowDeliveryRunner(f.c, [{ ownerId: owner.id, async publish(job) {
      const payload: DeferredAcceptanceResult = { workflowId: job.workflowId, ownerId: job.ownerId, requestId: job.requestId,
        attemptId: job.attemptId, specDigest: job.specDigest, snapshotId: job.snapshot.id,
        result: { status: "error", code: "VERIFIER_UNAVAILABLE" } };
      f.c.accept(payload, signDeferredAcceptanceResult(payload, owner.signingKey));
      return { requestId: job.requestId, receiptId: "queue:done" };
    } }]);
    const r = await runner.deliver("flow", { timeoutMs: 1000 });
    expect(r.acceptance.status).toBe("error"); expect(r.delivery!.receiptId).toBe("queue:done");
  });

  it("serves workflow control without loading a model runtime and isolates thread identity", async () => {
    const f = await inline();
    const service = new HostProtocolService(new HostRuntimeRegistry(), new HostWorkflowController(f.c));
    expect(await service.handle(request("workflow.read"))).toMatchObject({ ok: true, result: { record: { id: "flow" } } });
    expect(await service.handle({ ...request("workflow.read"), threadId: "other" })).toMatchObject({ ok: false, error: { code: "WORKFLOW_NOT_FOUND" } });
    expect(await service.handle({ ...request("workflow.read"), version: 1 })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CAPABILITY" } });
    expect(await service.handle(request("workflow.wait", { timeoutMs: 10 }))).toMatchObject({ ok: true });
    expect(await service.handle(request("workflow.cancel", { revision: f.r.revision }))).toMatchObject({ ok: true, result: { cancelled: true } });
  });

  it("requires host authorization and never accepts a caller-supplied grant", async () => {
    const f = await inline(); let calls = 0; let approvals = 0;
    const controller = new HostWorkflowController(f.c, { actions: actions(f.c, () => calls++), async authorize() { approvals++; return { actionId: "publish-v1", grantId: "host-authorized" }; } });
    const service = new HostProtocolService(new HostRuntimeRegistry(), controller);
    expect(await service.handle(request("workflow.dispatch", { revision: f.r.revision, actionId: "publish-v1", grantId: "forged" }))).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(calls).toBe(0); expect(approvals).toBe(0);
    expect(await service.handle(request("workflow.dispatch", { revision: f.r.revision, actionId: "publish-v1" }))).toMatchObject({ ok: true, result: { actionResult: { status: "succeeded" } } });
    expect(calls).toBe(1); expect(approvals).toBe(1);
  });

  it("rechecks cancellation during asynchronous approval before invoking an action", async () => {
    const f = await inline(); let calls = 0;
    const controller = new HostWorkflowController(f.c, { actions: actions(f.c, () => calls++), async authorize() {
      f.c.cancel("flow", f.r.revision); return { actionId: "publish-v1", grantId: "approved" };
    } });
    await expect(controller.handle("thread", "workflow.dispatch", { workflowId: "flow", revision: f.r.revision, actionId: "publish-v1" })).rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    expect(calls).toBe(0);
  });

  it("offers CLI list/read/wait/cancel over an existing database with explicit revisions", async () => {
    const file = await path(); const f = await inline(sqlite(file)); let output = "";
    const emit = (s: string) => { output = s; };
    expect(await runWorkflowCommand(["read", "--db", file, "--id", "flow"], emit)).toBe(0);
    expect(JSON.parse(output).record.id).toBe("flow");
    expect(await runWorkflowCommand(["wait", "--db", file, "--id", "flow"], emit)).toBe(0);
    expect(await runWorkflowCommand(["cancel", "--db", file, "--id", "flow"], emit)).toBe(2);
    expect(f.c.read("flow").record.cancelled).toBe(false);
    expect(await runWorkflowCommand(["cancel", "--db", file, "--id", "flow", "--revision", String(f.r.revision)], emit)).toBe(0);
    expect(await runWorkflowCommand(["wait", "--db", file, "--id", "flow"], emit)).toBe(130);
    expect(await runWorkflowCommand(["list", "--db", file], emit)).toBe(0);
    expect(JSON.parse(output).records).toHaveLength(1);
    expect(await runWorkflowCommand(["read", "--db", file + ".missing", "--id", "flow"], emit)).toBe(2);
  });

  it("routes the actual CLI before piped stdin or provider initialization", async () => {
    const file = await path(); await inline(sqlite(file));
    const result = await promisify(execFile)(process.execPath, [resolve(import.meta.dir, "../../../src/index.tsx"), "workflow", "read", "--db", file, "--id", "flow"], { timeout: 10000 });
    expect(JSON.parse(result.stdout).record.acceptance.status).toBe("passed");
    expect(result.stderr).toBe("");
  });

  it("does not turn passed acceptance into a successful CLI gate with active blockers", async () => {
    const file = await path(); const f = await inline(sqlite(file));
    f.c.setBlockers("flow", f.r.revision, ["approval-pending"]);
    expect(await runWorkflowCommand(["wait", "--db", file, "--id", "flow"], () => {})).toBe(7);
  });
});

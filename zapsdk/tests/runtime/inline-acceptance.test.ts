import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AgentEventEmitter } from "../../agent/events.js";
import { AgentRuntime } from "../../runtime/agent-runtime.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { InMemoryAcceptanceStore, JsonAcceptanceStore } from "../../runtime/acceptance-store.js";
import { GitCommitSnapshotProvider } from "../../runtime/git-acceptance-snapshot.js";
import { InlineAcceptanceCoordinator, runWithInlineAcceptance, validateInlineAcceptanceRecord,
  type InlineAcceptanceConfiguration, type InlineHostVerifier, type AcceptanceSnapshotProvider } from "../../runtime/inline-acceptance.js";
import type { AgentOutcomeV1 } from "../../runtime/outcome.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "zap-m2-")); directories.push(dir); return dir; }
const spec = { id: "deliverable", revision: 1, subjects: [{ id: "file", path: "result.txt", expected: "exists" as const }], checks: [{ id: "content", verifierId: "reader-v1", subjectIds: ["file"] }] };
const terminal: AgentOutcomeV1 = { schema: "zap.outcome", schemaVersion: 1, threadId: "t", turnId: "turn", runId: "a", attemptId: "a", startedAt: 1, endedAt: 2,
  execution: { attemptId: "a", status: "finished", stopReason: "end_turn", finalResponse: "done", unresolvedActions: [] },
  acceptance: { attemptId: "a", status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
  workflow: { attemptId: "a", status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } };

const provider: AcceptanceSnapshotProvider = { id: "fixture", async preflight() {}, async capture() {
  return { id: "snapshot-1", providerId: "fixture", proof: "immutable_snapshot", subjects: [{ subjectId: "file", exists: true, version: "immutable:v1" }], async readFile() { return new TextEncoder().encode("done"); } };
} };
const verifier: InlineHostVerifier = { id: "reader-v1", async verify({ outcome, spec, snapshot, signal }) {
  expect(new TextDecoder().decode(await snapshot.readFile("file", signal))).toBe("done");
  return spec.checks.filter(c => c.verifierId === "reader-v1").map(c => ({ checkId: c.id, attemptId: outcome.attemptId, specId: spec.id, specRevision: spec.revision,
    snapshotId: snapshot.id, dependencies: c.subjectIds.map(id => snapshot.subjects.find(s => s.subjectId === id)!), status: "passed", code: "MATCH", evidenceRefs: ["host:reader"] }));
} };
function configuration(overrides: Partial<InlineAcceptanceConfiguration> = {}): InlineAcceptanceConfiguration {
  return { mode: "required", timing: "inline", spec: structuredClone(spec), snapshotProvider: provider, verifiers: [verifier], store: new InMemoryAcceptanceStore(), timeoutMs: 1000, ...overrides };
}
function runtime(execute: () => Promise<void> = async () => {}) {
  let calls = 0;
  class Executor extends AgentEventEmitter {
    async run() { calls++; await execute(); return { text: "done", steps: 1, totalUsage: { inputTokens: 1, outputTokens: 1 }, toolResults: [] }; }
    toolDefinitions() { return []; }
    effectiveSystemPrompt() { return undefined; }
  }
  const eventStore = new InMemoryRuntimeEventStore();
  const state = new InMemoryRuntimeStateStore();
  const agent = new AgentRuntime({ threadId: "t", agent: new Executor(), eventStore, stateTracker: new RuntimeStateTracker({ threadId: "t", workspaceRoot: "/tmp", store: state }) });
  return { agent, eventStore, state, calls: () => calls };
}

describe("inline host acceptance", () => {
  it("validates the full spec and capabilities before model/tool execution", async () => {
    for (const config of [configuration({ verifiers: [] }), configuration({ spec: { ...spec, checks: [] } }),
      configuration({ spec: { ...spec, subjects: [{ id: "file", path: "../escape", expected: "exists" }] } }),
      { ...configuration(), repair: { maxAttempts: 1 } }, { ...configuration(), timing: "deferred" }, configuration({ timeoutMs: Infinity }),
      configuration({ snapshotProvider: { ...provider, async preflight() { throw new Error("unavailable"); } } })]) {
      const r = runtime();
      await expect(runWithInlineAcceptance(r.agent, "x", { acceptance: config as InlineAcceptanceConfiguration })).rejects.toThrow();
      expect(r.calls()).toBe(0);
      expect(await r.eventStore.list("t")).toHaveLength(0);
    }
  });

  it("publishes execution before verification and leaves its persisted terminal untouched", async () => {
    const r = runtime();
    const config = configuration({ verifiers: [{ id: verifier.id, async verify(context) {
      expect(r.agent.cancelTurn()).toBe(false);
      const end = (await r.eventStore.list("t")).filter(e => e.payload.type === "attempt_ended");
      expect(end).toHaveLength(1);
      expect(r.agent.lastOutcome()).toEqual(context.outcome);
      return verifier.verify(context);
    } }] });
    const result = await runWithInlineAcceptance(r.agent, "x", { acceptance: config });
    expect(result.acceptance.report.status).toBe("passed");
    expect(result.acceptance.workflow.status).toBe("ready");
    expect(result.outcome.acceptance.status).toBe("not_requested");
    expect((await r.state.load("t"))!.attemptOutcomes[result.outcome.attemptId]!.outcome).toEqual(result.outcome);
    expect(result.acceptance.outcome).toEqual(result.outcome);
    expect(r.calls()).toBe(1);
  });

  it("cannot expose ready before saving, and persistence failure preserves execution", async () => {
    const r = runtime();
    const store = new InMemoryAcceptanceStore();
    store.save = async () => { throw new Error("disk full"); };
    await expect(runWithInlineAcceptance(r.agent, "x", { acceptance: configuration({ store }) })).rejects.toMatchObject({ code: "ACCEPTANCE_PERSISTENCE_FAILED" });
    expect(r.agent.lastOutcome()!.execution.status).toBe("finished");
    expect((await r.eventStore.list("t")).filter(e => e.payload.type === "attempt_ended")).toHaveLength(1);
  });

  it("treats missing stability as unknown and never invokes a verifier", async () => {
    let called = false;
    const result = await new InlineAcceptanceCoordinator(configuration({ snapshotProvider: { ...provider, async capture() { return undefined; } },
      verifiers: [{ id: verifier.id, async verify() { called = true; return []; } }] })).evaluate(terminal);
    expect(result.report).toMatchObject({ status: "unverified", code: "STABLE_SNAPSHOT_UNAVAILABLE" });
    expect(result.workflow.status).toBe("blocked"); expect(called).toBe(false);
  });

  it("checks expected absence and existence before verifiers", async () => {
    let called = false;
    const result = await new InlineAcceptanceCoordinator(configuration({ spec: { ...spec, subjects: [{ ...spec.subjects[0]!, expected: "absent" }] },
      verifiers: [{ id: verifier.id, async verify() { called = true; return []; } }] })).evaluate(terminal);
    expect(result.report).toMatchObject({ status: "failed", code: "SUBJECT_EXPECTATION_FAILED" }); expect(called).toBe(false);
  });

  it("rejects omitted, duplicated, foreign and stale verifier receipts", async () => {
    for (const corrupt of [() => [], (rows: any[]) => [...rows, rows[0]], (rows: any[]) => [{ ...rows[0], checkId: "unknown" }],
      (rows: any[]) => [{ ...rows[0], snapshotId: "old" }], (rows: any[]) => [{ ...rows[0], attemptId: "old" }],
      (rows: any[]) => [{ ...rows[0], specRevision: 0 }], (rows: any[]) => [{ ...rows[0], dependencies: [] }]]) {
      const result = await new InlineAcceptanceCoordinator(configuration({ verifiers: [{ id: verifier.id, async verify(ctx) { return corrupt(await verifier.verify(ctx)); } }] })).evaluate(terminal);
      expect(result.report).toMatchObject({ status: "error", code: "INVALID_VERIFIER_RESULT" });
      expect(result.workflow.status).toBe("blocked");
    }
  });

  it("aggregates verifier failures without retrying the model", async () => {
    const r = runtime();
    const result = await runWithInlineAcceptance(r.agent, "x", { acceptance: configuration({ verifiers: [{ id: verifier.id, async verify(ctx) {
      return (await verifier.verify(ctx)).map(row => ({ ...row, status: "failed" as const, code: "MISMATCH" }));
    } }] }) });
    expect(result.acceptance.report.status).toBe("failed"); expect(r.calls()).toBe(1);
    expect(result.outcome.execution.status).toBe("finished");
  });

  it("aggregates multiple verifiers with error taking precedence over failure", async () => {
    const result = await new InlineAcceptanceCoordinator(configuration({
      spec: { ...spec, checks: [...spec.checks, { id: "second", verifierId: "second", subjectIds: ["file"] }] },
      verifiers: [{ id: verifier.id, async verify(ctx) { return (await verifier.verify(ctx)).map(r => ({ ...r, status: "failed" as const })); } },
        { id: "second", async verify(ctx) { const r = (await verifier.verify(ctx))[0]!; return [{ ...r, checkId: "second", status: "error" }]; } }],
    })).evaluate(terminal);
    expect(result.report.status).toBe("error"); expect(result.report.checks).toHaveLength(2);
  });

  it("rejects incomplete snapshots and prevents verifier mutation of pinned metadata", async () => {
    const incomplete = await new InlineAcceptanceCoordinator(configuration({ snapshotProvider: { ...provider, async capture(ctx) {
      return { ...(await provider.capture(ctx))!, subjects: [] };
    } } })).evaluate(terminal);
    expect(incomplete.report.code).toBe("INVALID_SNAPSHOT");
    const mutated = await new InlineAcceptanceCoordinator(configuration({ verifiers: [{ id: verifier.id, async verify(ctx) {
      ctx.snapshot.subjects[0]!.version = "replaced";
      return verifier.verify(ctx);
    } }] })).evaluate(terminal);
    expect(mutated.report.status).toBe("error");
  });

  it("does not expose undeclared subjects to a verifier", async () => {
    const result = await new InlineAcceptanceCoordinator(configuration({
      spec: { ...spec, subjects: [...spec.subjects, { id: "other", path: "other", expected: "exists" }] },
      snapshotProvider: { ...provider, async capture(ctx) {
        const snapshot = (await provider.capture(ctx))!;
        return { ...snapshot, subjects: [...snapshot.subjects, { subjectId: "other", exists: true, version: "other-v1" }] };
      } }, verifiers: [{ id: verifier.id, async verify(ctx) {
        expect(ctx.snapshot.subjects.map(s => s.subjectId)).toEqual(["file"]);
        await ctx.snapshot.readFile("other", ctx.signal); return [];
      } }],
    })).evaluate(terminal);
    expect(result.report.code).toBe("UNDECLARED_CHECK_DEPENDENCY");
  });

  it("times out ignored cancellation and discards late passed receipts", async () => {
    let resolve!: (rows: Awaited<ReturnType<InlineHostVerifier["verify"]>>) => void;
    let receipts!: Awaited<ReturnType<InlineHostVerifier["verify"]>>;
    const store = new InMemoryAcceptanceStore();
    const result = await new InlineAcceptanceCoordinator(configuration({ timeoutMs: 30, store, verifiers: [{ id: verifier.id, async verify(ctx) {
      receipts = await verifier.verify(ctx);
      return new Promise(done => { resolve = done; });
    } }] })).evaluate(terminal);
    expect(result.report).toMatchObject({ status: "error", code: "ACCEPTANCE_TIMEOUT" });
    resolve(receipts); await new Promise(done => setTimeout(done, 5));
    expect(await store.load(result.id)).toEqual(result);
  });

  it("uses one deadline across capture and verification", async () => {
    let calls = 0;
    const result = await new InlineAcceptanceCoordinator(configuration({ timeoutMs: 20,
      snapshotProvider: { ...provider, capture: async () => new Promise(() => {}) }, verifiers: [{ id: verifier.id, async verify() { calls++; return []; } }] })).evaluate(terminal);
    expect(result.report.code).toBe("ACCEPTANCE_TIMEOUT"); expect(calls).toBe(0);
  });

  it("cancels acceptance without rewriting a finished execution", async () => {
    const controller = new AbortController();
    const r = runtime();
    const result = await runWithInlineAcceptance(r.agent, "x", { signal: controller.signal, acceptance: configuration({ verifiers: [{ id: verifier.id, async verify(ctx) {
      controller.abort(); return verifier.verify(ctx);
    } }] }) });
    expect(result.outcome.execution.status).toBe("finished");
    expect(result.acceptance.report.code).toBe("ACCEPTANCE_CANCELLED");
    expect(result.acceptance.workflow.status).toBe("blocked");
  });

  it("does not start the model on aborted or unresponsive preflight", async () => {
    for (const aborted of [false, true]) {
      const controller = new AbortController(); if (aborted) controller.abort();
      const r = runtime();
      await expect(runWithInlineAcceptance(r.agent, "x", { signal: controller.signal, acceptance: configuration({ timeoutMs: 15,
        snapshotProvider: { ...provider, preflight: async () => new Promise(() => {}) } }) })).rejects.toThrow();
      expect(r.calls()).toBe(0);
    }
  });

  it("never promotes limited or failed execution to ready", async () => {
    for (const execution of [{ ...terminal.execution, status: "limited" as const, stopReason: "budget" as const },
      { ...terminal.execution, status: "failed" as const, stopReason: "error" as const, error: { code: "FAILED", message: "failed", retryable: false } }]) {
      const result = await new InlineAcceptanceCoordinator(configuration()).evaluate({ ...terminal, execution });
      expect(result.workflow.status).toBe("blocked");
      expect(result.report.status).toBe(execution.status === "limited" ? "passed" : "unverified");
    }
  });

  it("does not release an imported finished outcome with unresolved work", async () => {
    const result = await new InlineAcceptanceCoordinator(configuration()).evaluate({ ...terminal,
      execution: { ...terminal.execution, unresolvedActions: [{ actionId: "pending", owner: "host", kind: "input", state: "pending", reason: "needs input" }] } });
    expect(result.report.status).toBe("passed");
    expect(result.workflow).toMatchObject({ status: "blocked", code: "EXECUTION_NOT_ELIGIBLE" });
    const tampered = structuredClone(result); tampered.workflow.status = "ready";
    expect(() => validateInlineAcceptanceRecord(tampered)).toThrow();
  });

  it("pins spec and verifier methods before asynchronous execution", async () => {
    const config = configuration();
    const coordinator = new InlineAcceptanceCoordinator(config);
    config.spec.checks.length = 0; config.verifiers[0] = { id: verifier.id, async verify() { throw new Error("changed"); } };
    expect((await coordinator.evaluate(terminal)).report.status).toBe("passed");
  });

  it("reuses immutable reports without rerunning and rejects spec reuse", async () => {
    const config = configuration(); const coordinator = new InlineAcceptanceCoordinator(config);
    const first = await coordinator.evaluate(terminal);
    expect(await coordinator.evaluate(terminal)).toEqual(first);
    const changed = configuration({ store: config.store, spec: { ...spec, revision: 2 } });
    await expect(new InlineAcceptanceCoordinator(changed).evaluate(terminal)).rejects.toMatchObject({ code: "ACCEPTANCE_CONFLICT" });
  });
});

it("persists reports atomically across reopen and refuses conflicting writes or corrupt reads", async () => {
  const path = await directory(); const store = new JsonAcceptanceStore(path);
  await store.preflight(new AbortController().signal);
  const record = await new InlineAcceptanceCoordinator(configuration({ store })).evaluate(terminal);
  const reopened = new JsonAcceptanceStore(path);
  expect(await reopened.load(record.id)).toEqual(record);
  await Promise.all([reopened.save(record), reopened.save(record)]);
  await expect(reopened.save({ ...record, endedAt: record.endedAt + 1 })).rejects.toMatchObject({ code: "ACCEPTANCE_CONFLICT" });
  const { readdir } = await import("node:fs/promises"); const file = (await readdir(path)).find(f => f.endsWith(".json"))!;
  await writeFile(join(path, file), "{}"); await expect(reopened.load(record.id)).rejects.toThrow();
  const malformed = structuredClone(record); malformed.report.checks[0]!.dependencies = [];
  expect(() => validateInlineAcceptanceRecord(malformed)).toThrow();
});

it("verifies immutable Git blobs after the real executor commits, despite later workspace edits", async () => {
  const root = await directory(); const output = await directory();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  const snapshotProvider = new GitCommitSnapshotProvider(root);
  const r = runtime(async () => { await writeFile(join(root, "result.txt"), "done"); git("add", "."); git("commit", "-m", "fixture"); });
  const accepted = await runWithInlineAcceptance(r.agent, "create and commit", { acceptance: configuration({ snapshotProvider, store: new JsonAcceptanceStore(output), verifiers: [{ id: verifier.id, async verify(context) {
    await writeFile(join(root, "result.txt"), "later mutation");
    return verifier.verify(context);
  } }] }) });
  expect(accepted.acceptance.report.status).toBe("passed");
  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("later mutation");
  const dirty = await new InlineAcceptanceCoordinator(configuration({ snapshotProvider })).evaluate(terminal);
  expect(dirty.report.code).toBe("STABLE_SNAPSHOT_UNAVAILABLE");
});

it("Git snapshots handle deletion, large blobs and reject symlinks", async () => {
  const root = await directory(); const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65); await writeFile(join(root, "result.txt"), bytes);
  git("add", "."); git("commit", "-m", "large");
  const snapshotProvider = new GitCommitSnapshotProvider(root); const signal = new AbortController().signal;
  const snapshot = (await snapshotProvider.capture({ outcome: terminal, spec, signal }))!;
  expect(await snapshot.readFile("file", signal)).toEqual(new Uint8Array(bytes));
  git("update-index", "--assume-unchanged", "result.txt");
  expect(await snapshotProvider.capture({ outcome: terminal, spec, signal })).toBeUndefined();
  git("update-index", "--no-assume-unchanged", "result.txt");
  git("update-index", "--skip-worktree", "result.txt");
  expect(await snapshotProvider.capture({ outcome: terminal, spec, signal })).toBeUndefined();
  git("update-index", "--no-skip-worktree", "result.txt");
  const absentSpec = { ...spec, subjects: [{ id: "file", path: "removed.txt", expected: "absent" as const }] };
  expect((await snapshotProvider.capture({ outcome: terminal, spec: absentSpec, signal }))!.subjects[0]!.exists).toBe(false);
  const { symlink } = await import("node:fs/promises"); await rm(join(root, "result.txt")); await symlink("outside", join(root, "result.txt"));
  git("add", "."); git("commit", "-m", "link");
  expect(await snapshotProvider.capture({ outcome: terminal, spec, signal })).toBeUndefined();
});

it("Git snapshots do not misclassify ignored files as accepted deletions", async () => {
  const root = await directory(); const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  await writeFile(join(root, ".gitignore"), "result.txt\n"); git("add", ".gitignore"); git("commit", "-m", "ignore");
  await writeFile(join(root, "result.txt"), "still exists");
  const snapshotProvider = new GitCommitSnapshotProvider(root);
  const result = await new InlineAcceptanceCoordinator(configuration({ snapshotProvider, spec: { ...spec, subjects: [{ ...spec.subjects[0]!, expected: "absent" }] } })).evaluate(terminal);
  expect(result.report).toMatchObject({ status: "unverified", code: "STABLE_SNAPSHOT_UNAVAILABLE" });
});

it("snapshot absence can pass an explicit deletion check", async () => {
  const root = await directory(); const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  git("commit", "--allow-empty", "-m", "empty");
  const result = await new InlineAcceptanceCoordinator(configuration({ snapshotProvider: new GitCommitSnapshotProvider(root),
    spec: { ...spec, subjects: [{ ...spec.subjects[0]!, expected: "absent" }] }, verifiers: [{ id: verifier.id, async verify(ctx) {
      return [{ checkId: "content", attemptId: ctx.outcome.attemptId, specId: ctx.spec.id, specRevision: ctx.spec.revision,
        snapshotId: ctx.snapshot.id, dependencies: ctx.snapshot.subjects, status: "passed", code: "ABSENT", evidenceRefs: [] }];
    } }] })).evaluate(terminal);
  expect(result.report.status).toBe("passed");
});

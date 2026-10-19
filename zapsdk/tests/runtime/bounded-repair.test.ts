import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBoundedRepairSession, runWithBoundedRepair, type BoundedRepairOptions } from "../../runtime/bounded-repair.js";
import { RepairBudget } from "../../runtime/repair-budget.js";
import { FileBytesSnapshotProvider, FileSizeVerifier } from "../../runtime/file-acceptance.js";
import { JsonAcceptanceStore } from "../../runtime/acceptance-store.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { createAgentRuntime } from "../../runtime/factory.js";
import { operationFailure } from "../../execution/failure.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createScriptedProvider, scriptedTextResponse, scriptedToolCallResponse, type ScriptedTurn } from "../../testing/scripted-provider.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const spec = { id: "public-size", revision: 1, subjects: [{ id: "file", path: "result.txt", expected: "exists" as const }], checks: [{ id: "size", verifierId: "file-size-v1", subjectIds: ["file"] }] };
const write = (id: string, text: string) => scriptedToolCallResponse([{ id, name: "write_result", arguments: { text } }]);

async function fixture(turns: ScriptedTurn[], transport: "call" | "stream" = "call") {
  const root = await mkdtemp(join(tmpdir(), "zap-repair-"));
  directories.push(root);
  const provider = createScriptedProvider({ transport, turns });
  const registry = new ToolRegistry();
  let writes = 0;
  registry.register({ definition: { name: "write_result", description: "Write result.txt", parameters: z.object({ text: z.string() }) },
    async handler(args) { writes++; await writeFile(join(root, "result.txt"), args.text as string); return { success: true, output: "written" }; } });
  const state = new InMemoryRuntimeStateStore();
  const events = new InMemoryRuntimeEventStore();
  const store = new JsonAcceptanceStore(join(root, "acceptance"));
  const options: BoundedRepairOptions = {
    runtime: { threadId: "repair-thread", workspace: { root }, subagent: false, stateStore: state, eventStore: events,
      loopAgent: { provider: provider.provider, registry, executor: new ToolExecutor(registry, { cwd: root }), maxSteps: 10, storageProjectCwd: root } },
    acceptance: { mode: "required", timing: "inline", spec, snapshotProvider: new FileBytesSnapshotProvider(root), verifiers: [new FileSizeVerifier([{ checkId: "size", subjectId: "file", maxBytes: 4 }])], store, timeoutMs: 1000 },
    repair: { maxAttempts: 1, publicChecks: [{ checkId: "size", instruction: "result.txt must contain at most 4 bytes", repairableCodes: ["FILE_TOO_LARGE"] }] },
    budget: { modelCalls: 10, toolCalls: 5, timeoutMs: 5000 },
  };
  return { root, provider, state, events, store, options, writes: () => writes };
}

describe("bounded public repair", () => {
  it("binds feedback to versions and repeated failures, exposing diagnostics only with host opt-in", async () => {
    for (const includeDiagnostics of [false, true]) {
      const f = await fixture([write("large", "too large"), scriptedTextResponse("done"), scriptedTextResponse("still done"),
        write("small", "okay"), scriptedTextResponse("fixed")]);
      f.options.repair.maxAttempts = 2;
      f.options.repair.publicChecks[0]!.includeDiagnostics = includeDiagnostics;
      const verifier = f.options.acceptance.verifiers[0]!;
      f.options.acceptance.verifiers = [{ id: verifier.id, async verify(context) {
        return (await verifier.verify(context)).map(check => ({ ...check, evidenceRefs: ["PRIVATE_EVIDENCE"],
          publicDiagnostic: { expected: "at most 4 bytes", actual: "PUBLIC_OBSERVATION" } }));
      } }];
      const result = await runWithBoundedRepair("write", f.options);
      expect(result.status).toBe("passed");
      const feedback = JSON.stringify(f.provider.requests()[3]!.messages);
      expect(feedback).toContain('consecutiveFailures\\\":2');
      expect(feedback).toContain(result.attempts[1]!.acceptance.snapshot!.id);
      expect(feedback).toContain("sha256:");
      expect(feedback).not.toContain("PRIVATE_EVIDENCE");
      expect(feedback.includes("PUBLIC_OBSERVATION")).toBe(includeDiagnostics);
    }
  });

  it("rejects malformed public diagnostics without dispatching repair", async () => {
    const f = await fixture([write("large", "too large"), scriptedTextResponse("done")]);
    const verifier = f.options.acceptance.verifiers[0]!;
    f.options.acceptance.verifiers = [{ id: verifier.id, async verify(context) {
      return (await verifier.verify(context)).map(check => ({ ...check, publicDiagnostic: { expected: "size", actual: "x".repeat(4097) } }));
    } }];
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.status).toBe("stopped");
    expect(result.attempts[0]!.acceptance.report.status).toBe("error");
    expect(f.provider.requests()).toHaveLength(2);
  });

  it("allows host observers before execution but never resets the session or accepts budget overrides", async () => {
    const f = await fixture([write("small", "okay"), scriptedTextResponse("done")]);
    const session = createBoundedRepairSession(f.options);
    let ended = 0;
    session.runtime.on("run_ended", () => { ended++; });
    expect((await session.run("write")).status).toBe("passed");
    expect(ended).toBe(1);
    await expect(session.run("again")).rejects.toMatchObject({ code: "REPAIR_SESSION_USED" });
    const other = await fixture([]);
    const invalid = createBoundedRepairSession(other.options);
    await expect(invalid.run("write", { signal: new AbortController().signal } as any)).rejects.toMatchObject({ code: "UNSUPPORTED_REPAIR_MODE" });
    expect(other.provider.requests()).toHaveLength(0);
  });

  for (const transport of ["call", "stream"] as const) it(`repairs a real file with immutable receipts and a new attempt (${transport})`, async () => {
    const f = await fixture([write("large", "too large"), scriptedTextResponse("done"), write("small", "okay"), scriptedTextResponse("fixed")], transport);
    const result = await runWithBoundedRepair("Write the result", f.options);
    expect(result.status).toBe("passed");
    expect(result.attempts).toHaveLength(2);
    const [first, second] = result.attempts;
    expect(first!.outcome.turnId).toBe(second!.outcome.turnId);
    expect(first!.outcome.attemptId).not.toBe(second!.outcome.attemptId);
    expect(first!.acceptance.report.status).toBe("failed");
    expect(second!.acceptance.report.status).toBe("passed");
    expect(first!.acceptance.snapshot!.id).not.toBe(second!.acceptance.snapshot!.id);
    expect(await f.store.load(first!.acceptance.id)).toEqual(first!.acceptance);
    expect((await f.state.load("repair-thread"))!.attemptOutcomes[first!.outcome.attemptId]!.outcome).toEqual(first!.outcome);
    expect((await f.events.list("repair-thread")).filter(event => event.payload.type === "attempt_ended")).toHaveLength(2);
    expect(result.usage).toMatchObject({ modelCalls: 4, toolCalls: 2 });
    expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("okay");
    const prompts = JSON.stringify(f.provider.requests()[2]!.messages);
    expect(prompts).toContain("FILE_TOO_LARGE");
    expect(prompts).toContain("at most 4 bytes");
    expect(prompts).not.toContain("file-size:9:max:4");
  });

  it("never repairs passed, private, missing-subject or verifier-error results", async () => {
    for (const mode of ["passed", "private", "missing", "error"]) {
      const f = await fixture(mode === "missing" ? [scriptedTextResponse("done")] : [write("write", mode === "passed" ? "okay" : "too large"), scriptedTextResponse("done")]);
      if (mode === "private") f.options.repair.publicChecks[0]!.repairableCodes = ["OTHER"];
      if (mode === "error") f.options.acceptance.verifiers = [{ id: "file-size-v1", async verify() { throw new Error("private verifier diagnostic"); } }];
      const result = await runWithBoundedRepair("write", f.options);
      expect(result.attempts).toHaveLength(1);
      expect(result.status).toBe(mode === "passed" ? "passed" : "stopped");
      expect(JSON.stringify(f.provider.requests())).not.toContain("private verifier diagnostic");
    }
  });

  it("stops after the configured repair count even when the model keeps claiming success", async () => {
    const f = await fixture([write("w1", "too large"), scriptedTextResponse("done"), scriptedTextResponse("definitely done")]);
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_ATTEMPT_LIMIT");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every(item => item.acceptance.report.status === "failed")).toBe(true);
  });

  it("enforces cumulative model admission across repair attempts", async () => {
    const f = await fixture([write("w1", "too large"), scriptedTextResponse("done"), write("w2", "okay")]);
    f.options.budget.modelCalls = 2;
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_MODEL_LIMIT");
    expect(f.provider.requests()).toHaveLength(2);
    expect(f.writes()).toBe(1);
    expect(result.usage.modelCalls).toBe(2);
  });

  it("enforces cumulative tool admission before a repair handler can write", async () => {
    const f = await fixture([write("w1", "too large"), scriptedTextResponse("done"), write("w2", "okay")]);
    const lifecycle: string[] = [];
    f.options.runtime.loopAgent.executor = f.options.runtime.loopAgent.executor.withExecutionLifecycle(event => { lifecycle.push(event.status); });
    f.options.budget.toolCalls = 1;
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_TOOL_LIMIT");
    expect(f.writes()).toBe(1);
    expect(result.usage.toolCalls).toBe(1);
    expect(lifecycle).toEqual(["started", "completed"]);
    expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("too large");
  });

  it("fails closed on acceptance persistence failure before a repair is dispatched", async () => {
    const f = await fixture([write("w1", "too large"), scriptedTextResponse("done")]);
    f.options.acceptance.store = { async preflight() {}, async load() { return undefined; }, async save() { throw new Error("disk full"); } };
    await expect(runWithBoundedRepair("write", f.options)).rejects.toMatchObject({ code: "ACCEPTANCE_PERSISTENCE_FAILED" });
    expect(f.provider.requests()).toHaveLength(2);
    expect(Object.keys((await f.state.load("repair-thread"))!.attemptOutcomes)).toHaveLength(1);
  });

  it("does not repair through a denied tool prerequisite", async () => {
    const f = await fixture([write("w1", "too large"), scriptedToolCallResponse([{ id: "denied", name: "restricted", arguments: {} }]), scriptedTextResponse("done")]);
    f.options.runtime.loopAgent.registry.register({ definition: { name: "restricted", description: "denied", parameters: z.object({}) },
      async handler() { return { success: false, output: "", failure: operationFailure("POLICY_DENIED", "policy") }; } });
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_PREREQUISITE_BLOCKED");
    expect(result.attempts).toHaveLength(1);
  });

  it("cancels during verification and never dispatches a repair", async () => {
    const f = await fixture([write("w1", "too large"), scriptedTextResponse("done")]);
    const controller = new AbortController();
    f.options.signal = controller.signal;
    f.options.acceptance.verifiers = [{ id: "file-size-v1", async verify() { controller.abort(); return new Promise(() => {}); } }];
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_CANCELLED");
    expect(result.lastOutcome!.execution.status).toBe("finished");
    expect(f.provider.requests()).toHaveLength(2);
  });

  it("does not expose a late saved acceptance as passed after the shared deadline", async () => {
    const f = await fixture([write("w1", "okay"), scriptedTextResponse("done")]);
    f.options.budget.timeoutMs = 100;
    let release!: () => void;
    f.options.acceptance.store = { async preflight() {}, async load() { return undefined; }, async save() { await new Promise<void>(resolve => { release = resolve; }); } };
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_DEADLINE_EXCEEDED");
    expect(result.status).toBe("stopped");
    release();
    expect(result.lastOutcome!.execution.status).toBe("finished");
  });

  it("rejects unsupported and malformed setup before any provider call", async () => {
    for (const mode of ["budget", "private-id", "subagent", "legacy", "verifier", "size-config"]) {
      const f = await fixture([scriptedTextResponse("unused")]);
      if (mode === "budget") f.options.budget.timeoutMs = Infinity;
      if (mode === "private-id") f.options.repair.publicChecks[0]!.checkId = "foreign";
      if (mode === "subagent") (f.options.runtime as any).subagent = {};
      if (mode === "legacy") f.options.runtime.completionEvidence = async () => ({});
      if (mode === "verifier") f.options.acceptance.verifiers = [];
      if (mode === "size-config") f.options.acceptance.verifiers = [new FileSizeVerifier([{ checkId: "size", subjectId: "foreign", maxBytes: 4 }])];
      await expect(runWithBoundedRepair("write", f.options)).rejects.toThrow();
      expect(f.provider.requests()).toHaveLength(0);
    }
  });

  it("honors a pre-cancelled workflow without creating an attempt", async () => {
    const f = await fixture([scriptedTextResponse("unused")]);
    f.options.signal = AbortSignal.abort();
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_CANCELLED");
    expect(result.attempts).toHaveLength(0);
    expect(f.provider.requests()).toHaveLength(0);
  });

  it("ignores late provider success after the workflow deadline", async () => {
    const f = await fixture([]);
    f.options.budget.timeoutMs = 100;
    let finish!: (value: ReturnType<typeof scriptedTextResponse>) => void;
    f.options.runtime.loopAgent.provider = { call: () => new Promise(resolve => { finish = resolve; }) };
    const result = await runWithBoundedRepair("write", f.options);
    expect(result.code).toBe("REPAIR_DEADLINE_EXCEEDED");
    finish(scriptedTextResponse("late success"));
    expect(result.status).toBe("stopped");
  });

  it("refuses stale repair lineage", async () => {
    for (const mode of ["outcome", "legacy"]) {
      const f = await fixture([scriptedTextResponse("one"), scriptedTextResponse("two")]);
      const runtime = createAgentRuntime(f.options.runtime);
      const first = await runtime.runWithOutcome("one");
      if (mode === "outcome") await runtime.runWithOutcome("two");
      else await runtime.run("two");
      await expect(runtime.runRepairWithOutcome("repair", first.outcome.attemptId)).rejects.toMatchObject({ code: "STALE_REPAIR_ATTEMPT" });
      expect(f.provider.requests()).toHaveLength(2);
    }
  });

  it("returns at the shared deadline while a terminal write remains pending", async () => {
    const f = await fixture([scriptedTextResponse("done")]);
    f.options.budget.timeoutMs = 150;
    let unblock!: () => void, settled!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const drained = new Promise<void>(resolve => { settled = resolve; });
    f.options.runtime.onSealingProgress = event => {
      if (event.stage === "ownership_release" && event.status === "completed") settled();
    };
    const append = f.events.append.bind(f.events);
    f.events.append = async event => {
      if (event.payload.type === "attempt_ended") await blocked;
      await append(event);
    };
    try {
      const result = await runWithBoundedRepair("write", f.options);
      expect(result).toMatchObject({ status: "stopped", code: "REPAIR_DEADLINE_EXCEEDED", attempts: [] });
      expect(result.lastOutcome).toBeUndefined();
      expect(f.provider.requests()).toHaveLength(1);
      expect(Object.values((await f.state.load("repair-thread"))!.attemptOutcomes)[0]!.publication).toBe("pending");
    } finally { unblock(); }
    await drained;
    expect((await f.events.list("repair-thread")).filter(event => event.payload.type === "attempt_ended")).toHaveLength(1);
    expect(f.provider.requests()).toHaveLength(1);
  });
});

describe("immutable file acceptance", () => {
  it("pins dirty file bytes and returns copies; enforces inclusive byte limits", async () => {
    const f = await fixture([]);
    await writeFile(join(f.root, "result.txt"), "中文");
    const provider = new FileBytesSnapshotProvider(f.root);
    const context = { spec, signal: new AbortController().signal, outcome: {} as any };
    const snapshot = (await provider.capture(context))!;
    await writeFile(join(f.root, "result.txt"), "new");
    const bytes = await snapshot.readFile("file", context.signal);
    expect(bytes.length).toBe(6);
    bytes.fill(0);
    expect(new TextDecoder().decode(await snapshot.readFile("file", context.signal))).toBe("中文");
    for (const maxBytes of [5, 6]) {
      const verifier = new FileSizeVerifier([{ checkId: "size", subjectId: "file", maxBytes }]);
      const rows = await verifier.verify({ ...context, outcome: { attemptId: "a" } as any, snapshot, deadlineAt: Date.now() + 1000 });
      expect(rows[0]!.status).toBe(maxBytes === 6 ? "passed" : "failed");
    }
  });

  it("rejects oversized snapshots, symlinks and undeclared reads", async () => {
    const f = await fixture([]);
    await writeFile(join(f.root, "result.txt"), "too large");
    const context = { spec, signal: new AbortController().signal, outcome: {} as any };
    expect(await new FileBytesSnapshotProvider(f.root, 4).capture(context)).toBeUndefined();
    const provider = new FileBytesSnapshotProvider(f.root);
    const snapshot = (await provider.capture(context))!;
    await expect(snapshot.readFile("foreign", context.signal)).rejects.toThrow();
    await rm(join(f.root, "result.txt"));
    await symlink("outside", join(f.root, "result.txt"));
    expect(await provider.capture(context)).toBeUndefined();
  });
});

describe("shared repair provider admission", () => {
  it("shares primary, fallback and summarizer admissions and closes after use", async () => {
    const budget = new RepairBudget({ modelCalls: 2, toolCalls: 0, timeoutMs: 1000 });
    let calls = 0;
    const inner = { async call() { calls++; return scriptedTextResponse("ok"); } };
    try {
      await budget.wrap(inner).call([]);
      await budget.wrap(inner).call([]);
      expect(() => budget.wrap(inner).call([])).toThrow("REPAIR_MODEL_LIMIT");
      expect(calls).toBe(2);
    } finally { budget.close(); }
  });
});

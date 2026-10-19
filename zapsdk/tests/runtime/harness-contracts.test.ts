import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAgentRuntime } from "../../runtime/factory.js";
import { collectRuntimeCompletionEvidence } from "../../runtime/completion-evidence.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { createRuntimeStateSnapshot } from "../../runtime/state-types.js";
import { emptyToolEffects } from "../../tools/effects.js";
import { ToolExecutor, type ToolExecutorOptions } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { DefaultToolPolicyEngine } from "../../policy/engine.js";
import { operationFailure } from "../../execution/index.js";
import { createScriptedProvider, scriptedTextResponse, scriptedToolCallResponse } from "../../testing/scripted-provider.js";
import type { HarnessPolicyOverrides } from "../../harness/policy.js";
import type { CompletionEvidenceProvider } from "../../harness/completion.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(policy?: HarnessPolicyOverrides, verification?: CompletionEvidenceProvider, approval?: () => Promise<boolean>, transport: "call" | "stream" = "call", executorOptions: Partial<ToolExecutorOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zap-harness-contract-"));
  directories.push(root);
  const path = join(root, "result.txt");
  const registry = new ToolRegistry();
  let writes = 0;
  registry.register({
    definition: {
      name: "write_result", description: "write result", parameters: z.object({}),
      resolveEffects: () => ({ ...emptyToolEffects(), filesystem: [{ kind: "filesystem", operation: "create", paths: [path] }], workspace: { mode: "root-integration" } }),
    },
    handler: async () => { writes++; await writeFile(path, "result"); return { success: true, output: "written" }; },
  });
  const scripted = createScriptedProvider({ transport, turns: [
    scriptedToolCallResponse([{ id: "write-1", name: "write_result", arguments: {} }]),
    scriptedTextResponse("done"),
  ] });
  const events = new InMemoryRuntimeEventStore();
  const state = new InMemoryRuntimeStateStore();
  const runtime = createAgentRuntime({
    threadId: "thread", workspace: { root }, subagent: false, stateStore: state, eventStore: events,
    loopAgent: { provider: scripted.provider, registry, executor: new ToolExecutor(registry, { cwd: root, onApproval: approval, ...executorOptions }), maxToolRetries: 0 },
    harnessPolicy: policy, completionEvidence: verification,
  });
  return { runtime, path, writes: () => writes, scripted, events, state, root };
}

describe("production harness contracts", () => {
  for (const transport of ["call", "stream"] as const) {
    it(`requires verifier acceptance for a mutation (${transport})`, async () => {
      const f = await fixture(undefined, undefined, undefined, transport);
      await f.runtime.run("write a result");
      expect(f.writes()).toBe(1);
      expect(await readFile(f.path, "utf8")).toBe("result");
      expect(f.runtime.lastCompletionAssessment()).toMatchObject({ status: "incomplete", success: false, modelClaimedSuccess: true });
      expect(f.runtime.lastCompletionAssessment()?.ledger.evidence.some((item) => item.kind === "artifact" && item.source === "runtime")).toBe(true);
    });
  }

  it("completes verified changes and preserves actual approval provenance", async () => {
    const f = await fixture({ autonomy: "supervised" }, async () => ({ verification: { satisfied: true, source: "verifier", detail: "artifact acceptance passed" } }), async () => true);
    await f.runtime.run("write a result");
    expect(f.runtime.lastCompletionAssessment()).toMatchObject({ status: "completed", evidenceState: "verified" });
    expect(f.runtime.lastCompletionAssessment()?.ledger.evidence.some((item) => item.kind === "approval" && item.source === "runtime" && item.satisfied)).toBe(true);
  });

  it("does not let a host verifier erase an artifact changed after tool execution", async () => {
    const f = await fixture(undefined, async () => {
      await writeFile(f.path, "tampered");
      return { verification: { satisfied: true, source: "verifier", detail: "passed" } };
    });
    // Collection must happen after the verifier to observe its final artifact state.
    await f.runtime.run("write a result");
    expect(f.runtime.lastCompletionAssessment()?.status).toBe("incomplete");
  });

  it("keeps verifier infrastructure failures visible without false completion", async () => {
    const f = await fixture(undefined, async () => { throw new Error("verifier offline"); });
    await f.runtime.run("write a result");
    expect(f.runtime.lastCompletionAssessment()).toMatchObject({ status: "incomplete", infrastructureOutcome: "failed" });
  });

  it("enforces capabilities before handler side effects", async () => {
    const f = await fixture({ execution: { allowedCapabilities: ["read"] } });
    const result = await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
    expect(result.toolResults[0]?.failure?.code).toBe("POLICY_DENIED");
    expect(f.runtime.lastCompletionAssessment()?.status).toBe("incomplete");
  });

  for (const transport of ["call", "stream"] as const) {
    for (const retry of [false, true]) {
      it(`${retry ? "accepts an exact successful retry" : "keeps unrelated same-tool success from clearing a refusal"} (${transport})`, async () => {
        const registry = new ToolRegistry();
        registry.register({
          definition: { name: "operate", description: "read a target", parameters: z.object({ path: z.string() }), resolveEffects: () => emptyToolEffects() },
          handler: async () => ({ success: true, output: "read" }),
        });
        const scripted = createScriptedProvider({ transport, turns: [
          scriptedToolCallResponse([{ id: "denied", name: "operate", arguments: { path: "first" } }]),
          scriptedToolCallResponse([{ id: "success", name: "operate", arguments: { path: retry ? "first" : "second" } }]),
          scriptedTextResponse("done"),
        ] });
        let attempts = 0;
        const hostPolicy = new DefaultToolPolicyEngine();
        const state = new InMemoryRuntimeStateStore();
        const runtime = createAgentRuntime({
          threadId: "retry", workspace: { root: process.cwd() }, subagent: false, stateStore: state,
          loopAgent: {
            provider: scripted.provider, registry, maxToolRetries: 0,
            executor: new ToolExecutor(registry, { policyEngine: { evaluate(request) {
              return ++attempts === 1 ? { decision: "deny", reason: "temporarily unavailable" }
                : hostPolicy.evaluate(request);
            } } }),
          },
        });
        const result = await runtime.run("read first then retry or read second");
        expect(result.toolResults.map((item) => item.failure?.code ?? item.success)).toEqual(["POLICY_DENIED", true]);
        expect(runtime.lastCompletionAssessment()?.status).toBe(retry ? "completed" : "incomplete");
        const runs = Object.values((await state.load("retry"))!.toolRuns);
        expect(runs.every((run) => run.argumentsHash !== undefined)).toBe(true);
        expect(runs[0]!.argumentsHash === runs[1]!.argumentsHash).toBe(retry);
      });
    }
  }

  it("keeps boundary failures without invocation identity blocked", async () => {
    const store = new InMemoryRuntimeStateStore();
    await store.update("thread", () => {
      const state = createRuntimeStateSnapshot({ threadId: "thread", workspaceRoot: "/tmp", now: 1 });
      state.toolRuns.denied = { toolRunId: "denied", threadId: "thread", turnId: "turn", runId: "run", toolName: "operate", status: "failed", success: false, failure: operationFailure("POLICY_DENIED", "policy"), createdAt: 1, updatedAt: 2 };
      state.toolRuns.success = { toolRunId: "success", threadId: "thread", turnId: "turn", runId: "run", toolName: "operate", status: "completed", success: true, createdAt: 3, updatedAt: 4 };
      return state;
    });
    const evidence = await collectRuntimeCompletionEvidence(store, { threadId: "thread", turnId: "turn", runId: "run", contract: {}, result: { text: "done", steps: 0, toolResults: [], totalUsage: { inputTokens: 0, outputTokens: 0 } } });
    expect(evidence.delivery?.blocked).toBe(true);
  });

  it("supervised writes require an approval callback even for auto tools", async () => {
    const f = await fixture({ autonomy: "supervised" });
    const result = await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
    expect(result.toolResults[0]?.failure?.code).toBe("APPROVAL_REQUIRED");
  });

  it("requires checkpoint coverage before writes", async () => {
    const f = await fixture({ execution: { checkpoint: "before-write" } });
    const result = await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
    expect(result.toolResults[0]?.failure?.code).toBe("CHECKPOINT_REQUIRED");
  });

  it("rejects direct root mutations when isolated writes are required", async () => {
    const f = await fixture({ execution: { workspaceMode: "isolated-write" } });
    await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
  });

  it("rejects an unsupported cost cap before the first model call", async () => {
    await expect(fixture({ budgets: { costUsd: 1 } })).rejects.toThrow("no authoritative cost meter");
  });

  it("retains an explicit V1 natural completion contract", async () => {
    const f = await fixture({ version: 1 });
    await f.runtime.run("write a result");
    expect(f.runtime.lastCompletionAssessment()?.status).toBe("completed");
  });

  it("does not reuse historical approval and merge evidence", async () => {
    const store = new InMemoryRuntimeStateStore();
    await store.update("thread", () => {
      const state = createRuntimeStateSnapshot({ threadId: "thread", workspaceRoot: "/tmp", now: 1 });
      state.merges.old = { mergeId: "old", threadId: "thread", turnId: "old-turn", artifactIds: [], status: "completed", createdAt: 1, updatedAt: 2 };
      return state;
    });
    const evidence = await collectRuntimeCompletionEvidence(store, { threadId: "thread", turnId: "new-turn", runId: "run", contract: {}, result: { text: "answer", steps: 0, toolResults: [], totalUsage: { inputTokens: 0, outputTokens: 0 } } });
    expect(evidence.merges).toEqual([]);
    expect(evidence.delivery).toMatchObject({ mutated: false, blocked: false });
  });
});


describe("harness policy inheritance and observability", () => {
  it("does not let the legacy approval escape hatch bypass supervised mode", async () => {
    const f = await fixture({ autonomy: "supervised" }, undefined, undefined, "call", { allowConfirmWithoutApproval: true });
    await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
  });

  it("blocks approval escalation in bounded mode", async () => {
    let approvals = 0;
    const f = await fixture({ autonomy: "bounded" }, undefined, async () => { approvals++; return true; }, "call", {
      policyEngine: { evaluate(request) { return { decision: "ask", reason: "host approval", request: { call: request.call, effects: request.effects, proposedGrant: { callId: request.call.id, expiresAt: Date.now() + 10000, filesystem: { read: [], write: [request.workspace.root] } } } }; } },
    });
    await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
    expect(approvals).toBe(0);
  });

  it("executes only after required checkpoint coverage succeeds", async () => {
    const covered: string[][] = [];
    const f = await fixture({ execution: { checkpoint: "before-write" } }, undefined, undefined, "call", { onTrackEdit: async (paths) => { covered.push(paths); } });
    await f.runtime.run("write a result");
    expect(covered).toEqual([[f.path]]);
    expect(f.writes()).toBe(1);
  });

  for (const failCoverage of [false, true]) {
    it(`${failCoverage ? "blocks execution if combined coverage fails" : "covers and fingerprints both path declarations"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "zap-combined-coverage-"));
      directories.push(root);
      const paths = [join(root, "first"), join(root, "second")];
      await Promise.all(paths.map((path) => writeFile(path, "old")));
      const registry = new ToolRegistry();
      registry.register({
        definition: {
          name: "two_paths", description: "write two files", parameters: z.object({}),
          writesPath: () => ["./first"],
          resolveEffects: () => ({ ...emptyToolEffects(), filesystem: [{ kind: "filesystem", operation: "modify", paths }] }),
        },
        handler: async () => { await Promise.all(paths.map((path) => writeFile(path, "new"))); return { success: true, output: "written" }; },
      });
      const covered: string[][] = [];
      const executor = new ToolExecutor(registry, {
        cwd: root, checkpointMode: "before-write", onTrackEdit: async (requested, options) => {
          covered.push(requested);
          expect(options?.required).toBe(true);
          if (failCoverage && requested.includes(paths[1]!)) throw new Error("second file cannot be backed up");
        },
      });
      const result = await executor.execute("two_paths", {});
      expect(covered).toEqual([["./first", paths[1]!]]);
      expect(result.success).toBe(!failCoverage);
      expect(await readFile(paths[1]!, "utf8")).toBe(failCoverage ? "old" : "new");
      if (failCoverage) expect(result.failure?.code).toBe("CHECKPOINT_REQUIRED");
      else expect(result.runtime?.writeEvidence?.paths.map((item) => item.path)).toEqual(paths);
    });
  }

  it("fails closed when required checkpoint creation throws", async () => {
    const f = await fixture({ execution: { checkpoint: "before-write" } }, undefined, undefined, "call", { onTrackEdit: async () => { throw new Error("backup failed"); } });
    await f.runtime.run("write a result");
    expect(f.writes()).toBe(0);
  });

  it("skips elective backups when the policy selects never", async () => {
    let backups = 0;
    const f = await fixture({ execution: { checkpoint: "never" } }, undefined, undefined, "call", { onTrackEdit: async () => { backups++; } });
    await f.runtime.run("write a result");
    expect(f.writes()).toBe(1);
    expect(backups).toBe(0);
  });

  for (const level of ["minimal", "standard", "debug"] as const) {
    it(`applies ${level} observability without removing lifecycle events`, async () => {
      const f = await fixture({ observability: { level } });
      await f.runtime.run("write a result", { contextPrefix: "stable context", contextDiagnostics: () => ({ totalChars: 14, estimatedTokens: 4, hash: "stable", segments: [] }) });
      const events = await f.events.list("thread");
      const steps = events.flatMap((event) => event.payload.type === "agent_event" && event.payload.item.event.type === "run_step" ? [event.payload.item.event] : []);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.some((step) => step.context !== undefined)).toBe(level !== "minimal");
      expect(events.some((event) => event.payload.type === "turn_incomplete")).toBe(true);
    });
  }
});


describe("child executor policy", () => {
  it("inherits required coverage and cannot bypass capability restrictions", async () => {
    const registry = new ToolRegistry();
    let inherited: Omit<ToolExecutorOptions, "onApproval"> | undefined;
    const scripted = createScriptedProvider({ transport: "call", turns: [] });
    createAgentRuntime({
      threadId: "child-policy", workspace: { root: process.cwd() },
      harnessPolicy: { autonomy: "supervised", execution: { allowedCapabilities: ["read"], checkpoint: "before-write" } },
      loopAgent: {
        provider: scripted.provider, registry, executor: new ToolExecutor(registry, { allowConfirmWithoutApproval: true }),
        subagentFactory: (args) => {
          inherited = args.executorOptions;
          return { definition: { name: "agent", description: "fixture", parameters: z.object({}) }, handler: async () => ({ success: true, output: "fixture" }) };
        },
      },
      subagent: {},
    });
    expect(inherited?.checkpointMode).toBe("before-write");
    expect(inherited?.allowConfirmWithoutApproval).toBe(false);
    expect(registry.has("agent")).toBe(false);
    const childRegistry = new ToolRegistry();
    let childWrites = 0;
    childRegistry.register({
      definition: {
        name: "child_write", description: "child write", parameters: z.object({}),
        resolveEffects: () => ({ ...emptyToolEffects(), filesystem: [{ kind: "filesystem", operation: "create", paths: [join(process.cwd(), "child-result")] }], workspace: { mode: "isolated-write" } }),
      },
      handler: async () => { childWrites++; return { success: true, output: "written" }; },
    });
    const child = new ToolExecutor(childRegistry, { ...inherited, workspace: { root: process.cwd(), mode: "isolated-write" } });
    const result = await child.execute("child_write", {});
    expect(result.failure?.code).toBe("POLICY_DENIED");
    expect(childWrites).toBe(0);
  });
});

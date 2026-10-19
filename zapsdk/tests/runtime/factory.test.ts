import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  createScriptedProvider,
  scriptedTextResponse,
  scriptedToolCallResponse,
} from "../../testing/scripted-provider.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { createAgentRuntime } from "../../runtime/factory.js";
import { InMemoryRuntimeStateStore } from "../../runtime/state-store.js";
import { createRuntimeStateSnapshot } from "../../runtime/state-types.js";
import { subagentTool } from "../../builtin-tools/subagent.js";

describe("createAgentRuntime", () => {
  it("maps V2 policy budgets into one generic adaptive decision path", async () => {
    const scripted = createScriptedProvider({
      transport: "call",
      turns: [
        scriptedToolCallResponse([{
          id: "write-1",
          name: "write_result",
          arguments: {},
        }]),
        scriptedTextResponse("verified response"),
      ],
    });
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "write_result", description: "writes", parameters: z.object({}) },
      handler: async () => ({ success: true, output: "written" }),
    });
    const eventStore = new InMemoryRuntimeEventStore();
    const runtime = createAgentRuntime({
      threadId: "adaptive-policy-thread",
      workspace: { root: process.cwd() },
      loopAgent: {
        provider: scripted.provider,
        registry,
        executor: new ToolExecutor(registry),
      },
      harnessPolicy: {
        version: 2,
        budgets: { modelTurns: 2 },
      },
      subagent: false,
      eventStore,
    });

    await expect(runtime.run("make the change")).resolves.toMatchObject({ text: "verified response" });
    expect(scripted.requests()).toHaveLength(2);
    expect(scripted.requests()[1]?.messages.some((message) => (
      typeof message.content === "string"
      && message.content.includes("Reason code: unverified_workspace_change")
    ))).toBe(true);
    const decisions = (await eventStore.list("adaptive-policy-thread")).flatMap((event) => (
      event.payload.type === "agent_event"
      && event.payload.item.event.type === "observation"
      && event.payload.item.event.kind === "budget_decision"
        ? [event.payload.item.event.detail]
        : []
    ));
    expect(decisions.some((decision) => (
      decision?.action === "converge"
      && decision.reasonCode === "unverified_workspace_change"
    ))).toBe(true);
  });

  for (const profile of ["legacy", "outcome-v1"] as const) it(`routes ${profile} Agent Tool execution through the durable Coordinator`, async () => {
    const scripted = createScriptedProvider({
      transport: "call",
      turns: [
        scriptedToolCallResponse([{
          id: "agent-call-1",
          name: "agent",
          arguments: { task: "inspect runtime", agent_type: "explore" },
        }]),
        scriptedTextResponse("child report"),
        scriptedTextResponse("root synthesis"),
      ],
    });
    const registry = new ToolRegistry();
    const eventStore = new InMemoryRuntimeEventStore();
    const stateStore = new InMemoryRuntimeStateStore();
    const runtime = createAgentRuntime({
      threadId: "coordinator-production-thread",
      workspace: { root: process.cwd() },
      loopAgent: {
        provider: scripted.provider,
        registry,
        executor: new ToolExecutor(registry),
        subagentFactory: subagentTool,
        maxSteps: 3,
      },
      subagent: { maxConcurrency: 2 },
      stateStore,
      eventStore,
    });

    const execution = profile === "outcome-v1" ? await runtime.runWithOutcome("delegate this") : undefined;
    const result = execution?.loopResult ?? await runtime.run("delegate this");
    if (execution) expect(execution.outcome.execution.status).toBe("finished");

    expect(result.text).toBe("root synthesis");
    const state = await stateStore.load("coordinator-production-thread");
    const childRuns = Object.values(state?.coordinator?.runs ?? {});
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      toolCallId: "agent-call-1",
      agentType: "explore",
      status: "completed",
      success: true,
    });
    const lifecycle = (await eventStore.list("coordinator-production-thread"))
      .flatMap((event) => event.payload.type === "agent_event"
        && event.payload.item.event.type === "agent_run_state"
        && event.payload.item.event.run.runId === childRuns[0]?.runId
        ? [event.payload.item.event.run]
        : []);
    expect(lifecycle.map((run) => run.status)).toEqual([
      "scheduled",
      "starting",
      "running",
      "completed",
    ]);
  });

  it("runs the production LoopAgent through the shared runtime assembly", async () => {
    const scripted = createScriptedProvider({
      transport: "call",
      turns: [scriptedTextResponse("factory result")],
    });
    const registry = new ToolRegistry();
    const store = new InMemoryRuntimeEventStore();
    const stateStore = new InMemoryRuntimeStateStore();
    let ended = 0;
    const runtime = createAgentRuntime({
      threadId: "factory-thread",
      workspace: { root: process.cwd() },
      loopAgent: {
        provider: scripted.provider,
        registry,
        executor: new ToolExecutor(registry),
        maxSteps: 1,
      },
      subagent: false,
      eventStore: store,
      stateStore,
      onRunEnd: async () => { ended++; },
    });

    const result = await runtime.run("hello");

    expect(result.text).toBe("factory result");
    expect(ended).toBe(1);
    expect(scripted.requests()).toHaveLength(1);
    expect((await store.list("factory-thread")).map((event) => event.payload.type)).toEqual([
      "turn_started",
      "agent_event",
      "agent_event",
      "agent_event",
      "agent_event",
      "agent_event",
      "turn_completed",
    ]);
    const state = await stateStore.load("factory-thread");
    expect(state?.thread.status).toBe("idle");
    expect(state?.owner).toBeUndefined();
    expect(Object.values(state?.turns ?? {}).map((turn) => turn.status)).toEqual(["completed"]);
    expect(Object.values(state?.runs ?? {}).map((run) => run.status)).toEqual(["completed"]);
  });

  it("persists the active turn before the first provider side effect", async () => {
    const scripted = createScriptedProvider({
      transport: "call",
      turns: [scriptedTextResponse("must not run")],
    });
    const registry = new ToolRegistry();
    const stateStore = new InMemoryRuntimeStateStore();
    const originalUpdate = stateStore.update.bind(stateStore);
    stateStore.update = async (...args) => {
      await originalUpdate(...args);
      throw new Error("state disk unavailable");
    };
    const runtime = createAgentRuntime({
      threadId: "fail-closed-thread",
      workspace: { root: process.cwd() },
      loopAgent: {
        provider: scripted.provider,
        registry,
        executor: new ToolExecutor(registry),
        maxSteps: 1,
      },
      subagent: false,
      stateStore,
    });

    await expect(runtime.run("hello")).rejects.toThrow("state disk unavailable");
    expect(scripted.requests()).toHaveLength(0);
  });

  it("keeps repeated model tool-call ids distinct across turns", async () => {
    const scripted = createScriptedProvider({
      transport: "call",
      turns: [
        scriptedToolCallResponse([{
          id: "tool-1",
          name: "confirm_write",
          arguments: { value: "first" },
        }]),
        scriptedTextResponse("first done"),
        scriptedToolCallResponse([{
          id: "tool-1",
          name: "confirm_write",
          arguments: { value: "second" },
        }]),
        scriptedTextResponse("second done"),
      ],
    });
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({ value: z.string() }),
        permission: "confirm",
      },
      handler: async () => ({
        success: true,
        output: "ok",
        runtime: {
          checkpoint: { attempted: true, covered: true },
          writeEvidence: {
            paths: [{
              path: "/workspace/result.txt",
              before: { exists: false },
              after: { exists: true, kind: "file", size: 2, sha256: "test-hash" },
            }],
          },
        },
      }),
    });
    const stateStore = new InMemoryRuntimeStateStore();
    const runtime = createAgentRuntime({
      threadId: "repeated-tool-id-thread",
      workspace: { root: process.cwd() },
      loopAgent: {
        provider: scripted.provider,
        registry,
        executor: new ToolExecutor(registry, { onApproval: async () => true }),
        maxSteps: 2,
      },
      subagent: false,
      stateStore,
    });

    await runtime.run("first");
    await runtime.run("second");

    const state = await stateStore.load("repeated-tool-id-thread");
    expect(Object.keys(state?.toolRuns ?? {})).toHaveLength(2);
    expect(Object.keys(state?.approvals ?? {})).toHaveLength(2);
    expect(Object.values(state?.toolRuns ?? {}).every((toolRun) => toolRun.status === "completed")).toBe(true);
    expect(Object.values(state?.toolRuns ?? {}).every((toolRun) => (
      toolRun.checkpoint?.covered === true
      && toolRun.writeEvidence?.paths[0]?.after.sha256 === "test-hash"
    ))).toBe(true);
    expect(Object.values(state?.approvals ?? {}).every((approval) => approval.status === "approved")).toBe(true);
  });

  it("surfaces startup recovery reports to the host", async () => {
    const scripted = createScriptedProvider({
      transport: "call",
      turns: [scriptedTextResponse("continued"), scriptedTextResponse("continued again")],
    });
    const registry = new ToolRegistry();
    const stateStore = new InMemoryRuntimeStateStore();
    const interrupted = createRuntimeStateSnapshot({
      threadId: "recovery-visible-thread",
      workspaceRoot: process.cwd(),
      now: 1_000,
    });
    interrupted.owner = { instanceId: "dead-runtime", pid: 999_999, startedAt: 1_000 };
    interrupted.thread.status = "running";
    interrupted.thread.activeTurnId = "old-turn";
    interrupted.turns["old-turn"] = {
      turnId: "old-turn",
      threadId: interrupted.threadId,
      rootRunId: "old-run",
      status: "running",
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    interrupted.runs["old-run"] = {
      runId: "old-run",
      threadId: interrupted.threadId,
      turnId: "old-turn",
      agentType: "root",
      taskPreview: "interrupted",
      status: "running",
      sequence: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    await stateStore.update(interrupted.threadId, () => interrupted);
    const surfaced: string[] = [];
    const runtime = createAgentRuntime({
      threadId: interrupted.threadId,
      workspace: { root: process.cwd() },
      loopAgent: {
        provider: scripted.provider,
        registry,
        executor: new ToolExecutor(registry),
        maxSteps: 1,
      },
      subagent: false,
      stateStore,
      onRecovery: (reports) => {
        surfaced.push(...reports.map((report) => report.threadId));
      },
    });

    await runtime.run("continue");
    await runtime.run("continue again");

    expect(surfaced).toEqual([interrupted.threadId]);
    expect(runtime.lastRecoveryReports().map((report) => report.threadId)).toEqual([
      interrupted.threadId,
    ]);
  });
});

it("rejects explicit legacy provenance and unsupported acceptance before provider or tool calls", async () => {
  const scripted = createScriptedProvider({ transport: "call", turns: [scriptedTextResponse("unused")] });
  const registry = new ToolRegistry();
  const create = (extra: Partial<Parameters<typeof createAgentRuntime>[0]> = {}) => createAgentRuntime({
    threadId: "preflight", workspace: { root: process.cwd() }, subagent: false,
    loopAgent: { provider: scripted.provider, registry, executor: new ToolExecutor(registry) }, ...extra,
  });
  for (const extra of [
    { completionEvidence: async () => ({}) },
    { harnessPolicy: { completion: { id: "delivery-response-v2" } } },
    { harnessPolicy: { task: { completion: { requirements: [] } } } },
  ]) await expect(create(extra).runWithOutcome("x")).rejects.toThrow("legacy completion");
  for (const config of [{ mode: "required", timing: "inline" }, { mode: "required", timing: "deferred" }, { mode: "observe", timing: "none", repair: {} }]) {
    await expect(create().runWithOutcome("x", { acceptance: config as any })).rejects.toThrow();
  }
  expect(scripted.requests()).toHaveLength(0);
});

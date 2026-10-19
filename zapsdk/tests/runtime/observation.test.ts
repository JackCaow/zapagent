import { expect, it } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime } from "../../runtime/factory.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { createScriptedProvider, scriptedToolCallResponse, scriptedTextResponse } from "../../testing/scripted-provider.js";
import { readFileTool } from "../../builtin-tools/filesystem.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import type { ScriptedProviderRequest } from "../../testing/scripted-provider.js";
import type { RuntimeObservation } from "../../runtime/observation.js";

for (const transport of ["call", "stream"] as const) it(`observes scoped real ${transport} tools without changing outcome`, async () => {
  const work = mkdtempSync(join(tmpdir(), "zap-watch-sdk-"));
  try {
    for (const observerMode of ["off", "collect", "throw", "reject"] as const) {
      const observations: RuntimeObservation[] = [], registry = new ToolRegistry(); let executed = 0;
      registry.register({ definition: { name: "probe", description: "fixture", parameters: z.object({}), readOnly: true, permission: "confirm" },
        handler: async () => { executed++; return { success: true, output: "PRIVATE_OUTPUT" }; } });
      const provider = createScriptedProvider({ transport, turns: [scriptedToolCallResponse([{ id: "same", name: "probe", arguments: {} }]), scriptedTextResponse("PRIVATE_FINAL")] });
      const runtime = createAgentRuntime({ threadId: "fixture", workspace: { root: work }, subagent: false,
        observer: observerMode === "off" ? undefined : { observe(event) { if (observerMode === "throw") throw Error("observer"); if (observerMode === "reject") return Promise.reject(Error("observer async")); observations.push(event); } },
        loopAgent: { provider: provider.provider, registry, executor: new ToolExecutor(registry, { onApproval: async () => true }), maxSteps: 3 } });
      const result = await runtime.runWithOutcome("PRIVATE_PROMPT");
      expect(result.outcome.execution.status).toBe("finished"); expect(result.loopResult.text).toBe("PRIVATE_FINAL");
      expect(executed).toBe(1); expect(provider.requests()).toHaveLength(2);
      if (observerMode === "collect") {
        const calls = observations.filter(e => e.kind === "tool_execution");
        expect(calls.map(e => e.kind === "tool_execution" ? e.event.status : "")).toEqual(["started", "completed"]);
        expect(calls.every(e => e.kind === "tool_execution" && e.scope.runId === result.outcome.runId)).toBe(true);
        expect(calls[0]?.kind === "tool_execution" && calls[1]?.kind === "tool_execution" && calls[0].executionSpanId === calls[1].executionSpanId).toBe(true);
        expect(observations.some(e => e.kind === "lifecycle" && e.phase === "sealing")).toBe(true);
        expect(observations.some(e => e.kind === "runtime_event" && e.event.payload.type === "attempt_ended")).toBe(true);
      }
      await runtime.close();
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

it("preserves observation ownership through coordinator queues and reused root/child call IDs", async () => {
  const work = mkdtempSync(join(tmpdir(), "zap-watch-sdk-child-"));
  try {
    const observations: RuntimeObservation[] = [], registry = new ToolRegistry();
    for (const id of ["same", "other"]) writeFileSync(join(work, id + ".txt"), "child " + id);
    const read = readFileTool({ defaultCwd: work, allowedPaths: [work] });
    registry.register({ ...read, definition: { ...read.definition, permission: "auto" } });
    const respond = (request: Readonly<ScriptedProviderRequest>) => {
      if (request.toolNames.includes("agent") || request.messages.some(message => message.role === "tool_result")) return scriptedTextResponse("summary");
      const id = request.messages.some(message => message.role === "user" && message.content === "inspect same") ? "same" : "other";
      return scriptedToolCallResponse([{ id: "same", name: "read_file", arguments: { path: join(work, id + ".txt") } }]);
    };
    const provider = createScriptedProvider({ transport: "call", turns: [
      scriptedToolCallResponse(["same", "other"].map(id => ({ id, name: "agent", arguments: { task: "inspect " + id, agent_type: "explore" } }))),
      ...Array.from({ length: 5 }, () => respond),
    ] });
    const runtime = createAgentRuntime({ threadId: "children", workspace: { root: work }, observer: { observe: e => { observations.push(e); } },
      loopAgent: { provider: provider.provider, registry, executor: new ToolExecutor(registry, { onApproval: async () => true }), subagentFactory: subagentTool, maxSteps: 4 },
      subagent: { maxConcurrency: 1 } });
    const { outcome } = await runtime.runWithOutcome("inspect");
    const executions = observations.filter(e => e.kind === "tool_execution" && e.event.status === "started");
    expect(executions).toHaveLength(4);
    const childExecutions = executions.filter(e => e.kind === "tool_execution" && e.event.toolName === "read_file");
    expect(new Set(childExecutions.map(e => e.kind === "tool_execution" && e.scope.runId)).size).toBe(2);
    expect(observations.some(e => e.kind === "runtime_event" && e.event.payload.type === "agent_event"
      && e.event.payload.item.event.type === "agent_run_state" && e.event.payload.item.event.run.status === "waiting_capacity")).toBe(true);
    const child = executions.find(e => e.kind === "tool_execution" && e.event.toolName === "read_file");
    expect(child?.kind).toBe("tool_execution");
    if (child?.kind !== "tool_execution") throw Error("No child observation");
    expect(child.scope.runId).not.toBe(outcome.runId); expect(child.scope.parentRunId).toBe(outcome.runId);
    expect(child.scope.turnId).toBe(outcome.turnId); expect(child.event.toolCallId).toBe("same");
    expect(observations.some(e => e.kind === "run_binding" && e.childRunId === child.scope.runId)).toBe(true);
    await runtime.close();
  } finally { rmSync(work, { recursive: true, force: true }); }
});

it("does not leak a watched parent's context into an independent unobserved runtime", async () => {
  const { currentRuntimeObservation, withRuntimeObservation } = await import("../../runtime/observation.js");
  let seen: unknown = "not called";
  await withRuntimeObservation({ scope: { threadId: "outer", turnId: "t", runId: "r" }, observer: { observe() {} }, isActive: () => true }, async () => {
    await withRuntimeObservation(undefined, async () => { await Promise.resolve(); seen = currentRuntimeObservation(); });
    expect(currentRuntimeObservation()?.scope.threadId).toBe("outer");
  });
  expect(seen).toBeUndefined();
});

it("observes actual user-input wait settlement while keeping the question in the existing tool path", async () => {
  const { askUserQuestionTool } = await import("../../builtin-tools/ask-user.js");
  const { withRuntimeObservation } = await import("../../runtime/observation.js");
  const events: RuntimeObservation[] = [];
  const tool = askUserQuestionTool({ callbacks: { async ask() {
    expect(events.map(e => e.kind === "input_wait" ? e.phase : "")).toEqual(["requested"]);
    return [{ question: "CANARY_QUESTION", answers: ["CANARY_ANSWER"] }];
  } } });
  const result = await withRuntimeObservation({ scope: { threadId: "input", turnId: "turn", runId: "run" }, isActive: () => true,
    observer: { observe: e => { events.push(e); } } }, () => tool.handler({ questions: [] }, undefined, { toolCallId: "q", step: 0 }));
  expect(result.success).toBe(true); expect(result.output).toContain("CANARY_ANSWER");
  expect(events.map(e => e.kind === "input_wait" ? e.phase : "")).toEqual(["requested", "settled"]);
  expect(JSON.stringify(events)).not.toContain("CANARY_");
});

import { expect, it } from "bun:test";
import { WatchHub } from "../../src/watch/hub.js";
import { watchToolKey } from "../../src/watch/protocol.js";
import type { RuntimeEvent } from "../../zapsdk/runtime/types.js";
import type { AgentEvent } from "../../zapsdk/agent/events.js";

const scope = { threadId: "thread", turnId: "turn", runId: "root" };
function agent(sequence: number, event: AgentEvent, runId = "root"): RuntimeEvent {
  return { schemaVersion: 3, eventId: "event" + sequence, sequence, timestamp: Date.now(), ...scope, runId, correlationId: "turn",
    payload: { type: "agent_event", item: { itemId: "item" + sequence, ...scope, runId, type: "agent_event", event, createdAt: Date.now() } } };
}
it("keeps metadata only, scoped tool identity, distinct attempts and replay consistency", () => {
  const hub = new WatchHub();
  try {
    hub.observe({ kind: "tool_catalog", names: ["probe"] });
    for (const [i, runId] of ["a", "b"].entries()) {
      const child = { ...scope, runId, parentRunId: "root" };
      hub.observe({ kind: "runtime_event", event: agent(i + 1, { type: "content_final", kind: "tool_call", id: "same", step: 1,
        toolName: "probe", arguments: { key: "CANARY_SECRET" } }, runId) });
      for (const executionSpanId of ["exec1", "exec2"]) hub.observe({ kind: "tool_execution", scope: child, executionSpanId,
        event: { executionId: "same", toolCallId: "same", toolName: "probe", sessionId: "CANARY_SECRET", argumentsHash: "CANARY_SECRET",
          error: "CANARY_SECRET", step: 1, status: "completed", timestamp: Date.now() } });
    }
    const s = hub.snapshot(); expect(s.nodes.filter(n => n.kind === "tool")).toHaveLength(2);
    expect(s.nodes.filter(n => n.kind === "tool").every(n => n.executionSpans?.length === 2)).toBe(true);
    expect(JSON.stringify(s)).not.toContain("CANARY_SECRET");
    const state = new Map(s.nodes.map(n => [n.id, n])); const changes: string[] = [];
    const subscription = hub.connect(hub.instanceId, s.throughSeq, json => changes.push(json))!;
    hub.observe({ kind: "runtime_event", event: agent(3, { type: "content_final", kind: "tool_result", id: "same", step: 1, toolName: "probe",
      result: { success: false, output: "CANARY_SECRET", error: "CANARY_SECRET" } }, "a") });
    for (const json of changes) for (const change of JSON.parse(json).changes) if (change.op === "node.upsert") state.set(change.node.id, change.node);
    expect([...state.values()]).toEqual(hub.snapshot().nodes);
    expect(hub.snapshot().nodes.find(n => n.id === watchToolKey({ ...scope, runId: "a" }, 1, "same"))?.success).toBe(false);
    expect(JSON.stringify(changes)).not.toContain("CANARY_SECRET"); subscription.close();
  } finally { hub.close(); }
});
it("resets old/foreign/future cursors and preserves current state under ring eviction", () => {
  const hub = new WatchHub({ maxFrames: 2 });
  try {
    for (let sequence = 1; sequence <= 8; sequence++) hub.observe({ kind: "runtime_event", event: agent(sequence, { type: "status", status: "thinking" }) });
    expect(hub.connect(hub.instanceId, 0, () => {})).toBeUndefined();
    expect(hub.connect("foreign", hub.seq, () => {})).toBeUndefined();
    expect(hub.connect(hub.instanceId, hub.seq + 1, () => {})).toBeUndefined();
    expect(hub.snapshot().nodes[0]?.activity).toBe("thinking"); expect(hub.snapshot().coverage.truncated).toBe(true);
  } finally { hub.close(); }
});
it("exposes explicit capacity loss instead of silently pretending a complete graph", () => {
  const hub = new WatchHub({ maxNodes: 1 });
  try {
    hub.observe({ kind: "runtime_event", event: agent(1, { type: "status", status: "writing" }, "a") });
    hub.observe({ kind: "runtime_event", event: agent(2, { type: "status", status: "writing" }, "b") });
    expect(hub.snapshot().nodes).toHaveLength(1); expect(hub.snapshot().diagnostics.active_capacity).toBeGreaterThan(0);
  } finally { hub.close(); }
});
it("distinguishes approval from execution and never resurrects a terminal cancelled tool", () => {
  const hub = new WatchHub();
  try {
    const event = { toolName: "probe", toolCallId: "call", step: 1, approvalId: "ap", argumentsHash: "private", timestamp: Date.now() };
    hub.observe({ kind: "approval", scope, approvalOccurrence: "ap", event: { ...event, status: "approved" } });
    expect(hub.snapshot().nodes.find(n => n.kind === "tool")?.wasExecuted).toBe(false);
    expect(hub.snapshot().nodes.find(n => n.kind === "tool")?.status).toBe("authorized");
    hub.observe({ kind: "runtime_event", event: agent(1, { type: "content_final", kind: "tool_result", id: "call", step: 1, toolName: "probe",
      result: { success: false, output: "", failure: { code: "CANCELLED", source: "executor", message: "private" } as any } }) });
    hub.observe({ kind: "tool_execution", scope, executionSpanId: "late", event: { ...event, executionId: "late", status: "completed" } });
    expect(hub.snapshot().nodes.find(n => n.kind === "tool")?.status).toBe("cancelled");
    expect(hub.snapshot().diagnostics.late_event).toBeGreaterThan(0);
  } finally { hub.close(); }
});

it("projects input waiting without disclosing questions and exposes projection failures", () => {
  const hub = new WatchHub();
  try {
    hub.observe({ kind: "input_wait", scope, toolCallId: "question", step: 1, phase: "requested" });
    expect(hub.snapshot().nodes.find(n => n.kind === "run")?.activity).toBe("waiting_input");
    expect(hub.snapshot().nodes.find(n => n.kind === "tool")?.status).toBe("waiting_input");
    hub.observe({ kind: "input_wait", scope, toolCallId: "question", step: 1, phase: "settled" });
    expect(hub.snapshot().nodes.find(n => n.kind === "run")?.pendingInputs).toBe(0);
    expect(hub.snapshot().nodes.find(n => n.kind === "tool")?.status).toBe("settling");
    hub.observe({ kind: "runtime_event", event: { ...agent(1, { type: "status", status: "thinking" }), payload: null } } as any);
    expect(hub.snapshot().diagnostics.projection_error).toBe(1);
    expect(hub.snapshot().coverage.reasons).toContain("projection_error");
  } finally { hub.close(); }
});

it("closes observation without inventing child completion or reopening detached TUI sessions", () => {
  const hub = new WatchHub();
  try {
    hub.observe({ kind: "runtime_event", event: { ...agent(1, { type: "status", status: "thinking" }), payload: { type: "turn_started" } } as any });
    hub.observe({ kind: "run_binding", scope: { ...scope, rootRunId: scope.runId }, childRunId: "child", toolCallId: "spawn", step: 0 });
    hub.session(scope.threadId, "closed");
    hub.observe({ kind: "runtime_event", event: { ...agent(2, { type: "status", status: "thinking" }), payload: { type: "turn_failed", interrupted: true } } as any });
    const child = hub.snapshot().nodes.find(n => n.scope.runId === "child");
    expect(child?.terminal).toBe(false); expect(child?.observationClosed).toBe(true); expect(child?.coverage).toBe("partial");
    expect(hub.snapshot().sessions[0]?.status).toBe("closed");
    hub.observe({ kind: "runtime_event", event: agent(3, { type: "status", status: "writing" }, "child") });
    expect(hub.snapshot().nodes.find(n => n.scope.runId === "child")?.activity).toBeUndefined();
    expect(hub.snapshot().diagnostics.late_event).toBeGreaterThan(0);
    hub.session(scope.threadId, "idle"); expect(hub.snapshot().sessions[0]?.status).toBe("idle");
  } finally { hub.close(); }
});


it("marks a transport failure as lost observation without inventing an execution outcome", () => {
  const hub = new WatchHub();
  try {
    hub.observe({ kind: "runtime_event", event: agent(1, { type: "status", status: "thinking" }) });
    hub.stop("transport_error");
    const snapshot = hub.snapshot();
    expect(snapshot.diagnostics.transport_error).toBe(1);
    expect(snapshot.nodes[0]?.terminal).toBe(false);
    expect(snapshot.nodes[0]?.observationClosed).toBe(true);
    expect(snapshot.nodes[0]?.coverage).toBe("partial");
    expect(snapshot.outcomes).toHaveLength(0);
    expect(snapshot.processState).toBe("stopping");
  } finally { hub.close(); }
});

/** Synthetic events for UI preview only. No model calls, tools, or approvals execute. */
import { WatchHub } from "../src/watch/hub.js";
import { WatchServer } from "../src/watch/server.js";
import type { AgentEvent } from "../zapsdk/agent/events.js";
const hub = new WatchHub(), server = await new WatchServer(hub).start();
const scope = { threadId: "DEMO · Watch 动态预览", turnId: "preview", runId: "main-agent" };
let sequence = 0;
function emit(event: AgentEvent, runId = scope.runId) {
  sequence++;
  const scoped = { ...scope, runId, ...(runId !== scope.runId ? { parentRunId: scope.runId } : {}) };
  hub.observe({ kind: "runtime_event", event: { schemaVersion: 3, eventId: `event-${sequence}`, sequence, timestamp: Date.now(), ...scoped, correlationId: "preview", payload: { type: "agent_event", item: { itemId: `item-${sequence}`, ...scoped, type: "agent_event", event, createdAt: Date.now() } } } });
}
function call(id: string, name: string, runId = scope.runId) {
  emit({ type: "content_final", kind: "tool_call", id, step: 1, toolName: name, arguments: {} }, runId);
  hub.observe({ kind: "tool_execution", scope: { ...scope, runId }, executionSpanId: id, event: { executionId: id, toolCallId: id, toolName: name, argumentsHash: "demo", step: 1, status: "started", timestamp: Date.now() } });
}
function done(id: string, name: string, runId = scope.runId) {
  emit({ type: "content_final", kind: "tool_result", id, step: 1, toolName: name, result: { success: true, output: "" } }, runId);
}
hub.observe({ kind: "tool_catalog", names: ["read_file", "agent", "bash", "grep"] });
hub.session(scope.threadId, "running");
emit({ type: "status", status: "thinking" });
call("read-01", "read_file"); done("read-01", "read_file");
call("delegate-01", "agent");
hub.observe({ kind: "run_binding", scope, childRunId: "explore-agent", toolCallId: "delegate-01", step: 1 });
emit({ type: "status", status: "thinking" }, "explore-agent");
call("grep-01", "grep", "explore-agent");
emit({ type: "content_final", kind: "tool_call", id: "check-01", step: 1, toolName: "bash", arguments: {} });
hub.observe({ kind: "approval", scope, approvalOccurrence: "approval-preview", event: { toolName: "bash", toolCallId: "check-01", step: 1, approvalId: "approval-preview", argumentsHash: "demo", timestamp: Date.now(), status: "requested" } });
let phase = 0;
const timer = setInterval(() => {
  emit({ type: "status", status: phase++ % 2 ? "thinking" : "writing" }, "explore-agent");
}, 3000);
console.log("Synthetic UI preview — no agent/tool execution.\n" + server.url);
process.on("SIGINT", async () => { clearInterval(timer); await server.close(); process.exit(0); });

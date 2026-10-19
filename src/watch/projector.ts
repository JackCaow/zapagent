import type { AgentEvent } from "../../zapsdk/agent/events.js";
import type { RuntimeObservation, ObservationScope } from "../../zapsdk/runtime/observation.js";
import type { WatchNode, WatchScope, WatchMutation, WatchEdge, WatchSession, WatchOutcome, WatchTimelineItem } from "./protocol.js";
import { watchRunKey, watchToolKey, watchKey } from "./protocol.js";

const runStates = new Set(["scheduled", "waiting_dependency", "waiting_capacity", "starting", "running", "waiting_approval", "waiting_input", "cancelling", "validating", "ready_to_merge", "merging", "completed", "incomplete", "blocked", "failed", "cancelled"]);
const terminal = new Set(["completed", "incomplete", "blocked", "failed", "cancelled", "finished", "limited", "exited", "returned"]);
const roles = new Set(["root", "general", "explore", "plan", "claude", "codex"]);
const externalTools = new Set(["bash", "read_file", "write_file", "edit_file", "shell", "command_execution", "file_change", "mcp_tool_call"]);
const idSafe = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function validWatchScope(scope: WatchScope): boolean {
  return [scope.threadId, scope.turnId, scope.runId].every(idSafe) && (scope.parentRunId === undefined || idSafe(scope.parentRunId))
    && (scope.rootRunId === undefined || idSafe(scope.rootRunId));
}

/** Metadata-only projection. Never stores model input, content or raw SDK objects. */
export class WatchProjector {
  readonly nodes = new Map<string, WatchNode>();
  readonly edges = new Map<string, WatchEdge>();
  readonly sessions = new Map<string, WatchSession>();
  readonly outcomes = new Map<string, WatchOutcome>();
  readonly timeline: WatchTimelineItem[] = [];
  readonly diagnostics: Record<string, number> = {};
  private readonly tools = new Set<string>();
  private readonly births = new Map<string, number>();
  private readonly sourceSequences = new Map<string, number>();
  private readonly counters = new Map<string, { text: number; thinking: number; dirty: boolean }>();
  private changes: WatchMutation[] = [];
  private timelineId = 0;
  private readonly closedTurns = new Set<string>();
  private readonly roots = new Map<string, string>();
  private readonly endedAttempts: string[] = [];
  constructor(readonly maxNodes = 4096, readonly now = Date.now, readonly monotonic = () => performance.now()) {}

  private begin() { this.changes = []; }
  private diagnostic(code: string) {
    const count = Math.min(Number.MAX_SAFE_INTEGER, (this.diagnostics[code] ?? 0) + 1);
    this.diagnostics[code] = count;
    this.changes.push({ op: "diagnostic.set", code, count });
  }
  observationFailed(code: "projection_error" | "transport_error"): WatchMutation[] {
    this.begin(); this.diagnostic(code); return this.changes;
  }
  closeObservation(): WatchMutation[] {
    this.begin(); this.diagnostic("transport_error");
    for (const node of this.nodes.values()) if (!node.terminal && !node.observationClosed) {
      this.add({ ...node, observationClosed: true, coverage: "partial", updatedAt: this.now() });
    }
    return this.changes;
  }
  registerSession(threadId: string, status: WatchSession["status"]): WatchMutation[] {
    this.begin(); this.session(threadId, status, true); return this.changes;
  }
  private session(threadId: string, status: WatchSession["status"], fromHost = false) {
    if (!idSafe(threadId)) { this.diagnostic("invalid_identity"); return; }
    // A detached TUI session can still publish its final cancellation outcome.
    if (!fromHost && this.sessions.get(threadId)?.status === "closed") return;
    if (!this.sessions.has(threadId) && this.sessions.size >= 16) {
      const old = [...this.sessions.values()].find(value => value.status !== "running");
      if (!old) { this.diagnostic("session_capacity"); return; }
      this.sessions.delete(old.threadId); this.changes.push({ op: "session.remove", id: old.threadId });
    }
    const session = { threadId, status }; this.sessions.set(threadId, session);
    this.changes.push({ op: "session.upsert", session });
  }
  private add(node: WatchNode): WatchNode | undefined {
    const previous = this.nodes.get(node.id);
    if (!previous && this.nodes.size >= this.maxNodes) {
      const candidate = [...this.nodes.values()].find(value => value.terminal);
      if (candidate) this.remove(candidate.id);
      else { this.diagnostic("active_capacity"); return undefined; }
    }
    if (!previous) this.births.set(node.id, this.monotonic());
    const safe = { ...node, elapsedMs: previous?.terminal || previous?.observationClosed ? previous.elapsedMs
      : Math.max(0, Math.round(this.monotonic() - (this.births.get(node.id) ?? this.monotonic()))) };
    this.nodes.set(node.id, safe);
    this.changes.push({ op: "node.upsert", node: structuredClone(safe) });
    return safe;
  }
  private remove(id: string) {
    for (const [edgeId, edge] of this.edges) if (edge.from === id || edge.to === id) {
      this.edges.delete(edgeId); this.changes.push({ op: "edge.remove", id: edgeId });
    }
    this.nodes.delete(id); this.births.delete(id); this.counters.delete(id);
    this.changes.push({ op: "node.remove", id }); this.diagnostic("history_evicted");
  }
  private run(scope: WatchScope, patch: Partial<WatchNode> = {}): WatchNode | undefined {
    const id = watchRunKey(scope), previous = this.nodes.get(id), at = this.now();
    const node: WatchNode = { id, kind: "run", scope: { ...scope }, label: scope.parentRunId ? "agent" : "root",
      status: "running", source: "runtime", coverage: "full", createdAt: at, updatedAt: at, elapsedMs: 0, terminal: false,
      ...previous, ...patch };
    // Preserve an authoritative terminal against late activity and result callbacks.
    if (previous?.terminal && patch.status && patch.status !== previous.status) { this.diagnostic("late_event"); return previous; }
    return this.add(node);
  }
  private edge(from: string, to: string, kind: WatchEdge["kind"]) {
    if (from === to || !this.nodes.has(from) || !this.nodes.has(to)) return;
    const edge: WatchEdge = { id: watchKey("edge", [from, to, kind]), from, to, kind };
    if (this.edges.has(edge.id)) return;
    if (this.edges.size >= 8192) { this.diagnostic("edge_capacity"); return; }
    this.edges.set(edge.id, edge); this.changes.push({ op: "edge.upsert", edge });
  }
  private tool(scope: WatchScope, callId: string | undefined, step: number | undefined, name: string, patch: Partial<WatchNode>, external = false) {
    if (!idSafe(callId) || !Number.isSafeInteger(step) || step! < 0) { this.diagnostic("unassociated_tool"); return; }
    const parent = this.nodes.get(watchRunKey(scope)) ?? this.run(scope);
    const id = watchToolKey(scope, step!, callId), previous = this.nodes.get(id), at = this.now();
    const label = external ? externalTools.has(name) ? name : "external_tool" : this.tools.has(name) ? name : "tool";
    if (previous?.terminal && patch.status && patch.status !== previous.status) { this.diagnostic("late_event"); return; }
    const node = this.add({ id, kind: "tool", scope: { ...scope }, label, step, toolCallId: callId,
      status: "submitted", source: external ? "external_report" : "runtime", coverage: external ? "partial" : "full",
      createdAt: at, updatedAt: at, elapsedMs: 0, terminal: false, wasExecuted: false, ...previous, ...patch });
    if (parent && node) this.edge(parent.id, node.id, "owns");
    return node;
  }
  private record(kind: string, status: string, nodeId?: string) {
    const item: WatchTimelineItem = { id: ++this.timelineId, at: this.now(), kind, status, ...(nodeId ? { nodeId } : {}) };
    this.timeline.push(item); if (this.timeline.length > 1000) this.timeline.shift();
    this.changes.push({ op: "timeline.append", item });
  }
  private binding(scope: ObservationScope, childRunId: string, toolCallId?: string, step?: number, external = false) {
    if (!idSafe(childRunId)) { this.diagnostic("invalid_identity"); return; }
    const childScope = { ...scope, runId: childRunId, parentRunId: scope.runId };
    const previous = this.nodes.get(watchRunKey(childScope));
    const parentTool = idSafe(toolCallId) && Number.isSafeInteger(step)
      ? this.tool(scope, toolCallId, step, "agent", {}) : undefined;
    const child = this.run(childScope, { scope: childScope, parentToolKey: parentTool?.id ?? previous?.parentToolKey,
      ...(external ? { label: "external", coverage: "opaque" as const } : {}) });
    if (parentTool && child) this.edge(parentTool.id, child.id, "spawns");
    else if (child?.parentToolKey) this.edge(child.parentToolKey, child.id, "spawns");
    else if (child) this.diagnostic("missing_parent_tool");
    return child;
  }
  private agent(scope: WatchScope, event: AgentEvent, external = false) {
    const run = this.nodes.get(watchRunKey(scope)) ?? this.run(scope);
    if (!run) return;
    const at = this.now();
    if (event.type === "agent_run_state" && !external) {
      const value = event.run;
      if (!idSafe(value.runId) || !runStates.has(value.status)) { this.diagnostic("invalid_identity"); return; }
      const childScope = { ...scope, runId: value.runId, parentRunId: value.parentRunId };
      const existing = this.nodes.get(watchRunKey(childScope));
      if (existing?.sequence !== undefined && existing.sequence >= value.sequence) return;
      const parentId = existing?.scope.parentRunId ?? value.parentRunId;
      this.run({ ...childScope, parentRunId: parentId }, { label: roles.has(value.agentType) ? value.agentType : "agent",
        sequence: value.sequence, status: value.status, terminal: terminal.has(value.status), updatedAt: at,
        scope: { ...childScope, parentRunId: parentId } });
      this.record("agent", value.status, watchRunKey(childScope));
    } else if (event.type === "status") {
      if (!["idle", "thinking", "writing", "tool", "compacting"].includes(event.status)) return;
      this.run(scope, { activity: event.status, updatedAt: at });
    } else if (event.type === "run_step") {
      this.run(scope, { step: event.step, updatedAt: at });
    } else if (event.type === "provider_request") {
      if (!idSafe(event.requestId)) { this.diagnostic("request_identity_missing"); return; }
      const request = event.request, id = watchKey("request", [watchRunKey(scope), event.requestId]);
      if (!["requesting", "waiting_output", "streaming", "retrying", "completed", "failed"].includes(request.phase)) return;
      const previous = this.nodes.get(id);
      const node = this.add({ id, kind: "request", scope: { ...scope }, label: "provider",
        source: "runtime", coverage: "full", createdAt: at, updatedAt: at, elapsedMs: 0,
        ...previous, status: request.phase, terminal: request.phase === "completed" || request.phase === "failed",
        attempt: finite(request.attempt) ? request.attempt : undefined,
        maxAttempts: finite(request.maxAttempts) ? request.maxAttempts : undefined,
        retryDelayMs: finite(request.delayMs) ? request.delayMs : undefined });
      if (node) this.edge(run.id, node.id, "owns");
      this.record("request", request.phase, id);
    } else if (event.type === "tool_call_pending") {
      this.tool(scope, event.id, event.step, event.toolName, { status: "arguments_streaming",
        ...(finite(event.bytesHint) ? { argumentChars: event.bytesHint } : {}), updatedAt: at }, external);
    } else if (event.type === "content_final" && (event.kind === "tool_call" || event.kind === "tool_result")) {
      const result = event.kind === "tool_result";
      const node = this.tool(scope, event.id, event.step, event.toolName, {
        status: event.kind === "tool_result" ? event.result.success ? "returned" : event.result.failure?.code === "CANCELLED" ? "cancelled" : "failed" : "submitted", terminal: result, updatedAt: at,
        ...(event.kind === "tool_result" ? { success: event.result.success } : {}),
      }, external);
      this.record("tool", result ? event.kind === "tool_result" && event.result.success ? "returned" : "failed" : "submitted", node?.id);
    } else if (event.type === "observation") {
      // ObservationKind is a closed SDK enum. Arbitrary detail is never forwarded.
      const allowed = new Set(["autocompact_start", "autocompact_done", "reactive_compact", "provider_fallback", "provider_stream_continuation", "max_tokens_recovery", "checkpoint_error", "duplicate_tool_suppressed", "force_finish_timeout"]);
      if (allowed.has(event.kind)) this.record("observation", event.kind, run.id);
    } else if (event.type === "run_usage") {
      this.run(scope, { inputTokens: (run.inputTokens ?? 0) + (finite(event.inputTokens) ? event.inputTokens : 0),
        outputTokens: (run.outputTokens ?? 0) + (finite(event.outputTokens) ? event.outputTokens : 0),
        usageIncomplete: run.usageIncomplete || event.usageIncomplete || event.providerUsageReported === false, updatedAt: at });
    }
  }
  countContent(scope: WatchScope, kind: "text" | "thinking", length: number) {
    if (!validWatchScope(scope)) return;
    const id = watchRunKey(scope);
    if (!this.nodes.has(id) || this.nodes.get(id)!.terminal) return;
    const value = this.counters.get(id) ?? { text: 0, thinking: 0, dirty: false };
    value[kind] = Math.min(Number.MAX_SAFE_INTEGER, value[kind] + length);
    value.dirty = true;
    this.counters.set(id, value);
  }
  flushCounters(): WatchMutation[] {
    this.begin();
    for (const [id, count] of this.counters) {
      if (!count.dirty) continue;
      count.dirty = false;
      const node = this.nodes.get(id);
      if (node && !node.terminal) this.run(node.scope, { textChars: count.text, thinkingChars: count.thinking, updatedAt: this.now() });
    }
    return this.changes;
  }
  project(observation: RuntimeObservation): WatchMutation[] {
    this.begin();
    if (observation.kind === "tool_catalog") {
      for (const name of observation.names.slice(0, 1024)) if (this.tools.size < 2048 && /^[a-zA-Z0-9_.:-]{1,80}$/.test(name)) this.tools.add(name);
      return this.changes;
    }
    if (observation.kind === "runtime_event") {
      const event = observation.event;
      if (!idSafe(event.threadId) || !idSafe(event.turnId) || !idSafe(event.runId)) { this.diagnostic("invalid_identity"); return this.changes; }
      const source = event.threadId;
      const rootIdentity = JSON.stringify([event.threadId, event.turnId]);
      if (event.payload.type === "turn_started") this.roots.set(rootIdentity, event.runId);
      if (event.sequence <= (this.sourceSequences.get(source) ?? 0)) return this.changes;
      this.sourceSequences.set(source, event.sequence);
      const payload = event.payload, scope: WatchScope = { threadId: event.threadId, turnId: event.turnId, runId: event.runId,
        ...(idSafe(event.parentRunId) ? { parentRunId: event.parentRunId } : {}), rootRunId: this.roots.get(rootIdentity) };
      if (payload.type === "turn_started") {
        this.session(event.threadId, "running");
        this.run(scope, { label: "root" }); this.record("run", "running", watchRunKey(scope));
      } else if (payload.type === "agent_event") {
        if (this.closedTurns.has(JSON.stringify([event.threadId, event.turnId, scope.rootRunId ?? event.runId]))) { this.diagnostic("late_event"); return this.changes; }
        this.agent(scope, payload.item.event);
      } else {
        const terminalPayload = payload.type === "attempt_ended" ? payload.legacyTerminal : payload;
        const status = payload.type === "attempt_ended" ? payload.outcome.execution.status
          : terminalPayload.type === "turn_failed" ? terminalPayload.interrupted ? "cancelled" : "failed"
          : terminalPayload.type === "turn_incomplete" ? "incomplete" : "completed";
        this.run(scope, { status, terminal: true, updatedAt: this.now() });
        this.closedTurns.add(JSON.stringify([event.threadId, event.turnId, event.runId]));
        this.session(event.threadId, "idle");
        for (const node of this.nodes.values()) if (!node.terminal && node.scope.rootRunId === event.runId) {
          this.add({ ...node, observationClosed: true, coverage: "partial", updatedAt: this.now() }); this.diagnostic("unfinished_observation");
        }
        const outcome: WatchOutcome = { attemptId: event.runId, execution: status,
          acceptance: payload.type === "attempt_ended" ? payload.outcome.acceptance.status : "legacy_unknown",
          workflow: payload.type === "attempt_ended" ? payload.outcome.workflow.status : "legacy_unknown" };
        this.outcomes.set(event.runId, outcome); if (this.outcomes.size > 3) {
          const id = this.outcomes.keys().next().value!; this.outcomes.delete(id); this.changes.push({ op: "outcome.remove", id });
        }
        this.changes.push({ op: "outcome.set", outcome }); this.record("run", status, watchRunKey(scope));
        this.endedAttempts.push(event.runId);
        if (this.endedAttempts.length > 3) {
          const oldRoot = this.endedAttempts.shift()!;
          for (const node of this.nodes.values()) if (node.scope.rootRunId === oldRoot) this.remove(node.id);
        }
        if (this.closedTurns.size > 1024) this.closedTurns.delete(this.closedTurns.values().next().value!);
        if (this.roots.size > 1024) this.roots.delete(this.roots.keys().next().value!);
        if (this.sourceSequences.size > 1024) this.sourceSequences.delete(this.sourceSequences.keys().next().value!);
      }
      return this.changes;
    }
    const scope = observation.scope;
    if (!validWatchScope(scope)) { this.diagnostic("invalid_identity"); return this.changes; }
    if (this.closedTurns.has(JSON.stringify([scope.threadId, scope.turnId, scope.rootRunId ?? scope.runId]))) { this.diagnostic("late_event"); return this.changes; }
    if (observation.kind === "input_wait") {
      const previous = this.nodes.get(watchRunKey(scope));
      const pendingInputs = Math.max(0, (previous?.pendingInputs ?? 0) + (observation.phase === "requested" ? 1 : -1));
      this.run(scope, { activity: pendingInputs ? "waiting_input" : "tool", pendingInputs, updatedAt: this.now() });
      this.tool(scope, observation.toolCallId, observation.step, "ask_user_question", {
        status: observation.phase === "requested" ? "waiting_input" : "settling", updatedAt: this.now() });
      this.record("input", observation.phase, watchRunKey(scope));
    } else if (observation.kind === "dependencies") {
      if (observation.dependencies.length && idSafe(observation.childRunId)) {
        const childScope = { ...scope, runId: observation.childRunId };
        const child = this.nodes.get(watchRunKey(childScope)) ?? this.run(childScope, { label: "agent", status: "scheduled" });
        for (const dependency of observation.dependencies.slice(0, 32)) {
          if (!idSafe(dependency)) continue;
          const parentScope = { ...scope, runId: dependency };
          const parent = this.nodes.get(watchRunKey(parentScope)) ?? this.run(parentScope, { label: "agent", status: "unknown", coverage: "partial" });
          if (child && parent) this.edge(parent.id, child.id, "depends_on");
        }
      }
    } else if (observation.kind === "external_unknown") {
      const previous = this.nodes.get(watchRunKey(scope));
      this.run(scope, { unknownEvents: Math.min(Number.MAX_SAFE_INTEGER, (previous?.unknownEvents ?? 0) + 1) });
    } else if (observation.kind === "run_binding") {
      this.binding(scope, observation.childRunId, observation.toolCallId, observation.step);
    } else if (observation.kind === "lifecycle") {
      this.run(scope, { status: observation.phase, updatedAt: this.now() }); this.record("lifecycle", observation.phase, watchRunKey(scope));
    } else if (observation.kind === "external_run") {
      const child = this.binding(scope, observation.childRunId, observation.toolCallId, observation.step, true);
      if (child) this.run(child.scope, { status: observation.phase, terminal: terminal.has(observation.phase), updatedAt: this.now() });
      this.record("external", observation.phase, child?.id);
    } else if (observation.kind === "external_event") {
      if (observation.event.type === "status" || observation.event.type === "content_final") this.run(scope, { coverage: "partial" });
      this.agent(scope, observation.event, true);
    } else {
      const event = observation.event;
      const previous = idSafe(event.toolCallId) && Number.isSafeInteger(event.step)
        ? this.nodes.get(watchToolKey(scope, event.step!, event.toolCallId)) : undefined;
      let node: WatchNode | undefined;
      if (observation.kind === "approval") {
        node = this.tool(scope, event.toolCallId, event.step, event.toolName, {
          status: event.status === "requested" ? "waiting_approval" : event.status === "approved" ? "authorized" : event.status,
          approval: { id: observation.approvalOccurrence, status: event.status }, updatedAt: this.now() });
      } else {
        const spans = [...(previous?.executionSpans ?? [])], index = spans.findIndex(value => value.id === observation.executionSpanId);
        const span = { id: observation.executionSpanId, status: event.status };
        if (index >= 0) spans[index] = span; else spans.push(span);
        node = this.tool(scope, event.toolCallId, event.step, event.toolName, { wasExecuted: true, source: "executor",
          status: event.status === "started" ? "running" : event.status === "completed" ? "settling" : event.status,
          executionSpans: spans.slice(-16), updatedAt: this.now() });
      }
      this.record(observation.kind, event.status, node?.id);
    }
    return this.changes;
  }
}

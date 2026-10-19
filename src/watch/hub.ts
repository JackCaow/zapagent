import { randomUUID } from "node:crypto";
import type { RuntimeObserver, RuntimeObservation } from "../../zapsdk/runtime/observation.js";
import type { WatchFrame, WatchMutation, WatchSnapshot } from "./protocol.js";
import { WatchProjector, validWatchScope } from "./projector.js";

export class WatchHub implements RuntimeObserver {
  readonly instanceId = randomUUID();
  readonly projector: WatchProjector;
  seq = 0;
  private ring: Array<{ seq: number; json: string; bytes: number }> = [];
  private bytes = 0;
  private readonly listeners = new Set<(json: string) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopping = false;
  private ended = false;
  private warned = false;
  private readonly sourceSequences = new Map<string, number>();
  constructor(private readonly options: { maxFrames?: number; maxBytes?: number; maxNodes?: number; onError?: () => void } = {}) {
    this.projector = new WatchProjector(options.maxNodes);
    this.timer = setInterval(() => this.commit(this.projector.flushCounters()), 100);
    this.timer.unref();
  }
  observe(observation: RuntimeObservation): void {
    if (this.ended || this.stopping) return;
    try {
      if (observation.kind === "runtime_event") {
        const event = observation.event;
        if (event.sequence <= (this.sourceSequences.get(event.threadId) ?? 0)) return;
        this.sourceSequences.set(event.threadId, event.sequence);
        if (this.sourceSequences.size > 1024) this.sourceSequences.delete(this.sourceSequences.keys().next().value!);
        if (event.payload.type !== "agent_event" || ["run_ended", "content_final"].includes(event.payload.item.event.type)) this.commit(this.projector.flushCounters());
      }
      if (observation.kind === "runtime_event" && observation.event.payload.type === "agent_event") {
        const event = observation.event, agent = observation.event.payload.item.event;
        if (agent.type === "content_delta") {
          const scope = { threadId: event.threadId, turnId: event.turnId!, runId: event.runId! };
          if (validWatchScope(scope)) this.projector.countContent(scope, agent.kind, agent.text.length);
          return;
        }
      }
      this.commit(this.projector.project(observation));
    } catch {
      this.commit(this.projector.observationFailed("projection_error"));
      if (!this.warned) { this.warned = true; this.options.onError?.(); }
    }
  }
  session(threadId: string, status: "idle" | "running" | "closed") {
    if (!this.ended) this.commit(this.projector.registerSession(threadId, status));
  }
  private commit(changes: WatchMutation[]) {
    if (this.ended || changes.length === 0) return;
    let batch: WatchMutation[] = [], size = 0;
    const flush = () => {
      if (!batch.length) return;
      const frame: WatchFrame = { schema: "zap.watch", schemaVersion: 1, instanceId: this.instanceId,
        seq: ++this.seq, observedAt: Date.now(), changes: batch };
      const json = JSON.stringify(frame), bytes = Buffer.byteLength(json);
      this.ring.push({ seq: this.seq, json, bytes }); this.bytes += bytes;
      while (this.ring.length > (this.options.maxFrames ?? 10000) || this.bytes > (this.options.maxBytes ?? 8 * 1024 * 1024)) {
        this.bytes -= this.ring.shift()!.bytes;
      }
      for (const listener of this.listeners) { try { listener(json); } catch { /* An observer cannot block other readers. */ } }
      batch = []; size = 0;
    };
    for (const change of changes) {
      const bytes = Buffer.byteLength(JSON.stringify(change));
      if (size + bytes > 15000) flush();
      batch.push(change); size += bytes;
    }
    flush();
  }
  snapshot(): WatchSnapshot {
    const model = this.projector;
    return structuredClone({ schema: "zap.watch", schemaVersion: 1, instanceId: this.instanceId, throughSeq: this.seq,
      processState: this.stopping ? "stopping" : "running", sessions: [...model.sessions.values()], nodes: [...model.nodes.values()],
      edges: [...model.edges.values()], outcomes: [...model.outcomes.values()], recentTimeline: model.timeline,
      coverage: { historyFromSeq: this.ring[0]?.seq ?? this.seq, truncated: (this.ring[0]?.seq ?? 1) > 1 || Object.keys(model.diagnostics).length > 0,
        reasons: Object.keys(model.diagnostics) }, diagnostics: model.diagnostics });
  }
  /** Cursor validation, replay capture and listener registration are synchronous. */
  connect(instanceId: string, after: number, listener: (json: string) => void): { replay: string[]; close(): void } | undefined {
    const oldest = this.ring[0]?.seq ?? this.seq + 1;
    if (this.ended || instanceId !== this.instanceId || !Number.isSafeInteger(after) || after < 0 || after > this.seq || after < oldest - 1) return;
    const replay = this.ring.filter(frame => frame.seq > after).map(frame => frame.json);
    this.listeners.add(listener);
    return { replay, close: () => { this.listeners.delete(listener); } };
  }
  stop(reason?: "transport_error") {
    if (this.stopping) return;
    if (reason) this.commit(this.projector.closeObservation());
    clearInterval(this.timer); this.commit(this.projector.flushCounters());
    this.stopping = true; this.commit([{ op: "process.set", state: "stopping" }]);
  }
  close() { this.stop(); this.ended = true; this.listeners.clear(); }
}

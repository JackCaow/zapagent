import { OutcomeProtocolError, validateObserveConfiguration, type AcceptanceConfiguration, type AgentOutcomeV1 } from "../runtime/outcome.js";
import { projectLegacyEvent } from "../runtime/types.js";
import type { AgentRunSnapshot } from "../agent/run-state.js";
import type { LoopAgentResult, RunOptions } from "../agent/loop.js";
import type { AgentMailboxMessage } from "../coordinator/types.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { RuntimeEventStore } from "../runtime/event-store.js";
import type {
  RuntimeEventFilter,
  RuntimeEventListener,
  ThreadSnapshot,
} from "../runtime/types.js";

export interface HostControllableRuntime {
  readonly threadId: string;
  readonly eventStore: RuntimeEventStore;
  threadSnapshot(): ThreadSnapshot;
  run(input: string, options?: RunOptions): Promise<LoopAgentResult>;
  runWithOutcome?(input: string, options?: RunOptions & { acceptance?: AcceptanceConfiguration }): Promise<{ loopResult: LoopAgentResult; outcome: AgentOutcomeV1 }>;
  lastOutcome?(): AgentOutcomeV1 | undefined;
  initialize?(): Promise<void>;
  cancelTurn(reason?: string): boolean;
  subscribe(filter: RuntimeEventFilter, listener: RuntimeEventListener, version?: 2 | 3): () => void;
  listAgents(): Promise<AgentRunSnapshot[]>;
  cancelAgent(runId: string, reason?: string): Promise<AgentRunSnapshot>;
  steerAgent(runId: string, text: string): Promise<AgentMailboxMessage>;
  resumeAgent(runId: string): Promise<AgentRunSnapshot>;
}

export interface SessionHostRuntimeOptions {
  threadId: string;
  eventStore: RuntimeEventStore;
  runTurn(input: string, options?: RunOptions, resultSchema?: "outcome-v1" | "legacy"): Promise<LoopAgentResult>;
  cancelTurn?: (reason: string) => boolean;
  isBusy?: () => boolean;
  clock?: () => number;
  recover?: () => Promise<AgentOutcomeV1 | undefined>;
}

function matchesFilter(event: Parameters<RuntimeEventListener>[0], filter: RuntimeEventFilter): boolean {
  if (filter.threadId && event.threadId !== filter.threadId) return false;
  if (filter.turnId && event.turnId !== filter.turnId) return false;
  if (filter.runId && event.runId !== filter.runId) return false;
  if (filter.payloadTypes && !filter.payloadTypes.includes(event.payload.type)) return false;
  return true;
}

/** Session-lifetime HostProtocol target for hosts whose concrete AgentRuntime
 * is assembled per turn. The stable binding remains discoverable while idle;
 * a concrete Runtime is attached only for the period in which it owns a turn. */
export class SessionHostRuntime implements HostControllableRuntime {
  readonly threadId: string;
  readonly eventStore: RuntimeEventStore;

  private readonly options: SessionHostRuntimeOptions;
  private readonly createdAt: number;
  private updatedAt: number;
  private activeRuntime?: AgentRuntime;
  private latestRuntime?: AgentRuntime;
  private runtimeUnsubscribe?: () => void;
  private readonly listeners = new Set<RuntimeEventListener>();
  private closed = false;
  private invoking = false;
  private recoveredOutcome?: AgentOutcomeV1;
  private recovering?: Promise<void>;

  constructor(options: SessionHostRuntimeOptions) {
    if (!options.threadId.trim()) throw new Error("SessionHostRuntime threadId is required");
    this.options = options;
    this.threadId = options.threadId;
    this.eventStore = options.eventStore;
    this.createdAt = (options.clock ?? Date.now)();
    this.updatedAt = this.createdAt;
  }

  async attach(runtime: AgentRuntime): Promise<() => void> {
    await this.recovering;
    if (this.closed) throw new Error(`Host runtime session ${this.threadId} is closed`);
    if (runtime.threadId !== this.threadId) {
      throw new Error(`Runtime thread ${runtime.threadId} does not match host session ${this.threadId}`);
    }
    if (this.activeRuntime && this.activeRuntime !== runtime) {
      throw new Error(`Host runtime session ${this.threadId} already has an attached Runtime`);
    }
    const previous = this.latestRuntime;
    if (previous && previous !== runtime) await previous.close();
    this.runtimeUnsubscribe?.();
    this.latestRuntime = runtime;
    this.activeRuntime = runtime;
    this.updatedAt = (this.options.clock ?? Date.now)();
    this.runtimeUnsubscribe = runtime.subscribe({ threadId: this.threadId }, (event) => {
      this.updatedAt = event.timestamp;
      for (const listener of this.listeners) listener(event);
    }, 3);
    return () => {
      if (this.activeRuntime !== runtime) return;
      this.runtimeUnsubscribe?.();
      this.runtimeUnsubscribe = undefined;
      this.activeRuntime = undefined;
      this.updatedAt = (this.options.clock ?? Date.now)();
    };
  }

  threadSnapshot(): ThreadSnapshot {
    const runtime = this.activeRuntime ?? this.latestRuntime;
    if (runtime) return runtime.threadSnapshot();
    return {
      threadId: this.threadId,
      status: "idle",
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  async run(input: string, options?: RunOptions): Promise<LoopAgentResult> {
    if (options && "acceptance" in options) throw new OutcomeProtocolError("UNSUPPORTED_ACCEPTANCE_MODE", "Use runWithOutcome() for acceptance configuration");
    if (this.closed) throw new Error(`Host runtime session ${this.threadId} is closed`);
    if (this.invoking || this.activeRuntime || this.options.isBusy?.()) {
      throw new Error(`Thread ${this.threadId} already has an active turn`);
    }
    this.invoking = true;
    try { return await this.options.runTurn(input, options, "legacy"); }
    finally { this.invoking = false; }
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error(`Host runtime session ${this.threadId} is closed`);
    if (this.invoking || this.activeRuntime || this.options.isBusy?.()) return;
    if (this.latestRuntime) return this.latestRuntime.initialize();
    if (!this.recovering) this.recovering = (async () => {
      this.recoveredOutcome = await this.options.recover?.();
    })().finally(() => { this.recovering = undefined; });
    await this.recovering;
  }

  lastOutcome(): AgentOutcomeV1 | undefined { return this.latestRuntime?.lastOutcome() ?? this.recoveredOutcome; }

  async runWithOutcome(input: string, options?: RunOptions & { acceptance?: AcceptanceConfiguration }): Promise<{ loopResult: LoopAgentResult; outcome: AgentOutcomeV1 }> {
    validateObserveConfiguration(options?.acceptance);
    if (this.closed || this.invoking || this.activeRuntime || this.options.isBusy?.()) throw new Error(`Thread ${this.threadId} is unavailable or busy`);
    this.invoking = true;
    const previousAttemptId = this.lastOutcome()?.attemptId;
    try {
      const loopResult = await this.options.runTurn(input, options, "outcome-v1");
      const outcome = this.lastOutcome();
      if (!outcome || outcome.attemptId === previousAttemptId) throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", "Host did not return a new attempt outcome");
      return { loopResult, outcome };
    } finally { this.invoking = false; }
  }

  cancelTurn(reason = "cancelled by host"): boolean {
    if (this.activeRuntime) return this.activeRuntime.cancelTurn(reason);
    return this.options.cancelTurn?.(reason) ?? false;
  }

  subscribe(filter: RuntimeEventFilter, listener: RuntimeEventListener, version: 2 | 3 = 2): () => void {
    const filtered: RuntimeEventListener = (event) => {
      const projected = version === 2 ? projectLegacyEvent(event) : event;
      if (matchesFilter(projected, filter)) listener(projected);
    };
    this.listeners.add(filtered);
    return () => { this.listeners.delete(filtered); };
  }

  async listAgents(): Promise<AgentRunSnapshot[]> {
    return this.latestRuntime?.listAgents() ?? [];
  }

  async cancelAgent(runId: string, reason?: string): Promise<AgentRunSnapshot> {
    return this.requireRuntime().cancelAgent(runId, reason);
  }

  async steerAgent(runId: string, text: string): Promise<AgentMailboxMessage> {
    return this.requireRuntime().steerAgent(runId, text);
  }

  async resumeAgent(runId: string): Promise<AgentRunSnapshot> {
    return this.requireRuntime().resumeAgent(runId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.recovering?.catch(() => {});
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = undefined;
    const runtime = this.latestRuntime;
    this.activeRuntime = undefined;
    this.latestRuntime = undefined;
    await runtime?.close();
    await this.eventStore.close();
    this.listeners.clear();
  }

  private requireRuntime(): AgentRuntime {
    const runtime = this.latestRuntime;
    if (!runtime) throw new Error(`Thread ${this.threadId} has not created an AgentRuntime yet`);
    return runtime;
  }
}

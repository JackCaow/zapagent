import { ServiceReceiptSchema, type ServiceReceipt } from "../services/contracts.js";
import { ServiceOperationObservationSchema, type ServiceOperationObservation } from "../services/contracts.js";
import type { TaskStore } from "../tasks/store.js";
import { RuntimeSealing, type SealingProgress } from "./sealing.js";
import { InMemoryRuntimeStateStore } from "./state-store.js";
import { publishAttempt, saveAttempt, type PersistedAttemptOutcome } from "./outcome-state.js";
import { classifyExecution, classifyObservedAcceptance, validateObserveConfiguration, OutcomeProtocolError, type AcceptanceConfiguration, type AgentOutcomeV1, type ActionReference } from "./outcome.js";
import { projectLegacyEvent, type LegacyTerminalPayload, type RuntimeEventV3 } from "./types.js";
import { randomUUID } from "node:crypto";
import { notifyRuntimeObserver, withRuntimeObservation, type RuntimeObserver } from "./observation.js";
import type {
  AgentEvent,
  AgentEventHandler,
  AgentEventSource,
  AgentEventType,
} from "../agent/events.js";
import type { LoopAgentResult, RunOptions } from "../agent/loop.js";
import type { ToolDefinition } from "../tools/types.js";
import { InMemoryRuntimeEventStore, type RuntimeEventStore } from "./event-store.js";
import { RuntimeStateTracker } from "./state-tracker.js";
import type { RuntimeRecoveryReport } from "./state-types.js";
import type { AgentCoordinator } from "../coordinator/coordinator.js";
import type { AgentRunSnapshot } from "../agent/run-state.js";
import type { AgentCoordinatorResult, AgentMailboxMessage } from "../coordinator/types.js";
import {
  assessCompletion,
  type CompletionAssessment,
  type CompletionContract,
  type CompletionEvidenceProvider,
  DEFAULT_COMPLETION_CONTRACT,
} from "../harness/completion.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  rootRunSnapshot,
  type AgentEventRuntimeItem,
  type RuntimeEvent,
  type RuntimeEventFilter,
  type RuntimeEventListener,
  type RuntimeEventPayload,
  type RuntimeRunSnapshot,
  type ThreadSnapshot,
  type TurnSnapshot,
} from "./types.js";

export interface RuntimeAgentExecutor extends AgentEventSource {
  run(input: string, options?: RunOptions): Promise<LoopAgentResult>;
  toolDefinitions(): ToolDefinition[];
  effectiveSystemPrompt(): string | undefined;
  protocolPrompt?(): string | undefined;
}

export interface AgentRuntimeOptions {
  threadId: string;
  observer?: RuntimeObserver;
  agent: RuntimeAgentExecutor;
  eventStore?: RuntimeEventStore;
  idFactory?: () => string;
  clock?: () => number;
  eventStoreFailureMode?: "best-effort" | "required";
  onEventStoreError?: (error: Error) => void;
  stateTracker?: RuntimeStateTracker;
  onRecovery?: (reports: RuntimeRecoveryReport[]) => void | Promise<void>;
  /** Notification after the cancellation latch closes, before persistence. */
  onSealing?: () => void;
  /** Caller wait limit from sealing through lease release. Defaults to 30s. */
  sealingTimeoutMs?: number;
  /** Out-of-band diagnostics: never queued behind the storage being measured. */
  onSealingProgress?: (progress: SealingProgress) => void;
  coordinator?: AgentCoordinator;
  observability?: "minimal" | "standard" | "debug";
  backgroundTasks?: { store: TaskStore; disposition: "stop" | "host" };
  completionContract?: CompletionContract;
  hasExplicitCompletionContract?: boolean;
  /** Optional bridge for Broker/StateStore evidence. It is host-authored and
   * never becomes model context or a task-specific benchmark hint. */
  completionEvidence?: CompletionEvidenceProvider;
}

interface ActiveTurn {
  turn: TurnSnapshot;
  run: RuntimeRunSnapshot;
  controller: AbortController;
  phase?: "running" | "sealing" | "ended";
  observedTools?: LoopAgentResult["toolResults"];
  observedText?: string;
  observedServices?: ServiceReceipt[];
  observedServiceOperations?: ServiceOperationObservation[];
  observedMetrics?: Pick<LoopAgentResult, "steps" | "totalUsage">;
}

function matchesFilter(event: RuntimeEvent, filter: RuntimeEventFilter): boolean {
  if (filter.threadId && event.threadId !== filter.threadId) return false;
  if (filter.turnId && event.turnId !== filter.turnId) return false;
  if (filter.runId && event.runId !== filter.runId) return false;
  if (filter.payloadTypes && !filter.payloadTypes.includes(event.payload.type)) return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stable runtime facade around the current LoopAgent executor. Hosts consume
 * AgentEvent directly during migration while every event is also projected
 * into the versioned Thread/Turn/Item/Run protocol. */
export class AgentRuntime implements RuntimeAgentExecutor {
  readonly threadId: string;
  readonly eventStore: RuntimeEventStore;

  private readonly agent: RuntimeAgentExecutor;
  private readonly observer?: RuntimeObserver;
  private readonly idFactory: () => string;
  private readonly clock: () => number;
  private readonly eventStoreFailureMode: "best-effort" | "required";
  private readonly onEventStoreError?: (error: Error) => void;
  private readonly stateTracker: RuntimeStateTracker;
  private readonly explicitCompletion: boolean;
  private readonly onSealing?: () => void;
  private readonly sealingTimeoutMs: number;
  private readonly onSealingProgress?: (progress: SealingProgress) => void;
  private sealing?: RuntimeSealing;
  private busy = false;
  private initializing?: Promise<void>;
  private readonly backgroundTasks?: AgentRuntimeOptions["backgroundTasks"];
  private outcome?: AgentOutcomeV1;
  private readonly onRecovery?: (reports: RuntimeRecoveryReport[]) => void | Promise<void>;
  private readonly coordinator?: AgentCoordinator;
  private readonly observability: "minimal" | "standard" | "debug";
  private readonly completionContract?: CompletionContract;
  private readonly completionEvidence?: CompletionEvidenceProvider;
  private completionAssessment?: CompletionAssessment;
  private recoveryReports: RuntimeRecoveryReport[] = [];
  private recoveryPrepared = false;
  private createdAt: number;
  private readonly listeners = new Set<RuntimeEventListener>();
  private active?: ActiveTurn;
  private sequence = 0;
  private lastEventId?: string;
  private sequenceReady?: Promise<void>;
  private storeTail: Promise<void> = Promise.resolve();
  private rootRunSequence = 0;

  constructor(options: AgentRuntimeOptions) {
    if (!options.threadId.trim()) throw new Error("AgentRuntime threadId is required");
    this.threadId = options.threadId;
    this.agent = options.agent;
    this.observer = options.observer;
    this.backgroundTasks = options.backgroundTasks ? { ...options.backgroundTasks } : undefined;
    this.eventStore = options.eventStore ?? new InMemoryRuntimeEventStore();
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? Date.now;
    this.eventStoreFailureMode = options.eventStoreFailureMode ?? "best-effort";
    this.onEventStoreError = options.onEventStoreError;
    this.stateTracker = options.stateTracker ?? new RuntimeStateTracker({
      threadId: options.threadId, workspaceRoot: process.cwd(), store: new InMemoryRuntimeStateStore(), clock: options.clock,
    });
    this.explicitCompletion = options.hasExplicitCompletionContract ?? Boolean(options.completionContract || options.completionEvidence);
    this.onRecovery = options.onRecovery;
    this.onSealing = options.onSealing;
    this.sealingTimeoutMs = options.sealingTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.sealingTimeoutMs) || this.sealingTimeoutMs < 1 || this.sealingTimeoutMs > 2_147_483_647) {
      throw new Error("sealingTimeoutMs must be a positive finite timer duration");
    }
    this.onSealingProgress = options.onSealingProgress;
    this.coordinator = options.coordinator;
    this.observability = options.observability ?? "standard";
    this.completionContract = options.completionContract;
    this.completionEvidence = options.completionEvidence;
    this.createdAt = this.clock();
    this.agent.on("*", this.handleAgentEvent);
    if (this.observer) {
      try { notifyRuntimeObserver(this.observer, { kind: "tool_catalog", names: this.agent.toolDefinitions().map(tool => tool.name) }); }
      catch { /* A diagnostic catalog cannot block custom SDK executors. */ }
    }
  }

  on(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.agent.on(type, handler);
  }

  off(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.agent.off(type, handler);
  }

  toolDefinitions(): ToolDefinition[] {
    return this.agent.toolDefinitions();
  }

  effectiveSystemPrompt(): string | undefined {
    return this.agent.effectiveSystemPrompt();
  }

  protocolPrompt(): string | undefined {
    return this.agent.protocolPrompt?.();
  }

  subscribe(filter: RuntimeEventFilter, listener: RuntimeEventListener, version: 2 | 3 = 2): () => void {
    const filtered: RuntimeEventListener = (event) => {
      const projected = version === 2 ? projectLegacyEvent(event) : event;
      if (matchesFilter(projected, filter)) listener(projected);
    };
    this.listeners.add(filtered);
    return () => { this.listeners.delete(filtered); };
  }

  threadSnapshot(): ThreadSnapshot {
    const updatedAt = this.active?.turn.updatedAt ?? this.outcome?.endedAt ?? this.createdAt;
    const running = this.active?.turn.status === "running";
    return {
      threadId: this.threadId,
      status: running ? "running" : "idle",
      createdAt: this.createdAt,
      updatedAt,
      activeTurnId: running ? this.active?.turn.turnId : undefined,
    };
  }

  cancelTurn(reason = "cancelled by host"): boolean {
    if (!this.active || this.active.turn.status !== "running" || this.active.phase === "sealing") return false;
    this.active.controller.abort(new Error(reason));
    return true;
  }

  lastCompletionAssessment(): CompletionAssessment | undefined {
    return this.completionAssessment ? structuredClone(this.completionAssessment) : undefined;
  }

  lastRecoveryReports(): RuntimeRecoveryReport[] {
    return structuredClone(this.recoveryReports);
  }

  async listAgents(): Promise<AgentRunSnapshot[]> {
    return this.coordinator?.list() ?? [];
  }

  async cancelAgent(runId: string, reason?: string): Promise<AgentRunSnapshot> {
    if (!this.coordinator) throw new Error("AgentCoordinator is not enabled for this Runtime");
    return this.coordinator.cancel(runId, reason);
  }

  async steerAgent(runId: string, text: string): Promise<AgentMailboxMessage> {
    if (!this.coordinator) throw new Error("AgentCoordinator is not enabled for this Runtime");
    return this.coordinator.steer(runId, text);
  }

  async resumeAgent(runId: string): Promise<AgentRunSnapshot> {
    if (!this.coordinator) throw new Error("AgentCoordinator is not enabled for this Runtime");
    return this.coordinator.resume(runId);
  }

  async waitForAgent(runId: string): Promise<AgentCoordinatorResult> {
    if (!this.coordinator) throw new Error("AgentCoordinator is not enabled for this Runtime");
    return this.coordinator.wait(runId);
  }

  lastOutcome(): AgentOutcomeV1 | undefined {
    return this.outcome ? structuredClone(this.outcome) : undefined;
  }

  async runWithOutcome(input: string, options?: RunOptions & { acceptance?: AcceptanceConfiguration }): Promise<{ loopResult: LoopAgentResult; outcome: AgentOutcomeV1 }> {
    validateObserveConfiguration(options?.acceptance);
    if (this.explicitCompletion) throw new OutcomeProtocolError("UNSUPPORTED_ACCEPTANCE_MODE", "Explicit legacy completion contracts require run(), not runWithOutcome()");
    const { acceptance: _acceptance, ...runOptions } = options ?? {};
    const loopResult = await this.execute(input, runOptions, true);
    return { loopResult, outcome: structuredClone(this.outcome!) };
  }

  /** Explicit host repair: a fresh attempt in the preceding turn. Never called
   * by acceptance evaluation itself; the host owns eligibility and budgets. */
  async runRepairWithOutcome(input: string, previousAttemptId: string, options?: RunOptions): Promise<{ loopResult: LoopAgentResult; outcome: AgentOutcomeV1 }> {
    if (this.explicitCompletion || options?.turnEndGuard || (options && "acceptance" in options)) {
      throw new OutcomeProtocolError("UNSUPPORTED_REPAIR_MODE", "Repair requires outcome mode without an implicit completion guard");
    }
    await this.initializing;
    return this.withOwnership(async () => {
      const previous = this.outcome;
      const state = await this.stateTracker.store.load(this.threadId);
      if (!previous || previous.attemptId !== previousAttemptId
        || state?.attemptOutcomes[previousAttemptId]?.terminalEventId !== this.lastEventId
        || state?.turns[previous.turnId]?.rootRunId !== previous.runId
        || previous.execution.status !== "finished" || previous.execution.error
        || previous.execution.unresolvedActions.length > 0
        || previous.execution.backgroundTasks?.some(task => task.disposition !== "stopped")) {
        throw new OutcomeProtocolError("STALE_REPAIR_ATTEMPT", "Repair requires the latest finished, settled attempt");
      }
      const loopResult = await this.runOwned(input, options, true, previous.turnId);
      return { loopResult, outcome: structuredClone(this.outcome!) };
    }, true);
  }

  async run(input: string, options?: RunOptions): Promise<LoopAgentResult> {
    if (options && "acceptance" in options) throw new OutcomeProtocolError("UNSUPPORTED_ACCEPTANCE_MODE", "Use runWithOutcome() for acceptance configuration");
    return this.execute(input, options, false);
  }

  /** Recover persisted terminals without starting a provider or tool turn. */
  initialize(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (this.busy) return Promise.resolve();
    this.initializing = this.withOwnership(async () => {}, true).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }

  private async execute(input: string, options: RunOptions | undefined, outcomeMode: boolean): Promise<LoopAgentResult> {
    await this.initializing;
    return this.withOwnership(() => this.runOwned(input, options, outcomeMode), outcomeMode);
  }

  private async withOwnership<T>(operation: () => Promise<T>, outcomeMode: boolean): Promise<T> {
    if (this.busy) throw new Error(`Thread ${this.threadId} already has an active turn`);
    this.busy = true;
    const sealing = new RuntimeSealing(this.sealingTimeoutMs, this.onSealingProgress);
    this.sealing = sealing;
    const owned = this.runWithOwnership(operation, outcomeMode).finally(() => {
      sealing.close();
      this.sealing = undefined;
      this.busy = false;
    });
    // A timed-out caller must not release the lease underneath a pending write.
    // The owned operation drains in place; new runs remain blocked until then.
    return Promise.race([owned, sealing.expired]);
  }

  private async runWithOwnership<T>(operation: () => Promise<T>, outcomeMode: boolean): Promise<T> {
    this.completionAssessment = undefined;
    try {
      if (!this.recoveryPrepared) {
        const reports = await this.stateTracker.prepareRecovery();
        this.recoveryReports = structuredClone(reports);
        if (reports.length > 0) await this.onRecovery?.(structuredClone(reports));
        this.recoveryPrepared = true;
      }
      await this.stateTracker.acquireOwnership();
    } catch (error) {
      if (outcomeMode) throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", errorMessage(error));
      throw error;
    }
    let failure: unknown;
    try {
      this.sequenceReady = undefined;
      await this.replayOutbox();
      return await operation();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try { await this.sealing!.measure("ownership_release", () => this.stateTracker.releaseOwnership()); }
      catch (error) {
        if (failure === undefined) {
          if (outcomeMode) throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", errorMessage(error));
          throw error;
        }
      }
    }
  }

  private async runOwned(input: string, options: RunOptions | undefined, outcomeMode: boolean, repairTurnId?: string): Promise<LoopAgentResult> {
    await this.ensureSequence();

    const controller = new AbortController();
    const externalSignal = options?.signal;
    const forwardAbort = () => { if (this.active?.phase !== "sealing") controller.abort(externalSignal?.reason); };
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    const runOptions: RunOptions = {
      ...options, signal: controller.signal, resultSchema: outcomeMode ? "outcome-v1" : "legacy",
      // Legacy run() does not perform outcome-mode background settlement.
      backgroundTaskOwner: outcomeMode && this.backgroundTasks
        ? Object.freeze({ storeId: this.backgroundTasks.store.instanceId, lifecycle: this.backgroundTasks.disposition === "stop" ? "run" : "host-session" })
        : undefined,
    };

    const startedAt = this.clock();
    const turnId = repairTurnId ?? this.idFactory();
    const runId = this.idFactory();
    const turn: TurnSnapshot = {
      turnId,
      threadId: this.threadId,
      rootRunId: runId,
      status: "running",
      ...(outcomeMode ? { resultSchema: "outcome-v1" as const } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const run = rootRunSnapshot({
      runId,
      threadId: this.threadId,
      turnId,
      task: input,
      status: "running",
      sequence: ++this.rootRunSequence,
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
    });
    this.active = { turn, run, controller, phase: "running", observedTools: [], observedText: "", observedServices: [], observedServiceOperations: [] };
    this.publish({
      type: "turn_started",
      thread: this.threadSnapshot(),
      turn: { ...turn },
      run: { ...run },
      item: {
        itemId: this.idFactory(),
        threadId: this.threadId,
        turnId,
        runId,
        type: "message",
        role: "user",
        text: input,
        createdAt: startedAt,
      },
    });
    // Control state is the crash-recovery boundary. Persist the active turn
    // before the first provider/tool side effect can start.
    try {
      await this.stateTracker?.flush();
    } catch (error) {
      this.active = undefined;
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (outcomeMode) throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", errorMessage(error));
      throw error;
    }

    if (outcomeMode) {
      try { return await this.runOutcome(input, runOptions); }
      finally {
        this.active = undefined;
        externalSignal?.removeEventListener("abort", forwardAbort);
      }
    }

    let result: LoopAgentResult;
    try {
      result = await this.runObserved(input, runOptions);
    } catch (error) {
      const completedAt = this.clock();
      const interrupted = controller.signal.aborted;
      const failedTurn: TurnSnapshot = {
        ...turn,
        status: interrupted ? "cancelled" : "failed",
        updatedAt: completedAt,
        completedAt,
      };
      const failedRun = rootRunSnapshot({
        runId,
        threadId: this.threadId,
        turnId,
        task: input,
        status: interrupted ? "cancelled" : "failed",
        sequence: ++this.rootRunSequence,
        createdAt: startedAt,
        updatedAt: completedAt,
        startedAt,
        finishedAt: completedAt,
        success: false,
      });
      this.active = { turn: failedTurn, run: failedRun, controller };
      this.publish({
        type: "turn_failed",
        thread: this.threadSnapshot(),
        turn: failedTurn,
        run: failedRun,
        item: {
          itemId: this.idFactory(),
          threadId: this.threadId,
          turnId,
          runId,
          type: "error",
          error: errorMessage(error),
          createdAt: completedAt,
        },
        interrupted,
      });
      try {
        await this.flushEvents();
      } catch (storeError) {
        throw new AggregateError(
          [error, storeError],
          `Agent run failed and runtime events could not be stored: ${errorMessage(error)}`,
        );
      } finally {
        this.active = undefined;
        externalSignal?.removeEventListener("abort", forwardAbort);
      }
      throw error;
    }

    const completedAt = this.clock();
    const completionContract = this.completionContract ?? DEFAULT_COMPLETION_CONTRACT;
    let completionEvidence;
    try {
      completionEvidence = await this.completionEvidence?.({
        result,
        threadId: this.threadId, turnId, runId,
        contract: completionContract,
        signal: controller.signal,
      });
    } catch (error) {
      completionEvidence = {
        infrastructure: [{
          source: "completion_evidence",
          status: "failed" as const,
          detail: `completion evidence provider failed: ${errorMessage(error)}`,
        }],
      };
    }
    const completion = assessCompletion(result, completionContract, completionEvidence);
    this.completionAssessment = structuredClone(completion);
    const completedTurn: TurnSnapshot = {
      ...turn,
      status: completion.status,
      updatedAt: completedAt,
      completedAt,
    };
    const completedRun = rootRunSnapshot({
      runId,
      threadId: this.threadId,
      turnId,
      task: input,
      status: completion.status,
      sequence: ++this.rootRunSequence,
      createdAt: startedAt,
      updatedAt: completedAt,
      startedAt,
      finishedAt: completedAt,
      statusDetail: completion.reason,
      success: completion.success,
      steps: result.steps,
      usage: result.totalUsage,
    });
    this.active = { turn: completedTurn, run: completedRun, controller };
    this.publish({
      type: completion.status === "completed" ? "turn_completed" : "turn_incomplete",
      thread: this.threadSnapshot(),
      turn: completedTurn,
      run: completedRun,
      item: {
        itemId: this.idFactory(),
        threadId: this.threadId,
        turnId,
        runId,
        type: "message",
        role: "assistant",
        text: result.text,
        createdAt: completedAt,
      },
      result: {
        text: result.text,
        steps: result.steps,
        totalUsage: result.totalUsage,
        stopped: result.stopped,
        completion: {
          status: completion.status,
          success: completion.success,
          modelClaimedSuccess: completion.modelClaimedSuccess,
          evidenceState: completion.evidenceState,
          infrastructureOutcome: completion.infrastructureOutcome,
          reason: completion.reason,
          evidence: completion.ledger.evidence,
          requirements: completion.ledger.requirements,
        },
      },
    });
    try {
      await this.flushEvents();
      return { ...result, completion };
    } finally {
      this.active = undefined;
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private runObserved(input: string, options: RunOptions): Promise<LoopAgentResult> {
    const active = this.active!;
    return withRuntimeObservation(this.observer ? {
      observer: this.observer,
      scope: { threadId: this.threadId, turnId: active.turn.turnId, runId: active.run.runId, rootRunId: active.run.runId },
      isActive: () => this.active === active && active.phase !== "ended",
    } : undefined, () => this.agent.run(input, options));
  }

  private async runOutcome(input: string, options: RunOptions): Promise<LoopAgentResult> {
    const active = this.active!;
    let result: LoopAgentResult = { text: "", steps: 0, toolResults: [], totalUsage: { inputTokens: 0, outputTokens: 0 } };
    let executionError: unknown;
    try { result = await this.runObserved(input, options); }
    catch (error) {
      executionError = error;
      result = { ...result, ...active.observedMetrics, text: active.observedText ?? "", toolResults: active.observedTools ?? [] };
    }
    active.phase = "sealing";
    notifyRuntimeObserver(this.observer, { kind: "lifecycle", scope: {
      threadId: this.threadId, turnId: active.turn.turnId, runId: active.run.runId,
    }, phase: "sealing", at: this.clock() });
    const cancelled = active.controller.signal.aborted;
    const sealing = this.sealing!;
    sealing.start({ threadId: this.threadId, turnId: active.turn.turnId, attemptId: active.run.runId });
    try { this.onSealing?.(); } catch { /* Host observers cannot alter the terminal latch. */ }
    const tasks = this.backgroundTasks?.store.list({ running: true }) ?? [];
    if (this.backgroundTasks?.disposition === "stop") {
      await sealing.measure("background_settle", () => this.backgroundTasks!.store.settle(tasks.map(task => task.taskId)));
    }
    const backgroundTasks = tasks.map(task => ({ taskId: task.taskId,
      disposition: this.backgroundTasks!.store.get(task.taskId)?.exitedAt !== undefined ? "stopped" as const
        : this.backgroundTasks!.disposition === "host" ? "host_owned" as const : "pending" as const }));
    const endedAt = this.clock();
    let actions: ActionReference[];
    try {
      await sealing.measure("state_flush", () => this.stateTracker.flush());
      const state = await sealing.measure("state_load", () => this.stateTracker.store.load(this.threadId));
      actions = Object.values(state?.approvals ?? {})
        .filter((approval) => approval.turnId === active.turn.turnId && approval.status === "pending")
        .map((approval) => ({ actionId: approval.approvalId, owner: "runtime", kind: "approval", state: "pending", toolCallId: approval.toolRunId, reason: "Approval is still pending" }));
      for (const tool of Object.values(state?.toolRuns ?? {})) {
        if (tool.turnId === active.turn.turnId && (tool.status === "running" || tool.status === "scheduled")) {
          actions.push({ actionId: tool.toolRunId, owner: "runtime", kind: "running_tool", state: "pending", toolCallId: tool.toolRunId, reason: "Tool execution remains active" });
        }
      }
    } catch (error) {
      throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", errorMessage(error));
    }
    for (const task of backgroundTasks) {
      if (task.disposition === "pending") actions.push({ actionId: task.taskId, owner: "runtime", kind: "running_tool", state: "pending", reason: "Background process did not stop before terminal publication" });
    }
    const outcome: AgentOutcomeV1 = {
      schema: "zap.outcome", schemaVersion: 1, threadId: this.threadId,
      turnId: active.turn.turnId, runId: active.run.runId, attemptId: active.run.runId,
      startedAt: active.turn.createdAt, endedAt,
      execution: { ...classifyExecution({ attemptId: active.run.runId, result, cancelled, error: executionError, unresolvedActions: actions }),
        ...(backgroundTasks.length ? { backgroundTasks } : {}),
        ...(active.observedServices?.length ? { services: latestServices(active.observedServices) } : {}),
        ...(active.observedServiceOperations?.length ? { serviceOperations: active.observedServiceOperations } : {}) },
      acceptance: classifyObservedAcceptance(active.run.runId, result, endedAt),
      workflow: { attemptId: active.run.runId, status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" },
    };
    // Compatibility is a pure projection of recorded facts. It never invokes
    // the legacy evidence bridge, filesystem inspection, or another model turn.
    const legacyTerminal = this.legacyTerminal(outcome, result, active.turn, active.run);
    const entry = this.terminalEntry(outcome, legacyTerminal);
    try { await sealing.measure("outcome_save", () => saveAttempt(this.stateTracker.store, entry)); }
    catch (error) { throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", errorMessage(error)); }
    this.outcome = structuredClone(outcome);
    active.turn = legacyTerminal.turn;
    active.run = legacyTerminal.run;
    try { await sealing.measure("event_flush", () => this.storeTail); }
    catch (error) { throw new OutcomeProtocolError("TERMINAL_PUBLICATION_FAILED", errorMessage(error)); }
    await publishAttempt(this.stateTracker.store, this.eventStore, entry, sealing);
    active.phase = "ended";
    this.notify(entry.terminalEvent);
    return result;
  }

  private legacyTerminal(outcome: AgentOutcomeV1, result: LoopAgentResult, turn: TurnSnapshot, run: RuntimeRunSnapshot): LegacyTerminalPayload {
    const completion = assessCompletion(result, this.completionContract ?? DEFAULT_COMPLETION_CONTRACT);
    const failed = outcome.execution.status === "failed" || outcome.execution.status === "cancelled";
    const status: TurnSnapshot["status"] = failed ? outcome.execution.status === "cancelled" ? "cancelled" : "failed" : completion.status;
    const base = {
      thread: { ...this.threadSnapshot(), status: "idle" as const, activeTurnId: undefined, updatedAt: outcome.endedAt },
      turn: { ...turn, status, updatedAt: outcome.endedAt, completedAt: outcome.endedAt },
      run: { ...run, status, sequence: ++this.rootRunSequence, updatedAt: outcome.endedAt, finishedAt: outcome.endedAt, success: !failed && completion.success, steps: result.steps, usage: result.totalUsage },
    };
    const item = { itemId: this.idFactory(), threadId: outcome.threadId, turnId: outcome.turnId, runId: outcome.runId, createdAt: outcome.endedAt };
    if (failed) return { ...base, type: "turn_failed", item: { ...item, type: "error", error: outcome.execution.error?.message ?? "Cancelled" }, interrupted: outcome.execution.status === "cancelled" };
    return {
      ...base, type: completion.status === "completed" ? "turn_completed" : "turn_incomplete",
      item: { ...item, type: "message", role: "assistant", text: result.text },
      result: { text: result.text, steps: result.steps, totalUsage: result.totalUsage, stopped: result.stopped,
        completion: { status: completion.status, success: completion.success, modelClaimedSuccess: completion.modelClaimedSuccess,
          evidenceState: completion.evidenceState, infrastructureOutcome: completion.infrastructureOutcome,
          reason: completion.reason, evidence: completion.ledger.evidence, requirements: completion.ledger.requirements } },
    };
  }

  private terminalEntry(outcome: AgentOutcomeV1, legacyTerminal: LegacyTerminalPayload): PersistedAttemptOutcome {
    const event: RuntimeEventV3 = {
      schemaVersion: 3, eventId: this.idFactory(), sequence: ++this.sequence, timestamp: outcome.endedAt,
      threadId: outcome.threadId, turnId: outcome.turnId, runId: outcome.runId,
      correlationId: outcome.turnId, causationId: this.lastEventId,
      payload: { type: "attempt_ended", outcome, legacyTerminal },
    };
    this.lastEventId = event.eventId;
    return { outcome, legacyTerminal, terminalEventId: event.eventId, terminalEventSequence: event.sequence, terminalEvent: event, publication: "pending" };
  }

  private async replayOutbox(): Promise<void> {
    await this.ensureSequence();
    const state = await this.stateTracker.store.load(this.threadId);
    if (!state) return;
    if (this.sequence === 0) this.createdAt = state.thread.createdAt;
    for (const entry of Object.values(state.attemptOutcomes).sort((a, b) => a.terminalEventSequence - b.terminalEventSequence)) {
      if (entry.publication === "pending") {
        await publishAttempt(this.stateTracker.store, this.eventStore, entry);
        this.notify(entry.terminalEvent);
      }
      if (entry.terminalEventSequence >= this.sequence) {
        this.sequence = entry.terminalEventSequence;
        this.lastEventId = entry.terminalEventId;
      }
      this.outcome = structuredClone(entry.outcome);
    }
    for (const turn of Object.values(state.turns)) {
      if (turn.resultSchema !== "outcome-v1" || state.attemptOutcomes[turn.rootRunId]) continue;
      const run = state.runs[turn.rootRunId];
      if (!run) continue;
      const endedAt = this.clock();
      const result: LoopAgentResult = { text: "", steps: run.steps ?? 0, toolResults: [], totalUsage: run.usage ?? { inputTokens: 0, outputTokens: 0 } };
      const outcome: AgentOutcomeV1 = {
        schema: "zap.outcome", schemaVersion: 1, threadId: this.threadId, turnId: turn.turnId, runId: run.runId, attemptId: run.runId,
        startedAt: turn.createdAt, endedAt,
        execution: classifyExecution({ attemptId: run.runId, result, error: new OutcomeProtocolError("RUN_INTERRUPTED", "Runtime owner exited before persisting a terminal outcome") }),
        acceptance: { attemptId: run.runId, status: "unverified", code: "RUN_INTERRUPTED", checks: [] },
        workflow: { attemptId: run.runId, status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" },
      };
      const terminal = this.legacyTerminal(outcome, result, turn, { ...run, task: run.taskPreview });
      const entry = this.terminalEntry(outcome, terminal);
      try { await saveAttempt(this.stateTracker.store, entry); }
      catch (error) { throw new OutcomeProtocolError("OUTCOME_PERSISTENCE_FAILED", errorMessage(error)); }
      await publishAttempt(this.stateTracker.store, this.eventStore, entry);
      this.notify(entry.terminalEvent);
      this.outcome = structuredClone(outcome);
    }
  }

  private notify(event: RuntimeEvent): void {
    notifyRuntimeObserver(this.observer, { kind: "runtime_event", event });
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers cannot alter the terminal result. */ }
    }
  }

  /** Read-only coordinator dependency facts; never enter the model prompt. */
  recordAgentDependencies(childRunId: string, dependencies: string[]): void {
    const active = this.active;
    if (!active || !this.observer) return;
    notifyRuntimeObserver(this.observer, { kind: "dependencies", scope: { threadId: this.threadId,
      turnId: active.turn.turnId, runId: active.run.runId, rootRunId: active.run.runId }, childRunId, dependencies });
  }

  /** Accept events emitted by child agents that do not pass through the root
   * LoopAgent emitter. RuntimeFactory wires its subagent callback here. */
  recordAgentEvent(event: AgentEvent): void {
    this.handleAgentEvent(event);
  }

  async close(): Promise<void> {
    if (this.busy) throw new Error(`Cannot close thread ${this.threadId} while it has an active turn or pending persistence`);
    this.agent.off("*", this.handleAgentEvent);
    await this.flushEvents();
    await this.eventStore.close();
    this.listeners.clear();
  }

  private readonly handleAgentEvent: AgentEventHandler = (event) => {
    const active = this.active;
    if (!active || active.phase === "sealing" || active.phase === "ended") return;
    // LoopAgent emits cumulative metrics in finally even when run() throws.
    // Retain a root-only snapshot for that failure path, not a sum of events.
    if (!event.path?.length && event.type === "run_ended") {
      active.observedMetrics = { steps: event.steps, totalUsage: { ...event.usage } };
    }
    if (event.type === "content_final" && event.kind === "tool_result") {
      const receipt = ServiceReceiptSchema.safeParse(event.result.runtime?.service);
      if (receipt.success) active.observedServices?.push(receipt.data);
      const operation = ServiceOperationObservationSchema.safeParse(event.result.runtime?.serviceOperation);
      if (operation.success) active.observedServiceOperations?.push(operation.data);
    }
    if (!event.path?.length && event.type === "content_final") {
      if (event.kind === "tool_result") active.observedTools?.push(event.result);
      if (event.kind === "text") active.observedText = event.text;
    }
    if (this.observability === "minimal" && event.type === "run_step") {
      const { context: _context, ...withoutContext } = event;
      event = withoutContext;
    }
    const path = event.path ?? [];
    const eventRunId = event.type === "agent_run_state"
      ? event.run.runId
      : path.at(-1) ?? active.run.runId;
    const parentRunId = event.type === "agent_run_state"
      ? event.run.parentRunId
      : path.length > 1
        ? path.at(-2)
        : path.length === 1
          ? active.run.runId
          : undefined;
    const toolRunId = event.type === "agent_run_state"
      ? event.run.toolCallId
      : event.type === "tool_call_pending"
        || (event.type === "content_final"
          && (event.kind === "tool_call" || event.kind === "tool_result"))
        ? event.id
        : undefined;
    const workspaceId = event.type === "agent_run_state" ? event.run.workspaceId : undefined;
    const item: AgentEventRuntimeItem = {
      itemId: this.idFactory(),
      threadId: this.threadId,
      turnId: active.turn.turnId,
      runId: eventRunId,
      type: "agent_event",
      event,
      createdAt: this.clock(),
    };
    this.publish(
      { type: "agent_event", item },
      { runId: eventRunId, parentRunId, toolRunId, workspaceId },
    );
  };

  private ensureSequence(): Promise<void> {
    if (!this.sequenceReady) {
      this.sequenceReady = Promise.all([
        this.eventStore.latestSequence(this.threadId),
        this.eventStore.list(this.threadId, { limit: 1 }),
        this.eventStore.list(this.threadId, { direction: "backward", limit: 1 }),
      ]).then(([sequence, firstEvents, lastEvents]) => {
        this.sequence = sequence;
        this.lastEventId = lastEvents[0]?.eventId;
        const firstPayload = firstEvents[0]?.payload;
        if (firstPayload && "thread" in firstPayload) {
          this.createdAt = firstPayload.thread.createdAt;
        }
      });
    }
    return this.sequenceReady;
  }

  private publish(
    payload: RuntimeEventPayload,
    identity: {
      runId?: string;
      parentRunId?: string;
      toolRunId?: string;
      workspaceId?: string;
    } = {},
  ): void {
    const active = this.active;
    const event: RuntimeEvent = {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: this.idFactory(),
      sequence: ++this.sequence,
      timestamp: this.clock(),
      threadId: this.threadId,
      turnId: active?.turn.turnId,
      runId: identity.runId ?? active?.run.runId,
      parentRunId: identity.parentRunId,
      toolRunId: identity.toolRunId,
      workspaceId: identity.workspaceId,
      correlationId: active?.turn.turnId ?? this.threadId,
      causationId: this.lastEventId,
      payload,
    };
    this.lastEventId = event.eventId;
    notifyRuntimeObserver(this.observer, { kind: "runtime_event", event });
    // Invoke append immediately so buffered stores can coalesce streaming
    // deltas. The store contract preserves per-thread ordering.
    const append = this.eventStore.append(event);
    this.storeTail = Promise.all([this.storeTail, append]).then(() => undefined);
    void this.storeTail.catch(() => undefined);
    this.stateTracker?.recordRuntimeEvent(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Runtime observers are projections, not lifecycle hooks. HookBus will
        // provide explicit blocking/failure semantics in its own phase.
      }
    }
  }

  private async flushEvents(): Promise<void> {
    await this.stateTracker?.flush();
    try {
      await this.storeTail;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.onEventStoreError?.(normalized);
      if (this.eventStoreFailureMode === "required") throw normalized;
      // Event persistence is observability during Phase 0, not mutable control
      // state. Preserve the completed agent result; RuntimeStateStore will use
      // fail-closed semantics once crash recovery depends on it.
      this.storeTail = Promise.resolve();
    }
  }
}

function latestServices(receipts: ServiceReceipt[]): ServiceReceipt[] {
  const latest = new Map<string, ServiceReceipt>();
  for (const receipt of receipts) {
    const key = JSON.stringify([receipt.backendId, receipt.ownerId, receipt.ownerGeneration, receipt.workspaceId, receipt.serviceId]);
    const previous = latest.get(key);
    if (!previous || receipt.observedAt >= previous.observedAt) latest.set(key, receipt);
  }
  return [...latest.values()];
}

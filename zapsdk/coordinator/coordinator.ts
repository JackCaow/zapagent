import { randomUUID } from "node:crypto";
import { isTerminalAgentRunStatus, type AgentRunSnapshot, type AgentRunStatus } from "../agent/run-state.js";
import { InMemoryAgentCoordinatorStateStore } from "./store.js";
import {
  AGENT_COORDINATOR_STATE_VERSION,
  type AgentCoordinatorEvent,
  type AgentCoordinatorExecutor,
  type AgentCoordinatorListener,
  type AgentCoordinatorResult,
  type AgentCoordinatorState,
  type AgentCoordinatorStateStore,
  type AgentMailboxMessage,
  type AgentTaskNode,
  type SpawnAgentInput,
  type AgentCoordinatorBindings,
} from "./types.js";

interface RunControl {
  bindings?: AgentCoordinatorBindings;
  input: SpawnAgentInput;
  controller: AbortController;
  started: boolean;
  occupiesCapacity: boolean;
  capacityWaiter?: CapacityWaiter;
  settled: boolean;
  waiters: Array<(result: AgentCoordinatorResult) => void>;
  messageWaiters: Array<(message: AgentMailboxMessage) => void>;
}

interface CapacityWaiter {
  runId: string;
  status: AgentRunStatus;
  detail?: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
}

export interface AgentCoordinatorOptions {
  threadId: string;
  executor: AgentCoordinatorExecutor;
  stateStore?: AgentCoordinatorStateStore;
  maxConcurrency?: number;
  idFactory?: () => string;
  clock?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneRun(run: AgentRunSnapshot): AgentRunSnapshot {
  return structuredClone(run);
}

function cloneTask(task: AgentTaskNode): AgentTaskNode {
  return structuredClone(task);
}

function emptyState(threadId: string, now: number): AgentCoordinatorState {
  return {
    schemaVersion: AGENT_COORDINATOR_STATE_VERSION,
    threadId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    runs: {},
    tasks: {},
    messages: [],
    results: {},
  };
}

function waitStatus(status: AgentRunStatus): boolean {
  return status === "waiting_approval" || status === "waiting_input";
}

/** Runtime-owned lifecycle and scheduling boundary for independently
 * controllable agents. Tool adapters submit work here; they never construct
 * or retain agent instances themselves. */
export class AgentCoordinator {
  readonly threadId: string;

  private readonly executor: AgentCoordinatorExecutor;
  private readonly stateStore: AgentCoordinatorStateStore;
  private readonly maxConcurrency: number;
  private readonly idFactory: () => string;
  private readonly clock: () => number;
  private readonly listeners = new Set<AgentCoordinatorListener>();
  private readonly controls = new Map<string, RunControl>();
  private readonly capacityWaiters: CapacityWaiter[] = [];
  private activeCount = 0;
  private state?: AgentCoordinatorState;
  private initializePromise?: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();
  private pumpTail: Promise<void> = Promise.resolve();

  constructor(options: AgentCoordinatorOptions) {
    if (!options.threadId.trim()) throw new Error("AgentCoordinator threadId is required");
    const maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("AgentCoordinator maxConcurrency must be a positive integer");
    }
    this.threadId = options.threadId;
    this.executor = options.executor;
    this.stateStore = options.stateStore ?? new InMemoryAgentCoordinatorStateStore();
    this.maxConcurrency = maxConcurrency;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? Date.now;
  }

  subscribe(listener: AgentCoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async spawn(input: SpawnAgentInput, bindings?: AgentCoordinatorBindings): Promise<AgentRunSnapshot> {
    await this.initialize();
    const task = input.task.trim();
    if (!task) throw new Error("Agent task is required");
    const dependencies = [...new Set(input.dependencies ?? [])];
    for (const dependency of dependencies) {
      if (!this.current().runs[dependency]) throw new Error(`Unknown Agent dependency: ${dependency}`);
    }
    const runId = this.idFactory();
    if (dependencies.includes(runId)) throw new Error("Agent cannot depend on itself");
    const now = this.clock();
    const status: AgentRunStatus = dependencies.length > 0 ? "waiting_dependency" : "scheduled";
    const run: AgentRunSnapshot = {
      runId,
      toolCallId: input.toolCallId,
      parentRunId: input.parentRunId,
      agentType: input.agentType,
      task,
      status,
      sequence: 1,
      createdAt: now,
      updatedAt: now,
      statusDetail: dependencies.length > 0 ? `waiting for ${dependencies.length} dependencies` : "scheduled",
    };
    const node: AgentTaskNode = {
      runId,
      dependencies,
      status: "pending",
      resumeOfRunId: input.resumeOfRunId,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: now,
      updatedAt: now,
    };
    this.current().runs[runId] = run;
    this.current().tasks[runId] = node;
    this.controls.set(runId, { ...this.createControl(input), bindings });
    await this.persist();
    this.emit({ type: "run_state", run: cloneRun(run) });
    this.emit({ type: "task_state", task: cloneTask(node) });
    this.schedulePump();
    return cloneRun(run);
  }

  async wait(runId: string): Promise<AgentCoordinatorResult> {
    await this.initialize();
    const existing = this.current().results[runId];
    if (existing) return structuredClone(existing);
    const run = this.requireRun(runId);
    if (isTerminalAgentRunStatus(run.status)) return this.resultForTerminalRun(run);
    const control = this.controls.get(runId);
    if (!control) return this.resultForTerminalRun(run);
    return new Promise((resolve) => { control.waiters.push(resolve); });
  }

  async cancel(runId: string, reason = "cancelled by coordinator"): Promise<AgentRunSnapshot> {
    await this.initialize();
    const run = this.requireRun(runId);
    if (isTerminalAgentRunStatus(run.status)) return cloneRun(run);
    const control = this.controls.get(runId);
    if (control?.settled) {
      await this.finish(runId, {
        ...(this.current().results[runId] ?? this.resultForTerminalRun(run)),
        runId,
        success: false,
        error: reason,
      }, "cancelled", reason);
      return cloneRun(this.requireRun(runId));
    }
    if (!control?.started) {
      await this.finish(runId, {
        runId,
        success: false,
        text: "",
        error: reason,
      }, "cancelled", reason);
      return cloneRun(this.requireRun(runId));
    }
    await this.transition(runId, "cancelling", reason);
    control.controller.abort(new Error(reason));
    return cloneRun(this.requireRun(runId));
  }

  async steer(runId: string, text: string): Promise<AgentMailboxMessage> {
    return this.send({ toRunId: runId, kind: "steer", text });
  }

  async send(input: {
    toRunId: string;
    fromRunId?: string;
    kind?: AgentMailboxMessage["kind"];
    text: string;
  }): Promise<AgentMailboxMessage> {
    await this.initialize();
    this.requireRun(input.toRunId);
    if (input.fromRunId) this.requireRun(input.fromRunId);
    const text = input.text.trim();
    if (!text) throw new Error("Agent mailbox message is required");
    const message: AgentMailboxMessage = {
      messageId: this.idFactory(),
      threadId: this.threadId,
      toRunId: input.toRunId,
      fromRunId: input.fromRunId,
      kind: input.kind ?? "message",
      text,
      createdAt: this.clock(),
    };
    this.current().messages.push(message);
    await this.persist();
    this.emit({ type: "mailbox", message: structuredClone(message) });
    this.deliverMessage(message);
    return structuredClone(message);
  }

  async resume(runId: string): Promise<AgentRunSnapshot> {
    await this.initialize();
    const previous = this.requireRun(runId);
    const control = this.controls.get(runId);
    if (!isTerminalAgentRunStatus(previous.status) && !control?.settled) {
      await this.send({ toRunId: runId, kind: "resume", text: "resume" });
      return cloneRun(previous);
    }
    return this.spawn({
      task: previous.task,
      agentType: previous.agentType,
      parentRunId: previous.parentRunId,
      resumeOfRunId: runId,
      metadata: {
        ...structuredClone(this.current().tasks[runId]?.metadata ?? {}),
        resumed: true,
      },
    });
  }

  async list(): Promise<AgentRunSnapshot[]> {
    await this.initialize();
    return Object.values(this.current().runs)
      .sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId))
      .map(cloneRun);
  }

  async markMerging(runId: string, detail = "merging artifact"): Promise<void> {
    await this.initialize();
    await this.transition(runId, "merging", detail);
  }

  async completeMerge(runId: string, success: boolean, detail?: string): Promise<void> {
    await this.initialize();
    const existing = this.current().results[runId] ?? this.resultForTerminalRun(this.requireRun(runId));
    await this.finish(runId, {
      ...existing,
      success,
      error: success ? undefined : detail ?? "artifact merge failed",
    }, success ? "completed" : "blocked", detail);
  }

  private initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.loadState();
    }
    return this.initializePromise;
  }

  private async loadState(): Promise<void> {
    const loaded = await this.stateStore.load(this.threadId);
    if (loaded && (loaded.schemaVersion !== AGENT_COORDINATOR_STATE_VERSION || loaded.threadId !== this.threadId)) {
      throw new Error(`Invalid AgentCoordinator state for ${this.threadId}`);
    }
    this.state = loaded ?? emptyState(this.threadId, this.clock());
    let changed = false;
    for (const run of Object.values(this.state.runs)) {
      const input: SpawnAgentInput = {
        task: run.task,
        agentType: run.agentType,
        parentRunId: run.parentRunId,
        toolCallId: run.toolCallId,
        dependencies: this.state.tasks[run.runId]?.dependencies,
        resumeOfRunId: this.state.tasks[run.runId]?.resumeOfRunId,
        metadata: structuredClone(this.state.tasks[run.runId]?.metadata ?? {}),
      };
      this.controls.set(run.runId, this.createControl(input));
      const control = this.controls.get(run.runId)!;
      if (this.state.results[run.runId]) {
        control.started = true;
        control.settled = true;
      }
      if (run.status === "scheduled" || run.status === "waiting_dependency" || run.status === "waiting_capacity") {
        continue;
      }
      if (run.status === "ready_to_merge" && this.state.results[run.runId]) {
        const task = this.state.tasks[run.runId];
        if (task && task.status !== "running") {
          task.status = "running";
          task.updatedAt = this.clock();
          changed = true;
        }
        continue;
      }
      if (!isTerminalAgentRunStatus(run.status)) {
        const now = this.clock();
        run.status = "blocked";
        run.statusDetail = "interrupted execution requires explicit resume";
        run.sequence++;
        run.updatedAt = now;
        run.finishedAt = now;
        run.success = false;
        const task = this.state.tasks[run.runId];
        if (task) {
          task.status = "failed";
          task.updatedAt = now;
        }
        changed = true;
      }
    }
    if (changed) await this.persist();
    this.schedulePump();
  }

  private createControl(input: SpawnAgentInput): RunControl {
    return {
      input: structuredClone(input),
      controller: new AbortController(),
      started: false,
      occupiesCapacity: false,
      settled: false,
      waiters: [],
      messageWaiters: [],
    };
  }

  private schedulePump(): void {
    this.pumpTail = this.pumpTail.then(() => this.pump());
  }

  private async pump(): Promise<void> {
    while (this.activeCount < this.maxConcurrency) {
      const waiter = this.capacityWaiters.shift();
      if (waiter) {
        const control = this.controls.get(waiter.runId);
        if (!control || control.settled || control.controller.signal.aborted
          || this.requireRun(waiter.runId).status === "cancelling") {
          waiter.reject(new Error("Agent capacity wait cancelled"));
          continue;
        }
        if (!control.occupiesCapacity) {
          control.occupiesCapacity = true;
          this.activeCount++;
        }
        try {
          await this.transition(waiter.runId, waiter.status, waiter.detail);
          if (control.controller.signal.aborted) waiter.reject(new Error("Agent capacity wait cancelled"));
          else waiter.resolve();
        } catch (error) {
          this.releaseCapacity(control);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      const next = Object.values(this.current().runs)
        .filter((run) => {
          const control = this.controls.get(run.runId);
          return control && !control.started && !isTerminalAgentRunStatus(run.status);
        })
        .sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId))
        .find((run) => this.dependenciesReady(run.runId));
      if (!next) break;
      const blockedReason = this.dependencyFailure(next.runId);
      if (blockedReason) {
        await this.finish(next.runId, {
          runId: next.runId,
          success: false,
          text: "",
          error: blockedReason,
        }, "blocked", blockedReason);
        continue;
      }
      const control = this.controls.get(next.runId)!;
      control.started = true;
      control.occupiesCapacity = true;
      this.activeCount++;
      void this.executeRun(next.runId, control);
    }
    for (const run of Object.values(this.current().runs)) {
      const control = this.controls.get(run.runId);
      if (!control?.started && run.status === "scheduled" && this.activeCount >= this.maxConcurrency) {
        await this.transition(run.runId, "waiting_capacity", "waiting for Agent capacity");
      } else if (!control?.started && run.status !== "waiting_dependency" && !this.dependenciesReady(run.runId)) {
        await this.transition(run.runId, "waiting_dependency", "waiting for Agent dependencies");
      }
    }
  }

  private dependenciesReady(runId: string): boolean {
    const node = this.current().tasks[runId];
    if (!node) return true;
    return node.dependencies.every((dependency) => {
      const task = this.current().tasks[dependency];
      return task?.status === "succeeded" || task?.status === "failed" || task?.status === "cancelled";
    });
  }

  private dependencyFailure(runId: string): string | undefined {
    const node = this.current().tasks[runId];
    const failed = node?.dependencies.find((dependency) =>
      this.current().tasks[dependency]?.status !== "succeeded"
    );
    return failed ? `dependency ${failed} did not succeed` : undefined;
  }

  private async executeRun(runId: string, control: RunControl): Promise<void> {
    const task = this.current().tasks[runId]!;
    task.status = "running";
    task.updatedAt = this.clock();
    this.emit({ type: "task_state", task: cloneTask(task) });
    try {
      await this.transition(runId, "starting", "preparing Agent runtime");
      await this.transition(runId, "running", "Agent running", { startedAt: this.clock() });
      const result = await this.executor.execute({
        threadId: this.threadId,
        run: cloneRun(this.requireRun(runId)),
        metadata: structuredClone(control.input.metadata ?? {}),
        signal: control.controller.signal,
        runtimeObservation: control.bindings?.runtimeObservation,
        observations: control.bindings?.observations,
        deadlineAtMs: control.bindings?.deadlineAtMs,
        reportStatus: (status, detail) => this.reportExecutorStatus(runId, status, detail),
        drainMailbox: () => this.drainMailbox(runId),
        waitForMessage: () => this.waitForMessage(runId),
      });
      const current = this.requireRun(runId);
      // Cancellation is already authoritative while its transition is being
      // persisted, before cancel() delivers the AbortSignal to the executor.
      const cancelled = control.controller.signal.aborted || current.status === "cancelling";
      const cancellationReason = control.controller.signal.aborted
        ? errorMessage(control.controller.signal.reason) : current.statusDetail;
      const settled = cancelled || !result.success ? {
        ...result,
        success: false,
        error: cancelled ? cancellationReason : result.error,
        artifactId: undefined,
        changedPaths: undefined,
      } : result;
      const status: AgentRunStatus = cancelled ? "cancelled" : !settled.success ? "failed"
        : settled.artifactId ? "ready_to_merge" : "completed";
      await this.finish(runId, { ...settled, runId }, status, settled.artifactId
        ? `${settled.changedPaths?.length ?? 0} file(s) ready to merge`
        : settled.error);
    } catch (error) {
      const cancelled = control.controller.signal.aborted || this.requireRun(runId).status === "cancelling";
      await this.finish(runId, {
        runId,
        success: false,
        text: "",
        error: errorMessage(error),
      }, cancelled ? "cancelled" : "failed", errorMessage(error));
    } finally {
      control.bindings = undefined;
      this.releaseCapacity(control);
      this.schedulePump();
    }
  }

  private async reportExecutorStatus(
    runId: string,
    status: AgentRunStatus,
    detail?: string,
  ): Promise<void> {
    const control = this.controls.get(runId);
    if (!control || control.settled) return;
    if (control.controller.signal.aborted || this.requireRun(runId).status === "cancelling") {
      throw new Error("Agent capacity wait cancelled");
    }
    if (waitStatus(status)) {
      this.releaseCapacity(control);
      await this.transition(runId, status, detail);
      this.schedulePump();
      return;
    }
    if (status === "running") {
      // A model batch may approve several tools concurrently. They must share
      // one admission or a single Agent can consume every capacity slot.
      if (control.capacityWaiter) return control.capacityWaiter.promise;
      if (!control.occupiesCapacity) {
        let resolve!: () => void;
        let reject!: (reason: Error) => void;
        const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        const cleanup = () => {
          control.controller.signal.removeEventListener("abort", abort);
          const index = this.capacityWaiters.indexOf(waiter);
          if (index >= 0) this.capacityWaiters.splice(index, 1);
          if (control.capacityWaiter === waiter) control.capacityWaiter = undefined;
        };
        const waiter: CapacityWaiter = {
          runId, status, detail, promise,
          resolve: () => { cleanup(); resolve(); },
          reject: (reason) => { cleanup(); reject(reason); },
        };
        const abort = () => waiter.reject(new Error("Agent capacity wait cancelled"));
        control.capacityWaiter = waiter;
        control.controller.signal.addEventListener("abort", abort, { once: true });
        this.capacityWaiters.push(waiter);
        this.schedulePump();
        return promise;
      }
    }
    await this.transition(runId, status, detail);
  }

  private releaseCapacity(control: RunControl): void {
    if (!control.occupiesCapacity) return;
    control.occupiesCapacity = false;
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  private async transition(
    runId: string,
    status: AgentRunStatus,
    detail?: string,
    patch: Partial<AgentRunSnapshot> = {},
  ): Promise<void> {
    const current = this.requireRun(runId);
    if (isTerminalAgentRunStatus(current.status)) return;
    const now = this.clock();
    const next: AgentRunSnapshot = {
      ...current,
      ...patch,
      status,
      statusDetail: detail,
      sequence: current.sequence + 1,
      updatedAt: now,
    };
    this.current().runs[runId] = next;
    await this.persist();
    this.emit({ type: "run_state", run: cloneRun(next) });
  }

  private async finish(
    runId: string,
    result: AgentCoordinatorResult,
    status: AgentRunStatus,
    detail?: string,
  ): Promise<void> {
    const control = this.controls.get(runId);
    const current = this.requireRun(runId);
    if (isTerminalAgentRunStatus(current.status) && this.current().results[runId]) return;
    const now = this.clock();
    const terminal = isTerminalAgentRunStatus(status);
    const next: AgentRunSnapshot = {
      ...current,
      status,
      statusDetail: detail,
      sequence: current.sequence + 1,
      updatedAt: now,
      finishedAt: terminal ? now : undefined,
      success: result.success,
      steps: result.steps,
      usage: result.usage,
      workspaceId: result.workspaceId,
      artifactId: result.artifactId,
    };
    const task = this.current().tasks[runId];
    if (task) {
      // An isolated write run is not a successful dependency until its
      // artifact has actually merged. Starting dependents at ready_to_merge
      // would make them observe stale root-workspace content.
      task.status = terminal
        ? result.success ? "succeeded" : status === "cancelled" ? "cancelled" : "failed"
        : "running";
      task.updatedAt = now;
    }
    this.current().runs[runId] = next;
    this.current().results[runId] = structuredClone(result);
    const firstSettlement = control ? !control.settled : false;
    if (control) {
      control.settled = true;
      control.capacityWaiter?.reject(new Error("Agent finished while waiting for capacity"));
      control.bindings = undefined;
    }
    await this.persist();
    this.emit({ type: "run_state", run: cloneRun(next) });
    if (task) this.emit({ type: "task_state", task: cloneTask(task) });
    if (firstSettlement) {
      for (const resolve of control?.waiters.splice(0) ?? []) resolve(structuredClone(result));
    }
    this.schedulePump();
  }

  private async drainMailbox(runId: string): Promise<AgentMailboxMessage[]> {
    const now = this.clock();
    const messages = this.current().messages.filter((message) =>
      message.toRunId === runId && message.consumedAt === undefined
    );
    for (const message of messages) message.consumedAt = now;
    if (messages.length > 0) await this.persist();
    return structuredClone(messages);
  }

  private async waitForMessage(runId: string): Promise<AgentMailboxMessage> {
    const available = await this.drainMailbox(runId);
    if (available[0]) return available[0];
    const control = this.controls.get(runId);
    if (!control) throw new Error(`Unknown Agent run: ${runId}`);
    return new Promise((resolve, reject) => {
      const deliver = (message: AgentMailboxMessage) => {
        control.controller.signal.removeEventListener("abort", abort);
        resolve(structuredClone(message));
      };
      const abort = () => {
        const index = control.messageWaiters.indexOf(deliver);
        if (index >= 0) control.messageWaiters.splice(index, 1);
        reject(control.controller.signal.reason ?? new Error("Agent cancelled"));
      };
      if (control.controller.signal.aborted) abort();
      else control.controller.signal.addEventListener("abort", abort, { once: true });
      control.messageWaiters.push(deliver);
    });
  }

  private deliverMessage(message: AgentMailboxMessage): void {
    const control = this.controls.get(message.toRunId);
    const waiter = control?.messageWaiters.shift();
    if (!waiter) return;
    message.consumedAt = this.clock();
    void this.persist();
    waiter(structuredClone(message));
  }

  private resultForTerminalRun(run: AgentRunSnapshot): AgentCoordinatorResult {
    return {
      runId: run.runId,
      success: run.success === true,
      text: "",
      steps: run.steps,
      usage: run.usage,
      workspaceId: run.workspaceId,
      artifactId: run.artifactId,
      error: run.success === true ? undefined : run.statusDetail ?? `Agent ${run.status}`,
    };
  }

  private requireRun(runId: string): AgentRunSnapshot {
    const run = this.current().runs[runId];
    if (!run) throw new Error(`Unknown Agent run: ${runId}`);
    return run;
  }

  private current(): AgentCoordinatorState {
    if (!this.state) throw new Error("AgentCoordinator is not initialized");
    return this.state;
  }

  private persist(): Promise<void> {
    const state = this.current();
    state.revision++;
    state.updatedAt = this.clock();
    const snapshot = structuredClone(state);
    const write = this.persistTail
      .catch(() => undefined)
      .then(() => this.stateStore.save(snapshot));
    this.persistTail = write.catch(() => undefined);
    return write;
  }

  private emit(event: AgentCoordinatorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        // Observers cannot change durable coordinator lifecycle.
      }
    }
  }
}

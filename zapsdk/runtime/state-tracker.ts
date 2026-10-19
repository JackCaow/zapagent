import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { AgentRunSnapshot, AgentRunStatus } from "../agent/run-state.js";
import type {
  ApprovalLifecycleEvent,
  ToolExecutionLifecycleEvent,
} from "../tools/executor.js";
import type { MergeLifecycleEvent } from "../merge/coordinator.js";
import type { WorkspaceLifecycleEvent } from "../workspace/types.js";
import { sliceHeadCodePoints } from "../utils/logical-lines.js";
import { isRuntimeOwnerAlive } from "./owner.js";
import type { RuntimeEvent } from "./types.js";
import {
  createRuntimeStateSnapshot,
  type PersistedRunState,
  type RuntimeRecoveryAction,
  type RuntimeRecoveryReport,
  type RuntimeOwnerState,
  type RuntimeStateSnapshot,
} from "./state-types.js";
import {
  RuntimeThreadLeaseConflictError,
  type RuntimeStateStore,
  type RuntimeThreadLease,
} from "./state-store.js";

export interface RuntimeStateTrackerOptions {
  threadId: string;
  workspaceRoot: string;
  store: RuntimeStateStore;
  clock?: () => number;
  instanceId?: string;
  pid?: number;
}

export interface RuntimeRecoveryOptions {
  clock?: () => number;
  isOwnerAlive?: (owner: RuntimeOwnerState) => boolean | Promise<boolean>;
  pathExists?: (path: string) => boolean | Promise<boolean>;
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === "completed"
    || status === "incomplete"
    || status === "blocked"
    || status === "failed"
    || status === "cancelled";
}

function taskPreview(task: string): string {
  return sliceHeadCodePoints(task, 1_000);
}

function persistedRun(
  run: AgentRunSnapshot & { threadId?: string; turnId?: string },
  threadId: string,
  turnId: string,
): PersistedRunState {
  return {
    runId: run.runId,
    threadId,
    turnId,
    parentRunId: run.parentRunId,
    toolCallId: run.toolCallId,
    agentType: run.agentType,
    taskPreview: taskPreview(run.task),
    status: run.status,
    sequence: run.sequence,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    statusDetail: run.statusDetail,
    success: run.success,
    steps: run.steps,
    usage: run.usage,
    workspaceId: run.workspaceId,
    artifactId: run.artifactId,
  };
}

function ensureState(
  current: RuntimeStateSnapshot | undefined,
  input: { threadId: string; workspaceRoot: string; now: number },
): RuntimeStateSnapshot {
  return current ?? createRuntimeStateSnapshot(input);
}

function currentTurnId(state: RuntimeStateSnapshot): string | undefined {
  return state.thread.activeTurnId;
}

function persistedToolRunId(turnId: string, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

function persistedApprovalId(turnId: string | undefined, approvalId: string): string {
  return turnId ? `${turnId}:${approvalId}` : approvalId;
}

function syncCoordinatorMergeState(
  state: RuntimeStateSnapshot,
  event: MergeLifecycleEvent,
): void {
  const coordinator = state.coordinator;
  if (!coordinator) return;
  const runIds = new Set(event.artifactIds
    .map((artifactId) => state.artifacts[artifactId]?.runId)
    .filter((runId): runId is string => Boolean(runId)));
  let changed = false;
  for (const runId of runIds) {
    const run = coordinator.runs[runId];
    if (!run) continue;
    const task = coordinator.tasks[runId];
    const success = event.type === "merge_completed" ? event.result.success : false;
    const targetStatus = event.type === "merge_started"
      ? "merging"
      : success ? "completed" : "blocked";
    const detail = event.type === "merge_started"
      ? "merging recovered artifact"
      : success
        ? "artifact merged"
        : event.type === "merge_failed"
          ? event.error
          : event.result.error ?? "artifact merge blocked";
    const successChanged = event.type !== "merge_started" && run.success !== success;
    if (run.status !== targetStatus || run.statusDetail !== detail || successChanged) {
      run.status = targetStatus;
      run.statusDetail = detail;
      run.sequence += 1;
      run.updatedAt = event.timestamp;
      if (event.type !== "merge_started") {
        run.finishedAt = event.timestamp;
        run.success = success;
      }
      changed = true;
    }
    if (task) {
      const taskStatus = event.type === "merge_started" ? "running" : success ? "succeeded" : "failed";
      if (task.status !== taskStatus) {
        task.status = taskStatus;
        task.updatedAt = event.timestamp;
        changed = true;
      }
    }
    if (event.type !== "merge_started") {
      const result = coordinator.results[runId];
      if (result && (result.success !== success || result.error !== (success ? undefined : detail))) {
        result.success = success;
        result.error = success ? undefined : detail;
        changed = true;
      }
    }
  }
  if (changed) {
    coordinator.revision += 1;
    coordinator.updatedAt = event.timestamp;
  }
}

/** Converts live Runtime/approval/workspace/merge lifecycle into atomically
 * replaceable control state. EventStore remains the append-only fact source. */
export class RuntimeStateTracker {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly store: RuntimeStateStore;

  private readonly clock: () => number;
  private readonly owner: RuntimeOwnerState;
  private lease?: RuntimeThreadLease;
  private tail: Promise<void> = Promise.resolve();
  private prepared?: Promise<RuntimeRecoveryReport[]>;

  constructor(options: RuntimeStateTrackerOptions) {
    this.threadId = options.threadId;
    this.workspaceRoot = options.workspaceRoot;
    this.store = options.store;
    this.clock = options.clock ?? Date.now;
    this.owner = {
      instanceId: options.instanceId ?? randomUUID(),
      pid: options.pid ?? process.pid,
      startedAt: this.clock(),
    };
  }

  prepareRecovery(): Promise<RuntimeRecoveryReport[]> {
    if (!this.prepared) {
      this.prepared = recoverInterruptedRuntimeStates(this.store, { clock: this.clock });
    }
    return this.prepared;
  }

  ownerSnapshot(): RuntimeOwnerState {
    return { ...this.owner };
  }

  async acquireOwnership(): Promise<void> {
    if (this.lease) return;
    const lease = await this.store.acquireThreadLease(this.threadId, this.owner);
    try {
      await this.store.update(this.threadId, (current) => {
        const state = ensureState(current, {
          threadId: this.threadId,
          workspaceRoot: this.workspaceRoot,
          now: this.clock(),
        });
        state.owner = { ...this.owner };
        state.updatedAt = this.clock();
        return state;
      });
      this.lease = lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async releaseOwnership(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    this.lease = undefined;
    try {
      await this.store.update(this.threadId, (current) => {
        if (!current || current.owner?.instanceId !== this.owner.instanceId) return null;
        current.owner = undefined;
        current.updatedAt = this.clock();
        return current;
      });
    } finally {
      await lease.release();
    }
  }

  recordRuntimeEvent(event: RuntimeEvent): void {
    if (event.threadId !== this.threadId || !this.shouldPersistEvent(event)) return;
    this.enqueue(async (state) => {
      const now = event.timestamp;
      const payload = event.payload.type === "attempt_ended" ? event.payload.legacyTerminal : event.payload;
      state.updatedAt = now;
      if (payload.type === "turn_started") {
        state.owner = { ...this.owner };
        state.thread = { ...payload.thread };
        state.turns[payload.turn.turnId] = { ...payload.turn };
        state.runs[payload.run.runId] = persistedRun(
          payload.run,
          state.threadId,
          payload.turn.turnId,
        );
        return;
      }
      if (payload.type === "turn_completed" || payload.type === "turn_incomplete" || payload.type === "turn_failed") {
        state.owner = undefined;
        state.thread = { ...payload.thread };
        state.turns[payload.turn.turnId] = { ...payload.turn };
        state.runs[payload.run.runId] = persistedRun(
          payload.run,
          state.threadId,
          payload.turn.turnId,
        );
        return;
      }

      const agentEvent = payload.item.event;
      const turnId = event.turnId ?? currentTurnId(state);
      const runId = event.runId;
      if (!turnId || !runId) return;
      if (agentEvent.type === "agent_run_state") {
        state.runs[agentEvent.run.runId] = persistedRun(
          agentEvent.run,
          state.threadId,
          turnId,
        );
        if (agentEvent.run.workspaceId && !state.workspaces[agentEvent.run.workspaceId]) {
          state.workspaces[agentEvent.run.workspaceId] = {
            workspaceId: agentEvent.run.workspaceId,
            threadId: state.threadId,
            turnId,
            runId: agentEvent.run.runId,
            mode: agentEvent.run.workspaceMode ?? "shared-readonly",
            path: agentEvent.run.workspaceMode === "shared-readonly" ? state.workspaceRoot : "",
            status: "active",
            acquiredAt: agentEvent.run.startedAt ?? agentEvent.run.createdAt,
            updatedAt: agentEvent.run.updatedAt,
          };
        }
        if (agentEvent.run.artifactId && !state.artifacts[agentEvent.run.artifactId]) {
          state.artifacts[agentEvent.run.artifactId] = {
            artifactId: agentEvent.run.artifactId,
            threadId: state.threadId,
            turnId,
            runId: agentEvent.run.runId,
            workspaceId: agentEvent.run.workspaceId ?? "unknown",
            changedPaths: [],
            status: agentEvent.run.status === "merging" ? "merging" : "ready",
            createdAt: agentEvent.run.updatedAt,
            updatedAt: agentEvent.run.updatedAt,
          };
        }
        return;
      }
      if (agentEvent.type === "content_final" && agentEvent.kind === "tool_call") {
        const toolRunId = persistedToolRunId(turnId, agentEvent.id);
        const existing = state.toolRuns[toolRunId];
        state.toolRuns[toolRunId] = {
          toolRunId,
          threadId: state.threadId,
          turnId,
          runId,
          toolName: agentEvent.toolName,
          status: "running",
          argumentsHash: createHash("sha256").update(JSON.stringify(agentEvent.arguments)).digest("hex"),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        return;
      }
      if (agentEvent.type === "content_final" && agentEvent.kind === "tool_result") {
        const toolRunId = persistedToolRunId(turnId, agentEvent.id);
        const existing = state.toolRuns[toolRunId];
        state.toolRuns[toolRunId] = {
          toolRunId,
          threadId: state.threadId,
          turnId,
          runId,
          toolName: agentEvent.toolName,
          argumentsHash: existing?.argumentsHash,
          status: agentEvent.result.success ? "completed"
            : agentEvent.result.failure?.code === "CANCELLED" ? "cancelled" : "failed",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          completedAt: now,
          success: agentEvent.result.success,
          error: agentEvent.result.error,
          checkpoint: agentEvent.result.runtime?.checkpoint,
          writeEvidence: agentEvent.result.runtime?.writeEvidence,
          execution: agentEvent.result.runtime?.execution ?? existing?.execution,
          failure: agentEvent.result.failure ?? existing?.failure,
        };
      }
    });
  }

  recordApprovalEvent(event: ApprovalLifecycleEvent): Promise<void> {
    return this.enqueue(async (state) => {
      const turnId = currentTurnId(state);
      const toolRunId = event.toolCallId && turnId
        ? persistedToolRunId(turnId, event.toolCallId)
        : event.toolCallId;
      const toolRun = toolRunId ? state.toolRuns[toolRunId] : undefined;
      const resolvedTurnId = toolRun?.turnId ?? turnId;
      const approvalId = persistedApprovalId(resolvedTurnId, event.approvalId);
      const existing = state.approvals[approvalId];
      const runId = toolRun?.runId ?? (turnId ? state.turns[turnId]?.rootRunId : undefined);
      const status = event.status === "requested" ? "pending" : event.status;
      state.updatedAt = event.timestamp;
      state.approvals[approvalId] = {
        approvalId,
        threadId: state.threadId,
        turnId: resolvedTurnId,
        runId,
        toolRunId,
        toolName: event.toolName,
        argumentsHash: event.argumentsHash,
        status,
        requestedAt: existing?.requestedAt ?? event.timestamp,
        updatedAt: event.timestamp,
        resolvedAt: event.status === "requested" ? undefined : event.timestamp,
        error: event.error,
      };
      if (toolRun) {
        toolRun.status = event.status === "requested"
          ? "waiting_approval"
          : event.status === "approved"
            ? "running"
            : event.status === "cancelled"
              ? "cancelled"
              : "failed";
        toolRun.updatedAt = event.timestamp;
      }
    });
  }

  recordToolExecutionEvent(event: ToolExecutionLifecycleEvent): Promise<void> {
    return this.enqueue(async (state) => {
      const turnId = currentTurnId(state);
      if (!turnId) return;
      const sourceId = event.toolCallId ?? event.executionId;
      const toolRunId = persistedToolRunId(turnId, sourceId);
      const existing = state.toolRuns[toolRunId];
      const runId = existing?.runId ?? state.turns[turnId]?.rootRunId;
      if (!runId) return;
      const status = event.status === "started"
        ? "running"
        : event.status === "completed"
          ? "completed"
          : event.status === "cancelled"
            ? "cancelled"
            : "failed";
      state.updatedAt = event.timestamp;
      state.toolRuns[toolRunId] = {
        toolRunId,
        threadId: state.threadId,
        turnId,
        runId,
        toolName: event.toolName,
        status,
        argumentsHash: existing?.argumentsHash ?? event.argumentsHash,
        createdAt: existing?.createdAt ?? event.timestamp,
        updatedAt: event.timestamp,
        completedAt: event.status === "started" ? undefined : event.timestamp,
        success: event.status === "started" ? undefined : event.status === "completed",
        error: event.error,
        checkpoint: existing?.checkpoint,
        writeEvidence: existing?.writeEvidence,
        execution: event.execution ?? existing?.execution,
        failure: event.failure ?? existing?.failure,
      };
    });
  }

  recordWorkspaceEvent(event: WorkspaceLifecycleEvent): Promise<void> {
    return this.enqueue(async (state) => {
      state.updatedAt = event.timestamp;
      const turnId = state.runs[event.lease.runId]?.turnId ?? currentTurnId(state);
      if (event.type === "workspace_acquire_started") {
        state.workspaces[event.lease.workspaceId] = {
          workspaceId: event.lease.workspaceId,
          threadId: state.threadId,
          turnId,
          runId: event.lease.runId,
          mode: event.lease.mode,
          path: event.lease.path,
          batchPath: event.lease.batchPath,
          status: "acquiring",
          acquiredAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        return;
      }
      if (event.type === "workspace_acquired" || event.type === "workspace_hydrated") {
        const existing = state.workspaces[event.lease.workspaceId];
        state.workspaces[event.lease.workspaceId] = {
          workspaceId: event.lease.workspaceId,
          threadId: state.threadId,
          turnId,
          runId: event.lease.runId,
          mode: event.lease.mode,
          path: event.lease.path,
          repoPath: event.lease.repoPath,
          baseOid: event.lease.baseOid,
          batchPath: event.lease.batchPath,
          status: event.type === "workspace_hydrated" ? "preserved" : "active",
          acquiredAt: existing?.acquiredAt ?? event.timestamp,
          updatedAt: event.timestamp,
        };
        return;
      }
      if (event.type === "workspace_acquire_failed") {
        const workspace = state.workspaces[event.lease.workspaceId];
        if (workspace) {
          workspace.status = "failed";
          workspace.updatedAt = event.timestamp;
          workspace.error = event.error;
        }
        return;
      }
      if (event.type === "workspace_cleanup_started") {
        const workspace = state.workspaces[event.lease.workspaceId];
        if (workspace) {
          workspace.status = "releasing";
          workspace.updatedAt = event.timestamp;
        }
        return;
      }
      if (event.type === "artifact_created") {
        state.artifacts[event.artifact.artifactId] = {
          ...event.artifact,
          threadId: state.threadId,
          turnId,
          status: "ready",
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        return;
      }
      const workspace = state.workspaces[event.lease.workspaceId];
      if (workspace) {
        workspace.status = "released";
        workspace.updatedAt = event.timestamp;
        workspace.releasedAt = event.timestamp;
      }
      for (const artifact of Object.values(state.artifacts)) {
        if (artifact.workspaceId === event.lease.workspaceId
          && (artifact.status === "ready"
            || artifact.status === "merging"
            || artifact.status === "blocked")) {
          artifact.status = "discarded";
          artifact.updatedAt = event.timestamp;
        }
      }
    });
  }

  recordMergeEvent(event: MergeLifecycleEvent): Promise<void> {
    return this.enqueue(async (state) => {
      state.updatedAt = event.timestamp;
      syncCoordinatorMergeState(state, event);
      if (event.type === "merge_started") {
        state.merges[event.mergeId] = {
          mergeId: event.mergeId,
          threadId: state.threadId,
          turnId: currentTurnId(state),
          artifactIds: [...event.artifactIds],
          status: "running",
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        for (const artifactId of event.artifactIds) {
          const artifact = state.artifacts[artifactId];
          if (artifact) {
            artifact.status = "merging";
            artifact.updatedAt = event.timestamp;
            const run = state.runs[artifact.runId];
            if (run) {
              run.status = "merging";
              run.sequence += 1;
              run.updatedAt = event.timestamp;
              run.statusDetail = "merging recovered artifact";
            }
          }
        }
        return;
      }
      const existing = state.merges[event.mergeId];
      if (event.type === "merge_failed") {
        state.merges[event.mergeId] = {
          mergeId: event.mergeId,
          threadId: state.threadId,
          turnId: existing?.turnId ?? currentTurnId(state),
          artifactIds: [...event.artifactIds],
          status: "failed",
          createdAt: existing?.createdAt ?? event.timestamp,
          updatedAt: event.timestamp,
          completedAt: event.timestamp,
          error: event.error,
        };
        for (const artifactId of event.artifactIds) {
          const artifact = state.artifacts[artifactId];
          if (!artifact) continue;
          artifact.status = "blocked";
          artifact.updatedAt = event.timestamp;
          const run = state.runs[artifact.runId];
          if (!run) continue;
          run.status = "blocked";
          run.sequence += 1;
          run.updatedAt = event.timestamp;
          run.finishedAt = event.timestamp;
          run.success = false;
          run.statusDetail = event.error;
        }
        return;
      }
      state.merges[event.mergeId] = {
        mergeId: event.mergeId,
        threadId: state.threadId,
        turnId: existing?.turnId ?? currentTurnId(state),
        artifactIds: [...event.artifactIds],
        status: event.result.success ? "completed" : "blocked",
        createdAt: existing?.createdAt ?? event.timestamp,
        updatedAt: event.timestamp,
        completedAt: event.timestamp,
        changedPaths: [...event.result.changedPaths],
        conflicts: event.result.conflicts ? [...event.result.conflicts] : undefined,
        error: event.result.error,
      };
      for (const artifactId of event.artifactIds) {
        const artifact = state.artifacts[artifactId];
        if (artifact) {
          artifact.status = event.result.success ? "merged" : "blocked";
          artifact.updatedAt = event.timestamp;
          const run = state.runs[artifact.runId];
          if (run) {
            run.status = event.result.success ? "completed" : "blocked";
            run.sequence += 1;
            run.updatedAt = event.timestamp;
            run.finishedAt = event.timestamp;
            run.success = event.result.success;
            run.statusDetail = event.result.success
              ? "artifact merged"
              : event.result.error ?? "artifact merge blocked";
          }
        }
      }
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private shouldPersistEvent(event: RuntimeEvent): boolean {
    if (event.payload.type !== "agent_event") return true;
    const agentEvent = event.payload.item.event;
    return agentEvent.type === "agent_run_state"
      || (agentEvent.type === "content_final"
        && (agentEvent.kind === "tool_call" || agentEvent.kind === "tool_result"));
  }

  private enqueue(
    mutate: (state: RuntimeStateSnapshot) => void | Promise<void>,
  ): Promise<void> {
    const next = this.tail.then(async () => {
      await this.store.update(this.threadId, async (current) => {
        const state = ensureState(current, {
          threadId: this.threadId,
          workspaceRoot: this.workspaceRoot,
          now: this.clock(),
        });
        await mutate(state);
        return state;
      });
    });
    this.tail = next;
    void next.catch(() => undefined);
    return next;
  }
}

export async function recoverInterruptedRuntimeStates(
  store: RuntimeStateStore,
  options: RuntimeRecoveryOptions = {},
): Promise<RuntimeRecoveryReport[]> {
  const clock = options.clock ?? Date.now;
  const isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
  const pathExists = options.pathExists ?? defaultPathExists;
  const reports: RuntimeRecoveryReport[] = [];
  const recoveryOwner: RuntimeOwnerState = {
    instanceId: `recovery:${randomUUID()}`,
    pid: process.pid,
    startedAt: clock(),
  };
  for (const snapshot of await store.list()) {
    let lease: RuntimeThreadLease;
    try {
      lease = await store.acquireThreadLease(snapshot.threadId, recoveryOwner);
    } catch (error) {
      if (error instanceof RuntimeThreadLeaseConflictError) continue;
      throw error;
    }
    let report: RuntimeRecoveryReport | undefined;
    try {
      await store.update(snapshot.threadId, async (current) => {
        if (!current) return null;
        if (current.owner && await isOwnerAlive(current.owner)) return null;
        const now = clock();
        const hadOwner = current.owner !== undefined;
        const actions = await classifyInterruptedState(current, now, pathExists);
        if (actions.length === 0 && !hadOwner) return null;
        current.thread.status = "idle";
        current.thread.activeTurnId = undefined;
        current.thread.updatedAt = now;
        current.owner = undefined;
        current.updatedAt = now;
        if (actions.length > 0) {
          report = { threadId: current.threadId, detectedAt: now, actions };
          current.recovery = report;
        }
        return current;
      });
    } finally {
      await lease.release();
    }
    if (report) reports.push(report);
  }
  return reports;
}

async function classifyInterruptedState(
  current: RuntimeStateSnapshot,
  now: number,
  pathExists: (path: string) => boolean | Promise<boolean>,
): Promise<RuntimeRecoveryAction[]> {
  const actions: RuntimeRecoveryAction[] = [];

  for (const approval of Object.values(current.approvals)) {
    if (approval.status !== "pending") continue;
    approval.status = "interrupted";
    approval.updatedAt = now;
    approval.resolvedAt = now;
    actions.push({
      disposition: "needs_user",
      entityType: "approval",
      entityId: approval.approvalId,
      reason: "approval Promise cannot survive process restart",
    });
  }

  for (const merge of Object.values(current.merges)) {
    if (merge.status !== "running") continue;
    merge.status = "interrupted";
    merge.updatedAt = now;
    merge.completedAt = now;
    merge.error = "merge interrupted; root application state requires inspection";
    actions.push({
      disposition: "blocked",
      entityType: "merge",
      entityId: merge.mergeId,
      reason: merge.error,
    });
    for (const artifactId of merge.artifactIds) {
      const artifact = current.artifacts[artifactId];
      if (!artifact || artifact.status !== "merging") continue;
      artifact.status = "blocked";
      artifact.updatedAt = now;
      actions.push({
        disposition: "blocked",
        entityType: "artifact",
        entityId: artifact.artifactId,
        reason: "artifact merge was interrupted",
      });
    }
  }

  for (const toolRun of Object.values(current.toolRuns)) {
    if (toolRun.status === "completed"
      || toolRun.status === "failed"
      || toolRun.status === "cancelled") continue;
    const priorStatus = toolRun.status;
    toolRun.status = priorStatus === "waiting_approval" ? "cancelled" : "failed";
    toolRun.success = false;
    toolRun.updatedAt = now;
    toolRun.completedAt = now;
    toolRun.error = `tool execution interrupted during ${priorStatus}`;
    actions.push({
      disposition: priorStatus === "waiting_approval" ? "needs_user" : "failed",
      entityType: "tool_run",
      entityId: toolRun.toolRunId,
      reason: toolRun.error,
    });
  }

  for (const run of Object.values(current.runs)) {
    if (isTerminalRunStatus(run.status)) continue;
    const priorStatus = run.status;
    run.status = priorStatus === "waiting_approval"
      || priorStatus === "ready_to_merge"
      || priorStatus === "merging"
      ? "blocked"
      : "failed";
    run.success = false;
    run.finishedAt = now;
    run.updatedAt = now;
    run.statusDetail = `interrupted during ${priorStatus}`;
    actions.push({
      disposition: priorStatus === "waiting_approval" || priorStatus === "ready_to_merge"
        ? "needs_user"
        : priorStatus === "merging"
          ? "blocked"
          : "failed",
      entityType: "run",
      entityId: run.runId,
      reason: run.statusDetail,
    });
  }

  for (const turn of Object.values(current.turns)) {
    if (turn.status !== "running") continue;
    turn.status = "failed";
    turn.updatedAt = now;
    turn.completedAt = now;
    actions.push({
      disposition: "failed",
      entityType: "turn",
      entityId: turn.turnId,
      reason: "turn interrupted before terminal state was persisted",
    });
  }

  for (const workspace of Object.values(current.workspaces)) {
    if (workspace.status !== "active"
      && workspace.status !== "acquiring"
      && workspace.status !== "releasing") continue;
    if (workspace.mode === "shared-readonly") {
      workspace.status = "released";
      workspace.updatedAt = now;
      workspace.releasedAt = now;
      actions.push({
        disposition: "cleanup_only",
        entityType: "workspace",
        entityId: workspace.workspaceId,
        reason: "shared readonly lease closed after owner exit",
      });
      continue;
    }
    if (workspace.status === "releasing") {
      await recoverInterruptedCleanup(current, workspace.workspaceId, now, pathExists, actions);
      continue;
    }
    const artifact = Object.values(current.artifacts).find((item) => (
      item.workspaceId === workspace.workspaceId
      && (item.status === "ready" || item.status === "merging" || item.status === "blocked")
    ));
    const evidenceExists = artifact ? await pathExists(workspace.path) : false;
    workspace.status = artifact && evidenceExists ? "preserved" : "orphaned";
    workspace.updatedAt = now;
    if (artifact && !evidenceExists) {
      artifact.status = "blocked";
      artifact.updatedAt = now;
      if (!actions.some((action) => (
        action.entityType === "artifact" && action.entityId === artifact.artifactId
      ))) {
        actions.push({
          disposition: "blocked",
          entityType: "artifact",
          entityId: artifact.artifactId,
          reason: "artifact workspace is missing; content cannot be resumed or merged",
        });
      }
    }
    actions.push({
      disposition: artifact
        ? evidenceExists ? "needs_user" : "blocked"
        : "cleanup_only",
      entityType: "workspace",
      entityId: workspace.workspaceId,
      reason: artifact && evidenceExists
        ? `workspace preserved for artifact ${artifact.artifactId}`
        : artifact
          ? `artifact ${artifact.artifactId} references a missing workspace`
          : "orphan workspace has no frozen artifact",
    });
  }

  return actions;
}

async function recoverInterruptedCleanup(
  current: RuntimeStateSnapshot,
  workspaceId: string,
  now: number,
  pathExists: (path: string) => boolean | Promise<boolean>,
  actions: RuntimeRecoveryAction[],
): Promise<void> {
  const workspace = current.workspaces[workspaceId];
  const evidenceExists = await pathExists(workspace.path);
  workspace.status = evidenceExists ? "preserved" : "released";
  workspace.updatedAt = now;
  workspace.releasedAt = evidenceExists ? undefined : now;
  if (!evidenceExists) {
    for (const artifact of Object.values(current.artifacts)) {
      if (artifact.workspaceId === workspace.workspaceId
        && artifact.status !== "merged"
        && artifact.status !== "discarded") {
        artifact.status = "discarded";
        artifact.updatedAt = now;
      }
    }
  }
  actions.push({
    disposition: "cleanup_only",
    entityType: "workspace",
    entityId: workspace.workspaceId,
    reason: evidenceExists
      ? "workspace cleanup was interrupted before evidence removal"
      : "workspace cleanup completed before terminal state persistence",
  });
}

function defaultIsOwnerAlive(owner: RuntimeOwnerState): boolean {
  return isRuntimeOwnerAlive(owner);
}

async function defaultPathExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

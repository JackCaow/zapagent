import { currentRuntimeObservation, observeRuntime } from "./observation.js";
import { collectRuntimeCompletionEvidence, mergeCompletionEvidence } from "./completion-evidence.js";
import { HarnessToolPolicyEngine } from "../harness/execution-policy.js";
import type { AgentEventHandler } from "../agent/events.js";
import {
  LoopAgent,
  type LoopAgentOptions,
  type SubagentConfig,
} from "../agent/loop.js";
import { MergeCoordinator } from "../merge/coordinator.js";
import { WorkspaceManager } from "../workspace/manager.js";
import type { WorkspaceRetentionPolicy, WorkspaceRetentionReport } from "../workspace/retention.js";
import { AgentRuntime, type AgentRuntimeOptions } from "./agent-runtime.js";
import type { RuntimeEventStore } from "./event-store.js";
import { InMemoryRuntimeStateStore, type RuntimeStateStore } from "./state-store.js";
import { RuntimeStateTracker } from "./state-tracker.js";
import { protectedWorkspaceBatchPaths } from "./recovery-center.js";
import { AgentCoordinator } from "../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../coordinator/executor-bridge.js";
import { RuntimeAgentCoordinatorStateStore } from "../coordinator/store.js";
import {
  policyToTaskDecomposition,
  resolveHarnessPolicy,
  type HarnessPolicyOverrides,
} from "../harness/policy.js";

export interface RuntimeWorkspaceOptions {
  root: string;
  onTrackEdit?: (paths: string[]) => Promise<void>;
  retention?: false | Partial<WorkspaceRetentionPolicy>;
  onRetention?: (report: WorkspaceRetentionReport) => void | Promise<void>;
}

export interface RuntimeSubagentOptions extends Omit<
  SubagentConfig,
  "workspaceManager" | "mergeCoordinator" | "onEvent" | "coordinator" | "coordinatorExecutorBridge"
> {
  onEvent?: AgentEventHandler;
  maxConcurrency?: number;
}

export interface CreateAgentRuntimeOptions {
  threadId: string;
  observer?: AgentRuntimeOptions["observer"];
  workspace: RuntimeWorkspaceOptions;
  loopAgent: Omit<LoopAgentOptions, "onRunEnd" | "subagent">;
  subagent?: false | RuntimeSubagentOptions;
  onRunEnd?: LoopAgentOptions["onRunEnd"];
  eventStore?: RuntimeEventStore;
  idFactory?: AgentRuntimeOptions["idFactory"];
  clock?: AgentRuntimeOptions["clock"];
  eventStoreFailureMode?: AgentRuntimeOptions["eventStoreFailureMode"];
  onEventStoreError?: AgentRuntimeOptions["onEventStoreError"];
  onRecovery?: AgentRuntimeOptions["onRecovery"];
  onSealing?: AgentRuntimeOptions["onSealing"];
  sealingTimeoutMs?: AgentRuntimeOptions["sealingTimeoutMs"];
  onSealingProgress?: AgentRuntimeOptions["onSealingProgress"];
  stateStore?: RuntimeStateStore;
  /** V1 input remains accepted; resolution always yields the V2 policy model. */
  harnessPolicy?: HarnessPolicyOverrides;
  backgroundTasks?: AgentRuntimeOptions["backgroundTasks"];
  completionEvidence?: AgentRuntimeOptions["completionEvidence"];
}

/** Single production assembly path shared by TUI, headless and future hosts. */
export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const harnessPolicy = resolveHarnessPolicy(options.harnessPolicy);
  // A dollar cap cannot be enforced from token counts without authoritative
  // pricing/billing. Reject it before any model or tool side effect.
  if (harnessPolicy.budgets.costUsd !== undefined) {
    throw new Error("Harness costUsd is unsupported: no authoritative cost meter is configured");
  }
  const stateStore = options.stateStore ?? new InMemoryRuntimeStateStore();
  const stateTracker = new RuntimeStateTracker({
    threadId: options.threadId,
    workspaceRoot: options.workspace.root,
    store: stateStore,
    clock: options.clock,
  });
  const runtimeOwner = stateTracker.ownerSnapshot();
  const workspaceManager = new WorkspaceManager({
    root: options.workspace.root,
    owner: {
      threadId: options.threadId,
      instanceId: runtimeOwner.instanceId,
      pid: runtimeOwner.pid,
    },
    onLifecycle: (event) => stateTracker.recordWorkspaceEvent(event),
    retention: options.workspace.retention ?? {},
    protectedBatchPaths: async () => protectedWorkspaceBatchPaths(
      await stateStore.list(),
      options.workspace.root,
    ),
    onRetention: options.workspace.onRetention,
  });
  const mergeCoordinator = new MergeCoordinator(workspaceManager, {
    onTrackEdit: options.workspace.onTrackEdit,
    onLifecycle: (event) => stateTracker.recordMergeEvent(event),
  });
  let runtime: AgentRuntime | undefined;
  const subagentOptions = options.subagent === false ? undefined : options.subagent;
  const coordinatorExecutorBridge = subagentOptions
    ? new DeferredAgentCoordinatorExecutor()
    : undefined;
  const coordinator = subagentOptions && coordinatorExecutorBridge
    ? new AgentCoordinator({
        threadId: options.threadId,
        executor: coordinatorExecutorBridge,
        stateStore: new RuntimeAgentCoordinatorStateStore({
          threadId: options.threadId,
          workspaceRoot: options.workspace.root,
          runtimeStateStore: stateStore,
          clock: options.clock,
        }),
        // Four simultaneous model loops are counterproductive on the common
        // 1–2 CPU workspace/benchmark container. Keep SDK callers free to
        // choose a higher cap, but production hosts start with one executor
        // plus one independent read-only investigator.
        maxConcurrency: subagentOptions.maxConcurrency ?? 2,
        clock: options.clock,
      })
    : undefined;
  coordinator?.subscribe((event) => {
    if (event.type === "task_state") runtime?.recordAgentDependencies(event.task.runId, event.task.dependencies);
    if (event.type !== "run_state") return;
    const agentEvent: Parameters<AgentEventHandler>[0] = {
      type: "agent_run_state",
      path: event.run.parentRunId ? [event.run.parentRunId] : [],
      run: event.run,
    };
    runtime?.recordAgentEvent(agentEvent);
    subagentOptions?.onEvent?.(agentEvent);
  });
  const subagent = subagentOptions === undefined
    ? undefined
    : {
        ...subagentOptions,
        onEvent: (event) => {
          runtime?.recordAgentEvent(event);
          subagentOptions?.onEvent?.(event);
        },
        workspaceManager,
        mergeCoordinator,
        coordinator,
        coordinatorExecutorBridge,
      } satisfies SubagentConfig;

  const executor = options.loopAgent.executor
    .withRuntimePolicy(new HarnessToolPolicyEngine(options.loopAgent.executor.policyEngine, harnessPolicy), harnessPolicy.execution.checkpoint, harnessPolicy.autonomy === "supervised")
    .withApprovalLifecycle((event) => stateTracker.recordApprovalEvent(event))
    .withExecutionLifecycle((event) => stateTracker.recordToolExecutionEvent(event));
  const agent = new LoopAgent({
    ...options.loopAgent,
    maxSteps: options.loopAgent.maxSteps ?? harnessPolicy.budgets.modelTurns,
    timeoutMs: options.loopAgent.timeoutMs ?? harnessPolicy.budgets.wallTimeMs,
    adaptiveBudget: harnessPolicy.legacy.sourceVersion === 2 ? harnessPolicy.budgets : undefined,
    taskDecomposition: options.loopAgent.taskDecomposition ?? policyToTaskDecomposition(harnessPolicy),
    reserveSteps: options.loopAgent.reserveSteps ?? harnessPolicy.legacy.reserveSteps,
    executor,
    onRunEnd: async (context) => {
      try {
        await options.onRunEnd?.(context);
      } finally {
        const observation = currentRuntimeObservation();
        if (observation) observeRuntime({ kind: "lifecycle", scope: observation.scope, phase: "cleanup", at: Date.now() });
        await workspaceManager.cleanup();
      }
    },
    subagent,
  });
  runtime = new AgentRuntime({
    threadId: options.threadId,
    observer: options.observer,
    agent,
    backgroundTasks: options.backgroundTasks,
    eventStore: options.eventStore,
    idFactory: options.idFactory,
    clock: options.clock,
    eventStoreFailureMode: options.eventStoreFailureMode,
    onEventStoreError: options.onEventStoreError,
    onRecovery: options.onRecovery,
    onSealing: options.onSealing,
    sealingTimeoutMs: options.sealingTimeoutMs,
    onSealingProgress: options.onSealingProgress,
    stateTracker,
    coordinator,
    hasExplicitCompletionContract: Boolean(options.completionEvidence || options.harnessPolicy?.completion || options.harnessPolicy?.task?.completion),
    completionContract: harnessPolicy.task.completion,
    completionEvidence: async (context) => {
      let hostEvidence;
      try {
        hostEvidence = await options.completionEvidence?.(context);
      } catch (error) {
        hostEvidence = { infrastructure: [{
          source: "completion_evidence", status: "failed" as const,
          detail: error instanceof Error ? error.message : String(error),
        }] };
      }
      // Verifiers may change files or produce lifecycle events. Read evidence
      // after they finish, then assess the final current-turn state.
      await stateTracker.flush();
      const evidence = await collectRuntimeCompletionEvidence(stateStore, context);
      return mergeCompletionEvidence(evidence, hostEvidence);
    },
    observability: harnessPolicy.observability.level,
  });
  return runtime;
}

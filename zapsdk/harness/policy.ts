import type { CompletionContract } from "./completion.js";

/**
 * V1 was intentionally small so existing hosts could share task-decomposition
 * and completion settings. Keep it public as an input shape: config written
 * against V1 must continue to resolve without a migration step.
 */
export interface HarnessPolicyV1 {
  version: 1;
  taskDecomposition: TaskDecompositionPolicy;
  reserveSteps: number;
  completion: CompletionContract;
}

export type HarnessAutonomy = "interactive" | "bounded" | "supervised";
export type HarnessTaskClass = "question" | "investigation" | "change" | "migration";
export type HarnessPlanThreshold = "never" | "complexity" | "risk";
export type HarnessWorkspaceMode = "shared-read" | "isolated-write";
export type HarnessCheckpointMode = "never" | "best-effort" | "before-destructive" | "before-write";
export type HarnessObservabilityLevel = "minimal" | "standard" | "debug";
export type TaskDecompositionPolicy = "off" | "auto" | "required";

/**
 * Resource constraints are shared product policy, not hidden verifier hints.
 * P0.2 turns the observable limits into adaptive convergence decisions. Strong
 * enforcement for process/network/files and durable evidence arrives through
 * the Broker and StateStore work packages.
 */
export interface HarnessBudgetConstraints {
  wallTimeMs?: number;
  modelTurns?: number;
  toolCalls?: number;
  freshInputTokens?: number;
  /** Accepted for config compatibility; runtime assembly rejects this until a cost meter exists. */
  costUsd?: number;
}

export interface HarnessTaskPolicy {
  classHint?: HarnessTaskClass;
  requirePlanAbove: HarnessPlanThreshold;
  completion: CompletionContract;
}

export interface HarnessExecutionPolicy {
  /** Undefined means the host's existing capability policy remains authoritative. */
  allowedCapabilities?: readonly string[];
  workspaceMode: HarnessWorkspaceMode;
  checkpoint: HarnessCheckpointMode;
}

export interface HarnessPolicyV2 {
  version: 2;
  autonomy: HarnessAutonomy;
  task: HarnessTaskPolicy;
  budgets: HarnessBudgetConstraints;
  execution: HarnessExecutionPolicy;
  observability: { level: HarnessObservabilityLevel };
}

/** The accepted persisted policy shapes. New code should emit V2. */
export type HarnessPolicy = HarnessPolicyV1 | HarnessPolicyV2;

export interface HarnessPolicyOverrides {
  /** Omit for the current V2 product default. Set 1 to retain V1 behavior. */
  version?: 1 | 2;
  /** V1 compatibility fields. */
  taskDecomposition?: TaskDecompositionPolicy;
  reserveSteps?: number;
  completion?: Partial<CompletionContract>;
  /** V2 fields. */
  autonomy?: HarnessAutonomy;
  task?: Partial<Omit<HarnessTaskPolicy, "completion">> & {
    completion?: Partial<CompletionContract>;
  };
  budgets?: HarnessBudgetConstraints;
  execution?: Partial<HarnessExecutionPolicy>;
  observability?: { level?: HarnessObservabilityLevel };
}

/**
 * V2 resolution keeps the old LoopAgent knobs in one explicit adapter. That
 * prevents UI/headless callers from reintroducing V1 semantics independently
 * while the LoopAgent is migrated to adaptive decisions.
 */
export interface ResolvedHarnessPolicy extends HarnessPolicyV2 {
  legacy: {
    sourceVersion: 1 | 2;
    taskDecomposition: TaskDecompositionPolicy;
    reserveSteps: number;
  };
}

export const DEFAULT_HARNESS_POLICY: Readonly<HarnessPolicyV2> = Object.freeze({
  version: 2,
  autonomy: "interactive",
  task: Object.freeze({
    requirePlanAbove: "complexity",
    completion: Object.freeze({ id: "delivery-response-v2", requirements: Object.freeze([Object.freeze({ kind: "final_response" as const }), Object.freeze({ kind: "delivery" as const })]) }),
  }),
  budgets: Object.freeze({}),
  execution: Object.freeze({
    workspaceMode: "shared-read",
    checkpoint: "before-destructive",
  }),
  observability: Object.freeze({ level: "standard" }),
});

const LEGACY_DEFAULTS = Object.freeze({
  taskDecomposition: "auto" as const,
  reserveSteps: 2,
});

export function resolveHarnessPolicy(
  overrides: HarnessPolicyOverrides | undefined,
): ResolvedHarnessPolicy {
  const sourceVersion = overrides?.version ?? 2;
  const taskDecomposition = overrides?.taskDecomposition
    ?? planThresholdToLegacyMode(overrides?.task?.requirePlanAbove)
    ?? LEGACY_DEFAULTS.taskDecomposition;
  const reserveSteps = nonNegativeInteger(overrides?.reserveSteps) ?? LEGACY_DEFAULTS.reserveSteps;
  const completion = {
    ...(sourceVersion === 1 ? { id: "natural-response-v1" } : DEFAULT_HARNESS_POLICY.task.completion),
    ...overrides?.completion,
    ...overrides?.task?.completion,
  } as CompletionContract;

  return {
    version: 2,
    autonomy: overrides?.autonomy ?? DEFAULT_HARNESS_POLICY.autonomy,
    task: {
      classHint: overrides?.task?.classHint,
      requirePlanAbove: overrides?.task?.requirePlanAbove
        ?? legacyModeToPlanThreshold(taskDecomposition),
      completion,
    },
    budgets: normalizeBudgetConstraints(overrides?.budgets),
    execution: {
      allowedCapabilities: overrides?.execution?.allowedCapabilities,
      workspaceMode: overrides?.execution?.workspaceMode
        ?? DEFAULT_HARNESS_POLICY.execution.workspaceMode,
      checkpoint: overrides?.execution?.checkpoint
        ?? DEFAULT_HARNESS_POLICY.execution.checkpoint,
    },
    observability: {
      level: overrides?.observability?.level ?? DEFAULT_HARNESS_POLICY.observability.level,
    },
    legacy: {
      sourceVersion,
      taskDecomposition,
      reserveSteps,
    },
  };
}

export function policyToTaskDecomposition(policy: ResolvedHarnessPolicy): TaskDecompositionPolicy {
  return policy.legacy.taskDecomposition;
}

function normalizeBudgetConstraints(
  budgets: HarnessBudgetConstraints | undefined,
): HarnessBudgetConstraints {
  return {
    ...(nonNegativeInteger(budgets?.wallTimeMs) === undefined
      ? {} : { wallTimeMs: nonNegativeInteger(budgets?.wallTimeMs) }),
    ...(nonNegativeInteger(budgets?.modelTurns) === undefined
      ? {} : { modelTurns: nonNegativeInteger(budgets?.modelTurns) }),
    ...(nonNegativeInteger(budgets?.toolCalls) === undefined
      ? {} : { toolCalls: nonNegativeInteger(budgets?.toolCalls) }),
    ...(nonNegativeInteger(budgets?.freshInputTokens) === undefined
      ? {} : { freshInputTokens: nonNegativeInteger(budgets?.freshInputTokens) }),
    ...(nonNegativeFinite(budgets?.costUsd) === undefined
      ? {} : { costUsd: nonNegativeFinite(budgets?.costUsd) }),
  };
}

function legacyModeToPlanThreshold(mode: TaskDecompositionPolicy): HarnessPlanThreshold {
  return mode === "off" ? "never" : mode === "required" ? "risk" : "complexity";
}

function planThresholdToLegacyMode(
  threshold: HarnessPlanThreshold | undefined,
): TaskDecompositionPolicy | undefined {
  return threshold === undefined
    ? undefined
    : threshold === "never" ? "off" : threshold === "risk" ? "required" : "auto";
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function nonNegativeFinite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

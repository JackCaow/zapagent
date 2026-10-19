import { ServiceReceiptSchema, type ServiceReceipt } from "../services/contracts.js";
import { ServiceOperationObservationSchema, type ServiceOperationObservation } from "../services/contracts.js";
import type { LoopAgentResult } from "../agent/loop.js";

export class OutcomeProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OutcomeProtocolError";
  }
}

export function validateObserveConfiguration(value: unknown): void {
  if (value === undefined) return;
  const invalid = (): never => { throw new OutcomeProtocolError("INVALID_ACCEPTANCE_CONFIG", "Malformed acceptance configuration"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const config = value as Record<string, unknown>;
  if (config.mode === "observe" && config.timing === "none"
    && Object.keys(config).every(key => key === "mode" || key === "timing")) return;
  if (config.mode === "required" && (config.timing === "inline" || config.timing === "deferred")) {
    const spec = config.spec as AcceptanceSpec | undefined;
    const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
    if (!spec || !nonempty(spec.id) || !Number.isSafeInteger(spec.revision) || spec.revision < 1
      || !Array.isArray(spec.subjects) || !Array.isArray(spec.checks)
      || spec.subjects.some(subject => !subject || !nonempty(subject.id) || !nonempty(subject.path) || !["exists", "absent"].includes(subject.expected))
      || new Set(spec.subjects.map(subject => subject.id)).size !== spec.subjects.length
      || spec.checks.some(check => !check || !nonempty(check.id) || !nonempty(check.verifierId) || !Array.isArray(check.subjectIds)
        || check.subjectIds.some(id => !spec.subjects.some(subject => subject.id === id)))
      || new Set(spec.checks.map(check => check.id)).size !== spec.checks.length
      || typeof config.timeoutMs !== "number" || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) invalid();
    if (config.timing === "inline") {
      const verifiers = config.verifiers as HostVerifier[] | undefined;
      if (!Array.isArray(verifiers) || verifiers.some(verifier => !verifier || !nonempty(verifier.id) || typeof verifier.verify !== "function")
        || new Set(verifiers.map(verifier => verifier.id)).size !== verifiers.length
        || spec!.checks.some(check => !verifiers.some(verifier => verifier.id === check.verifierId))) invalid();
      if (config.repair !== undefined) {
        const repair = config.repair as { maxAttempts?: number; timeoutMs?: number };
        if (!repair || !Number.isSafeInteger(repair.maxAttempts) || (repair.maxAttempts ?? 0) < 1
          || typeof repair.timeoutMs !== "number" || !Number.isFinite(repair.timeoutMs) || repair.timeoutMs <= 0) invalid();
      }
    } else if (!nonempty(config.externalOwnerId) || !nonempty(config.correlationId)) invalid();
  } else if (config.mode !== "observe" || config.timing !== "none") invalid();
  throw new OutcomeProtocolError("UNSUPPORTED_ACCEPTANCE_MODE", "M1 supports observe/none only");
}

export function classifyExecution(input: {
  attemptId: string;
  result: LoopAgentResult;
  cancelled?: boolean;
  error?: unknown;
  unresolvedActions?: ActionReference[];
}): ExecutionOutcome {
  const actions = input.unresolvedActions ?? [];
  const base = { attemptId: input.attemptId, finalResponse: input.result.text, unresolvedActions: actions };
  const fault = input.error instanceof Error && input.error.message === "aborted"
    ? input.error.cause : input.error;
  const error = fault === undefined ? undefined : {
    code: fault instanceof OutcomeProtocolError ? fault.code : "EXECUTION_FAILED",
    message: fault instanceof Error ? fault.message : String(fault), retryable: false,
  };
  if (input.cancelled) return { ...base, status: "cancelled", stopReason: "aborted", ...(error ? { error } : {}) };
  if (input.error !== undefined) return {
    ...base, status: "failed", stopReason: "error",
    error: { code: input.error instanceof OutcomeProtocolError ? input.error.code : "EXECUTION_FAILED", message: input.error instanceof Error ? input.error.message : String(input.error), retryable: false },
  };
  if (actions.length) return {
    ...base, status: "blocked",
    stopReason: actions.some((action) => action.kind === "approval") ? "permission_denied"
      : actions.some((action) => action.kind === "input") ? "input_required" : "capability_unavailable",
  };
  if (input.result.stopped) return { ...base, status: "limited", stopReason: input.result.stopped };
  return { ...base, status: "finished", stopReason: "end_turn" };
}

export function classifyObservedAcceptance(attemptId: string, result: LoopAgentResult, now: number): AcceptanceReport {
  try { return observeAcceptance(attemptId, result, now); }
  catch {
    return { attemptId, status: "unverified", code: "OBSERVATION_UNAVAILABLE", checks: [
      { checkId: `${attemptId}:observation`, source: "agent_check", observedOutcome: "error", evidenceRefs: [], observedAt: now },
    ] };
  }
}

function observeAcceptance(attemptId: string, result: LoopAgentResult, now: number): AcceptanceReport {
  let mutated = false;
  const checks: AcceptanceCheckResult[] = [];
  for (const [index, tool] of result.toolResults.entries()) {
    const runtime = tool.runtime;
    const effects = runtime?.effects;
    mutated ||= !effects || Boolean(runtime?.writeEvidence?.paths.length) || Boolean(effects && (
      effects.confidence === "unknown" || effects.filesystem.some((effect) => effect.operation !== "read")
      || effects.process.some((effect) => !effect.readOnly) || effects.network.some((effect) => effect.operation === "mutate")
      || effects.external.some((effect) => effect.operation !== "read")
      || effects.workspace.mode === "isolated-write" || effects.workspace.mode === "root-integration"
    ));
    const verification = runtime?.verification;
    if (verification) {
      const ref = runtime?.command?.commandRef ?? `${attemptId}:tool:${index}`;
      verification.steps.forEach((step, stepIndex) => checks.push({
        checkId: `${ref}:${stepIndex}`, source: "agent_check",
        observedOutcome: step.exitCode === null ? "error" : step.exitCode === 0 ? "passed" : "failed",
        evidenceRefs: [ref], observedAt: now,
      }));
    }
  }
  return {
    attemptId, status: mutated || checks.length ? "unverified" : "not_requested",
    code: mutated ? "NO_ACCEPTANCE_SPEC" : checks.length ? "AGENT_CHECK_ONLY" : "ACCEPTANCE_NOT_CONFIGURED", checks,
  };
}

export function executionExitCode(execution: ExecutionOutcome): number {
  switch (execution.status) {
    case "finished": case "limited": return 0;
    case "cancelled": return 130;
    case "blocked": return execution.stopReason === "permission_denied" ? 4 : 7;
    case "failed": return 1;
  }
}

export function validateOutcome(value: unknown): asserts value is AgentOutcomeV1 {
  const outcome = value as AgentOutcomeV1 | undefined;
  if (!outcome || outcome.schema !== "zap.outcome" || outcome.schemaVersion !== 1
    || ![outcome.threadId, outcome.turnId, outcome.runId, outcome.attemptId].every(id => typeof id === "string" && id.length > 0)
    || outcome.attemptId !== outcome.runId
    || [outcome.execution, outcome.acceptance, outcome.workflow].some(part => !part || part.attemptId !== outcome.attemptId)) {
    throw new OutcomeProtocolError("OUTCOME_IDENTITY_MISMATCH", "Outcome identities must match the attempt");
  }
  const reasons: Record<ExecutionStatus, ExecutionStopReason[]> = {
    finished: ["end_turn"], limited: ["max_steps", "max_tokens", "budget", "timeout", "max_repeat"],
    failed: ["error"], cancelled: ["aborted"], blocked: ["permission_denied", "input_required", "capability_unavailable"],
  };
  const { execution, acceptance, workflow } = outcome;
  if (!Number.isFinite(outcome.startedAt) || !Number.isFinite(outcome.endedAt)
    || !reasons[execution.status]?.includes(execution.stopReason) || typeof execution.finalResponse !== "string"
    || !Array.isArray(execution.unresolvedActions) || execution.unresolvedActions.some(action => !action
      || typeof action.actionId !== "string" || !["host", "runtime"].includes(action.owner)
      || !["approval", "input", "capability", "running_tool"].includes(action.kind)
      || action.state !== "pending" || typeof action.reason !== "string")
    || (execution.status === "failed" && !execution.error)
    || (execution.error !== undefined && (!execution.error || typeof execution.error.code !== "string"
      || typeof execution.error.message !== "string" || typeof execution.error.retryable !== "boolean"))
    || (execution.backgroundTasks !== undefined && (!Array.isArray(execution.backgroundTasks)
      || execution.backgroundTasks.some(task => !task || typeof task.taskId !== "string"
        || !["stopped", "host_owned", "pending"].includes(task.disposition))))
    || (execution.services !== undefined && !ServiceReceiptSchema.array().safeParse(execution.services).success)
    || (execution.serviceOperations !== undefined && !ServiceOperationObservationSchema.array().safeParse(execution.serviceOperations).success)
    || !["not_requested", "unverified"].includes(acceptance.status) || typeof acceptance.code !== "string"
    || !Array.isArray(acceptance.checks) || acceptance.checks.some(check => !check || typeof check.checkId !== "string"
      || check.source !== "agent_check" || !["passed", "failed", "error"].includes(check.observedOutcome)
      || !Array.isArray(check.evidenceRefs) || check.evidenceRefs.some(ref => typeof ref !== "string") || !Number.isFinite(check.observedAt))
    || workflow.status !== "not_requested" || workflow.controlRevision !== 0 || typeof workflow.code !== "string") {
    throw new OutcomeProtocolError("INVALID_OUTCOME", "Malformed M1 outcome");
  }
}

export type ExecutionStatus = "finished" | "limited" | "blocked" | "cancelled" | "failed";
export type ExecutionStopReason =
  | "end_turn" | "max_steps" | "max_tokens" | "budget" | "timeout" | "max_repeat"
  | "permission_denied" | "input_required" | "capability_unavailable" | "aborted" | "error";

export interface OutcomeError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ActionReference {
  actionId: string;
  owner: "host" | "runtime";
  kind: "approval" | "input" | "capability" | "running_tool";
  state: "pending";
  toolCallId?: string;
  reason: string;
}

export interface BackgroundTaskReceipt {
  taskId: string;
  disposition: "stopped" | "host_owned" | "pending";
}

export interface ExecutionOutcome {
  attemptId: string;
  status: ExecutionStatus;
  stopReason: ExecutionStopReason;
  finalResponse: string;
  error?: OutcomeError;
  unresolvedActions: ActionReference[];
  backgroundTasks?: BackgroundTaskReceipt[];
  /** Owner observations; running is not endpoint health or acceptance. */
  services?: ServiceReceipt[];
  /** Unknown/absent calls remain visible even without a service identity. */
  serviceOperations?: ServiceOperationObservation[];
}

export interface AcceptanceCheckResult {
  checkId: string;
  source: "agent_check" | "host_verifier";
  observedOutcome: "passed" | "failed" | "error";
  evidenceRefs: string[];
  observedAt: number;
  snapshotId?: string;
}

export interface AcceptanceReport {
  attemptId: string;
  status: "not_requested" | "pending" | "unverified" | "passed" | "failed" | "error";
  code: string;
  specId?: string;
  specRevision?: number;
  snapshotId?: string;
  checks: AcceptanceCheckResult[];
}

export interface WorkflowDecision {
  status: "not_requested" | "ready" | "awaiting_acceptance" | "blocked";
  attemptId: string;
  controlRevision: number;
  code: string;
  snapshotId?: string;
}

export interface AgentOutcomeV1 {
  schema: "zap.outcome";
  schemaVersion: 1;
  threadId: string;
  turnId: string;
  runId: string;
  attemptId: string;
  startedAt: number;
  endedAt: number;
  execution: ExecutionOutcome;
  acceptance: AcceptanceReport;
  workflow: WorkflowDecision;
}

export interface AcceptanceSpec {
  id: string;
  revision: number;
  subjects: Array<{
    id: string;
    path: string;
    expected: "exists" | "absent";
  }>;
  checks: Array<{
    id: string;
    verifierId: string;
    subjectIds: string[];
  }>;
}

export interface StableSnapshot {
  id: string;
  root: string;
  proof: "immutable_snapshot" | "all_writers_excluded";
  subjects: Array<{ subjectId: string; exists: boolean; sha256?: string }>;
}

export interface HostVerifier {
  id: string;
  verify(context: {
    attemptId: string;
    spec: AcceptanceSpec;
    snapshot: StableSnapshot;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<{
    checkId: string;
    snapshotId: string;
    status: "passed" | "failed" | "error";
    evidenceRefs: string[];
  }[]>;
}

export type AcceptanceConfiguration =
  | { mode: "observe"; timing: "none" }
  | {
      mode: "required";
      timing: "inline";
      spec: AcceptanceSpec;
      verifiers: HostVerifier[];
      timeoutMs: number;
      repair?: { maxAttempts: number; timeoutMs: number };
    }
  | {
      mode: "required";
      timing: "deferred";
      spec: AcceptanceSpec;
      externalOwnerId: string;
      correlationId: string;
      timeoutMs: number;
    };

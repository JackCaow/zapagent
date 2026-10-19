import { isDeepStrictEqual } from "node:util";
import { acceptanceSpecDigest, validateAcceptanceSpec, validateInlineAcceptanceRecord,
  acceptanceRecordId, type AcceptanceSnapshot, type InlineCheckResult } from "./inline-acceptance.js";
import { OutcomeProtocolError, validateOutcome, type AcceptanceSpec, type AgentOutcomeV1 } from "./outcome.js";

export type WorkflowSnapshot = Omit<AcceptanceSnapshot, "readFile">;
export interface WorkflowAuthorization { actionId: string; grantId: string }
export interface WorkflowActionClaim extends WorkflowAuthorization {
  operationId: string;
  requestId: string;
  attemptId: string;
  snapshotId: string;
  specDigest: string;
  /** Revision atomically consumed when the action was claimed. */
  controlRevision: number;
  claimedAt: number;
}
export interface WorkflowActionReceipt {
  operationId: string;
  snapshotId: string;
  status: "succeeded" | "failed" | "unknown";
  code: string;
  evidenceRefs: string[];
}
export interface WorkflowActionResult extends WorkflowActionReceipt {
  observedAt: number;
  source: "execute" | "reconcile";
}
export interface DeferredWorkflowRecord {
  schema: "zap.workflow";
  schemaVersion: 1;
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Shared absolute deadline. Replacing an attempt cannot reset it. */
  deadlineAt: number;
  requestId: string;
  ownerId: string;
  outcome: AgentOutcomeV1;
  spec: AcceptanceSpec;
  specDigest: string;
  snapshot?: WorkflowSnapshot;
  cancelled: boolean;
  blockers: string[];
  allowLimitedDelivery: boolean;
  authorization?: WorkflowAuthorization;
  acceptance: {
    status: "pending" | "passed" | "failed" | "error" | "unverified";
    code: string;
    checks: InlineCheckResult[];
    /** Digest of an authenticated final callback, for idempotent retries. */
    resultDigest?: string;
  };
  /** A claim is permanent. An unknown external outcome must be reconciled, never replayed. */
  action?: WorkflowActionClaim;
  /** Missing/unknown means reconcile the external operation; never automatically execute it again. */
  actionResult?: WorkflowActionResult;
  /** Deferred delivery is at-least-once; the external owner deduplicates requestId. */
  delivery?: { attempts: number; receiptId?: string };
}

export interface WorkflowControlDecision {
  workflowId: string;
  requestId: string;
  attemptId: string;
  controlRevision: number;
  snapshotId?: string;
  specDigest: string;
  status: "not_requested" | "awaiting_acceptance" | "blocked" | "ready" | "claimed";
  code: string;
}

export interface WorkflowControlStore {
  load(id: string): DeferredWorkflowRecord | undefined;
  /** Insert the next immutable revision only if expectedRevision is still current (0 = create). */
  compareAndSwap(expectedRevision: number, record: DeferredWorkflowRecord): void;
}

export function workflowError(code: string, message = code): never { throw new OutcomeProtocolError(code, message); }
export const workflowString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(workflowString) && new Set(value).size === value.length;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function validateWorkflowActionReceipt(value: unknown, claim: WorkflowActionClaim): asserts value is WorkflowActionReceipt {
  const r = value as WorkflowActionReceipt;
  if (!r || r.operationId !== claim.operationId || r.snapshotId !== claim.snapshotId
    || !["succeeded", "failed", "unknown"].includes(r.status) || !workflowString(r.code)
    || !Array.isArray(r.evidenceRefs) || r.evidenceRefs.some(ref => !workflowString(ref))) workflowError("INVALID_ACTION_RECEIPT");
}

export function validateWorkflowSnapshot(snapshot: WorkflowSnapshot, spec: AcceptanceSpec): void {
  if (!snapshot || !workflowString(snapshot.id) || !workflowString(snapshot.providerId) || snapshot.proof !== "immutable_snapshot"
    || !Array.isArray(snapshot.subjects) || snapshot.subjects.length !== spec.subjects.length
    || new Set(snapshot.subjects.map(s => s?.subjectId)).size !== spec.subjects.length
    || snapshot.subjects.some(s => !s || !spec.subjects.some(v => v.id === s.subjectId) || typeof s.exists !== "boolean" || !workflowString(s.version))) {
    workflowError("INVALID_SNAPSHOT");
  }
}

export function validateWorkflowRecord(value: unknown): asserts value is DeferredWorkflowRecord {
  const r = value as DeferredWorkflowRecord;
  if (!r || r.schema !== "zap.workflow" || r.schemaVersion !== 1 || !workflowString(r.id)
    || !Number.isSafeInteger(r.revision) || r.revision < 1 || !time(r.createdAt) || !time(r.updatedAt) || r.updatedAt < r.createdAt
    || !time(r.deadlineAt) || r.deadlineAt <= r.createdAt || !workflowString(r.requestId) || !workflowString(r.ownerId)
    || typeof r.cancelled !== "boolean" || typeof r.allowLimitedDelivery !== "boolean" || !strings(r.blockers)
    || !r.acceptance || !workflowString(r.acceptance.code) || !Array.isArray(r.acceptance.checks)
    || (r.acceptance.resultDigest !== undefined && !/^[a-f0-9]{64}$/.test(r.acceptance.resultDigest))) workflowError("INVALID_WORKFLOW_RECORD");
  validateOutcome(r.outcome);
  validateAcceptanceSpec(r.spec);
  if (r.specDigest !== acceptanceSpecDigest(r.spec)) workflowError("INVALID_WORKFLOW_RECORD");
  if (r.snapshot) validateWorkflowSnapshot(r.snapshot, r.spec);
  if (r.acceptance.status === "pending") {
    if (!r.snapshot || r.acceptance.checks.length || r.acceptance.resultDigest) workflowError("INVALID_WORKFLOW_RECORD");
  } else {
    // Reuse the same receipt/freshness contract as inline acceptance without rewriting execution.
    const execution = r.outcome.execution;
    const ready = execution.status === "finished" && !execution.error && execution.unresolvedActions.length === 0
      && !execution.backgroundTasks?.some(t => t.disposition === "pending") && r.acceptance.status === "passed";
    validateInlineAcceptanceRecord({ schema: "zap.acceptance", schemaVersion: 1, revision: 1,
      id: acceptanceRecordId(r.outcome), outcome: r.outcome, spec: r.spec, specDigest: r.specDigest,
      startedAt: r.createdAt, endedAt: r.updatedAt, snapshot: r.snapshot, report: r.acceptance,
      workflow: { status: ready ? "ready" : "blocked", code: r.acceptance.code, snapshotId: r.snapshot?.id } });
  }
  if (r.authorization && (!workflowString(r.authorization.actionId) || !workflowString(r.authorization.grantId))) workflowError("INVALID_WORKFLOW_RECORD");
  if (r.action) {
    const a = r.action;
    if (!r.authorization || a.actionId !== r.authorization.actionId || a.grantId !== r.authorization.grantId
      || !workflowString(a.operationId) || a.requestId !== r.requestId || a.attemptId !== r.outcome.attemptId
      || a.snapshotId !== r.snapshot?.id || a.specDigest !== r.specDigest || !time(a.claimedAt)
      || a.claimedAt < r.createdAt || a.claimedAt >= r.deadlineAt || a.claimedAt > r.updatedAt
      || !Number.isSafeInteger(a.controlRevision) || a.controlRevision < 1 || a.controlRevision >= r.revision
      || r.acceptance.status !== "passed") workflowError("INVALID_WORKFLOW_RECORD");
  }
  if (r.actionResult !== undefined) {
    if (!r.action) workflowError("INVALID_WORKFLOW_RECORD");
    validateWorkflowActionReceipt(r.actionResult, r.action);
    if (!time(r.actionResult.observedAt) || r.actionResult.observedAt < r.action.claimedAt || r.actionResult.observedAt > r.updatedAt
      || !["execute", "reconcile"].includes(r.actionResult.source)) workflowError("INVALID_WORKFLOW_RECORD");
  }
  if (r.delivery && (!Number.isSafeInteger(r.delivery.attempts) || r.delivery.attempts < 0
    || (r.delivery.receiptId !== undefined && (!workflowString(r.delivery.receiptId) || r.delivery.attempts < 1)))) workflowError("INVALID_WORKFLOW_RECORD");
}

/** Pure candidate decision. Only claimAction's CAS can consume it. */
export function workflowExecutionAllowsRelease(record: DeferredWorkflowRecord): boolean {
  const execution = record.outcome.execution;
  return (execution.status === "finished" || (execution.status === "limited" && record.allowLimitedDelivery))
    && !execution.error && execution.unresolvedActions.length === 0 && !record.blockers.length
    && !execution.backgroundTasks?.some(t => t.disposition === "pending");
}

export function decideWorkflow(record: DeferredWorkflowRecord, now = Date.now()): WorkflowControlDecision {
  validateWorkflowRecord(record);
  const result = (status: WorkflowControlDecision["status"], code: string): WorkflowControlDecision => ({
    workflowId: record.id, requestId: record.requestId, attemptId: record.outcome.attemptId,
    controlRevision: record.revision, snapshotId: record.snapshot?.id, specDigest: record.specDigest, status, code,
  });
  if (record.cancelled || record.outcome.execution.status === "cancelled") return result("blocked", "WORKFLOW_CANCELLED");
  if (record.action) return result("claimed", "ACTION_ALREADY_CLAIMED");
  if (now >= record.deadlineAt) return result("blocked", "WORKFLOW_DEADLINE_EXCEEDED");
  if (!record.authorization) return result("not_requested", "ACTION_NOT_AUTHORIZED");
  const execution = record.outcome.execution;
  if (!["finished", "limited"].includes(execution.status) || execution.error || execution.unresolvedActions.length
    || execution.backgroundTasks?.some(t => t.disposition === "pending") || record.blockers.length) return result("blocked", "EXECUTION_NOT_ELIGIBLE");
  if (execution.status === "limited" && !record.allowLimitedDelivery) return result("blocked", "LIMITED_DELIVERY_DISABLED");
  if (record.acceptance.status === "pending") return result("awaiting_acceptance", "ACCEPTANCE_PENDING");
  if (record.acceptance.status !== "passed") return result("blocked", record.acceptance.code);
  return result("ready", "ACCEPTANCE_PASSED");
}

/** Store-level invariants also protect against accidental use of raw CAS by hosts. */
export function validateWorkflowTransition(previous: DeferredWorkflowRecord | undefined, next: DeferredWorkflowRecord, expectedRevision: number): void {
  validateWorkflowRecord(next);
  if ((previous?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1) workflowError("WORKFLOW_CONFLICT");
  if (!previous) {
    if (next.deadlineAt <= Date.now()) workflowError("WORKFLOW_DEADLINE_EXCEEDED");
    if (next.action || next.cancelled || next.acceptance.resultDigest) workflowError("INVALID_WORKFLOW_TRANSITION");
    return;
  }
  if (previous.id !== next.id || previous.createdAt !== next.createdAt || previous.deadlineAt !== next.deadlineAt
    || previous.updatedAt > next.updatedAt || (previous.cancelled && !next.cancelled)) workflowError("INVALID_WORKFLOW_TRANSITION");
  if (previous.action && (!isDeepStrictEqual(previous.action, next.action) || previous.requestId !== next.requestId
    || !isDeepStrictEqual(previous.authorization, next.authorization))) workflowError("ACTION_ALREADY_CLAIMED");
  if (previous.actionResult && (!next.actionResult || next.actionResult.observedAt < previous.actionResult.observedAt
    || (previous.actionResult.status !== "unknown" && !isDeepStrictEqual(previous.actionResult, next.actionResult)))) workflowError("ACTION_RESULT_CONFLICT");
  if (previous.requestId === next.requestId) {
    if ((next.delivery?.attempts ?? 0) > (previous.delivery?.attempts ?? 0)
      && (previous.cancelled || previous.acceptance.status !== "pending" || previous.delivery?.receiptId || Date.now() >= previous.deadlineAt)) workflowError("DELIVERY_NOT_PENDING");
    if (previous.delivery && (!next.delivery || next.delivery.attempts < previous.delivery.attempts
      || (previous.delivery.receiptId !== undefined && !isDeepStrictEqual(previous.delivery, next.delivery)))) workflowError("DELIVERY_CONFLICT");
    for (const key of ["ownerId", "outcome", "spec", "specDigest", "snapshot"] as const) {
      if (!isDeepStrictEqual(previous[key], next[key])) workflowError("INVALID_WORKFLOW_TRANSITION");
    }
    if (previous.acceptance.status !== "pending" && !isDeepStrictEqual(previous.acceptance, next.acceptance)) workflowError("ACCEPTANCE_CONFLICT");
  } else if (previous.cancelled || previous.action || next.authorization || next.action || next.acceptance.resultDigest
    || previous.outcome.threadId !== next.outcome.threadId || previous.outcome.turnId !== next.outcome.turnId
    || previous.outcome.attemptId === next.outcome.attemptId) workflowError("INVALID_WORKFLOW_TRANSITION");
  if (previous.acceptance.status === "pending" && next.acceptance.resultDigest && Date.now() >= previous.deadlineAt) workflowError("ACCEPTANCE_TIMEOUT");
  if (!previous.action && next.action) {
    if (decideWorkflow(previous, Math.max(Date.now(), next.action.claimedAt)).status !== "ready" || next.action.controlRevision !== previous.revision
      || next.cancelled || !isDeepStrictEqual({ ...previous, revision: next.revision, updatedAt: next.updatedAt, action: next.action }, next)) workflowError("INVALID_WORKFLOW_TRANSITION");
  }
}

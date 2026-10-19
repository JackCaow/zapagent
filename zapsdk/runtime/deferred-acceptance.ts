import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { acceptanceSpecDigest, validateAcceptanceSpec, validateInlineAcceptanceRecord, type InlineCheckResult, type InlineAcceptanceStore } from "./inline-acceptance.js";
import { validateOutcome, type AcceptanceSpec, type AgentOutcomeV1 } from "./outcome.js";
import { decideWorkflow, validateWorkflowRecord, validateWorkflowSnapshot, validateWorkflowActionReceipt, workflowError, workflowString,
  type DeferredWorkflowRecord, type WorkflowAuthorization, type WorkflowControlStore, type WorkflowControlDecision,
  type WorkflowSnapshot, type WorkflowActionReceipt, type WorkflowActionResult } from "./workflow-control.js";

export interface DeferredAcceptanceOwner {
  id: string;
  /** At least 32 bytes of secret key material. Kept out of persisted records and Agent input. */
  signingKey: Uint8Array;
}
export interface DeferredWorkflowRegistration {
  workflowId: string;
  ownerId: string;
  outcome: AgentOutcomeV1;
  spec: AcceptanceSpec;
  /** Trusted host attestation; the external owner must independently resolve this immutable version. */
  snapshot?: WorkflowSnapshot;
  deadlineAt: number;
  blockers?: string[];
  allowLimitedDelivery?: boolean;
}
export interface DeferredAcceptanceResult {
  workflowId: string;
  requestId: string;
  ownerId: string;
  attemptId: string;
  specDigest: string;
  snapshotId: string;
  result: { status: "completed"; checks: InlineCheckResult[] } | { status: "error"; code: string };
}

// Deterministic JSON makes signatures independent of transport property order; arrays stay ordered.
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return workflowError("INVALID_CALLBACK", "Callback must be plain JSON");
}

/** External owner helper. This is a signing capability, not a tool exposed to the model. */
export function signDeferredAcceptanceResult(result: DeferredAcceptanceResult, signingKey: Uint8Array): string {
  if (!(signingKey instanceof Uint8Array) || signingKey.byteLength < 32) workflowError("INVALID_CALLBACK_KEY");
  return createHmac("sha256", signingKey).update("zap.deferred-acceptance.v1\n").update(canonical(result)).digest("hex");
}

/** Host-only control plane. No model continuation, verifier invocation or external side effects. */
export class DeferredAcceptanceCoordinator {
  private readonly keys = new Map<string, Uint8Array>();
  constructor(private readonly store: WorkflowControlStore, owners: DeferredAcceptanceOwner[]) {
    if (!store || typeof store.load !== "function" || typeof store.compareAndSwap !== "function"
      || !Array.isArray(owners)) workflowError("INVALID_DEFERRED_CONFIG");
    for (const owner of owners) {
      if (!owner || !workflowString(owner.id) || owner.id === "host:inline" || this.keys.has(owner.id)
        || !(owner.signingKey instanceof Uint8Array) || owner.signingKey.byteLength < 32) workflowError("INVALID_DEFERRED_CONFIG");
      this.keys.set(owner.id, new Uint8Array(owner.signingKey));
    }
  }

  private load(id: string): DeferredWorkflowRecord {
    const record = this.store.load(id);
    if (!record) workflowError("WORKFLOW_NOT_FOUND");
    validateWorkflowRecord(record);
    if (record.id !== id) workflowError("INVALID_WORKFLOW_RECORD");
    return record;
  }
  private expected(id: string, revision: number): DeferredWorkflowRecord {
    const record = this.load(id);
    if (record.revision !== revision) workflowError("WORKFLOW_CONFLICT");
    return record;
  }
  private save(previous: DeferredWorkflowRecord, next: DeferredWorkflowRecord): DeferredWorkflowRecord {
    next.revision = previous.revision + 1;
    next.updatedAt = Math.max(Date.now(), previous.updatedAt);
    this.store.compareAndSwap(previous.revision, next);
    return structuredClone(next);
  }
  private registration(input: DeferredWorkflowRegistration, now: number, inline = false): DeferredWorkflowRecord {
    const args = structuredClone(input);
    if (!workflowString(args.workflowId) || (!inline && !this.keys.has(args.ownerId)) || !Number.isSafeInteger(args.deadlineAt) || args.deadlineAt <= now
      || Object.keys(args).some(k => !["workflowId", "ownerId", "outcome", "spec", "snapshot", "deadlineAt", "blockers", "allowLimitedDelivery"].includes(k))) workflowError("INVALID_DEFERRED_CONFIG");
    validateOutcome(args.outcome);
    validateAcceptanceSpec(args.spec);
    if (args.snapshot) validateWorkflowSnapshot(args.snapshot, args.spec);
    const record: DeferredWorkflowRecord = {
      schema: "zap.workflow", schemaVersion: 1, id: args.workflowId, revision: 1, createdAt: now, updatedAt: now,
      deadlineAt: args.deadlineAt, requestId: randomUUID(), ownerId: args.ownerId,
      outcome: args.outcome, spec: args.spec, specDigest: acceptanceSpecDigest(args.spec), snapshot: args.snapshot,
      cancelled: false, blockers: args.blockers ?? [], allowLimitedDelivery: args.allowLimitedDelivery ?? false,
      acceptance: args.snapshot ? { status: "pending", code: "ACCEPTANCE_PENDING", checks: [] }
        : { status: "unverified", code: "STABLE_SNAPSHOT_UNAVAILABLE", checks: [] },
    };
    if (args.snapshot && args.spec.subjects.some(s => args.snapshot!.subjects.find(v => v.subjectId === s.id)!.exists !== (s.expected === "exists"))) {
      record.acceptance = { status: "failed", code: "SUBJECT_EXPECTATION_FAILED", checks: [] };
    }
    validateWorkflowRecord(record);
    return record;
  }

  /** Import only a persisted, validated M2 report. This grants no action authorization. */
  async registerInline(input: { workflowId: string; deadlineAt: number; recordId: string; store: InlineAcceptanceStore;
    blockers?: string[]; allowLimitedDelivery?: boolean }): Promise<DeferredWorkflowRecord> {
    const { store, ...args } = input;
    const pinned = structuredClone(args);
    const report = await store.load(pinned.recordId);
    if (!report || report.id !== pinned.recordId) workflowError("ACCEPTANCE_NOT_FOUND");
    validateInlineAcceptanceRecord(report);
    const record = this.registration({ workflowId: pinned.workflowId, deadlineAt: pinned.deadlineAt,
      ownerId: "host:inline", outcome: report.outcome, spec: report.spec, snapshot: report.snapshot,
      blockers: pinned.blockers, allowLimitedDelivery: pinned.allowLimitedDelivery }, Date.now(), true);
    record.acceptance = structuredClone(report.report);
    this.store.compareAndSwap(0, record);
    return structuredClone(record);
  }

  /** Persist delivery intent before queue/network I/O. A retry keeps the original requestId. */
  beginDelivery(id: string, expectedRevision: number): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (previous.cancelled || Date.now() >= previous.deadlineAt || previous.acceptance.status !== "pending"
      || previous.delivery?.receiptId || !this.keys.has(previous.ownerId)) workflowError("DELIVERY_NOT_PENDING");
    return this.save(previous, { ...previous, delivery: { attempts: (previous.delivery?.attempts ?? 0) + 1 } });
  }

  acknowledgeDelivery(id: string, expectedRevision: number, requestId: string, receiptId: string): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (previous.requestId !== requestId) workflowError("STALE_DELIVERY_RESULT");
    if (!previous.delivery?.attempts || !workflowString(receiptId)) workflowError("INVALID_DELIVERY_RECEIPT");
    if (previous.delivery.receiptId) {
      if (previous.delivery.receiptId !== receiptId) workflowError("DELIVERY_CONFLICT");
      return previous;
    }
    return this.save(previous, { ...previous, delivery: { ...previous.delivery, receiptId } });
  }

  /** Persist before publishing a request to the external owner. Existing IDs never silently reset. */
  register(input: DeferredWorkflowRegistration): DeferredWorkflowRecord {
    const record = this.registration(input, Date.now());
    this.store.compareAndSwap(0, record);
    return structuredClone(record);
  }

  read(id: string): { record: DeferredWorkflowRecord; decision: WorkflowControlDecision } {
    const record = this.load(id);
    return { record, decision: decideWorkflow(record) };
  }

  /** Explicit new attempt in the same turn, sharing the original deadline. Clears action authorization. */
  replaceAttempt(id: string, expectedRevision: number, input: Omit<DeferredWorkflowRegistration, "workflowId" | "deadlineAt">): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (previous.cancelled) workflowError("WORKFLOW_CANCELLED");
    if (previous.action) workflowError("ACTION_ALREADY_CLAIMED");
    const next = this.registration({ ...input, workflowId: id, deadlineAt: previous.deadlineAt }, Date.now());
    next.createdAt = previous.createdAt;
    return this.save(previous, next);
  }

  /** Permission adapter must resolve the current user grant before calling this trusted-host API. */
  authorizeAction(id: string, expectedRevision: number, authorization: WorkflowAuthorization | undefined): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (previous.cancelled) workflowError("WORKFLOW_CANCELLED");
    if (previous.action) workflowError("ACTION_ALREADY_CLAIMED");
    return this.save(previous, { ...previous, authorization: authorization && structuredClone(authorization) });
  }

  setBlockers(id: string, expectedRevision: number, blockers: string[]): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    return this.save(previous, { ...previous, blockers: structuredClone(blockers) });
  }

  cancel(id: string, expectedRevision: number): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (previous.cancelled) return previous;
    return this.save(previous, { ...previous, cancelled: true });
  }

  /** Persist a timeout if still pending. Late results cannot replace this terminal acceptance. */
  expire(id: string, expectedRevision: number): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (previous.acceptance.status !== "pending") return previous;
    if (Date.now() < previous.deadlineAt) workflowError("WORKFLOW_NOT_EXPIRED");
    return this.save(previous, { ...previous, acceptance: { status: "error", code: "ACCEPTANCE_TIMEOUT", checks: [] } });
  }

  accept(input: DeferredAcceptanceResult, signature: string): DeferredWorkflowRecord {
    const payload = structuredClone(input);
    const key = this.keys.get(payload?.ownerId);
    if (!key || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)
      || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signDeferredAcceptanceResult(payload, key), "hex"))) workflowError("CALLBACK_UNAUTHORIZED");
    const previous = this.load(payload.workflowId);
    if (payload.ownerId !== previous.ownerId || payload.requestId !== previous.requestId || payload.attemptId !== previous.outcome.attemptId
      || payload.specDigest !== previous.specDigest || !previous.snapshot || payload.snapshotId !== previous.snapshot.id) workflowError("STALE_ACCEPTANCE_RESULT");
    const digest = createHash("sha256").update(canonical(payload)).digest("hex");
    if (previous.acceptance.resultDigest === digest) return previous;
    if (previous.acceptance.status !== "pending") workflowError("ACCEPTANCE_CONFLICT");
    if (Date.now() >= previous.deadlineAt) workflowError("ACCEPTANCE_TIMEOUT");
    let acceptance: DeferredWorkflowRecord["acceptance"];
    if (payload.result?.status === "completed") {
      const checks = payload.result.checks;
      if (!Array.isArray(checks) || checks.length !== previous.spec.checks.length) workflowError("INVALID_VERIFIER_RESULT");
      const status = checks.some(c => c?.status === "error") ? "error" : checks.some(c => c?.status === "failed") ? "failed" : "passed";
      acceptance = { status, code: `ACCEPTANCE_${status.toUpperCase()}`, checks, resultDigest: digest };
    } else if (payload.result?.status === "error" && workflowString(payload.result.code)) {
      acceptance = { status: "error", code: payload.result.code, checks: [], resultDigest: digest };
    } else return workflowError("INVALID_VERIFIER_RESULT");
    // Cancellation is preserved even when authenticated late evidence is retained for audit.
    return this.save(previous, { ...previous, acceptance });
  }

  /** Logical action start. Only one caller obtains a claim; no automatic replay after a crash. */
  claimAction(candidate: WorkflowControlDecision, authorization: WorkflowAuthorization): DeferredWorkflowRecord {
    const previous = this.expected(candidate.workflowId, candidate.controlRevision);
    const current = decideWorkflow(previous);
    if (candidate.status !== "ready" || current.status !== "ready"
      || candidate.requestId !== current.requestId || candidate.attemptId !== current.attemptId
      || candidate.specDigest !== current.specDigest || candidate.snapshotId !== current.snapshotId) workflowError("WORKFLOW_NOT_READY");
    if (!authorization || previous.authorization?.actionId !== authorization.actionId
      || previous.authorization.grantId !== authorization.grantId) workflowError("ACTION_NOT_AUTHORIZED");
    const now = Date.now();
    return this.save(previous, { ...previous, action: { actionId: authorization.actionId, grantId: authorization.grantId, operationId: randomUUID(),
      requestId: previous.requestId, attemptId: previous.outcome.attemptId, snapshotId: previous.snapshot!.id,
      specDigest: previous.specDigest, controlRevision: previous.revision, claimedAt: now } });
  }

  /** Trusted executor/query receipt. Completion is independent of later cancellation or deadline. */
  recordActionResult(id: string, expectedRevision: number, input: WorkflowActionReceipt, source: WorkflowActionResult["source"]): DeferredWorkflowRecord {
    const previous = this.expected(id, expectedRevision);
    if (!previous.action) workflowError("ACTION_NOT_CLAIMED");
    validateWorkflowActionReceipt(input, previous.action);
    // Copy only protocol fields; adapter extensions cannot overwrite publication metadata.
    const receipt: WorkflowActionReceipt = { operationId: input.operationId, snapshotId: input.snapshotId,
      status: input.status, code: input.code, evidenceRefs: [...input.evidenceRefs] };
    const existing = previous.actionResult;
    if (existing) {
      const { observedAt, source: existingSource, ...saved } = existing;
      if (isDeepStrictEqual(saved, receipt)) return previous;
      if (existing.status !== "unknown") workflowError("ACTION_RESULT_CONFLICT");
    }
    return this.save(previous, { ...previous, actionResult: { ...receipt, source,
      observedAt: Math.max(Date.now(), previous.updatedAt) } });
  }

  /** Independent of Agent execution/exit. Abort only stops this wait; cancel() changes durable control. */
  async wait(id: string, options: { signal?: AbortSignal; timeoutMs: number; pollMs?: number }): Promise<ReturnType<DeferredAcceptanceCoordinator["read"]>> {
    const { signal, timeoutMs, pollMs = 100 } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) workflowError("INVALID_WAIT_CONFIG");
    const end = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const state = this.read(id);
      // Observe acceptance even if no downstream action has been authorized.
      if (state.record.acceptance.status !== "pending" || state.record.cancelled || Date.now() >= state.record.deadlineAt) return state;
      if (Date.now() >= end) workflowError("WORKFLOW_WAIT_TIMEOUT");
      await delay(Math.min(pollMs, end - Date.now(), Math.max(1, state.record.deadlineAt - Date.now())), undefined, { signal });
    }
  }
}

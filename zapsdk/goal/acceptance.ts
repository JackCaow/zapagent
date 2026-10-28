import { FileBytesSnapshotProvider } from "../runtime/file-acceptance.js";
import { InlineAcceptanceCoordinator, acceptanceSpecDigest, validateInlineAcceptanceRecord,
  type InlineAcceptanceStore, type InlineHostVerifier } from "../runtime/inline-acceptance.js";
import type { AcceptanceSpec, AgentOutcomeV1 } from "../runtime/outcome.js";
import type { GoalWorkspaceCandidate, GoalVerifierWorkspace, GoalWorkspace } from "./workspace.js";
import { goalTreeHash } from "./workspace.js";

/** Store this binding in Host-owned Goal state. Agent-provided objects are not receipts. */
export interface GoalAcceptanceReceipt {
  candidateId: string;
  candidateHash: string;
  integrationHash: string;
  attemptId: string;
  recordId: string;
  specDigest: string;
  snapshotId: string;
  goalSpecRevision: number;
  planRevision: number;
  taskSpecRevision: number;
  verifierVersion: string;
  verificationId?: string;
}
export interface GoalAcceptanceBinding {
  goalSpecRevision: number;
  planRevision: number;
  taskSpecRevision: number;
  verifierVersion: string;
  verificationId?: string;
}

/** Host-only: the supplied verifiers must execute independently under the
 * Host's Broker policy. Directory copies alone do not enforce that policy. */
export async function verifyGoalCandidate(options: {
  workspace: GoalWorkspace;
  candidate: GoalWorkspaceCandidate;
  verifierWorkspace: GoalVerifierWorkspace;
  outcome: AgentOutcomeV1;
  spec: AcceptanceSpec;
  verifiers: InlineHostVerifier[];
  store: InlineAcceptanceStore;
  binding: GoalAcceptanceBinding;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: "passed" | "failed" | "unverified" | "error"; receipt?: GoalAcceptanceReceipt; detail: string }> {
  const { workspace, candidate, verifierWorkspace, outcome, spec, store, binding } = options;
  if (outcome.attemptId !== candidate.attemptId) throw new Error("Acceptance attempt does not match the candidate");
  if (![binding.goalSpecRevision, binding.planRevision, binding.taskSpecRevision].every(n => Number.isSafeInteger(n) && n > 0) || !binding.verifierVersion) {
    throw new Error("Invalid Goal acceptance binding");
  }
  await workspace.assertVerifierUnchanged(candidate, verifierWorkspace);
  const snapshotProvider = new FileBytesSnapshotProvider(candidate.snapshotPath);
  const coordinator = new InlineAcceptanceCoordinator({ mode: "required", timing: "inline", spec, snapshotProvider,
    verifiers: options.verifiers, store, timeoutMs: options.timeoutMs });
  const record = await coordinator.evaluate(outcome, options.signal);
  await workspace.assertVerifierUnchanged(candidate, verifierWorkspace);
  if (record.report.status !== "passed" || record.workflow.status !== "ready" || !record.snapshot) {
    return { status: record.report.status, detail: record.report.code };
  }
  const receipt: GoalAcceptanceReceipt = { candidateId: candidate.candidateId, candidateHash: candidate.treeHash,
    integrationHash: candidate.integrationHash, attemptId: candidate.attemptId, recordId: record.id,
    specDigest: record.specDigest, snapshotId: record.snapshot.id, ...binding };
  await assertGoalAcceptance(candidate, receipt, store);
  return { status: "passed", receipt, detail: record.report.code };
}

/** Re-read the current immutable bytes and the Host's persisted receipt at each
 * merge boundary. The caller must read the binding from its trusted GoalStore. */
export async function assertGoalAcceptance(candidate: GoalWorkspaceCandidate, receipt: GoalAcceptanceReceipt, store: InlineAcceptanceStore): Promise<void> {
  if (receipt.candidateId !== candidate.candidateId || receipt.candidateHash !== candidate.treeHash
    || receipt.integrationHash !== candidate.integrationHash || receipt.attemptId !== candidate.attemptId
    || !receipt.verifierVersion || ![receipt.goalSpecRevision, receipt.planRevision, receipt.taskSpecRevision].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Acceptance receipt does not match the Goal candidate");
  }
  const record = await store.load(receipt.recordId);
  validateInlineAcceptanceRecord(record);
  if (record.id !== receipt.recordId || record.outcome.attemptId !== candidate.attemptId || record.report.status !== "passed"
    || record.workflow.status !== "ready" || record.specDigest !== receipt.specDigest
    || acceptanceSpecDigest(record.spec) !== receipt.specDigest || record.snapshot?.id !== receipt.snapshotId) {
    throw new Error("Acceptance record is not a passing Host receipt");
  }
  if (await goalTreeHash(candidate.snapshotPath) !== candidate.treeHash) throw new Error("Candidate changed after acceptance");
  const provider = new FileBytesSnapshotProvider(candidate.snapshotPath);
  const signal = new AbortController().signal;
  const current = await provider.capture({ outcome: record.outcome, spec: record.spec, signal });
  if (!current || current.id !== receipt.snapshotId) throw new Error("Acceptance subject changed after verification");
}

export interface GoalFinalAcceptanceReceipt extends GoalAcceptanceBinding {
  goalId: string;
  snapshotId: string;
  treeHash: string;
  attemptId: string;
  recordId: string;
  specDigest: string;
  acceptanceSnapshotId: string;
}

/** Final acceptance uses a fresh immutable integration snapshot and a separate
 * verifier copy; a passed worker receipt is never an integration receipt. */
export async function verifyGoalFinalSnapshot(options: {
  workspace: GoalWorkspace;
  snapshot: import("./workspace.js").GoalFinalSnapshot;
  verifierWorkspace: GoalVerifierWorkspace;
  outcome: AgentOutcomeV1;
  spec: AcceptanceSpec;
  verifiers: InlineHostVerifier[];
  store: InlineAcceptanceStore;
  binding: GoalAcceptanceBinding;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: "passed" | "failed" | "unverified" | "error"; receipt?: GoalFinalAcceptanceReceipt; detail: string }> {
  const { workspace, snapshot, verifierWorkspace, outcome, spec, store, binding } = options;
  if (![binding.goalSpecRevision, binding.planRevision, binding.taskSpecRevision].every(n => Number.isSafeInteger(n) && n > 0) || !binding.verifierVersion) throw new Error("Invalid Goal acceptance binding");
  await workspace.assertFinalVerifierUnchanged(snapshot, verifierWorkspace);
  const provider = new FileBytesSnapshotProvider(snapshot.path);
  const coordinator = new InlineAcceptanceCoordinator({ mode: "required", timing: "inline", spec, snapshotProvider: provider,
    verifiers: options.verifiers, store, timeoutMs: options.timeoutMs });
  const record = await coordinator.evaluate(outcome, options.signal);
  await workspace.assertFinalVerifierUnchanged(snapshot, verifierWorkspace);
  if (record.report.status !== "passed" || record.workflow.status !== "ready" || !record.snapshot) return { status: record.report.status, detail: record.report.code };
  const receipt: GoalFinalAcceptanceReceipt = { goalId: snapshot.goalId, snapshotId: snapshot.snapshotId, treeHash: snapshot.treeHash,
    attemptId: outcome.attemptId, recordId: record.id, specDigest: record.specDigest, acceptanceSnapshotId: record.snapshot.id, ...binding };
  await assertGoalFinalAcceptance(workspace, snapshot, receipt, store);
  return { status: "passed", receipt, detail: record.report.code };
}

export async function assertGoalFinalAcceptance(workspace: GoalWorkspace, snapshot: import("./workspace.js").GoalFinalSnapshot,
  receipt: GoalFinalAcceptanceReceipt, store: InlineAcceptanceStore): Promise<void> {
  await workspace.assertFinalSnapshot(snapshot);
  if (receipt.goalId !== snapshot.goalId || receipt.snapshotId !== snapshot.snapshotId || receipt.treeHash !== snapshot.treeHash
    || !receipt.verifierVersion || ![receipt.goalSpecRevision, receipt.planRevision, receipt.taskSpecRevision].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Final acceptance binding is stale");
  const record = await store.load(receipt.recordId);
  validateInlineAcceptanceRecord(record);
  if (record.outcome.attemptId !== receipt.attemptId || record.report.status !== "passed" || record.workflow.status !== "ready"
    || record.specDigest !== receipt.specDigest || record.snapshot?.id !== receipt.acceptanceSnapshotId) throw new Error("Final acceptance has no passing Host receipt");
  const provider = new FileBytesSnapshotProvider(snapshot.path);
  const current = await provider.capture({ outcome: record.outcome, spec: record.spec, signal: new AbortController().signal });
  if (!current || current.id !== receipt.acceptanceSnapshotId) throw new Error("Final acceptance subjects changed");
}

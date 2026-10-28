/** Goal control records are Host-owned. Agent output is a proposal, never a state transition. */
export type GoalStatus = "created" | "running" | "paused" | "blocked" | "awaiting_acceptance" | "ready_for_delivery" | "completed" | "cancelled" | "failed";
export type GoalPhase = "planning" | "executing" | "verifying" | "repairing" | "integrating" | "final_verifying" | "delivering" | "sealing";
export interface GoalTask {
  id: string;
  description: string;
  acceptance: string;
  dependencies: string[];
  revision: number;
  status: "pending" | "running" | "verifying" | "repairing" | "passed" | "blocked";
  attempt: number;
  candidate?: unknown;
  receipt?: GoalReceipt;
}
export interface GoalReceipt {
  status: "passed" | "failed" | "unverified" | "error";
  candidateId: string;
  snapshotId: string;
  specDigest: string;
  taskId: string;
  attempt: number;
  /** Immutable record returned by the host verifier; never the worker's claim. */
  evidence: unknown;
  detail?: string;
}
export interface GoalRecord {
  id: string;
  objective: string;
  deliveryPolicy: "artifact" | "workspace";
  machineCheck?: "bun" | "npm" | "pytest" | "go";
  /** User-authorized, host-managed dependency preparation. */
  dependencyInstall?: "npm";
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  cwd: string;
  stateRevision: number;
  specRevision: number;
  planRevision: number;
  status: GoalStatus;
  phase?: GoalPhase;
  stopReason?: string;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  ownerEpoch: number;
  owner?: { instanceId: string; pid: number };
  /** Intent persisted before external work. Recovery must reconcile before retry. */
  inFlight?: { operationId: string; phase: GoalPhase; taskId?: string; opaqueBefore?: number };
  control?: "pause" | "cancel";
  tasks: GoalTask[];
  integration?: unknown;
  finalReceipt?: GoalReceipt;
  delivery?: unknown;
}
export interface GoalPlanProposal {
  tasks: Array<{ id: string; description: string; acceptance: string; dependencies?: string[] }>;
}
export interface GoalCandidate {
  candidateId: string;
  snapshotId: string;
  specDigest: string;
  value: unknown;
}
export interface GoalOperationContext {
  goal: Readonly<GoalRecord>;
  operationId: string;
  signal: AbortSignal;
}
/** Concrete Host implementations provide real isolated runtimes and trusted verifier receipts. */
export interface GoalHost {
  recoveryMarker?(): number;
  reconcile?(goal: Readonly<GoalRecord>): Promise<{ kind: "retry" | "verified" | "blocked"; receipt?: GoalReceipt; reason?: string }>;
  onClaim?(goal: Readonly<GoalRecord>, previousEpoch: number): Promise<void>;
  plan(context: GoalOperationContext): Promise<GoalPlanProposal>;
  execute(context: GoalOperationContext, task: Readonly<GoalTask>, previous?: GoalReceipt): Promise<GoalCandidate>;
  verify(context: GoalOperationContext, task: Readonly<GoalTask>, candidate: GoalCandidate, final: boolean): Promise<GoalReceipt>;
  integrate(context: GoalOperationContext, task: Readonly<GoalTask>, candidate: GoalCandidate, receipt: GoalReceipt): Promise<unknown>;
  snapshotIntegration(context: GoalOperationContext): Promise<GoalCandidate>;
  deliver(context: GoalOperationContext, integration: unknown, receipt: GoalReceipt): Promise<{ status: "delivered" | "needs_authorization"; value?: unknown }>;
  /** Called during cancellation; must settle the process tree before resolving. */
  seal?(goal: Readonly<GoalRecord>): Promise<void>;
}

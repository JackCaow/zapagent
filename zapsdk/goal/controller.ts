import { randomUUID } from "node:crypto";
import type { GoalCandidate, GoalHost, GoalOperationContext, GoalPhase, GoalPlanProposal, GoalReceipt, GoalRecord, GoalTask } from "./contracts.js";
import { GoalStore } from "./store.js";

function validatePlan(proposal: GoalPlanProposal): GoalTask[] {
  if (!proposal || !Array.isArray(proposal.tasks) || !proposal.tasks.length || proposal.tasks.length > 64) throw new Error("INVALID_GOAL_PLAN");
  const ids = new Set<string>();
  const tasks: GoalTask[] = proposal.tasks.map(item => {
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.description !== "string" || !item.description.trim() || typeof item.acceptance !== "string" || !item.acceptance.trim()
      || (item.dependencies !== undefined && (!Array.isArray(item.dependencies) || item.dependencies.some(v => typeof v !== "string")))) throw new Error("INVALID_GOAL_PLAN");
    ids.add(item.id);
    return { id: item.id, description: item.description, acceptance: item.acceptance, dependencies: [...(item.dependencies ?? [])], revision: 1, status: "pending", attempt: 0 };
  });
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("CYCLIC_GOAL_PLAN");
    if (visited.has(id)) return;
    const task = tasks.find(t => t.id === id); if (!task) throw new Error("MISSING_GOAL_DEPENDENCY");
    visiting.add(id); for (const dep of task.dependencies) visit(dep); visiting.delete(id); visited.add(id);
  }
  tasks.forEach(task => visit(task.id));
  return tasks;
}
function checkCandidate(candidate: GoalCandidate): void {
  if (!candidate || !candidate.candidateId || !candidate.snapshotId || !candidate.specDigest) throw new Error("INVALID_GOAL_CANDIDATE");
}
function checkReceipt(receipt: GoalReceipt, candidate: GoalCandidate, task: GoalTask): void {
  if (!receipt || !["passed", "failed", "unverified", "error"].includes(receipt.status) || receipt.candidateId !== candidate.candidateId
    || receipt.snapshotId !== candidate.snapshotId || receipt.specDigest !== candidate.specDigest || receipt.taskId !== task.id
    || receipt.attempt !== task.attempt || receipt.evidence == null) throw new Error("INVALID_GOAL_ACCEPTANCE_RECEIPT");
}

/** Host-only coordinator: every effect has a persisted intent; unknown outcomes block recovery. */
export class GoalController {
  private readonly instanceId = randomUUID();
  private readonly abort = new AbortController();
  private epoch = 0;
  private timer?: ReturnType<typeof setInterval>;
  private control?: "pause" | "cancel" | "deadline";
  constructor(private readonly store: GoalStore, private readonly host: GoalHost, private readonly goalId: string, private readonly maxRepairs = 2) {}
  private get(): GoalRecord { const goal = this.store.get(this.goalId); if (!goal) throw new Error("GOAL_NOT_FOUND"); return goal; }
  private update(fn: (goal: GoalRecord) => void): GoalRecord { return this.store.update(this.goalId, this.epoch, this.instanceId, fn); }
  private check(): void {
    const goal = this.get();
    if (goal.ownerEpoch !== this.epoch || goal.owner?.instanceId !== this.instanceId) throw new Error("GOAL_STALE_OWNER");
    if (goal.control || Date.now() >= goal.deadlineAt) {
      this.control = goal.control ?? "deadline"; this.abort.abort(); throw new Error("GOAL_STOP_REQUESTED");
    }
  }
  private begin(phase: GoalPhase, taskId?: string): GoalOperationContext {
    this.check();
    const operationId = randomUUID();
    const opaqueBefore = this.host.recoveryMarker?.();
    const goal = this.update(value => { value.phase = phase; value.inFlight = { phase, operationId, ...(taskId ? { taskId } : {}), ...(opaqueBefore === undefined ? {} : { opaqueBefore }) }; });
    return { goal, operationId, signal: this.abort.signal };
  }
  private finish(context: GoalOperationContext, apply: (goal: GoalRecord) => void): GoalRecord {
    this.check();
    return this.update(goal => {
      if (goal.inFlight?.operationId !== context.operationId) throw new Error("GOAL_OPERATION_CONFLICT");
      apply(goal); goal.inFlight = undefined;
    });
  }
  /** Reconcile persisted intent before any new work. The Host must prove
   * absence of live writers and opaque effects; no unsafe replay fallback. */
  async recover(): Promise<GoalRecord> {
    const before = this.get();
    if (!before.inFlight) return before;
    const claimed = this.store.claim(this.goalId, this.instanceId, process.pid, true); this.epoch = claimed.ownerEpoch;
    try {
      await this.host.onClaim?.(claimed, before.ownerEpoch);
      const resolution = await this.host.reconcile?.(claimed) ?? { kind: "blocked" as const, reason: "NO_RECONCILIATION_ADAPTER" };
      if (resolution.kind === "blocked") return this.store.release(this.goalId, this.epoch, this.instanceId, "blocked", resolution.reason ?? "RECONCILIATION_REQUIRED");
      this.update(goal => {
        const flight = goal.inFlight; if (!flight || flight.operationId !== claimed.inFlight?.operationId) throw new Error("GOAL_OPERATION_CONFLICT");
        if (flight.phase === "executing" || flight.phase === "repairing") {
          const task = goal.tasks.find(item => item.id === flight.taskId); if (!task) throw new Error("GOAL_TASK_MISSING");
          task.status = flight.phase === "repairing" ? "repairing" : "pending";
        }
        if (resolution.kind === "verified") {
          const task = goal.tasks.find(item => item.id === flight.taskId); if (!task || !task.candidate || !resolution.receipt) throw new Error("GOAL_RECOVERY_RECEIPT_MISSING");
          checkReceipt(resolution.receipt, task.candidate as GoalCandidate, task);
          task.receipt = resolution.receipt;
          task.status = resolution.receipt.status === "passed" ? "verifying" : resolution.receipt.status === "failed" ? "repairing" : "blocked";
        }
        goal.inFlight = undefined; goal.control = undefined;
      });
      return this.store.release(this.goalId, this.epoch, this.instanceId, "paused", "RECONCILED_SAFE_TO_RESUME");
    } catch (error) {
      return this.store.release(this.goalId, this.epoch, this.instanceId, "blocked", `RECONCILIATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async run(): Promise<GoalRecord> {
    const before = this.get();
    const claimed = this.store.claim(this.goalId, this.instanceId, process.pid); this.epoch = claimed.ownerEpoch;
    this.timer = setInterval(() => {
      try { const value = this.get(); if (value.control || Date.now() >= value.deadlineAt) { this.control = value.control ?? "deadline"; this.abort.abort(); } }
      catch { this.abort.abort(); }
    }, 200);
    try {
      await this.host.onClaim?.(claimed, before.ownerEpoch);
      if (!claimed.planRevision) {
        const ctx = this.begin("planning");
        const proposal = validatePlan(await this.host.plan(ctx));
        this.finish(ctx, goal => { goal.tasks = proposal; goal.planRevision = 1; });
      }
      while (true) {
        this.check();
        const current = this.get();
        const task = current.tasks.find(t => t.status !== "passed" && t.dependencies.every(d => current.tasks.some(x => x.id === d && x.status === "passed")));
        if (!task) {
          if (current.tasks.some(t => t.status !== "passed")) throw new Error("GOAL_DEPENDENCY_BLOCKED");
          break;
        }
        let currentTask = task;
        let candidate = task.candidate as GoalCandidate | undefined;
        let receipt = task.receipt;
        if (task.status === "blocked") return this.store.release(this.goalId, this.epoch, this.instanceId, "awaiting_acceptance", receipt?.detail ?? "TASK_REQUIRES_ACCEPTANCE");
        // Persisted candidate and receipt identify the next safe step. Never
        // replay a worker merely because the owner died between operations.
        if (task.status === "pending" || task.status === "repairing") {
          if (task.status === "repairing" && (!receipt || receipt.status !== "failed" || task.attempt > this.maxRepairs)) {
            return this.store.release(this.goalId, this.epoch, this.instanceId, "blocked", "REPAIR_LIMIT_OR_EVIDENCE_MISSING");
          }
          const ctx = this.begin(task.status === "repairing" ? "repairing" : "executing", task.id);
          const running = this.update(goal => { const t = goal.tasks.find(x => x.id === task.id)!; t.attempt++; t.status = task.status === "repairing" ? "repairing" : "running"; });
          currentTask = running.tasks.find(x => x.id === task.id)!;
          candidate = await this.host.execute({ ...ctx, goal: running }, currentTask, receipt);
          checkCandidate(candidate);
          this.finish(ctx, goal => { const t = goal.tasks.find(x => x.id === task.id)!; t.candidate = candidate; t.receipt = undefined; t.status = "verifying"; });
          receipt = undefined;
        } else if (task.status !== "verifying") throw new Error("GOAL_TASK_RECOVERY_REQUIRED");
        if (!candidate) throw new Error("GOAL_CANDIDATE_MISSING");
        checkCandidate(candidate);
        if (!receipt) {
          const verification = this.begin("verifying", task.id);
          receipt = await this.host.verify(verification, currentTask, candidate, false); checkReceipt(receipt, candidate, currentTask);
          const checked = receipt;
          this.finish(verification, goal => { const t = goal.tasks.find(x => x.id === task.id)!; t.receipt = checked; t.status = checked.status === "failed" ? "repairing" : checked.status === "passed" ? "verifying" : "blocked"; });
        } else checkReceipt(receipt, candidate, currentTask);
        if (receipt.status !== "passed") {
          if (receipt.status === "failed" && currentTask.attempt <= this.maxRepairs) continue;
          return this.store.release(this.goalId, this.epoch, this.instanceId, receipt.status === "failed" ? "blocked" : "awaiting_acceptance", receipt.detail ?? `VERIFICATION_${receipt.status.toUpperCase()}`);
        }
        const integration = this.begin("integrating", task.id);
        const integrated = await this.host.integrate(integration, currentTask, candidate, receipt);
        this.finish(integration, goal => { goal.integration = integrated; goal.tasks.find(x => x.id === task.id)!.status = "passed"; });
      }
      const snapshotOp = this.begin("final_verifying");
      const finalCandidate = await this.host.snapshotIntegration(snapshotOp); checkCandidate(finalCandidate);
      // The final snapshot and check share one persisted operation, so a crash cannot skip final verification.
      const finalTask: GoalTask = { id: "$goal", description: this.get().objective, acceptance: this.get().objective, dependencies: [], revision: this.get().specRevision, status: "verifying", attempt: 1 };
      const finalReceipt = await this.host.verify(snapshotOp, finalTask, finalCandidate, true); checkReceipt(finalReceipt, finalCandidate, finalTask);
      this.finish(snapshotOp, goal => { goal.finalReceipt = finalReceipt; });
      if (finalReceipt.status !== "passed") return this.store.release(this.goalId, this.epoch, this.instanceId, "awaiting_acceptance", finalReceipt.detail ?? "FINAL_ACCEPTANCE_NOT_PASSED");
      const deliveryOp = this.begin("delivering");
      const delivered = await this.host.deliver(deliveryOp, this.get().integration, finalReceipt);
      this.finish(deliveryOp, goal => { goal.delivery = delivered.value; });
      return this.store.release(this.goalId, this.epoch, this.instanceId, delivered.status === "delivered" ? "completed" : "ready_for_delivery", delivered.status === "delivered" ? undefined : "DELIVERY_AUTHORIZATION_REQUIRED");
    } catch (error) {
      const goal = this.get();
      if (this.control) {
        if (error instanceof Error && error.message.includes("GOAL_SEAL_UNCONFIRMED")) throw error;
        try {
          if (!this.host.seal && goal.inFlight) throw new Error("GOAL_SEAL_UNAVAILABLE");
          await this.host.seal?.(goal);
          this.update(value => { value.phase = "sealing"; value.control = undefined; });
          return this.store.release(this.goalId, this.epoch, this.instanceId, this.control === "cancel" ? "cancelled" : "paused", this.control === "deadline" ? "DEADLINE_EXCEEDED" : `USER_${this.control.toUpperCase()}`);
        } catch { throw new Error("GOAL_SEAL_UNCONFIRMED"); }
      }
      const reason = error instanceof Error ? error.message : String(error);
      return this.store.release(this.goalId, this.epoch, this.instanceId, "blocked", goal.inFlight ? `OPERATION_REQUIRES_RECONCILIATION: ${reason}` : reason);
    } finally { if (this.timer) clearInterval(this.timer); }
  }
}
export const goalControllerTesting = { validatePlan, checkReceipt };

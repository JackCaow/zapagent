import type { GoalRecord, GoalTask } from "./contracts.js";

export type GoalAction = { kind: "plan" | "snapshot" | "verify_final" | "deliver" }
  | { kind: "execute" | "verify" | "integrate"; task: GoalTask }
  | { kind: "stop"; status: "awaiting_acceptance" | "blocked" | "paused"; reason: string };

/** Pure scheduling policy. The controller alone owns effects and receipts. */
export function nextGoalAction(goal: Readonly<GoalRecord>): GoalAction {
  if (!goal.planRevision) return { kind: "plan" };
  if (goal.permissionMode === "plan") return { kind: "stop", status: "paused", reason: "GOAL_PLAN_REQUIRES_EXECUTION_AUTHORIZATION" };
  const task = goal.tasks.find(t => t.status !== "passed" && t.dependencies.every(id => goal.tasks.some(dep => dep.id === id && dep.status === "passed")));
  if (task) {
    if (task.status === "blocked") return { kind: "stop", status: "awaiting_acceptance", reason: task.receipt?.detail ?? "TASK_REQUIRES_ACCEPTANCE" };
    if (task.status === "pending" || task.status === "repairing") return { kind: "execute", task };
    if (task.status !== "verifying") return { kind: "stop", status: "blocked", reason: "GOAL_TASK_RECOVERY_REQUIRED" };
    if (task.receipt && task.receipt.status !== "passed") return { kind: "stop", status: "awaiting_acceptance", reason: task.receipt.detail ?? "TASK_REQUIRES_ACCEPTANCE" };
    return { kind: task.receipt ? "integrate" : "verify", task };
  }
  if (goal.tasks.some(t => t.status !== "passed")) return { kind: "stop", status: "blocked", reason: "GOAL_DEPENDENCY_BLOCKED" };
  if (!goal.finalCandidate) return { kind: "snapshot" };
  if (!goal.finalReceipt) return { kind: "verify_final" };
  if (goal.finalReceipt.status !== "passed") return { kind: "stop", status: "awaiting_acceptance", reason: goal.finalReceipt.detail ?? "FINAL_ACCEPTANCE_NOT_PASSED" };
  return { kind: "deliver" };
}

/** Each completed phase emits the next scheduling opportunity. Yielding to
 * the event loop lets queued user control win before starting new work. */
export async function driveGoalSchedule(step: () => Promise<GoalRecord>): Promise<GoalRecord> {
  for (;;) {
    await new Promise<void>(resolve => setImmediate(resolve));
    const goal = await step();
    if (goal.status !== "running") return goal;
  }
}

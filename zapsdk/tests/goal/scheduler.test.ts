import { expect, it } from "bun:test";
import { driveGoalSchedule, nextGoalAction } from "../../goal/scheduler.js";
import type { GoalRecord, GoalTask } from "../../goal/contracts.js";

const task: GoalTask = { id: "one", description: "Report", acceptance: "Cited", dependencies: [], revision: 1, attempt: 0, status: "pending" };
const goal = { id: "g", objective: "Report", status: "running", planRevision: 0, tasks: [] } as unknown as GoalRecord;
it("selects one effect at a time and never equates a finished task with a finished Goal", () => {
  expect(nextGoalAction(goal).kind).toBe("plan");
  const planned = { ...goal, planRevision: 1, tasks: [task] };
  expect(nextGoalAction(planned).kind).toBe("execute");
  expect(nextGoalAction({ ...planned, tasks: [{ ...task, status: "verifying" }] }).kind).toBe("verify");
  const integrated = { ...planned, tasks: [{ ...task, status: "passed" as const }] };
  expect(nextGoalAction(integrated).kind).toBe("snapshot");
  const finalCandidate = { candidateId: "c", snapshotId: "s", specDigest: "d", value: {} };
  expect(nextGoalAction({ ...integrated, finalCandidate }).kind).toBe("verify_final");
  const finalReceipt = { ...finalCandidate, taskId: "$goal", attempt: 1, evidence: {}, status: "error" as const };
  expect(nextGoalAction({ ...integrated, finalCandidate, finalReceipt }).kind).toBe("stop");
  expect(nextGoalAction({ ...integrated, finalCandidate, finalReceipt: { ...finalReceipt, status: "passed" } }).kind).toBe("deliver");
});
it("yields between phase events so queued user input wins before continuation", async () => {
  let input = false, calls = 0;
  const result = await driveGoalSchedule(async () => {
    if (++calls === 1) { setImmediate(() => { input = true; }); return goal; }
    expect(input).toBe(true);
    return { ...goal, status: "paused" };
  });
  expect(result.status).toBe("paused"); expect(calls).toBe(2);
});

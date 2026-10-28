import { GoalController } from "../zapsdk/goal/controller.js"
import { GoalStore } from "../zapsdk/goal/store.js"
import { LocalGoalHost } from "./goal-host.js"
import { goalDatabasePath } from "./goal-command.js"

/** Invoked as a detached CLI child; it never treats a compiled executable as an interpreter. */
export async function runGoalRunner(id: string): Promise<number> {
  if (process.platform === "win32") {
    process.stderr.write("Goal execution is not yet supported on Windows: process-tree sealing cannot be verified.\n")
    return 2
  }
  const store = new GoalStore(goalDatabasePath(), { requireLedger: true })
  try {
    const goal = store.get(id)
    if (!goal || goal.cwd !== process.cwd()) throw new Error("Goal does not belong to the current workspace")
    const controller = new GoalController(store, new LocalGoalHost(id), id)
    if (goal.inFlight) {
      const reconciled = await controller.recover()
      if (reconciled.inFlight || reconciled.status === "blocked") {
        process.stderr.write(`Goal recovery blocked: ${reconciled.stopReason ?? "unknown effects"}\n`)
        return 1
      }
    }
    const outcome = await controller.run({ automatic: true })
    process.stdout.write(JSON.stringify({ id: outcome.id, status: outcome.status, phase: outcome.phase, reason: outcome.stopReason, delivery: outcome.delivery }) + "\n")
    return outcome.status === "completed" || outcome.status === "ready_for_delivery" ? 0 : 1
  } catch (error) {
    process.stderr.write(`Goal runner: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally { store.close() }
}

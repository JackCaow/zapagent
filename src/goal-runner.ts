import { GoalTurnHost } from "./goal-turn-host.js"
import type { GoalTurnExecutor } from "./goal-turn.js"
import { GoalController } from "../zapsdk/goal/controller.js"
import { GoalStore } from "../zapsdk/goal/store.js"
import { LocalGoalHost } from "./goal-host.js"
import { goalDatabasePath } from "./goal-command.js"

/** Shared controller entry for attached sessions and explicitly detached runners. */
export interface GoalRunnerObserver {
  runTurn?: GoalTurnExecutor
  signal?: AbortSignal
  onEvent?: (event: import("../zapsdk/agent/events.js").AgentEvent, operationId: string) => void
  onState?: (goal: import("../zapsdk/goal/contracts.js").GoalRecord) => void
  onOutcome?: (goal: import("../zapsdk/goal/contracts.js").GoalRecord) => void
}
export async function runGoalRunner(id: string, observer: GoalRunnerObserver = {}): Promise<number> {
  if (process.platform === "win32") {
    process.stderr.write("Goal execution is not yet supported on Windows: process-tree sealing cannot be verified.\n")
    return 2
  }
  const store = new GoalStore(goalDatabasePath(), { requireLedger: true })
  let revision = -1
  const publish = () => {
    const goal = store.get(id)
    if (goal && goal.stateRevision !== revision) { revision = goal.stateRevision; observer.onState?.(goal) }
  }
  const pause = () => {
    const goal = store.get(id)
    if (goal && ["created", "running"].includes(goal.status)) store.requestControl(id, "pause")
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  if (observer.onOutcome) for (const name of signals) process.on(name, pause)
  observer.signal?.addEventListener("abort", pause, { once: true })
  const timer = observer.onState ? setInterval(publish, 100) : undefined
  try {
    const goal = store.get(id)
    if (!goal || goal.cwd !== process.cwd()) throw new Error("Goal does not belong to the current workspace")
    const controller = new GoalController(store, (goal.executionMode === "session" ? new GoalTurnHost(id, observer.onEvent, observer.runTurn) : new LocalGoalHost(id, observer.onEvent)), id)
    if (goal.inFlight) {
      const reconciled = await controller.recover()
      if (reconciled.inFlight || reconciled.status === "blocked") {
        observer.onState?.(reconciled); observer.onOutcome?.(reconciled)
        if (!observer.onOutcome) process.stderr.write(`Goal recovery blocked: ${reconciled.stopReason ?? "unknown effects"}\n`)
        return 1
      }
    }
    publish()
    if (observer.signal?.aborted) { pause(); const stopped = store.get(id)!; observer.onOutcome?.(stopped); return 1 }
    const outcome = await controller.run({ automatic: true })
    publish()
    observer.onOutcome?.(outcome)
    if (!observer.onOutcome) process.stdout.write(JSON.stringify({ id: outcome.id, status: outcome.status, phase: outcome.phase, reason: outcome.stopReason, delivery: outcome.delivery }) + "\n")
    return outcome.status === "completed" || outcome.status === "ready_for_delivery" ? 0 : 1
  } catch (error) {
    if (observer.onOutcome) throw error
    process.stderr.write(`Goal runner: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    if (timer) clearInterval(timer)
    observer.signal?.removeEventListener("abort", pause)
    if (observer.onOutcome) for (const name of signals) process.removeListener(name, pause)
    store.close()
  }
}

import { goalPhaseFailureCode } from "../../zapsdk/goal/errors.js"
import type { GoalPhaseInput } from "./goalPhase.js"
import type { HeadlessFormatter, RunSummary } from "./formatter.js"
import { goalTurnMeter } from "../goal-turn.js"

/** Background execution uses the ordinary headless runtime: normal PATH,
 * network, approvals, checkpointing, child isolation and lifecycle sealing. */
export async function runSharedGoalTurnWorker(input: GoalPhaseInput): Promise<number> {
  const { runHeadless } = await import("./runHeadless.js")
  const readonly = ["planner", "verifier", "finalization"].includes(input.role)
  const meter = goalTurnMeter(input)
  let summary: RunSummary | undefined
  let toolCalls = 0
  const formatter: HeadlessFormatter = {
    init() {}, progress() {}, failure(error) { throw new Error(error.code) },
    onEvent(event) {
      if (event.type === "content_final" && event.kind === "tool_call") toolCalls++
      if (input.streamEvents) process.stdout.write(JSON.stringify({ type: "event", event }) + "\n")
    },
    finalize(value) { summary = value },
  }
  try {
    const code = await runHeadless({ prompt: input.prompt, permissionMode: input.permissionMode ?? "default", outputFormat: "json", resultSchema: "outcome-v1",
      cwd: input.cwd, quiet: true, continueLast: false, continueOnToolDenial: false, dangerouslyDisableOsSandbox: false, ...(input.sessionId ? { sessionId: input.sessionId } : {}), noDevtools: true,
    }, { formatter, ...meter, readOnlyWorkspace: readonly, disableRepoMap: true })
    if (!summary?.outcome) throw new Error("GOAL_TURN_OUTCOME_MISSING")
    const execution = summary.outcome.execution
    // This is the ordinary Runtime's terminal outcome, not an OS process-seal
    // claim. In-flight or pending background actions never clear ownership.
    const settled = execution.unresolvedActions.length === 0 && !execution.backgroundTasks?.some(task => task.disposition === "pending")
    process.stdout.write(JSON.stringify({ type: "result", summary, exitCode: code, runtimeSettled: settled, toolCalls, ...(code !== 0 ? { failureCode: goalPhaseFailureCode(summary.error ?? "") } : {}) }) + "\n")
    return code
  } finally { meter.close() }
}

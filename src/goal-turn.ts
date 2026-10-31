import { randomUUID } from "node:crypto"
import type { AgentEvent } from "../zapsdk/agent/events.js"
import type { AgentOutcomeV1 } from "../zapsdk/runtime/outcome.js"
import type { GoalBudgetRole } from "../zapsdk/goal/budget.js"
import { GoalBudgetLedger } from "../zapsdk/goal/budget.js"
import { meterGoalProvider } from "../zapsdk/goal/metered-provider.js"
import type { LLMProvider } from "../zapsdk/core/llm.js"
import type { PermissionMode } from "./config.js"

export interface GoalTurnInput {
  cwd: string
  goalId: string
  epoch: number
  ledgerPath: string
  role: GoalBudgetRole
  prompt: string
  permissionMode: PermissionMode
  signal: AbortSignal
  sessionId?: string
  onEvent: (event: AgentEvent) => void
}
export interface GoalTurnResult { text: string; outcome: AgentOutcomeV1; toolCalls: number; sessionId?: string }
export type GoalTurnExecutor = (input: GoalTurnInput) => Promise<GoalTurnResult>

/** Instrumentation only: tool permissions and workspace policy stay with the
 * normal runtime. Opaque external model calls remain explicitly unmetered. */
export function goalTurnMeter(input: Pick<GoalTurnInput, "goalId" | "epoch" | "role" | "ledgerPath">) {
  const ledger = new GoalBudgetLedger(input.ledgerPath)
  return {
    providerAdapter: (provider: LLMProvider) => meterGoalProvider(provider, ledger, input),
    admitToolExecution: (name: string) => {
      const admission = ledger.admit(input.goalId, input.epoch, { operationId: randomUUID(), role: input.role, kind: "tool", opaque: ["delegate_agent", "cron_create", "monitor"].includes(name) })
      if (!admission.ok) throw new Error(`Goal tool admission denied: ${admission.reason}`)
      if (name === "agent") {
        const spawn = ledger.admit(input.goalId, input.epoch, { operationId: randomUUID(), role: input.role, kind: "spawn" })
        if (!spawn.ok) throw new Error(`Goal spawn admission denied: ${spawn.reason}`)
      }
    },
    close: () => ledger.close(),
  }
}

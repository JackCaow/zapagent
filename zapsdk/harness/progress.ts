import type { RuntimeTimeBudget } from "../agent/events.js";
import type { HarnessBudgetConstraints } from "./policy.js";

export type BudgetDecisionAction = "continue" | "converge" | "finalize";
export type BudgetDecisionReasonCode =
  | "steady_progress"
  | "wall_clock_pressure"
  | "model_turn_budget_pressure"
  | "tool_call_budget_pressure"
  | "fresh_input_budget_pressure"
  | "stalled_progress"
  | "unverified_workspace_change";

export interface BudgetDecision {
  action: BudgetDecisionAction;
  reasonCode: BudgetDecisionReasonCode;
  remainingModelTurns: number;
  remainingToolCalls?: number;
  remainingFreshInputTokens?: number;
  /** Number of model turns held back for a focused end phase. */
  convergenceReserve: number;
}

export interface ProgressObservation {
  /** Main LoopAgent model calls already admitted by the shared AgentBudget. */
  modelTurns?: number;
  /**
   * Legacy tool-step count. V1 callers did not distinguish model calls from
   * tool rounds, so retain this field as the fallback observation.
   */
  steps: number;
  toolCalls: number;
  freshInputTokens: number;
  consecutiveNoProgress: number;
  workspaceChanged: boolean;
  timeBudget?: RuntimeTimeBudget;
}

export interface ProgressControllerOptions {
  maxSteps: number;
  /** V1 compatibility only. New V2 decisions derive their own reserve. */
  reserveSteps: number;
  constraints?: HarnessBudgetConstraints;
  /** True only when a V2 policy selected adaptive decisions. */
  adaptive?: boolean;
  timeoutMs?: number;
  forceFinishTimeoutMs: number;
  now?: () => number;
}

/**
 * Pure transient progress policy shared by every host. It deliberately has
 * no provider, tool, or conversation dependency; LoopAgent owns execution.
 *
 * V1 consumers can retain `stepWarning()`. V2 hosts call `decide()` with
 * runtime observations, so convergence follows real resource pressure and
 * observed work rather than a task-name-specific or fixed-step script.
 */
export class ProgressController {
  private finalizationLatencies: number[] = [];
  private roundDurations: number[] = [];

  resetRoundDurations(): void {
    this.roundDurations = [];
  }

  recordRoundDuration(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    this.roundDurations.push(elapsedMs);
    this.roundDurations = this.roundDurations.slice(-5);
  }

  constructor(private readonly options: ProgressControllerOptions) {}

  recordFinalizationLatency(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    this.finalizationLatencies.push(elapsedMs);
    this.finalizationLatencies = this.finalizationLatencies.slice(-8);
  }

  finalizationReserveMs(): number {
    const measured = this.finalizationLatencies.length > 0
      ? Math.ceil(Math.max(...this.finalizationLatencies) * 1.25
        + Math.min(250, this.options.forceFinishTimeoutMs * 0.25))
      : 0;
    return Math.max(this.options.forceFinishTimeoutMs, measured);
  }

  timeBudget(startedAt: number): RuntimeTimeBudget | undefined {
    const timeoutMs = this.options.constraints?.wallTimeMs ?? this.options.timeoutMs;
    if (timeoutMs === undefined) return undefined;
    const elapsedMs = Math.max(0, (this.options.now ?? Date.now)() - startedAt);
    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    const remainingPercent = timeoutMs === 0
      ? 0
      : Math.max(0, Math.min(100, Math.ceil((remainingMs / timeoutMs) * 100)));
    const finalizationReserveMs = Math.min(remainingMs, this.finalizationReserveMs());
    return {
      totalMs: timeoutMs,
      elapsedMs,
      remainingMs,
      remainingPercent,
      executionRemainingMs: remainingMs - finalizationReserveMs,
      finalizationReserveMs,
      ...(this.roundDurations.length > 0
        ? { recentRoundDurationsMs: [...this.roundDurations] } : {}),
      stage: remainingMs <= this.finalizationReserveMs()
        ? "finalize" : "execute",
    };
  }

  shouldReserveFinalization(startedAt: number): boolean {
    const budget = this.timeBudget(startedAt);
    return budget?.stage === "finalize";
  }

  decide(observation: ProgressObservation): BudgetDecision {
    const maxModelTurns = this.options.constraints?.modelTurns ?? this.options.maxSteps;
    const usedModelTurns = observation.modelTurns ?? observation.steps;
    const remainingModelTurns = Math.max(0, maxModelTurns - usedModelTurns);
    const remainingToolCalls = remaining(this.options.constraints?.toolCalls, observation.toolCalls);
    const remainingFreshInputTokens = remaining(
      this.options.constraints?.freshInputTokens,
      observation.freshInputTokens,
    );
    const convergenceReserve = this.convergenceReserve(observation, maxModelTurns);

    if (observation.timeBudget?.stage === "finalize") {
      return this.decision("finalize", "wall_clock_pressure", remainingModelTurns, remainingToolCalls, remainingFreshInputTokens, convergenceReserve);
    }
    // A one-turn conversational run must still be allowed to make its first
    // request. Reserve/convergence logic only applies after the run has made
    // an observable attempt or consumed a constrained resource.
    if (
      observation.steps === 0
      && observation.toolCalls === 0
      && observation.freshInputTokens === 0
      && !observation.workspaceChanged
    ) {
      return this.decision("continue", "steady_progress", remainingModelTurns, remainingToolCalls, remainingFreshInputTokens, convergenceReserve);
    }
    if (remainingModelTurns <= convergenceReserve) {
      return this.decision(
        observation.workspaceChanged ? "converge" : "finalize",
        observation.workspaceChanged ? "unverified_workspace_change" : "model_turn_budget_pressure",
        remainingModelTurns,
        remainingToolCalls,
        remainingFreshInputTokens,
        convergenceReserve,
      );
    }
    if (remainingToolCalls !== undefined && remainingToolCalls <= 1) {
      return this.decision("converge", "tool_call_budget_pressure", remainingModelTurns, remainingToolCalls, remainingFreshInputTokens, convergenceReserve);
    }
    if (remainingFreshInputTokens !== undefined && remainingFreshInputTokens <= this.freshInputReserve()) {
      return this.decision("converge", "fresh_input_budget_pressure", remainingModelTurns, remainingToolCalls, remainingFreshInputTokens, convergenceReserve);
    }
    if (observation.consecutiveNoProgress >= 3) {
      // Repeated observations do not establish that the task cannot progress.
      // Only real resource pressure may request convergence/finalization.
      return this.decision("continue", "stalled_progress", remainingModelTurns, remainingToolCalls, remainingFreshInputTokens, convergenceReserve);
    }
    return this.decision("continue", "steady_progress", remainingModelTurns, remainingToolCalls, remainingFreshInputTokens, convergenceReserve);
  }

  /** V1 helper retained for direct LoopAgent callers and extension authors. */
  stepWarning(steps: number): string | undefined {
    if (steps === 0) return undefined;
    const remaining = this.options.maxSteps - steps;
    const stepInfo = `[Step ${steps}/${this.options.maxSteps} · ${remaining} remaining]`;
    if (remaining === this.options.reserveSteps) {
      return `${stepInfo} Stop exploration now. Use the remaining steps to implement and verify the smallest user-requested deliverable. After a failed build or test, modify its inputs before retrying; do not replace implementation with a status summary.`;
    }
    if (remaining === this.options.reserveSteps + 1) {
      return `${stepInfo} Almost at the limit. Finish the concrete artifact and run its narrowest verification; defer further reconnaissance and explanation.`;
    }
    return undefined;
  }

  private convergenceReserve(observation: ProgressObservation, maxModelTurns: number): number {
    if (!this.options.adaptive) return this.options.reserveSteps;
    // One turn is always reserved for an end-state decision. A changed
    // workspace receives one additional turn to verify rather than producing
    // a status-only answer. Stalled work earns another convergence turn so a
    // model can summarize evidence or change strategy instead of blindly
    // consuming the final call. This is task-agnostic and bounded by the
    // configured run budget.
    const requested = 1
      + (observation.workspaceChanged ? 1 : 0)
      + (observation.consecutiveNoProgress > 0 ? 1 : 0);
    return Math.min(Math.max(1, maxModelTurns), requested);
  }

  private freshInputReserve(): number {
    const limit = this.options.constraints?.freshInputTokens;
    if (limit === undefined) return 0;
    return Math.min(8_192, Math.max(1_024, Math.ceil(limit * 0.1)));
  }

  private decision(
    action: BudgetDecisionAction,
    reasonCode: BudgetDecisionReasonCode,
    remainingModelTurns: number,
    remainingToolCalls: number | undefined,
    remainingFreshInputTokens: number | undefined,
    convergenceReserve: number,
  ): BudgetDecision {
    return {
      action,
      reasonCode,
      remainingModelTurns,
      ...(remainingToolCalls === undefined ? {} : { remainingToolCalls }),
      ...(remainingFreshInputTokens === undefined ? {} : { remainingFreshInputTokens }),
      convergenceReserve,
    };
  }
}

function remaining(limit: number | undefined, used: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, limit - used);
}

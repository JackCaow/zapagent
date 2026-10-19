/**
 * Shared budget for an agent tree — enforces tree-wide caps on LLM steps
 * and subagent spawns so parallel fan-out cannot burn unbounded cost.
 *
 * The root LoopAgent creates an `AgentBudget` (or accepts one via options)
 * and passes the SAME instance down to every subagent via the factory.
 * All increments are on the shared counters.
 */
export interface AgentBudgetOptions {
  /** Max LLM calls across the entire agent tree (root + all subagents). */
  maxSteps?: number;
  /** Max subagent spawns across the entire agent tree. */
  maxSpawns?: number;
  /** Max cumulative input+output tokens. 0 or omitted = unlimited. */
  maxTokens?: number;
}

export interface AgentBudgetSnapshot {
  stepsUsed: number;
  stepsRemaining: number;
  spawnsUsed: number;
  spawnsRemaining: number;
  tokensUsed: number;
  tokensRemaining: number; // Infinity if uncapped
}

export class AgentBudget {
  readonly maxSteps: number;
  readonly maxSpawns: number;
  readonly maxTokens: number; // 0 = unlimited
  private _stepsUsed = 0;
  private _spawnsUsed = 0;
  private _tokensUsed = 0;
  private requestLimit = Infinity;
  private toolLimit = Infinity;
  private freshLimit = Infinity;
  private toolsUsed = 0;
  private freshUsed = 0;
  private reservedInput = 0;
  private unknownUsage = false;

  /** Descendants may tighten shared limits, never reset or increase them. */
  constrain(limits: { modelTurns?: number; toolCalls?: number; freshInputTokens?: number }): void {
    if (limits.modelTurns !== undefined) this.requestLimit = Math.min(this.requestLimit, nonNegativeIntegerOrDefault(limits.modelTurns, Infinity));
    if (limits.toolCalls !== undefined) this.toolLimit = Math.min(this.toolLimit, nonNegativeIntegerOrDefault(limits.toolCalls, Infinity));
    if (limits.freshInputTokens !== undefined) this.freshLimit = Math.min(this.freshLimit, nonNegativeIntegerOrDefault(limits.freshInputTokens, Infinity));
  }

  useTool(): boolean {
    if (this.toolsUsed >= this.toolLimit) return false;
    this.toolsUsed++;
    return true;
  }

  get freshInputRemaining(): number { return Math.max(0, this.freshLimit - this.freshUsed - this.reservedInput); }
  get tokensUncertain(): boolean { return this.unknownUsage; }

  /** Reserve the uncached input estimate atomically across concurrent children.
   * Actual usage may exceed an estimate; settle it before another admission. */
  reserveRequest(inputEstimate: number): (() => void) | undefined {
    if (!this.canUseStep() || inputEstimate > this.freshInputRemaining) return undefined;
    this._stepsUsed++;
    this.reservedInput += inputEstimate;
    let released = false;
    return () => { if (!released) { released = true; this.reservedInput -= inputEstimate; } };
  }

  chargeFresh(tokens: number, incomplete: boolean): void {
    this.freshUsed += nonNegativeFinite(tokens);
    this.unknownUsage ||= incomplete;
  }

  constructor(opts: AgentBudgetOptions = {}) {
    this.maxSteps = nonNegativeIntegerOrDefault(opts.maxSteps, 200);
    this.maxSpawns = nonNegativeIntegerOrDefault(opts.maxSpawns, 10);
    this.maxTokens = nonNegativeIntegerOrDefault(opts.maxTokens, 0);
  }

  /** Whether another request can start using the currently reported usage. */
  canUseStep(): boolean {
    return this._stepsUsed < Math.min(this.maxSteps, this.requestLimit) && this.tokensRemaining > 0 && this.freshInputRemaining > 0
      && !(this.unknownUsage && (this.maxTokens > 0 || this.freshLimit < Infinity));
  }

  /** Admit one LLM step only while both shared step and token budgets remain. */
  useStep(): boolean {
    if (!this.canUseStep()) return false;
    this._stepsUsed++;
    return true;
  }

  /** Try to reserve one subagent spawn. Returns false if spawn budget is exhausted. */
  reserveSpawn(): boolean {
    if (this._spawnsUsed >= this.maxSpawns) return false;
    this._spawnsUsed++;
    return true;
  }

  /** Charge tokens. Returns false if this charge exceeds the token cap. */
  chargeTokens(inputTokens: number, outputTokens: number): boolean {
    this._tokensUsed += nonNegativeFinite(inputTokens) + nonNegativeFinite(outputTokens);
    if (this.maxTokens === 0) return true;
    return this._tokensUsed <= this.maxTokens;
  }

  get stepsUsed(): number { return this._stepsUsed; }
  get stepsRemaining(): number { return Math.max(0, Math.min(this.maxSteps, this.requestLimit) - this._stepsUsed); }
  get spawnsUsed(): number { return this._spawnsUsed; }
  get spawnsRemaining(): number { return Math.max(0, this.maxSpawns - this._spawnsUsed); }
  get tokensUsed(): number { return this._tokensUsed; }
  get tokensRemaining(): number {
    return this.maxTokens === 0 ? Infinity : Math.max(0, this.maxTokens - this._tokensUsed);
  }

  snapshot(): AgentBudgetSnapshot {
    return {
      stepsUsed: this._stepsUsed,
      stepsRemaining: this.stepsRemaining,
      spawnsUsed: this._spawnsUsed,
      spawnsRemaining: this.spawnsRemaining,
      tokensUsed: this._tokensUsed,
      tokensRemaining: this.tokensRemaining,
    };
  }
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nonNegativeIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

import { describe, expect, it } from "bun:test";
import { ProgressController } from "../../harness/progress.js";

describe("ProgressController", () => {
  it("separates usable execution time from the reserve at the unchanged deadline", () => {
    let now = 823_720;
    const controller = new ProgressController({ maxSteps: 80, reserveSteps: 2,
      timeoutMs: 840_000, forceFinishTimeoutMs: 15_000, now: () => now });
    expect(controller.timeBudget(0)).toMatchObject({
      remainingMs: 16_280, executionRemainingMs: 1_280, finalizationReserveMs: 15_000, stage: "execute",
    });
    expect(controller.shouldReserveFinalization(0)).toBe(false);
    now = 825_000;
    expect(controller.timeBudget(0)).toMatchObject({
      remainingMs: 15_000, executionRemainingMs: 0, finalizationReserveMs: 15_000, stage: "finalize",
    });
    expect(controller.shouldReserveFinalization(0)).toBe(true);
    now = 841_000;
    expect(controller.timeBudget(0)).toMatchObject({ remainingMs: 0, executionRemainingMs: 0, finalizationReserveMs: 0 });
  });

  it("reports bounded round observations without changing admission or finalization reserve", () => {
    const controller = new ProgressController({ maxSteps: 80, reserveSteps: 2,
      timeoutMs: 840_000, forceFinishTimeoutMs: 15_000, now: () => 700_000 });
    for (const duration of [1, 2, 3, 4, 5, 200_000, NaN, Infinity, -1, 0]) controller.recordRoundDuration(duration);
    const budget = controller.timeBudget(0)!;
    expect(budget.recentRoundDurationsMs).toEqual([2, 3, 4, 5, 200_000]);
    expect(budget.stage).toBe("execute");
    expect(controller.finalizationReserveMs()).toBe(15_000);
    expect(controller.shouldReserveFinalization(0)).toBe(false);
    budget.recentRoundDurationsMs!.push(999_999);
    expect(controller.timeBudget(0)?.recentRoundDurationsMs).toEqual([2, 3, 4, 5, 200_000]);
    controller.resetRoundDurations();
    expect(controller.timeBudget(0)?.recentRoundDurationsMs).toBeUndefined();
  });

  it("reserves finalization before the wall-clock deadline", () => {
    let now = 1_000;
    const controller = new ProgressController({
      maxSteps: 40, reserveSteps: 2, timeoutMs: 1_000, forceFinishTimeoutMs: 200, now: () => now,
    });
    expect(controller.timeBudget(1_000)).toMatchObject({ remainingMs: 1_000, stage: "execute" });
    now = 1_801;
    expect(controller.shouldReserveFinalization(1_000)).toBe(true);
    expect(controller.timeBudget(1_000)).toMatchObject({ remainingMs: 199, stage: "finalize" });
  });

  it("does not finalize long runs just because less than twenty percent remains", () => {
    const controller = new ProgressController({ maxSteps: 80, reserveSteps: 2,
      timeoutMs: 840_000, forceFinishTimeoutMs: 15_000, now: () => 700_000 });
    expect(controller.timeBudget(0)).toMatchObject({ remainingMs: 140_000, stage: "execute" });
    expect(controller.shouldReserveFinalization(0)).toBe(false);
  });

  it("uses the same absolute reserve for advice and admission even in short runs", () => {
    let now = 0;
    const controller = new ProgressController({ maxSteps: 10, reserveSteps: 2,
      timeoutMs: 1_000, forceFinishTimeoutMs: 400, now: () => now });
    now = 600;
    expect(controller.timeBudget(0)?.stage).toBe("finalize");
    expect(controller.shouldReserveFinalization(0)).toBe(true);
  });

  it("reserves observed final call latency with a bounded history and cancellation margin", () => {
    const controller = new ProgressController({ maxSteps: 10, reserveSteps: 2,
      timeoutMs: 100_000, forceFinishTimeoutMs: 1_000, now: () => 96_000 });
    controller.recordFinalizationLatency(3_000);
    expect(controller.finalizationReserveMs()).toBe(4_000);
    expect(controller.timeBudget(0)).toMatchObject({ executionRemainingMs: 0, finalizationReserveMs: 4_000 });
    expect(controller.shouldReserveFinalization(0)).toBe(true);
    for (let i = 0; i < 8; i++) controller.recordFinalizationLatency(100);
    expect(controller.finalizationReserveMs()).toBe(1_000);
    expect(controller.timeBudget(0)).toMatchObject({ executionRemainingMs: 3_000, finalizationReserveMs: 1_000 });
  });

  it("emits convergence prompts only at configured boundaries", () => {
    const controller = new ProgressController({ maxSteps: 10, reserveSteps: 2, forceFinishTimeoutMs: 1_000 });
    expect(controller.stepWarning(7)).toContain("Almost at the limit");
    expect(controller.stepWarning(8)).toContain("Stop exploration now");
    expect(controller.stepWarning(5)).toBeUndefined();
  });

  it("does not let cancellation margin consume an entire short run", () => {
    const controller = new ProgressController({ maxSteps: 5, reserveSteps: 2,
      timeoutMs: 60, forceFinishTimeoutMs: 10, now: () => 1 });
    controller.recordFinalizationLatency(1);
    expect(controller.finalizationReserveMs()).toBe(10);
    expect(controller.timeBudget(0)?.stage).toBe("execute");
  });

  it("uses observed workspace progress to reserve verification time adaptively", () => {
    const controller = new ProgressController({
      maxSteps: 10,
      reserveSteps: 2,
      adaptive: true,
      forceFinishTimeoutMs: 1_000,
    });

    expect(controller.decide({
      steps: 8,
      toolCalls: 3,
      freshInputTokens: 100,
      consecutiveNoProgress: 0,
      workspaceChanged: false,
    })).toMatchObject({ action: "continue", reasonCode: "steady_progress", convergenceReserve: 1 });

    expect(controller.decide({
      steps: 8,
      toolCalls: 3,
      freshInputTokens: 100,
      consecutiveNoProgress: 0,
      workspaceChanged: true,
    })).toMatchObject({
      action: "converge",
      reasonCode: "unverified_workspace_change",
      convergenceReserve: 2,
    });
  });

  it("uses actual model turns instead of tool-step count for V2 turn pressure", () => {
    const controller = new ProgressController({
      maxSteps: 20,
      reserveSteps: 2,
      adaptive: true,
      constraints: { modelTurns: 4 },
      forceFinishTimeoutMs: 1_000,
    });

    expect(controller.decide({
      modelTurns: 3,
      steps: 1,
      toolCalls: 1,
      freshInputTokens: 100,
      consecutiveNoProgress: 0,
      workspaceChanged: false,
    })).toMatchObject({
      action: "finalize",
      reasonCode: "model_turn_budget_pressure",
      remainingModelTurns: 1,
    });
  });

  it("explains tool, fresh-input, and stalled-progress pressure with stable reason codes", () => {
    const controller = new ProgressController({
      maxSteps: 20,
      reserveSteps: 2,
      adaptive: true,
      constraints: { toolCalls: 5, freshInputTokens: 10_000 },
      forceFinishTimeoutMs: 1_000,
    });
    const baseline = {
      steps: 5,
      freshInputTokens: 1_000,
      consecutiveNoProgress: 0,
      workspaceChanged: false,
    };

    expect(controller.decide({ ...baseline, toolCalls: 4 })).toMatchObject({
      action: "converge", reasonCode: "tool_call_budget_pressure", remainingToolCalls: 1,
    });
    expect(controller.decide({ ...baseline, toolCalls: 1, freshInputTokens: 9_100 })).toMatchObject({
      action: "converge", reasonCode: "fresh_input_budget_pressure", remainingFreshInputTokens: 900,
    });
    expect(controller.decide({ ...baseline, toolCalls: 1, consecutiveNoProgress: 3 })).toMatchObject({
      action: "continue", reasonCode: "stalled_progress",
    });
  });
});

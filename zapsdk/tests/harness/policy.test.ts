import { describe, expect, it } from "bun:test";
import {
  resolveHarnessPolicy,
} from "../../harness/policy.js";

describe("HarnessPolicy V2", () => {
  it("defaults new hosts to the V2 adaptive policy without fixed-step configuration", () => {
    const policy = resolveHarnessPolicy(undefined);

    expect(policy).toMatchObject({
      version: 2,
      autonomy: "interactive",
      task: { completion: { id: "delivery-response-v2", requirements: [{ kind: "final_response" }, { kind: "delivery" }] } },
      budgets: {},
      execution: { workspaceMode: "shared-read", checkpoint: "before-destructive" },
      observability: { level: "standard" },
      legacy: { sourceVersion: 2, reserveSteps: 2 },
    });
  });

  it("adapts V1 completion requirements and reserve steps without changing their meaning", () => {
    const policy = resolveHarnessPolicy({
      version: 1,
      reserveSteps: 4,
      completion: { id: "legacy-deliverable", requireSuccessfulToolCall: true },
    });

    expect(policy.version).toBe(2);
    expect(policy.task.completion).toMatchObject({
      id: "legacy-deliverable",
      requireSuccessfulToolCall: true,
    });
    expect(policy.legacy).toEqual({
      sourceVersion: 1,
      reserveSteps: 4,
    });
  });

  it("normalizes V2 resource constraints and keeps execution constraints declarative", () => {
    const policy = resolveHarnessPolicy({
      version: 2,
      autonomy: "supervised",
      task: { classHint: "migration" },
      budgets: {
        wallTimeMs: 12_000.9,
        modelTurns: 9.9,
        toolCalls: -1,
        freshInputTokens: Number.NaN,
        costUsd: 1.25,
      },
      execution: {
        allowedCapabilities: ["read", "write"],
        workspaceMode: "isolated-write",
        checkpoint: "before-write",
      },
      observability: { level: "debug" },
    });

    expect(policy).toMatchObject({
      autonomy: "supervised",
      task: { classHint: "migration" },
      budgets: { wallTimeMs: 12_000, modelTurns: 9, toolCalls: 0, costUsd: 1.25 },
      execution: {
        allowedCapabilities: ["read", "write"],
        workspaceMode: "isolated-write",
        checkpoint: "before-write",
      },
      observability: { level: "debug" },
      legacy: { sourceVersion: 2 },
    });
    expect(policy.budgets.freshInputTokens).toBeUndefined();
  });
});

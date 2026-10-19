import { describe, expect, it } from "bun:test";
import {
  assessCompletion,
  buildEvidenceLedger,
} from "../../harness/completion.js";
import type { LoopAgentResult } from "../../agent/loop.js";

function result(overrides: Partial<LoopAgentResult> = {}): LoopAgentResult {
  return {
    text: "done",
    steps: 1,
    toolResults: [],
    totalUsage: { inputTokens: 2, outputTokens: 1 },
    ...overrides,
  };
}

describe("completion harness", () => {
  it("accepts a natural response for conversational work", () => {
    const assessment = assessCompletion(result());

    expect(assessment.status).toBe("completed");
    expect(assessment.success).toBe(true);
    expect(assessment.modelClaimedSuccess).toBe(true);
    expect(assessment.evidenceState).toBe("verified");
    expect(assessment.ledger.version).toBe(2);
    expect(assessment.ledger.evidence.some((evidence) => (
      evidence.kind === "natural_finish"
      && evidence.satisfied
      && evidence.detail === "loop ended naturally"
    ))).toBe(true);
  });

  it("records a forced summary as incomplete instead of successful", () => {
    const assessment = assessCompletion(result({ stopped: "max_steps" }));

    expect(assessment.status).toBe("incomplete");
    expect(assessment.success).toBe(false);
    expect(assessment.reason).toContain("max_steps");
    expect(assessment.ledger.evidence.some((evidence) => (
      evidence.kind === "stop_reason"
      && !evidence.satisfied
      && evidence.detail === "max_steps"
    ))).toBe(true);
  });

  it("allows deliverable hosts to require successful tool evidence", () => {
    expect(assessCompletion(result(), { requireSuccessfulToolCall: true }).status).toBe("incomplete");
    expect(assessCompletion(result({
      toolResults: [{ success: true, output: "verified" }],
    }), { requireSuccessfulToolCall: true }).status).toBe("completed");
    expect(buildEvidenceLedger(result({
      toolResults: [{ success: false, output: "", error: "failed" }],
    })).failedToolCalls).toBe(1);
  });

  it("verifies a declared artifact from a tool write fingerprint", () => {
    const assessment = assessCompletion(result({
      toolResults: [{
        success: true,
        output: "written",
        runtime: {
          writeEvidence: {
            paths: [{
              path: "/workspace/report.txt",
              before: { exists: false },
              after: { exists: true, kind: "file", size: 7, sha256: "abc123" },
            }],
          },
        },
      }],
    }), {
      requirements: [{ kind: "artifact", path: "/workspace/report.txt", requireHash: true }],
    });

    expect(assessment.status).toBe("completed");
    expect(assessment.evidenceState).toBe("verified");
    expect(assessment.ledger.evidence.some((evidence) => (
      evidence.kind === "artifact"
      && evidence.path === "/workspace/report.txt"
      && evidence.sha256 === "abc123"
      && evidence.satisfied
    ))).toBe(true);
  });

  it("separates a model completion claim from missing host validation", () => {
    const assessment = assessCompletion(result(), {
      requirements: [
        { id: "test", kind: "command", commandRef: "test", exitCode: 0 },
        { id: "merge", kind: "merge" },
      ],
    }, {
      commands: [{ commandRef: "test", exitCode: 0 }],
      merges: [{ success: false, detail: "conflict" }],
    });

    expect(assessment.modelClaimedSuccess).toBe(true);
    expect(assessment.status).toBe("incomplete");
    expect(assessment.success).toBe(false);
    expect(assessment.evidenceState).toBe("partial");
    expect(assessment.reason).toContain("merge");
  });

  it("reports approval wait and cancellation as actionable evidence states", () => {
    const pending = assessCompletion(result(), {
      requirements: [{ kind: "approval", capability: "network" }],
    }, {
      approvals: [{ capability: "network", status: "pending" }],
    });
    const cancelled = assessCompletion(result(), {
      requirements: [{ kind: "approval", capability: "network" }],
    }, {
      approvals: [{ capability: "network", status: "cancelled" }],
    });

    expect(pending.status).toBe("incomplete");
    expect(pending.evidenceState).toBe("blocked");
    expect(cancelled.status).toBe("incomplete");
    expect(cancelled.evidenceState).toBe("cancelled");
  });

  it("keeps host artifact provenance instead of relabeling it as a tool result", () => {
    const ledger = buildEvidenceLedger(result(), undefined, {
      artifacts: [{ path: "/tmp/result.txt", exists: true, sha256: "host-hash", source: "verifier" }],
    });

    expect(ledger.evidence.some((evidence) => (
      evidence.kind === "artifact"
      && evidence.path === "/tmp/result.txt"
      && evidence.source === "verifier"
    ))).toBe(true);
  });
});


describe("completion evidence freshness", () => {
  const path = "/workspace/output";
  const write = (exists: boolean, sha256?: string) => ({ success: true, output: "write", runtime: {
    writeEvidence: { paths: [{ path, before: { exists: false }, after: { exists, sha256 } }] },
  } });
  const artifactContract = { requirements: [{ kind: "artifact" as const, path, requireHash: true }] };

  it("invalidates a created artifact after deletion", () => {
    expect(assessCompletion(result({ toolResults: [write(true, "v1"), write(false)] }), artifactContract).success).toBe(false);
  });

  it("uses the latest hash and does not inherit an older hash", () => {
    const updated = assessCompletion(result({ toolResults: [write(true, "v1"), write(true, "v2")] }), artifactContract);
    expect(updated.ledger.evidence.find(item => item.kind === "artifact")?.sha256).toBe("v2");
    expect(assessCompletion(result({ toolResults: [write(true, "v1"), write(true)] }), artifactContract).success).toBe(false);
  });

  it("treats a host's current missing snapshot as authoritative over old writes", () => {
    expect(assessCompletion(result({ toolResults: [write(true, "v1")] }), artifactContract,
      { artifacts: [{ path, exists: false }] }).success).toBe(false);
  });

  it("uses the latest command result rather than an earlier passing run", () => {
    expect(assessCompletion(result(), { requirements: [{ kind: "command", commandRef: "build" }] }, {
      commands: [{ commandRef: "build", exitCode: 0 }, { commandRef: "build", exitCode: 1 }],
    }).success).toBe(false);
  });

  it("invalidates a passing check after its input changes or disappears", () => {
    const contract = { requirements: [{ kind: "command" as const, commandRef: "test" }] };
    const commands = [{ commandRef: "test", exitCode: 0, artifacts: [{ path, exists: true, sha256: "v1" }] }];
    expect(assessCompletion(result({ toolResults: [write(true, "v1")] }), contract, { commands }).success).toBe(true);
    for (const toolResults of [[write(true, "v1"), write(true, "v2")], [write(true, "v1"), write(false)]]) {
      const assessment = assessCompletion(result({ toolResults }), contract, { commands });
      expect(assessment.success).toBe(false);
      expect(assessment.reason).toContain("command");
    }
  });
});


it("does not treat an unversioned existing input as proof that a check is current", () => {
  const path = "/workspace/source";
  expect(assessCompletion(result(), { requirements: [{ kind: "command", commandRef: "test" }] }, {
    commands: [{ commandRef: "test", exitCode: 0, artifacts: [{ path, exists: true }] }],
    artifacts: [{ path, exists: true, sha256: "current" }],
  }).success).toBe(false);
});

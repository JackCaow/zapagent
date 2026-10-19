import type { LoopAgentResult } from "../agent/loop.js";

/**
 * A normalized observation retained with a terminal run. It deliberately
 * contains references, paths and hashes rather than model-visible tool bodies
 * so hosts can persist it without expanding future model context.
 */
export type CompletionEvidenceSource = "runtime" | "tool" | "host" | "verifier" | "user";

export interface CompletionEvidence {
  kind: "final_response" | "natural_finish" | "tool_result" | "stop_reason" | "artifact" | "command" | "approval" | "merge" | "infrastructure" | "delivery";
  satisfied: boolean;
  detail: string;
  source?: CompletionEvidenceSource;
  requirementId?: string;
  path?: string;
  sha256?: string;
}

export type EvidenceState = "verified" | "partial" | "missing" | "blocked" | "cancelled";
export type InfrastructureOutcome = "not_observed" | "available" | "failed";

export interface CompletionArtifactEvidence {
  path: string;
  exists: boolean;
  sha256?: string;
  detail?: string;
  source?: CompletionEvidenceSource;
}

export interface CompletionCommandEvidence {
  /** Host-authored stable command reference, not model-supplied shell text. */
  commandRef: string;
  /** Optional input versions captured when the command ran. A later mutation
   * invalidates this check; unrelated files need not be included. */
  artifacts?: readonly CompletionArtifactEvidence[];
  exitCode?: number;
  detail?: string;
  source?: CompletionEvidenceSource;
}

export interface CompletionApprovalEvidence {
  capability: string;
  status: "approved" | "pending" | "denied" | "cancelled" | "failed";
  detail?: string;
  source?: CompletionEvidenceSource;
}

export interface CompletionMergeEvidence {
  mergeId?: string;
  success: boolean;
  detail?: string;
  source?: CompletionEvidenceSource;
}

/** Infrastructure observations are independent from task evidence. A provider
 * bridge failure must be visible to hosts, but a conversational turn without
 * an external requirement need not be retroactively reclassified as a model
 * failure. */
export interface CompletionInfrastructureEvidence {
  source: string;
  status: "available" | "failed";
  detail: string;
}

/** Additional host/runtime observations. Tool results are always collected
 * automatically; this input gives the Broker, StateStore and verifier bridge a
 * common way to add command, approval and merge evidence without teaching the
 * model about any of them. */
export interface CompletionEvidenceInput {
  /** Runtime observation of current-turn effects, never model prose. */
  delivery?: { mutated: boolean; observed: boolean; detail: string; blocked?: boolean };
  /** Host-authored acceptance result for mutations whose correctness requires a verifier. */
  verification?: { satisfied: boolean; detail: string; source: "verifier" | "user" };
  artifacts?: readonly CompletionArtifactEvidence[];
  commands?: readonly CompletionCommandEvidence[];
  approvals?: readonly CompletionApprovalEvidence[];
  merges?: readonly CompletionMergeEvidence[];
  infrastructure?: readonly CompletionInfrastructureEvidence[];
}

export type CompletionRequirement =
  | { id?: string; kind: "delivery" }
  | { id?: string; kind: "final_response" }
  | { id?: string; kind: "successful_tool_call"; minCount?: number }
  | { id?: string; kind: "artifact"; path?: string; requireHash?: boolean }
  | { id?: string; kind: "command"; commandRef: string; exitCode?: number }
  | { id?: string; kind: "approval"; capability: string }
  | { id?: string; kind: "merge" };

export interface CompletionRequirementAssessment {
  id: string;
  kind: CompletionRequirement["kind"];
  satisfied: boolean;
  detail: string;
}

export interface EvidenceLedger {
  version: 2;
  evidence: CompletionEvidence[];
  successfulToolCalls: number;
  failedToolCalls: number;
  requirements: CompletionRequirementAssessment[];
}

/**
 * A host may opt into stronger completion requirements for work that has an
 * observable deliverable. The legacy tool-call flag remains valid so existing
 * hosts keep their behavior while migrating to explicit requirements.
 */
export interface CompletionContract {
  id?: string;
  /** @deprecated Prefer requirements: [{ kind: "successful_tool_call" }]. */
  requireSuccessfulToolCall?: boolean;
  requirements?: readonly CompletionRequirement[];
}

export interface CompletionAssessment {
  status: "completed" | "incomplete";
  /** Compatibility boolean: true only when the CompletionContract is verified. */
  success: boolean;
  /** A natural non-empty model response, independent from delivery evidence. */
  modelClaimedSuccess: boolean;
  evidenceState: EvidenceState;
  infrastructureOutcome: InfrastructureOutcome;
  reason?: string;
  ledger: EvidenceLedger;
}

export interface CompletionEvidenceProviderContext {
  signal?: AbortSignal;
  result: LoopAgentResult;
  threadId: string;
  turnId: string;
  runId: string;
  contract: CompletionContract;
}

export type CompletionEvidenceProvider = (
  context: CompletionEvidenceProviderContext,
) => CompletionEvidenceInput | Promise<CompletionEvidenceInput | undefined> | undefined;

export const DEFAULT_COMPLETION_CONTRACT: Readonly<CompletionContract> = Object.freeze({
  id: "natural-response-v1",
});

function requirementId(requirement: CompletionRequirement, index: number): string {
  return requirement.id ?? `${requirement.kind}-${index + 1}`;
}

function contractRequirements(contract: CompletionContract): CompletionRequirement[] {
  const requirements = [...(contract.requirements ?? [])];
  if (contract.requireSuccessfulToolCall && !requirements.some((item) => item.kind === "successful_tool_call")) {
    requirements.push({ id: "legacy-successful-tool-call", kind: "successful_tool_call" });
  }
  return requirements;
}

function toolArtifactEvidence(result: LoopAgentResult): CompletionArtifactEvidence[] {
  return result.toolResults.flatMap((toolResult) => toolResult.runtime?.writeEvidence?.paths.map((path) => ({
    path: path.path,
    exists: path.after.exists,
    sha256: path.after.sha256,
    detail: path.after.exists
      ? "tool write fingerprint observed"
      : "tool write fingerprint reports no resulting path",
    source: "tool",
  })) ?? []);
}

function observedArtifacts(
  result: LoopAgentResult,
  input: CompletionEvidenceInput,
): CompletionArtifactEvidence[] {
  const observations = [...toolArtifactEvidence(result), ...(input.artifacts ?? [])];
  const deduplicated = new Map<string, CompletionArtifactEvidence>();
  for (const observation of observations) {
    // Observations are chronological; host observations are the current snapshot.
    deduplicated.set(observation.path, observation);
  }
  return [...deduplicated.values()];
}

function commandEvidenceCurrent(
  command: CompletionCommandEvidence,
  artifacts: readonly CompletionArtifactEvidence[],
): boolean {
  return (command.artifacts ?? []).every((expected) => {
    const current = artifacts.find((item) => item.path === expected.path);
    if (expected.exists && !expected.sha256) return false;
    return Boolean(current && current.exists === expected.exists
      && (expected.sha256 === undefined || current.sha256 === expected.sha256));
  });
}

function assessRequirement(
  requirement: CompletionRequirement,
  id: string,
  result: LoopAgentResult,
  input: CompletionEvidenceInput,
  artifacts: readonly CompletionArtifactEvidence[],
): CompletionRequirementAssessment {
  switch (requirement.kind) {
    case "delivery": {
      const delivery = input.delivery;
      const verified = input.verification?.satisfied === true;
      const satisfied = Boolean(delivery && !delivery.blocked && (!delivery.mutated || verified));
      return {
        id, kind: requirement.kind, satisfied,
        detail: !delivery ? "runtime delivery evidence is missing"
          : delivery.blocked ? delivery.detail
          : !delivery.mutated ? delivery.detail
          : verified ? input.verification!.detail
          : "mutation requires host-authored acceptance evidence; a final response is insufficient",
      };
    }
    case "final_response": {
      const satisfied = result.text.trim().length > 0;
      return {
        id,
        kind: requirement.kind,
        satisfied,
        detail: satisfied ? "assistant returned final text" : "assistant returned no final text",
      };
    }
    case "successful_tool_call": {
      const minCount = requirement.minCount ?? 1;
      const successfulCalls = result.toolResults.filter((item) => item.success).length;
      return {
        id,
        kind: requirement.kind,
        satisfied: successfulCalls >= minCount,
        detail: `${successfulCalls}/${minCount} successful tool call${minCount === 1 ? "" : "s"} observed`,
      };
    }
    case "artifact": {
      const candidates = artifacts.filter((item) => item.exists && (!requirement.path || item.path === requirement.path));
      const satisfied = candidates.some((item) => !requirement.requireHash || Boolean(item.sha256));
      return {
        id,
        kind: requirement.kind,
        satisfied,
        detail: satisfied
          ? `artifact evidence observed${requirement.path ? ` for ${requirement.path}` : ""}`
          : `missing artifact evidence${requirement.path ? ` for ${requirement.path}` : ""}`,
      };
    }
    case "command": {
      const command = (input.commands ?? []).findLast((item) => item.commandRef === requirement.commandRef);
      const expectedExitCode = requirement.exitCode ?? 0;
      const satisfied = command?.exitCode === expectedExitCode && commandEvidenceCurrent(command, artifacts);
      return {
        id,
        kind: requirement.kind,
        satisfied,
        detail: satisfied
          ? `command ${requirement.commandRef} exited ${expectedExitCode}`
          : command
            ? `command ${requirement.commandRef} exited ${command.exitCode ?? "unknown"}; expected ${expectedExitCode}${commandEvidenceCurrent(command, artifacts) ? "" : "; input artifacts changed or are unobserved"}`
            : `missing command evidence for ${requirement.commandRef}`,
      };
    }
    case "approval": {
      const approval = (input.approvals ?? []).find((item) => item.capability === requirement.capability);
      return {
        id,
        kind: requirement.kind,
        satisfied: approval?.status === "approved",
        detail: approval
          ? `approval for ${requirement.capability} is ${approval.status}`
          : `missing approval evidence for ${requirement.capability}`,
      };
    }
    case "merge": {
      const merge = (input.merges ?? []).find((item) => item.success);
      return {
        id,
        kind: requirement.kind,
        satisfied: Boolean(merge),
        detail: merge ? "successful workspace merge observed" : "missing successful workspace merge evidence",
      };
    }
  }
}

function evidenceStateFor(input: {
  modelClaimedSuccess: boolean;
  stopped: boolean;
  requirements: readonly CompletionRequirementAssessment[];
  evidence: readonly CompletionEvidence[];
  approvals: readonly CompletionApprovalEvidence[];
}): EvidenceState {
  if (input.approvals.some((item) => item.status === "cancelled")) return "cancelled";
  if (input.approvals.some((item) => (
    item.status === "pending" || item.status === "denied" || item.status === "failed"
  ))) return "blocked";
  if (input.stopped) return input.evidence.some((item) => item.satisfied) ? "partial" : "missing";
  if (!input.modelClaimedSuccess) return input.evidence.some((item) => item.satisfied) ? "partial" : "missing";
  if (input.requirements.every((item) => item.satisfied)) return "verified";
  if (input.requirements.some((item) => item.satisfied)) return "partial";
  return "missing";
}

function infrastructureOutcomeFor(input: CompletionEvidenceInput): InfrastructureOutcome {
  const observations = input.infrastructure ?? [];
  if (observations.some((item) => item.status === "failed")) return "failed";
  return observations.length > 0 ? "available" : "not_observed";
}

export function buildEvidenceLedger(
  result: LoopAgentResult,
  contract: CompletionContract = DEFAULT_COMPLETION_CONTRACT,
  input: CompletionEvidenceInput = {},
): EvidenceLedger {
  const successfulToolCalls = result.toolResults.filter((item) => item.success).length;
  const failedToolCalls = result.toolResults.length - successfulToolCalls;
  const artifacts = observedArtifacts(result, input);
  const evidence: CompletionEvidence[] = [
    {
      kind: "final_response",
      satisfied: result.text.trim().length > 0,
      detail: result.text.trim().length > 0 ? "assistant returned final text" : "assistant returned no final text",
      source: "runtime",
    },
    {
      kind: "natural_finish",
      satisfied: result.stopped === undefined,
      detail: result.stopped === undefined
        ? "loop ended naturally"
        : `loop stopped because ${result.stopped}`,
      source: "runtime",
    },
    ...result.toolResults.map((item) => ({
      kind: "tool_result" as const,
      satisfied: item.success,
      detail: item.success ? "tool call succeeded" : item.error ?? "tool call failed",
      source: "tool" as const,
    })),
    ...artifacts.map((item) => ({
      kind: "artifact" as const,
      satisfied: item.exists,
      detail: item.detail ?? (item.exists ? "artifact observed" : "artifact missing"),
      source: item.source ?? "host",
      path: item.path,
      sha256: item.sha256,
    })),
    ...(input.commands ?? []).map((item) => ({
      kind: "command" as const,
      satisfied: item.exitCode === 0 && commandEvidenceCurrent(item, artifacts),
      detail: item.detail ?? `command ${item.commandRef} exited ${item.exitCode ?? "unknown"}`,
      source: item.source ?? "host",
    })),
    ...(input.approvals ?? []).map((item) => ({
      kind: "approval" as const,
      satisfied: item.status === "approved",
      detail: item.detail ?? `approval for ${item.capability} is ${item.status}`,
      source: item.source ?? "host",
    })),
    ...(input.merges ?? []).map((item) => ({
      kind: "merge" as const,
      satisfied: item.success,
      detail: item.detail ?? (item.success ? "workspace merge succeeded" : "workspace merge failed"),
      source: item.source ?? "host",
    })),
    ...(input.infrastructure ?? []).map((item) => ({
      kind: "infrastructure" as const,
      satisfied: item.status === "available",
      detail: item.detail,
      source: "host" as const,
    })),
  ];
  if (result.stopped !== undefined) {
    evidence.push({
      kind: "stop_reason",
      satisfied: false,
      detail: result.stopped,
      source: "runtime",
    });
  }
  const requirements = contractRequirements(contract).map((requirement, index) => (
    assessRequirement(requirement, requirementId(requirement, index), result, input, artifacts)
  ));
  for (const requirement of requirements) {
    evidence.push({
      kind: requirement.kind === "successful_tool_call" ? "tool_result" : requirement.kind,
      satisfied: requirement.satisfied,
      detail: requirement.detail,
      source: "runtime",
      requirementId: requirement.id,
    });
  }
  return { version: 2, evidence, successfulToolCalls, failedToolCalls, requirements };
}

export function assessCompletion(
  result: LoopAgentResult,
  contract: CompletionContract = DEFAULT_COMPLETION_CONTRACT,
  input: CompletionEvidenceInput = {},
): CompletionAssessment {
  const ledger = buildEvidenceLedger(result, contract, input);
  const modelClaimedSuccess = result.stopped === undefined && result.text.trim().length > 0;
  const evidenceState = evidenceStateFor({
    modelClaimedSuccess,
    stopped: result.stopped !== undefined,
    requirements: ledger.requirements,
    evidence: ledger.evidence,
    approvals: input.approvals ?? [],
  });
  const infrastructureOutcome = infrastructureOutcomeFor(input);
  if (result.stopped !== undefined) {
    return {
      status: "incomplete",
      success: false,
      modelClaimedSuccess,
      evidenceState,
      infrastructureOutcome,
      reason: `run stopped before natural completion: ${result.stopped}`,
      ledger,
    };
  }
  if (!result.text.trim()) {
    return {
      status: "incomplete",
      success: false,
      modelClaimedSuccess,
      evidenceState,
      infrastructureOutcome,
      reason: "run ended without a final response",
      ledger,
    };
  }
  const missing = ledger.requirements.filter((item) => !item.satisfied);
  if (missing.length > 0) {
    return {
      status: "incomplete",
      success: false,
      modelClaimedSuccess,
      evidenceState,
      infrastructureOutcome,
      reason: `completion contract missing: ${missing.map((item) => item.id).join(", ")}`,
      ledger,
    };
  }
  return {
    status: "completed",
    success: true,
    modelClaimedSuccess,
    evidenceState,
    infrastructureOutcome,
    ledger,
  };
}

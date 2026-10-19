import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ToolResourceLimits } from "../tools/effects.js";
import type { ExecutionBrokerRequest, SandboxMode, SandboxStatus } from "./types.js";
import type {
  BackendCapabilities, EnforcementReceipt, ExecutionObservation, ExecutionOperation,
  ResolvedExecutionPlan,
} from "./contracts.js";

export function executionDigest(value: unknown): string {
  // Operation arguments are not JSON Schemas: even arrays named `enum` or
  // `required` retain their order and must yield different request digests.
  return createHash("sha256").update(JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
  })).digest("hex");
}

export interface ExecutionObservationProgress {
  grantChecked?: boolean;
  inputChecked?: boolean;
  outputChecked?: boolean;
  deadlineInstalled?: boolean;
  spawnedProcesses?: number;
  sandboxedProcesses?: number;
  sandboxUsed?: boolean;
  metersUsed?: boolean;
}

/** A status-only legacy projection. Unknown backend generation and unbound
 * approval are explicit: this must never be used to authorize an operation. */
export function observeLegacyExecution(
  request: ExecutionBrokerRequest,
  status: SandboxStatus | undefined,
  sandboxMode: SandboxMode,
  limits?: Readonly<ToolResourceLimits>,
): (outcome: EnforcementReceipt["outcome"], progress?: ExecutionObservationProgress) => ExecutionObservation {
  const backendId = request.effects.process.length > 0 ? status?.provider ?? "unresolved" : "host-adapter";
  const facts = {
    version: 2 as const, backendId, provider: status?.provider ?? null,
    source: status ? "status-only" as const : "unavailable" as const, available: status?.available ?? null, sandboxMode,
    generation: null, runtimeRevision: null, imageRevision: null,
    fineNetwork: "unknown" as const, ownerDeath: "unknown" as const,
    serviceLease: "unknown" as const, credentialRecipient: "unknown" as const,
  };
  const capabilities: BackendCapabilities = {
    ...facts, revision: executionDigest(facts), observedAt: Date.now(),
  };
  const context = request.context;
  const operation: ExecutionOperation = {
    version: 2, kind: "legacy-tool", operationId: request.executionId, toolName: request.name,
    argumentsDigest: executionDigest(request.args),
    identity: {
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context?.agentRun?.runId ? { runId: context.agentRun.runId } : {}),
      ...(context?.step !== undefined ? { step: context.step } : {}),
    },
    workspaceRef: {
      kind: "workspace", id: request.workspace.id || `workspace:${executionDigest(resolve(request.workspace.root))}`,
      revision: null,
    },
  };
  const planFields = {
    version: 2 as const, operationId: request.executionId,
    authorizationBinding: "legacy-unbound" as const,
    requestDigest: executionDigest(operation), effectsDigest: executionDigest(request.effects),
    grantDigest: executionDigest(request.grant), constraintsDigest: executionDigest(limits ?? null),
    backendId, capabilityRevision: capabilities.revision,
  };
  const plan: ResolvedExecutionPlan = { ...planFields, executionPlanDigest: executionDigest(planFields) };
  return (outcome, progress = {}) => {
    const checked = (dimension: EnforcementReceipt["constraints"][number]["dimension"], yes?: boolean) => ({
      dimension, status: yes ? "enforced" as const : "not-enforced" as const,
      level: yes ? "adapter" as const : "none" as const,
    });
    return {
      version: 2, operation, capabilities, plan,
      receipt: {
        version: 2, operationId: operation.operationId, executionPlanDigest: plan.executionPlanDigest,
        capabilityRevision: capabilities.revision, observedAt: Date.now(), outcome,
        spawnedProcesses: progress.spawnedProcesses ?? 0,
        sandboxedProcesses: progress.sandboxedProcesses ?? 0,
        constraints: [
          checked("grant-coverage", progress.grantChecked), checked("input-bytes", progress.inputChecked),
          checked("output-bytes", progress.outputChecked), checked("await-deadline", progress.deadlineInstalled),
          { dimension: "process-launcher", status: progress.spawnedProcesses ? "observed" : "not-enforced",
            level: progress.spawnedProcesses ? "adapter" : "none" },
          { dimension: "process-sandbox", status: progress.sandboxUsed ? "observed" : "not-enforced",
            level: progress.sandboxUsed ? "adapter" : "none" },
          { dimension: "resource-meters", status: progress.metersUsed ? "observed" : "not-enforced",
            level: progress.metersUsed ? "cooperative" : "none" },
          ...(["network-destinations", "network-methods", "owner-death", "credential-recipient"] as const)
            .map((dimension) => ({ dimension, status: "unknown" as const, level: "none" as const })),
        ],
      },
    };
  };
}

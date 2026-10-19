import { z } from "zod";

export const EXECUTION_CONTRACT_VERSION = 2 as const;
const version = z.literal(EXECUTION_CONTRACT_VERSION);
const identifier = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative();

export const OperationFailureSchema = z.object({
  version,
  code: z.enum([
    "POLICY_DENIED", "APPROVAL_REQUIRED", "SANDBOX_DENIED",
    "CAPABILITY_UNSUPPORTED", "BACKEND_UNAVAILABLE", "DEPENDENCY_MISSING",
    "AUTH_REQUIRED", "DNS_FAILED", "CONNECT_FAILED", "HTTP_REJECTED",
    "RESOURCE_LIMIT", "DEADLINE_EXCEEDED", "SERVICE_NOT_READY", "SERVICE_EXITED",
    "BROWSER_UNAVAILABLE", "EXECUTION_FAILED", "CANCELLED", "INVALID_ARGUMENTS",
    "TOOL_NOT_FOUND", "CHECKPOINT_REQUIRED", "TASK_PLAN_REQUIRED",
  ]),
  source: z.enum(["policy", "approval", "broker", "executor", "checkpoint", "backend", "harness", "unknown"]),
  retryable: z.boolean(),
  evidenceRef: identifier.optional(),
  missingCapabilities: z.array(identifier),
  safeAlternatives: z.array(identifier),
  partialResources: z.array(z.object({
    id: identifier,
    kind: z.enum(["workspace", "process", "service", "artifact", "preview"]),
    revision: z.number().int().nonnegative().nullable(),
  }).strict()),
}).strict();

export type OperationFailure = z.infer<typeof OperationFailureSchema>;
export type OperationFailureCode = OperationFailure["code"];

/** The legacy ToolEffects bridge describes a compound tool operation. It is
 * not a new executable capability API; P0.2 will introduce bound preparation. */
export const ExecutionOperationSchema = z.object({
  version,
  kind: z.literal("legacy-tool"),
  operationId: identifier,
  toolName: identifier,
  argumentsDigest: digest,
  identity: z.object({
    sessionId: identifier.optional(),
    toolCallId: identifier.optional(),
    runId: identifier.optional(),
    step: z.number().int().nonnegative().optional(),
  }).strict(),
  workspaceRef: z.object({
    id: identifier,
    kind: z.literal("workspace"),
    // Legacy workspaces have no authoritative resource revision.
    revision: z.null(),
  }).strict(),
}).strict();
export type ExecutionOperation = z.infer<typeof ExecutionOperationSchema>;

export const BackendCapabilitiesSchema = z.object({
  version,
  backendId: identifier,
  provider: z.enum(["macos-seatbelt", "linux-bwrap", "windows-appcontainer", "zapvm", "none"]).nullable(),
  revision: digest,
  observedAt: timestamp,
  source: z.enum(["status-only", "unavailable"]),
  available: z.boolean().nullable(),
  sandboxMode: z.enum(["disabled", "best-effort", "required"]),
  generation: z.null(),
  runtimeRevision: z.null(),
  imageRevision: z.null(),
  // status() does not prove these finer-grained capabilities are available.
  fineNetwork: z.literal("unknown"),
  ownerDeath: z.literal("unknown"),
  serviceLease: z.literal("unknown"),
  credentialRecipient: z.literal("unknown"),
}).strict().superRefine((value, context) => {
  const missing = value.provider === null || value.available === null;
  if ((value.source === "status-only" && missing)
    || (value.source === "unavailable" && (value.provider !== null || value.available !== null))) {
    context.addIssue({ code: "custom", message: "capability observation source mismatch" });
  }
});
export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

export const ResolvedExecutionPlanSchema = z.object({
  version,
  operationId: identifier,
  authorizationBinding: z.literal("legacy-unbound"),
  requestDigest: digest,
  effectsDigest: digest,
  grantDigest: digest,
  constraintsDigest: digest,
  backendId: identifier,
  capabilityRevision: digest,
  executionPlanDigest: digest,
}).strict();
export type ResolvedExecutionPlan = z.infer<typeof ResolvedExecutionPlanSchema>;

export const EnforcementReceiptSchema = z.object({
  version,
  operationId: identifier,
  executionPlanDigest: digest,
  capabilityRevision: digest,
  observedAt: timestamp,
  outcome: z.enum(["succeeded", "failed", "rejected"]),
  constraints: z.array(z.object({
    dimension: z.enum([
      "grant-coverage", "input-bytes", "output-bytes", "await-deadline",
      "process-launcher", "process-sandbox", "resource-meters",
      "network-destinations", "network-methods", "owner-death", "credential-recipient",
    ]),
    status: z.enum(["enforced", "observed", "not-enforced", "unknown"]),
    level: z.enum(["kernel", "proxy", "adapter", "cooperative", "none"]),
  }).strict()),
  spawnedProcesses: z.number().int().nonnegative(),
  sandboxedProcesses: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.sandboxedProcesses > value.spawnedProcesses) {
    context.addIssue({ code: "custom", message: "sandboxed process count exceeds launched count" });
  }
});
export type EnforcementReceipt = z.infer<typeof EnforcementReceiptSchema>;

export const ExecutionObservationSchema = z.object({
  version,
  operation: ExecutionOperationSchema,
  capabilities: BackendCapabilitiesSchema,
  plan: ResolvedExecutionPlanSchema,
  receipt: EnforcementReceiptSchema,
}).strict().superRefine((value, context) => {
  const { operation, capabilities, plan, receipt } = value;
  if (operation.operationId !== plan.operationId || operation.operationId !== receipt.operationId
    || plan.backendId !== capabilities.backendId || plan.capabilityRevision !== capabilities.revision
    || receipt.capabilityRevision !== capabilities.revision
    || receipt.executionPlanDigest !== plan.executionPlanDigest) {
    context.addIssue({ code: "custom", message: "execution observation binding mismatch" });
  }
});
export type ExecutionObservation = z.infer<typeof ExecutionObservationSchema>;

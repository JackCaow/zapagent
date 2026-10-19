import { ServiceReceiptSchema, ServiceOperationObservationSchema, ServiceModelReceiptSchema, ServiceModelOperationSchema } from "../services/contracts.js";
import type { ExecutionObservation } from "../core/types.js";
import type { OperationFailure, OperationFailureCode } from "./contracts.js";
import { OperationFailureSchema } from "./contracts.js";
import type { ToolResult } from "../tools/types.js";

export function operationFailure(
  code: OperationFailureCode,
  source: OperationFailure["source"],
  evidenceRef?: string,
): OperationFailure {
  return {
    version: 2, code, source, retryable: false,
    ...(evidenceRef ? { evidenceRef } : {}),
    missingCapabilities: [], safeAlternatives: [], partialResources: [],
  };
}

/** Only explicit boundary evidence classifies a failure. Legacy output strings
 * (including "sandbox denied") are never used as an authority signal. */
export class ExecutionBoundaryError extends Error {
  constructor(message: string, readonly failure: OperationFailure) {
    super(message);
    this.name = "ExecutionBoundaryError";
  }
}

export function executionFailureResult(error: unknown, evidenceRef?: string): ToolResult {
  return normalizeToolFailure({
    success: false,
    output: "",
    error: error instanceof Error ? error.message : String(error),
    failure: error instanceof ExecutionBoundaryError
      ? { ...error.failure, ...(evidenceRef ? { evidenceRef } : {}) }
      : operationFailure("EXECUTION_FAILED", "unknown", evidenceRef),
  }, evidenceRef);
}

export function normalizeToolFailure(result: ToolResult, evidenceRef?: string): ToolResult {
  if (result.success) return result;
  const failure = OperationFailureSchema.safeParse(result.failure);
  return { ...result, failure: failure.success
    ? { ...failure.data, ...(!failure.data.evidenceRef && evidenceRef ? { evidenceRef } : {}) }
    : operationFailure("EXECUTION_FAILED", "unknown", evidenceRef) };
}

/** Model-facing projection of the same validated failure used by audit/output.
 * Diagnostic prose is not evidence of permission, sandbox or network cause. */
export function formatToolFailureForModel(result: ToolResult): string {
  const failure = normalizeToolFailure(result).failure!;
  const metadata = JSON.stringify({ code: failure.code, source: failure.source,
    retryable: failure.retryable,
    missingCapabilities: failure.missingCapabilities.slice(0, 8).map(value => value.slice(0, 256)),
    safeAlternatives: failure.safeAlternatives.slice(0, 8).map(value => value.slice(0, 256)) });
  let guidance = failure.source === "unknown"
    ? "Cause unconfirmed. Do not infer a sandbox, network, or user denial from diagnostic text."
    : "Use the structured failure as the authoritative cause, not keywords in the diagnostic text.";
  if (failure.code === "POLICY_DENIED" || failure.code === "SANDBOX_DENIED" || failure.code === "APPROVAL_REQUIRED") {
    guidance += " Do not bypass the denied boundary with another tool. Report the restriction and request any needed authorization.";
  } else if (failure.code === "TASK_PLAN_REQUIRED") {
    guidance += " Provide the required todo_write plan before continuing; this is not a file or sandbox permission denial.";
  }
  if (!failure.retryable && failure.code !== "TASK_PLAN_REQUIRED") {
    guidance += " Do not repeat the same failed operation unchanged; first resolve the prerequisite or report it as blocked.";
  }
  return `[Execution failure] ${metadata}\n[HINT] ${guidance}`;
}

/** Keep diagnostic output even when a failed tool also provides an error.
 * The caller may persist/compress this body; failure metadata stays separate. */
export function formatToolResultContent(result: ToolResult): string {
  if (result.success) return result.output;
  const error = result.error ?? result.output;
  const output = result.error !== undefined && result.output && result.output !== error
    ? `\n\nTool output:\n${result.output}` : "";
  return `Error: ${error}${output}`;
}

/** A bounded projection of observed process facts, not task acceptance. Do not
 * infer status from diagnostic prose or expose command strings/authorization.
 * Service references are actionable identifiers, never authority tokens. */
export function projectToolObservation(result: ToolResult): ExecutionObservation | undefined {
  const command = result.runtime?.command;
  const processFacts = {
    ...(Number.isSafeInteger(command?.exitCode) ? { exitCode: command!.exitCode } : {}),
    ...(typeof command?.timedOut === "boolean" ? { timedOut: command.timedOut } : {}),
    ...(typeof command?.aborted === "boolean" ? { aborted: command.aborted } : {}),
  };
  const checks = result.runtime?.verification;
  const selfChecks = typeof checks?.passed === "boolean" && Array.isArray(checks.steps)
    ? { passed: checks.passed, observedSteps: checks.steps.length,
        stepExitCodes: checks.steps.slice(0, 32).map(step => Number.isSafeInteger(step?.exitCode) ? step.exitCode : null) }
    : undefined;
  const service = ServiceReceiptSchema.safeParse(result.runtime?.service);
  const operation = ServiceOperationObservationSchema.safeParse(result.runtime?.serviceOperation);
  if (Object.keys(processFacts).length === 0 && !selfChecks && !service.success && !operation.success) return undefined;
  return {
    ...(service.success ? { service: { operationId: service.data.operationId, serviceId: service.data.serviceId,
      state: service.data.state, ownerScope: service.data.ownerScope, observedAt: service.data.observedAt, expiresAt: service.data.expiresAt } } : {}),
    ...(operation.success ? { serviceOperation: { operationId: operation.data.operationId, kind: operation.data.kind,
      state: operation.data.state, ownerScope: operation.data.ownerScope, observedAt: operation.data.observedAt,
      ...(operation.data.expiresAt !== undefined ? { expiresAt: operation.data.expiresAt } : {}) } } : {}),
    ...(Object.keys(processFacts).length ? { command: processFacts } : {}),
    ...(selfChecks ? { selfChecks } : {}),
  };
}

export function formatExecutionObservation(observation: ExecutionObservation | undefined): string | undefined {
  if (!observation) return undefined;
  // Re-project persisted or caller-supplied metadata through the same whitelist.
  const safe = projectToolObservation({ success: true, output: "", runtime: {
    command: { commandRef: "", ...observation.command },
    ...(observation.selfChecks && Number.isSafeInteger(observation.selfChecks.observedSteps)
      && observation.selfChecks.observedSteps >= 0 && Array.isArray(observation.selfChecks.stepExitCodes)
      ? { verification: { passed: observation.selfChecks.passed,
          steps: observation.selfChecks.stepExitCodes.slice(0, 32).map(exitCode => ({ command: "", exitCode: exitCode as number })) } }
      : {}),
  } }) ?? {};
  const service = ServiceModelReceiptSchema.safeParse(observation.service);
  const operation = ServiceModelOperationSchema.safeParse(observation.serviceOperation);
  if (service.success) safe.service = service.data;
  if (operation.success) safe.serviceOperation = operation.data;
  if (!Object.keys(safe).length) return undefined;
  if (safe.selfChecks) safe.selfChecks.observedSteps = observation.selfChecks!.observedSteps;
  return `[Execution observation] ${JSON.stringify(safe)}\n` + (safe.service || safe.serviceOperation
    ? "Service owner observation only; not endpoint health or task acceptance. Query an unknown operation rather than repeating its start."
    : "Process/self-check status only; not task acceptance or proof that every pipeline stage succeeded.");
}

export function formatToolObservationForModel(result: ToolResult): string | undefined {
  return formatExecutionObservation(projectToolObservation(result));
}

/** Optional body has already been compressed or persisted by the caller.
 * Keep structured observations and failure causes outside that lossy step. */
export function formatToolResultForModel(result: ToolResult, content = formatToolResultContent(result)): string {
  return [
    !result.success ? formatToolFailureForModel(result) : undefined,
    formatToolObservationForModel(result),
    content,
  ].filter(part => part !== undefined).join("\n");
}

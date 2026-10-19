import { z } from "zod";
import { posix, win32 } from "node:path";
import { executionDigest } from "../execution/observation.js";

const id = z.string().min(1).max(256).refine(value => !value.includes("\0"));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const binding = {
  backendId: id, ownerId: id, ownerGeneration: id, workspaceId: id, ownerScope: z.enum(["host-session", "environment"]),
};
export const ServiceCapabilitiesSchema = z.object({
  version: z.literal(1), ...binding,
  defaultLeaseMs: duration, maxLeaseMs: duration, ownerExpiresAt: timestamp,
  /** Descriptive failure boundary; absence makes no owner-death guarantee. */
  ownerFailure: z.literal("unknown-until-host-reconciliation").optional(),
  networkPolicyDigest: digest.optional(),
}).strict().refine(value => value.defaultLeaseMs <= value.maxLeaseMs, "default service lease exceeds maximum");
export type ServiceCapabilities = z.infer<typeof ServiceCapabilitiesSchema>;

/** The journal key survives replay even when transient execution deadlines
 * change. Complete authority remains bound separately by the intent digest. */
export function createServiceOperationId(cap: ServiceCapabilities, dispatchIdentity: string): string {
  return `service:${executionDigest({ dispatchIdentity: id.parse(dispatchIdentity), cap })}`;
}

const intentFields = {
  version: z.literal(1), ...binding, operationId: id, command: z.string().min(1).max(1_000_000).refine(value => !value.includes("\0")),
  cwd: z.string().min(1).max(32768).refine(value => !value.includes("\0") && (posix.isAbsolute(value) || win32.isAbsolute(value)), "service cwd must be an absolute backend path"), authorizationDigest: digest, createdAt: timestamp, expiresAt: timestamp,
};
export const ServiceStartIntentSchema = z.object({ ...intentFields, requestDigest: digest }).strict()
  .refine(value => value.expiresAt > value.createdAt, "service lease must have a positive duration")
  .refine(({ requestDigest, ...value }) => executionDigest(value) === requestDigest, "service request digest mismatch");
/** Correlation data after Host authorization. Constructing an intent never
 * grants permission, starts a process or creates a service capability. */
export type ServiceStartIntent = z.infer<typeof ServiceStartIntentSchema>;

export const ServiceReceiptSchema = z.object({
  version: z.literal(1), ...binding, operationId: id, serviceId: id, requestDigest: digest,
  state: z.enum(["starting", "running", "stopped", "expired", "unknown"]),
  observedAt: timestamp, expiresAt: timestamp,
}).strict();
export type ServiceReceipt = z.infer<typeof ServiceReceiptSchema>;
export const ServiceLookupSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("unknown") }).strict(),
  z.object({ state: z.literal("present"), receipt: ServiceReceiptSchema }).strict(),
]);
export type ServiceLookup = z.infer<typeof ServiceLookupSchema>;

/** Host-selected backend transport only. start MUST durably deduplicate
 * operationId before launching, enforce the original grant/isolation/limits,
 * and scope lookup to this backend/owner generation/workspace. This client is
 * not a substitute for those backend responsibilities. No default exists. */
export interface ServiceTransport {
  lookup(operationId: string, signal?: AbortSignal): Promise<unknown>;
  start(intent: Readonly<ServiceStartIntent>, signal?: AbortSignal): Promise<unknown>;
}

export class ServiceProtocolError extends Error {
  constructor(readonly code: "SERVICE_BINDING_MISMATCH" | "SERVICE_OPERATION_CONFLICT" | "SERVICE_OPERATION_UNKNOWN" | "SERVICE_LEASE_EXPIRED" | "SERVICE_JOURNAL_INVALID", message: string) {
    super(message);
    this.name = "ServiceProtocolError";
  }
}

const bindingKeys = ["backendId", "ownerId", "ownerGeneration", "workspaceId", "ownerScope"] as const;
export function assertServiceBinding(value: Pick<ServiceCapabilities, typeof bindingKeys[number]>, expected: Pick<ServiceCapabilities, typeof bindingKeys[number]>): void {
  if (bindingKeys.some(key => value[key] !== expected[key])) {
    throw new ServiceProtocolError("SERVICE_BINDING_MISMATCH", "Service belongs to another backend, owner generation or workspace");
  }
}

export function createServiceStartIntent(capabilities: ServiceCapabilities, input: {
  operationId: string; command: string; cwd: string; authorizationDigest: string; leaseMs?: number;
}, now = Date.now()): Readonly<ServiceStartIntent> {
  const cap = ServiceCapabilitiesSchema.parse(capabilities);
  const lease = duration.parse(input.leaseMs ?? cap.defaultLeaseMs);
  if (lease > cap.maxLeaseMs || now + lease > cap.ownerExpiresAt || !Number.isSafeInteger(now + lease)) {
    throw new ServiceProtocolError("SERVICE_LEASE_EXPIRED", "Requested service lease exceeds the Host owner's lease bounds");
  }
  const fields = { version: 1 as const, ...Object.fromEntries(bindingKeys.map(key => [key, cap[key]])),
    operationId: input.operationId, command: input.command, cwd: input.cwd, authorizationDigest: input.authorizationDigest,
    createdAt: now, expiresAt: now + lease };
  return Object.freeze(ServiceStartIntentSchema.parse({ ...fields, requestDigest: executionDigest(fields) }));
}

export function parseServiceReceipt(value: unknown, capabilities: ServiceCapabilities, intent: ServiceStartIntent): ServiceReceipt {
  const receipt = ServiceReceiptSchema.parse(value);
  assertServiceBinding(receipt, capabilities);
  if (receipt.operationId !== intent.operationId || receipt.requestDigest !== intent.requestDigest || receipt.expiresAt !== intent.expiresAt) {
    throw new ServiceProtocolError("SERVICE_BINDING_MISMATCH", "Service receipt does not match the original start intent");
  }
  return receipt;
}

/** Historical process state remains intact. Expiry/staleness never proves
 * that the backend actually stopped a process or that an endpoint is healthy. */
export function observeServiceReceipt(receipt: ServiceReceipt, now: number, maxAgeMs: number): {
  lease: "active" | "expired" | "unknown"; processObservedRunning: boolean;
} {
  ServiceReceiptSchema.parse(receipt);
  timestamp.parse(now); duration.parse(maxAgeMs);
  if (now >= receipt.expiresAt) return { lease: "expired", processObservedRunning: false };
  const fresh = receipt.observedAt <= now && now - receipt.observedAt <= maxAgeMs;
  return { lease: fresh ? "active" : "unknown", processObservedRunning: fresh && receipt.state === "running" };
}

export const ServiceOperationObservationSchema = z.object({
  version: z.literal(1), executionId: id, kind: z.enum(["start", "status", "stop"]),
  backendId: id, ownerId: id, ownerGeneration: id, workspaceId: id,
  operationId: id, ownerScope: z.enum(["host-session", "environment"]), expiresAt: z.number().int().nonnegative().optional(), state: z.enum(["observed", "absent", "unknown"]), observedAt: z.number().int().nonnegative(),
}).strict();
export type ServiceOperationObservation = z.infer<typeof ServiceOperationObservationSchema>;

/** Bounded actionable service references for model history, without command,
 * authorization material, backend internals or an acceptance claim. */
export const ServiceModelReceiptSchema = ServiceReceiptSchema.pick({ operationId: true, serviceId: true,
  state: true, ownerScope: true, observedAt: true, expiresAt: true }).strict();
export const ServiceModelOperationSchema = ServiceOperationObservationSchema.pick({ operationId: true, kind: true,
  state: true, ownerScope: true, observedAt: true, expiresAt: true }).strict();
export type ServiceModelReceipt = z.infer<typeof ServiceModelReceiptSchema>;
export type ServiceModelOperation = z.infer<typeof ServiceModelOperationSchema>;

import { resolve } from "node:path";
import { z } from "zod";
import type { ExecutionBrokerRequest, SandboxMode } from "../execution/types.js";
import type { ToolResourceLimits } from "../tools/effects.js";
import { executionDigest } from "../execution/observation.js";
import { operationFailure } from "../execution/failure.js";
import type { ToolResult } from "../tools/types.js";
import { BoundServiceClient, type ServiceDispatchJournal } from "./client.js";
import { ServiceCapabilitiesSchema, ServiceLookupSchema, ServiceReceiptSchema, ServiceProtocolError,
  assertServiceBinding, createServiceOperationId, createServiceStartIntent, parseServiceReceipt,
  type ServiceOperationObservation, type ServiceCapabilities, type ServiceReceipt, type ServiceStartIntent } from "./contracts.js";

export type ServiceOperation = "start" | "status" | "stop";
export const ServiceStartArguments = z.object({ command: z.string().min(1).max(1_000_000).refine(s => !s.includes("\0")),
  lease_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), network: z.boolean().default(false) }).strict();
export const ServiceStatusArguments = z.object({ operation_id: z.string().min(1).max(256) }).strict();
export const ServiceStopArguments = z.object({ service_id: z.string().min(1).max(256) }).strict();


/** Immutable, Host-only authorization for the selected owner. A digest is
 * correlation, not authority. The backend must check this complete request
 * before dispatch and durably enforce grants, isolation, network, limits,
 * cancellation and leases in its own process domain. Never use a local
 * launcher as a fallback. Credentials must not be serialized into receipts. */
export interface ServiceExecutionAuthority {
  executionId: string;
  dispatchIdentity: string;
  identity: { sessionId?: string; toolCallId?: string; step?: number };
  name: string;
  args: Record<string, unknown>;
  effects: ExecutionBrokerRequest["effects"];
  grant: ExecutionBrokerRequest["grant"];
  workspace: ExecutionBrokerRequest["workspace"];
  limits: ToolResourceLimits;
  sandboxMode: SandboxMode;
  deadlineAtMs?: number;
}
export interface AuthorizedServiceBackend {
  capabilities: ServiceCapabilities;
  workspace: { id: string; root: string };
  journal: ServiceDispatchJournal;
  lookup(operationId: string, authority: Readonly<ServiceExecutionAuthority>, signal?: AbortSignal): Promise<unknown>;
  start(intent: Readonly<ServiceStartIntent>, authority: Readonly<ServiceExecutionAuthority>, signal?: AbortSignal): Promise<unknown>;
  status(serviceId: string, authority: Readonly<ServiceExecutionAuthority>, signal?: AbortSignal): Promise<unknown>;
  stop(serviceId: string, authority: Readonly<ServiceExecutionAuthority>, signal?: AbortSignal): Promise<unknown>;
}
function immutable<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (object: any): void => {
    if (!object || typeof object !== "object") return;
    Object.values(object).forEach(freeze); Object.freeze(object);
  };
  freeze(copy); return copy;
}

function bounded<T>(reply: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return reply;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    reply.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Host session wiring. This object is not an independent process owner. */
export class ServiceExecutionHost {
  private readonly cap: Readonly<ServiceCapabilities>;
  private readonly workspace: Readonly<{ id: string; root: string }>;
  private readonly intents = new Map<string, Readonly<ServiceStartIntent>>();
  constructor(private readonly backend: AuthorizedServiceBackend) {
    this.cap = Object.freeze(ServiceCapabilitiesSchema.parse(backend.capabilities));
    this.workspace = Object.freeze({ id: backend.workspace.id, root: resolve(backend.workspace.root) });
    if (this.cap.workspaceId !== this.workspace.id) throw new Error("Service workspace binding mismatch");
    if (this.cap.ownerScope === "environment" && backend.journal.durability !== "durable") throw new Error("Environment services require a durable journal");
  }
  capabilities(workspace: ExecutionBrokerRequest["workspace"]): ServiceCapabilities | undefined {
    return workspace.id === this.workspace.id && resolve(workspace.root) === this.workspace.root
      && workspace.mode !== "shared-readonly" && workspace.mode !== "isolated-write" ? { ...this.cap } : undefined;
  }

  async execute(kind: ServiceOperation, request: ExecutionBrokerRequest, limits: ToolResourceLimits,
    sandboxMode: SandboxMode, signal?: AbortSignal): Promise<ToolResult> {
    const cap = this.capabilities(request.workspace);
    if (!cap) return this.failure("Service owner is unavailable for this workspace", "POLICY_DENIED");
    if (!request.serviceOperationNonce) return this.failure("Service operation requires a stable Host approval identity", "POLICY_DENIED");
    const authority = immutable<ServiceExecutionAuthority>({ executionId: request.executionId, dispatchIdentity: request.serviceOperationNonce,
      identity: { sessionId: request.context?.sessionId, toolCallId: request.context?.toolCallId, step: request.context?.step }, name: request.name,
      args: request.args, effects: request.effects, grant: request.grant, workspace: request.workspace,
      limits, sandboxMode, deadlineAtMs: request.context?.deadlineAtMs });
    const args = kind === "start" ? ServiceStartArguments.parse(request.args)
      : kind === "status" ? ServiceStatusArguments.parse(request.args) : ServiceStopArguments.parse(request.args);
    // Model tool ids can repeat across sessions. Keep the Host approval key
    // stable on replay; changed authority must conflict at that same key.
    const authorityDigest = executionDigest(authority);
    const operationId = kind === "status" ? (args as z.infer<typeof ServiceStatusArguments>).operation_id
      : createServiceOperationId(cap, authority.dispatchIdentity);
    const observation: ServiceOperationObservation = Object.freeze({ version: 1, executionId: request.executionId, kind,
      backendId: cap.backendId, ownerId: cap.ownerId, ownerGeneration: cap.ownerGeneration, workspaceId: cap.workspaceId,
      operationId, ownerScope: cap.ownerScope, state: "unknown", observedAt: Date.now() });
    let current: { service?: ServiceReceipt; serviceOperation: ServiceOperationObservation } | undefined;
    const record = (value: { service?: ServiceReceipt; serviceOperation: ServiceOperationObservation }) => {
      Object.freeze(value);
      current = value;
      try { request.onServiceObservation?.(value); } catch { /* Observers do not change dispatch. */ }
    };
    record({ serviceOperation: observation });
    const check = () => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      if (authority.grant.expiresAt <= Date.now() || (authority.deadlineAtMs !== undefined && authority.deadlineAtMs <= Date.now())) throw new Error("Service authorization expired");
    };
    try {
      check();
      let receipt: ServiceReceipt;
      if (kind === "start") {
        const start = args as z.infer<typeof ServiceStartArguments>;
        let intent = this.intents.get(operationId);
        const digest = authorityDigest;
        if (intent && intent.authorizationDigest !== digest) throw new ServiceProtocolError("SERVICE_OPERATION_CONFLICT", "Service authorization changed");
        intent ??= createServiceStartIntent(cap, { operationId, command: start.command, cwd: this.workspace.root,
          authorizationDigest: digest, leaseMs: start.lease_ms });
        this.intents.set(operationId, intent);
        record({ serviceOperation: Object.freeze({ ...observation, expiresAt: intent.expiresAt }) });
        const client = new BoundServiceClient(cap, {
          lookup: (id, s) => { check(); return this.backend.lookup(id, authority, s); },
          start: (i, s) => { check(); return this.backend.start(i, authority, s); },
        }, this.backend.journal);
        receipt = await client.start(intent, signal);
      } else if (kind === "status") {
        const found = ServiceLookupSchema.parse(await bounded(this.backend.lookup(operationId, authority, signal), signal));
        check();
        if (found.state === "unknown") throw new Error("Service lookup is inconclusive");
        if (found.state === "absent") {
          record({ serviceOperation: Object.freeze({ ...observation, state: "absent", observedAt: Date.now() }) });
          return { success: true, output: JSON.stringify({ operationId, state: "absent", hint: "No bound receipt found. Absence does not authorize another start." }), runtime: current };
        }
        receipt = ServiceReceiptSchema.parse(found.receipt);
        assertServiceBinding(receipt, cap);
        if (receipt.expiresAt > cap.ownerExpiresAt) throw new Error("Service receipt exceeds owner lease");
        if (receipt.operationId !== operationId) throw new Error("Service operation mismatch");
        const intent = this.intents.get(operationId);
        if (intent) parseServiceReceipt(receipt, cap, intent);
        receipt = ServiceReceiptSchema.parse(await bounded(this.backend.status(receipt.serviceId, authority, signal), signal));
        if (receipt.operationId !== operationId || receipt.serviceId !== found.receipt.serviceId || receipt.requestDigest !== found.receipt.requestDigest || receipt.expiresAt !== found.receipt.expiresAt) throw new Error("Service status binding mismatch");
      } else {
        const id = (args as z.infer<typeof ServiceStopArguments>).service_id;
        const before = ServiceReceiptSchema.parse(await bounded(this.backend.status(id, authority, signal), signal));
        assertServiceBinding(before, cap);
        if (before.serviceId !== id || before.expiresAt > cap.ownerExpiresAt) throw new Error("Service stop target mismatch");
        check();
        record({ serviceOperation: Object.freeze({ ...observation, operationId: before.operationId, expiresAt: before.expiresAt }) });
        receipt = ServiceReceiptSchema.parse(await bounded(this.backend.stop(id, authority, signal), signal));
        if (receipt.serviceId !== id || receipt.operationId !== before.operationId || receipt.requestDigest !== before.requestDigest || receipt.expiresAt !== before.expiresAt) throw new Error("Service stop binding mismatch");
      }
      assertServiceBinding(receipt, cap);
      if (receipt.expiresAt > cap.ownerExpiresAt) throw new Error("Service receipt exceeds owner lease");
      check();
      const originalIntent = this.intents.get(receipt.operationId);
      if (originalIntent) {
        parseServiceReceipt(receipt, cap, originalIntent);
        await bounded(this.backend.journal.bindReceipt(originalIntent, receipt), signal);
        check();
      }
      const observed = { service: Object.freeze(receipt), serviceOperation: Object.freeze({ ...observation,
        operationId: receipt.operationId, state: "observed" as const, observedAt: Date.now() }) };
      record(observed);
      return { success: true, output: JSON.stringify({ service: receipt,
        hint: "Process-owner observation only. This does not prove endpoint health or user acceptance." }), runtime: observed };
    } catch {
      return { ...this.failure("Service operation has no validated receipt. Inspect the bound operation; do not assume it stopped or repeat its start.", "EXECUTION_FAILED"),
        output: JSON.stringify({ operationId: current?.serviceOperation.operationId ?? operationId, state: "unknown" }), runtime: current };
    }
  }
  private failure(error: string, code: "POLICY_DENIED" | "EXECUTION_FAILED"): ToolResult {
    return { success: false, output: "", error, failure: operationFailure(code, "broker") };
  }
}

import { ServiceLookupSchema, ServiceCapabilitiesSchema, ServiceProtocolError, ServiceStartIntentSchema, assertServiceBinding, parseServiceReceipt,
  type ServiceCapabilities, type ServiceReceipt, type ServiceStartIntent, type ServiceTransport } from "./contracts.js";

/** Each operation is bound once, then at most one caller claims dispatch.
 * Implementations must durably commit claimDispatch before returning true.
 * Remembering a receipt binds its immutable serviceId, not current liveness. */
export interface ServiceDispatchJournal {
  readonly durability: "host-session" | "durable";
  bindIntent(intent: ServiceStartIntent): Promise<void>;
  claimDispatch(intent: ServiceStartIntent): Promise<boolean>;
  bindReceipt(intent: ServiceStartIntent, receipt: ServiceReceipt): Promise<void>;
}

function waitForReply<T>(reply: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    reply.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** Reconcile a lost reply without blindly reissuing a service start. This is
 * Host-side transport plumbing, not an authorization or process launcher. */
export class BoundServiceClient {
  private readonly capabilities: Readonly<ServiceCapabilities>;
  private readonly inFlight = new Map<string, { digest: string; promise: Promise<ServiceReceipt> }>();
  constructor(capabilities: ServiceCapabilities, private readonly transport: ServiceTransport, private readonly journal: ServiceDispatchJournal) {
    this.capabilities = Object.freeze(ServiceCapabilitiesSchema.parse(capabilities));
    if (capabilities.ownerScope === "environment" && journal.durability !== "durable") {
      throw new ServiceProtocolError("SERVICE_JOURNAL_INVALID", "Environment services require a durable dispatch journal");
    }
  }

  async start(input: ServiceStartIntent, signal?: AbortSignal): Promise<ServiceReceipt> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const intent = Object.freeze(ServiceStartIntentSchema.parse(input));
    assertServiceBinding(intent, this.capabilities);
    if (intent.expiresAt - intent.createdAt > this.capabilities.maxLeaseMs || intent.expiresAt > this.capabilities.ownerExpiresAt) {
      throw new ServiceProtocolError("SERVICE_BINDING_MISMATCH", "Intent exceeds the selected owner's lease bounds");
    }
    const existing = this.inFlight.get(intent.operationId);
    if (existing) {
      if (existing.digest !== intent.requestDigest) throw new ServiceProtocolError("SERVICE_OPERATION_CONFLICT", "Operation id was reused with a different service request");
      return signal ? waitForReply(existing.promise, signal) : existing.promise;
    }
    const promise = this.reconcile(intent, signal).finally(() => this.inFlight.delete(intent.operationId));
    this.inFlight.set(intent.operationId, { digest: intent.requestDigest, promise });
    return promise;
  }

  private async reconcile(intent: ServiceStartIntent, signal?: AbortSignal): Promise<ServiceReceipt> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", forward, { once: true });
    if (signal?.aborted) forward();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => controller.abort(new ServiceProtocolError("SERVICE_LEASE_EXPIRED", "Service lease expired while awaiting a bound reply; process disposition is unknown"));
    const arm = () => {
      const remaining = intent.expiresAt - Date.now();
      if (remaining <= 0) expire();
      else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    };
    arm();
    const check = () => {
      if (!controller.signal.aborted && Date.now() >= intent.expiresAt) expire();
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
    };
    const wait = <T>(reply: Promise<T>) => waitForReply(reply, controller.signal);
    try {
      check();
      await wait(this.journal.bindIntent(intent));
      check();
      let found;
      try { found = ServiceLookupSchema.parse(await wait(this.transport.lookup(intent.operationId, controller.signal))); }
      catch {
        check();
        throw new ServiceProtocolError("SERVICE_OPERATION_UNKNOWN", "Service lookup unavailable or malformed; no new start was dispatched");
      }
      check();
      let receipt: ServiceReceipt;
      if (found.state === "present") receipt = parseServiceReceipt(found.receipt, this.capabilities, intent);
      else if (found.state !== "absent") throw new ServiceProtocolError("SERVICE_OPERATION_UNKNOWN", "Backend cannot determine whether this operation created a service");
      else {
        if (!await wait(this.journal.claimDispatch(intent))) {
          throw new ServiceProtocolError("SERVICE_OPERATION_UNKNOWN", "A prior dispatch may have created this service; lookup is inconclusive and start was not repeated");
        }
        // Wall-clock admission is rechecked even when a timer was delayed.
        check();
        try {
          receipt = parseServiceReceipt(await wait(this.transport.start(intent, controller.signal)), this.capabilities, intent);
        } catch (error) {
          // Durable claim survives lost replies, cancellation and validation.
          check();
          throw new ServiceProtocolError("SERVICE_OPERATION_UNKNOWN", `Service start has no bound receipt (${error instanceof Error ? error.name : "unknown error"}); reconcile by operation id`);
        }
        check();
      }
      await wait(this.journal.bindReceipt(intent, receipt));
      check();
      return receipt;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
  }
}

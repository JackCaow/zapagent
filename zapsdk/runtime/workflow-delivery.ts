import { DeferredAcceptanceCoordinator } from "./deferred-acceptance.js";
import { OutcomeProtocolError, type AcceptanceSpec } from "./outcome.js";
import { workflowError, workflowString, type DeferredWorkflowRecord, type WorkflowSnapshot } from "./workflow-control.js";

export interface WorkflowDeliveryRequest {
  workflowId: string;
  requestId: string;
  ownerId: string;
  attemptId: string;
  specDigest: string;
  spec: AcceptanceSpec;
  snapshot: WorkflowSnapshot;
  deadlineAt: number;
}
export interface WorkflowDeliveryAdapter {
  ownerId: string;
  /** Must durably deduplicate requestId and return the same receiptId on retries. */
  publish(request: WorkflowDeliveryRequest, signal: AbortSignal): Promise<{ requestId: string; receiptId: string }>;
}

/** Persisted pending records are the outbox. Lost acknowledgements retry delivery, never the Agent. */
export class WorkflowDeliveryRunner {
  private readonly adapters = new Map<string, WorkflowDeliveryAdapter>();
  constructor(private readonly coordinator: DeferredAcceptanceCoordinator, adapters: WorkflowDeliveryAdapter[]) {
    for (const adapter of adapters) {
      if (!adapter || !workflowString(adapter.ownerId) || this.adapters.has(adapter.ownerId) || typeof adapter.publish !== "function") workflowError("INVALID_DELIVERY_CONFIG");
      this.adapters.set(adapter.ownerId, { ownerId: adapter.ownerId, publish: adapter.publish.bind(adapter) });
    }
  }
  async deliver(id: string, options: { timeoutMs: number; signal?: AbortSignal; pollMs?: number }): Promise<DeferredWorkflowRecord> {
    const { timeoutMs, signal, pollMs = 50 } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) workflowError("INVALID_DELIVERY_CONFIG");
    signal?.throwIfAborted();
    const current = this.coordinator.read(id).record;
    const adapter = this.adapters.get(current.ownerId);
    if (!adapter) workflowError("DELIVERY_ADAPTER_UNAVAILABLE");
    if (current.delivery?.receiptId) return current;
    const record = this.coordinator.beginDelivery(id, current.revision);
    const deadline = Math.min(record.deadlineAt, Date.now() + timeoutMs);
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, fail) => { reject = fail; });
    const stop = (code: string) => {
      if (controller.signal.aborted) return;
      const error = new OutcomeProtocolError(code, code); reject(error); controller.abort(error);
    };
    const abort = () => stop("DELIVERY_CANCELLED");
    const check = () => {
      try {
        const latest = this.coordinator.read(id).record;
        if (latest.cancelled || latest.requestId !== record.requestId) stop("DELIVERY_CANCELLED");
        else if (Date.now() >= deadline) stop("DELIVERY_TIMEOUT");
      } catch { stop("DELIVERY_CONTROL_UNAVAILABLE"); }
    };
    const timer = setTimeout(() => stop("DELIVERY_TIMEOUT"), Math.max(0, deadline - Date.now()));
    const poll = setInterval(check, pollMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const receipt = await Promise.race([interrupted, Promise.resolve().then(async () => {
        check(); controller.signal.throwIfAborted();
        const request: WorkflowDeliveryRequest = { workflowId: id, requestId: record.requestId, ownerId: record.ownerId,
          attemptId: record.outcome.attemptId, specDigest: record.specDigest, spec: structuredClone(record.spec),
          snapshot: structuredClone(record.snapshot!), deadlineAt: record.deadlineAt };
        const value = await adapter.publish(request, controller.signal);
        check(); controller.signal.throwIfAborted();
        if (!value || value.requestId !== record.requestId || !workflowString(value.receiptId)) workflowError("INVALID_DELIVERY_RECEIPT");
        return structuredClone(value);
      })]);
      for (let retries = 0; retries < 8; retries++) {
        const latest = this.coordinator.read(id).record;
        try { return this.coordinator.acknowledgeDelivery(id, latest.revision, receipt.requestId, receipt.receiptId); }
        catch (error) { if (!(error instanceof OutcomeProtocolError) || error.code !== "WORKFLOW_CONFLICT") throw error; }
      }
      return workflowError("WORKFLOW_CONFLICT");
    } finally {
      clearTimeout(timer); clearInterval(poll); signal?.removeEventListener("abort", abort); controller.abort();
    }
  }
}

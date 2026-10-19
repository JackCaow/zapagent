import { DeferredAcceptanceCoordinator } from "./deferred-acceptance.js";
import { OutcomeProtocolError, type AcceptanceSpec } from "./outcome.js";
import { validateWorkflowActionReceipt, workflowError, workflowString,
  type DeferredWorkflowRecord, type WorkflowActionClaim, type WorkflowActionReceipt, type WorkflowActionResult,
  type WorkflowAuthorization, type WorkflowControlDecision, type WorkflowSnapshot } from "./workflow-control.js";

export interface WorkflowActionContext {
  workflowId: string;
  claim: Readonly<WorkflowActionClaim>;
  spec: Readonly<AcceptanceSpec>;
  snapshot: Readonly<WorkflowSnapshot>;
  signal: AbortSignal;
  deadlineAt: number;
}
export interface WorkflowActionAdapter {
  /** Trusted host action identity. Changing executor semantics requires a new actionId. */
  actionId: string;
  /** Consume only the immutable snapshot, using operationId as the external idempotency key. */
  execute(context: WorkflowActionContext): Promise<WorkflowActionReceipt>;
  /** Read-only query by operationId. Never execute or retry the operation here. */
  reconcile(context: WorkflowActionContext): Promise<WorkflowActionReceipt>;
}
export interface WorkflowActionRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function optionsValid(options: WorkflowActionRunOptions): void {
  if (!options || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) workflowError("INVALID_ACTION_CONFIG");
}

/** Explicit host composition. A recovered claim permits queries, never a second execute call. */
export class WorkflowActionRunner {
  private readonly adapters = new Map<string, WorkflowActionAdapter>();
  constructor(private readonly coordinator: DeferredAcceptanceCoordinator, adapters: WorkflowActionAdapter[], private readonly pollMs = 50) {
    if (!coordinator || !Array.isArray(adapters) || !adapters.length || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) workflowError("INVALID_ACTION_CONFIG");
    for (const adapter of adapters) {
      if (!adapter || !workflowString(adapter.actionId) || this.adapters.has(adapter.actionId)
        || typeof adapter.execute !== "function" || typeof adapter.reconcile !== "function") workflowError("INVALID_ACTION_CONFIG");
      this.adapters.set(adapter.actionId, { actionId: adapter.actionId,
        execute: adapter.execute.bind(adapter), reconcile: adapter.reconcile.bind(adapter) });
    }
  }

  private adapter(id: string): WorkflowActionAdapter {
    return this.adapters.get(id) ?? workflowError("ACTION_ADAPTER_UNAVAILABLE");
  }

  private cancel(id: string): void {
    for (let retries = 0; retries < 8; retries++) {
      const { record } = this.coordinator.read(id);
      if (record.cancelled) return;
      try { this.coordinator.cancel(id, record.revision); return; }
      catch (error) { if (!(error instanceof OutcomeProtocolError) || error.code !== "WORKFLOW_CONFLICT") throw error; }
    }
    workflowError("WORKFLOW_CONFLICT");
  }

  private publish(id: string, receipt: WorkflowActionReceipt, source: WorkflowActionResult["source"]): DeferredWorkflowRecord {
    try {
      for (let retries = 0; retries < 8; retries++) {
        const { record } = this.coordinator.read(id);
        // A concurrent conclusive query takes precedence over a timeout/unknown observation.
        if (receipt.status === "unknown" && record.actionResult && record.actionResult.status !== "unknown") return record;
        try { return this.coordinator.recordActionResult(id, record.revision, receipt, source); }
        catch (error) { if (!(error instanceof OutcomeProtocolError) || error.code !== "WORKFLOW_CONFLICT") throw error; }
      }
      workflowError("WORKFLOW_CONFLICT");
    } catch (error) {
      if (error instanceof OutcomeProtocolError && error.code === "ACTION_RESULT_CONFLICT") throw error;
      throw new OutcomeProtocolError("ACTION_RESULT_PERSISTENCE_FAILED", "Action claim is retained; reconcile its operationId before further action");
    }
  }

  private async invoke(record: DeferredWorkflowRecord, adapter: WorkflowActionAdapter, source: WorkflowActionResult["source"], options: WorkflowActionRunOptions): Promise<WorkflowActionReceipt> {
    const claim = record.action!;
    const controller = new AbortController();
    const deadlineAt = source === "execute" ? Math.min(record.deadlineAt, Date.now() + options.timeoutMs) : Date.now() + options.timeoutMs;
    let reject!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, fail) => { reject = fail; });
    const stop = (code: string) => {
      if (controller.signal.aborted) return;
      const error = new OutcomeProtocolError(code, code);
      reject(error);
      controller.abort(error);
    };
    const abort = () => {
      try { if (source === "execute") this.cancel(record.id); }
      catch { stop("ACTION_CONTROL_UNAVAILABLE"); return; }
      stop("ACTION_CANCELLED");
    };
    const check = () => {
      if (controller.signal.aborted) return;
      if (Date.now() >= deadlineAt) { stop("ACTION_TIMEOUT"); return; }
      if (source === "execute") {
        try {
          const current = this.coordinator.read(record.id).record;
          if (current.action?.operationId !== claim.operationId) stop("ACTION_CLAIM_CHANGED");
          else if (current.cancelled) stop("ACTION_CANCELLED");
          else if (current.blockers.length) stop("ACTION_BLOCKED");
          else if (Date.now() >= deadlineAt) stop("ACTION_TIMEOUT");
        } catch { stop("ACTION_CONTROL_UNAVAILABLE"); }
      }
    };
    const timer = setTimeout(() => stop("ACTION_TIMEOUT"), Math.max(0, deadlineAt - Date.now()));
    const poll = source === "execute" ? setInterval(check, this.pollMs) : undefined;
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      const receipt = await Promise.race([interrupted, Promise.resolve().then(async () => {
        check();
        controller.signal.throwIfAborted();
        const context: WorkflowActionContext = { workflowId: record.id, claim: freeze(structuredClone(claim)),
          snapshot: freeze(structuredClone(record.snapshot!)), spec: freeze(structuredClone(record.spec)), signal: controller.signal, deadlineAt };
        const result = await (source === "execute" ? adapter.execute(context) : adapter.reconcile(context));
        check();
        controller.signal.throwIfAborted();
        validateWorkflowActionReceipt(result, claim);
        return structuredClone(result);
      })]);
      return receipt;
    } catch (error) {
      // Throwing, aborting or losing the response does not establish whether the external effect happened.
      const code = error instanceof OutcomeProtocolError && ["ACTION_TIMEOUT", "ACTION_CANCELLED", "ACTION_BLOCKED", "ACTION_CONTROL_UNAVAILABLE", "ACTION_CLAIM_CHANGED", "INVALID_ACTION_RECEIPT"].includes(error.code)
        ? error.code : "ACTION_ADAPTER_ERROR";
      return { operationId: claim.operationId, snapshotId: claim.snapshotId, status: "unknown", code, evidenceRefs: [] };
    } finally {
      clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  async dispatch(candidate: WorkflowControlDecision, authorization: WorkflowAuthorization, options: WorkflowActionRunOptions): Promise<DeferredWorkflowRecord> {
    optionsValid(options);
    options.signal?.throwIfAborted();
    // Resolve executable capability before claiming. Acceptance never supplies or approves an adapter.
    const adapter = this.adapter(authorization.actionId);
    const record = this.coordinator.claimAction(candidate, authorization);
    const receipt = await this.invoke(record, adapter, "execute", options);
    return this.publish(record.id, receipt, "execute");
  }

  async reconcile(id: string, options: WorkflowActionRunOptions): Promise<DeferredWorkflowRecord> {
    optionsValid(options);
    options.signal?.throwIfAborted();
    const { record } = this.coordinator.read(id);
    if (!record.action) workflowError("ACTION_NOT_CLAIMED");
    if (record.actionResult && record.actionResult.status !== "unknown") return record;
    const adapter = this.adapter(record.action.actionId);
    // Queries may run after workflow cancellation/deadline to learn the real external outcome.
    const receipt = await this.invoke(record, adapter, "reconcile", options);
    return this.publish(record.id, receipt, "reconcile");
  }
}

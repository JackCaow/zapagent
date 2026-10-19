import type { DeferredAcceptanceCoordinator } from "../runtime/deferred-acceptance.js";
import type { WorkflowActionRunner } from "../runtime/workflow-action-runner.js";
import type { WorkflowAuthorization } from "../runtime/workflow-control.js";
import { OutcomeProtocolError } from "../runtime/outcome.js";

/** Only installed by a trusted host. Wire the existing permission system into authorize before dispatch. */
export class HostWorkflowController {
  constructor(private readonly coordinator: DeferredAcceptanceCoordinator, private readonly options: {
    actions?: WorkflowActionRunner;
    authorize?: (input: { threadId: string; workflowId: string; actionId: string }) => Promise<WorkflowAuthorization>;
  } = {}) {}

  async handle(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const fail = (code: string): never => { throw new OutcomeProtocolError(code, code); };
    const id = params.workflowId;
    if (typeof id !== "string" || !id.trim()) return fail("INVALID_PARAMS");
    const state = this.coordinator.read(id);
    if (state.record.outcome.threadId !== threadId) return fail("WORKFLOW_NOT_FOUND");
    const allowed = method === "workflow.dispatch" ? ["workflowId", "revision", "actionId", "timeoutMs"]
      : method === "workflow.cancel" ? ["workflowId", "revision"]
        : ["workflowId", ...(method === "workflow.wait" || method === "workflow.reconcile" ? ["timeoutMs"] : [])];
    if (Object.keys(params).some(k => !allowed.includes(k))) return fail("INVALID_PARAMS");
    const timeoutMs = params.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300_000) return fail("INVALID_PARAMS");
    if (method === "workflow.read") return state;
    if (method === "workflow.wait") return this.coordinator.wait(id, { timeoutMs: timeoutMs as number });
    if (method === "workflow.reconcile") {
      if (!this.options.actions) return fail("UNSUPPORTED_CAPABILITY");
      return this.options.actions.reconcile(id, { timeoutMs: timeoutMs as number });
    }
    if (!Number.isSafeInteger(params.revision) || params.revision !== state.record.revision) return fail("WORKFLOW_CONFLICT");
    if (method === "workflow.cancel") return this.coordinator.cancel(id, params.revision as number);
    if (method === "workflow.dispatch") {
      if (!this.options.actions || !this.options.authorize) return fail("UNSUPPORTED_CAPABILITY");
      if (typeof params.actionId !== "string" || !params.actionId.trim()) return fail("INVALID_PARAMS");
      const grant = await this.options.authorize({ threadId, workflowId: id, actionId: params.actionId });
      if (!grant || grant.actionId !== params.actionId) return fail("ACTION_NOT_AUTHORIZED");
      const record = this.coordinator.authorizeAction(id, state.record.revision, grant);
      return this.options.actions.dispatch(this.coordinator.read(record.id).decision, grant, { timeoutMs: timeoutMs as number });
    }
    return fail("METHOD_NOT_FOUND");
  }
}

import type {
  AgentCoordinatorExecutor,
  AgentCoordinatorExecutorContext,
  AgentCoordinatorResult,
} from "./types.js";

/** Late-bound bridge used during Runtime assembly. LoopAgent creates its Tool
 * registry after the Coordinator, so the concrete subagent executor is bound
 * when the `agent` Tool factory runs. */
export class DeferredAgentCoordinatorExecutor implements AgentCoordinatorExecutor {
  private readonly executors = new Map<string, AgentCoordinatorExecutor>();

  bind(executor: AgentCoordinatorExecutor, bindingId: string): string {
    if (!bindingId.trim()) throw new Error("AgentCoordinator executor binding id is required");
    this.executors.set(bindingId, executor);
    return bindingId;
  }

  execute(context: AgentCoordinatorExecutorContext): Promise<Omit<AgentCoordinatorResult, "runId">> {
    const bindingId = context.metadata.executorBindingId;
    const executor = typeof bindingId === "string"
      ? this.executors.get(bindingId)
      : undefined;
    if (!executor) {
      throw new Error("AgentCoordinator executor binding is unavailable");
    }
    return executor.execute(context);
  }
}

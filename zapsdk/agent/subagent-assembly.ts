import type { LoopAgentOptions, SubagentConfig, SubagentFactoryArgs } from "./loop.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutor } from "../tools/executor.js";

type AssemblyInput = Omit<SubagentFactoryArgs, "registry" | "executorOptions" | "onApproval"> & {
  registry: ToolRegistry;
  executor: ToolExecutor;
  maxSteps: number;
  subagent: LoopAgentOptions["subagent"];
  factory: LoopAgentOptions["subagentFactory"];
};

/** Per-run clone prevents subagent registration from mutating host registries. */
export function assembleSubagentTool(input: AssemblyInput): { registry: ToolRegistry; executor: ToolExecutor } {
  if (!input.subagent) return { registry: input.registry, executor: input.executor };
  const config: SubagentConfig = input.subagent === true ? {} : input.subagent;
  if (!input.factory) throw new Error("LoopAgentOptions.subagent is set but subagentFactory was not provided. Import { subagentTool } from zapsdk and pass it as subagentFactory.");
  const registry = input.registry.clone();
  const executor = input.executor.withRegistry(registry);
  if (registry.has("agent")) registry.unregister("agent");
  registry.register(input.factory({
    inheritedInstructions: config.inheritedInstructions,
    provider: input.provider,
    promptProfile: input.promptProfile,
    getResultSchema: input.getResultSchema,
    registry,
    maxSteps: Math.min(config.maxSteps ?? 50, input.maxSteps),
    timeoutMs: config.timeoutMs,
    maxDepth: config.maxDepth,
    onApproval: executor.onApproval,
    executorOptions: {
      timeoutMs: executor.timeoutMs,
      checkpointMode: executor.checkpointMode,
      postProcess: executor.postProcess,
      resultGuard: executor.resultGuard,
      onTrackEdit: executor.onTrackEdit,
      allowConfirmWithoutApproval: executor.allowConfirmWithoutApproval,
      approvalCoordinator: executor.approvalCoordinator,
      policyEngine: executor.policyEngine,
      executionBroker: executor.executionBroker,
      onApprovalLifecycle: executor.onApprovalLifecycle,
      onExecutionLifecycle: executor.onExecutionLifecycle,
    },
    onEvent: config.onEvent,
    budget: input.budget,
    fallbackProvider: input.fallbackProvider,
    todoStore: config.todoStore,
    contextWindow: input.contextWindow,
    inputTokenLimit: input.inputTokenLimit,
    outputTokenCeiling: input.outputTokenCeiling,
    reservedOutputTokens: input.reservedOutputTokens,
    storageProjectCwd: input.storageProjectCwd,
    workspaceManager: config.workspaceManager,
    mergeCoordinator: config.mergeCoordinator,
    createRegistryForCwd: config.createRegistryForCwd,
    requireWriteIsolation: config.requireWriteIsolation,
    coordinator: config.coordinator,
    coordinatorExecutorBridge: config.coordinatorExecutorBridge,
  }));
  return { registry, executor };
}

import type { LLMProvider, ToolExecutor, ToolRegistry, ExecutionEnvironmentFacts } from "../../zapsdk/index.js"
import type { ExecutionCapacityFacts } from "../../zapsdk/execution/capacity.js"

export interface AgentObjects {
  provider: LLMProvider
  registry: ToolRegistry
  executor: ToolExecutor
  modelId: string
  cwd: string
  executionFacts?: ExecutionEnvironmentFacts
  executionCapacity?: ExecutionCapacityFacts
  /** Commands run inside the OS sandbox or the VM (see PermissionManager). */
  sandboxConfined: boolean
  /** Rebuilds cwd-sensitive builtin tools while preserving live MCP/plugin
   * registrations. Used by isolated writing subagents. */
  createRegistryForCwd?: (cwd: string) => ToolRegistry
}

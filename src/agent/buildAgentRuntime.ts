import type { AgentBudget } from "../../zapsdk/agent/budget.js"
import type { TokenUsage } from "../../zapsdk/core/types.js"
import { watchObserver } from "../watch/integration.js"
import { taskStore } from "../singletons.js"
import type { CompletionEvidenceProvider } from "../../zapsdk/harness/completion.js"
import {
  createAgentRuntime,
  subagentTool,
  type AgentEventHandler,
  type AgentRuntime,
  type TodoStore,
} from "../../zapsdk/index.js"
import { AgentLogger } from "../../zapsdk/debug/agent-logger.js"
import type { CheckpointManager } from "../../zapsdk/checkpoint/index.js"
import type { ConversationManager } from "../../zapsdk/index.js"
import { devToolsSetAgent, devToolsSetReaders } from "../devtools-integration.js"
import { getActiveMaxOutputTokens, getActiveProvider, setVisionSupport } from "../config.js"
import type { AppConfig } from "../config.js"
import type { AgentObjects } from "./types.js"
import { resolveActiveContextLimits } from "../context-budget.js"
import {
  createProjectRuntimeEventStore,
  createProjectRuntimeStateStore,
} from "./runtimeEventStore.js"

export interface BuildAgentRuntimeDeps extends Pick<AgentObjects, "provider" | "registry" | "executor" | "cwd" | "createRegistryForCwd"> {
  budget?: AgentBudget
  initialUsage?: TokenUsage
  config: AppConfig
  completionEvidence?: CompletionEvidenceProvider
  conversation: ConversationManager
  fullSystemPrompt: string
  /** Explicit host instructions for descendants; excludes generated workflow sections. */
  inheritedInstructions?: string
  /** AutoCompact char threshold (≈ 80% context window × 4 chars/token). */
  autoCompactThreshold: number
  /** AutoCompact token threshold — catches CJK-heavy conversations where
   *  char/token ratio is much lower than 4. */
  autoCompactTokenThreshold: number
  agentLogger: AgentLogger
  currentSessionId: string
  checkpoint: CheckpointManager | null
  turnStartLogPosition: () => { journalLogIndex: number; uiLogIndex: number }
  todoStore: TodoStore
  subAgentEventHandler: AgentEventHandler
  onUpdateConfig?: (next: AppConfig) => void
}

/** Build the shared AgentRuntime facade for one host turn. RuntimeFactory owns
 * LoopAgent, workspace and merge assembly; this adapter only contributes TUI
 * config, checkpoint and devtools integration. */
export function buildAgentRuntime(deps: BuildAgentRuntimeDeps): AgentRuntime {
  const contextLimits = resolveActiveContextLimits(deps.config)
  const runtime = createAgentRuntime({
    threadId: deps.currentSessionId,
    observer: watchObserver(),
    harnessPolicy: { execution: { checkpoint: deps.config.fileCheckpointingEnabled === false ? "never" : "best-effort" } },
    backgroundTasks: { store: taskStore, disposition: "host" },
    completionEvidence: deps.completionEvidence,
    eventStore: createProjectRuntimeEventStore(deps.cwd),
    stateStore: createProjectRuntimeStateStore(deps.cwd),
    onEventStoreError: (error) => { deps.agentLogger.runtimeEventStoreError(error) },
    onRecovery: (reports) => { deps.agentLogger.runtimeRecovery(reports) },
    workspace: {
      root: deps.cwd,
      onTrackEdit: deps.checkpoint
        ? (paths) => deps.checkpoint!.trackEdits(paths)
        : undefined,
    },
    loopAgent: {
      budget: deps.budget,
      initialUsage: deps.initialUsage,
      onRunStart: async context => { await deps.checkpoint?.beginTurn(context.turnStartIndex, deps.turnStartLogPosition(), context.input) },
      provider: deps.provider,
      registry: deps.registry,
      executor: deps.executor,
      conversation: deps.conversation,
      systemPrompt: deps.fullSystemPrompt,
      promptProfile: deps.config.promptProfile ?? "standard",
      maxSteps: deps.config.maxSteps,
      reserveSteps: 2,
      maxToolRetries: 2,
      autoCompactThreshold: deps.autoCompactThreshold,
      autoCompactTokenThreshold: deps.autoCompactTokenThreshold,
      contextWindow: contextLimits.contextWindow,
      inputTokenLimit: contextLimits.inputLimit,
      outputTokenCeiling: getActiveMaxOutputTokens(deps.config),
      reservedOutputTokens: contextLimits.reservedOutputTokens,
      storageSessionId: deps.currentSessionId,
      storageProjectCwd: deps.cwd,
      sessionId: deps.currentSessionId,
      subagentFactory: subagentTool,
      onImageStripSelfHeal: () => {
        const active = getActiveProvider(deps.config)
        if (!active || !deps.onUpdateConfig) return
        deps.onUpdateConfig(
          setVisionSupport(deps.config, active.id, deps.config.active.model, false),
        )
      },
    },
    onRunEnd: async ({ turnStartIndex }) => {
      if (deps.checkpoint) {
        await deps.checkpoint.makeSnapshot(turnStartIndex, deps.turnStartLogPosition())
      }
    },
    subagent: {
      inheritedInstructions: deps.inheritedInstructions ?? deps.config.customSystemPrompt,
      onEvent: deps.subAgentEventHandler,
      todoStore: deps.todoStore,
      createRegistryForCwd: deps.createRegistryForCwd,
      requireWriteIsolation: true,
    },
  })

  deps.agentLogger.attach(runtime)
  devToolsSetAgent(runtime)
  devToolsSetReaders({
    getConversation: () => deps.conversation.getAllMessages(),
    getSystemPrompt: () => runtime.effectiveSystemPrompt() ?? deps.fullSystemPrompt,
    getConfig: () => deps.config,
  })

  return runtime
}

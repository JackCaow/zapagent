/**
 * ZapAgent SDK
 *
 * Fast, lightweight toolkit for building LLM-powered agents.
 * Domain-specific tools (code review, etc.) live in extensions/.
 */

// Core — LLM providers, types, retry
export { type Message, type ToolCallRequest, type LLMResponse, type TokenUsage, type LLMChunk, type ImageContent, type ContentBlock } from "./core/types.js";
export { createUserMessage, createSystemMessage, createToolResultMessage } from "./core/types.js";
export { type LLMProvider, type LLMCallOptions, type ProviderRequestEvent } from "./core/llm.js";
export { ProviderRequestTimeoutError } from "./core/provider-request.js";
export { AnthropicProvider, type AnthropicProviderOptions } from "./core/providers/anthropic.js";
export { ContextOverflowError } from "./core/errors.js";
export { OpenAIResponsesProvider, type OpenAIResponsesProviderOptions } from "./core/providers/openai-responses.js";
export { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from "./core/providers/openai-compatible.js";
export { RetryProvider, type RetryOptions, type CallOptions } from "./core/retry.js";
export { getModelsDevProvider, parseModelsDevProvider, suggestedModelsDevIds, clearModelsDevCache, type ModelsDevModel, type ModelsDevProvider } from "./core/models-dev.js";
export { ModelCatalogCache } from "./core/model-catalog-cache.js";
export { getModelsDevConnections, refreshModelsDevConnections, parseModelsDevConnections, type ModelsDevConnection } from "./core/models-dev.js";

// Tools — registry, executor, permissions
export { type Tool, type ToolDefinition, type ToolResult, type ToolHandler, type ToolPermission, type ToolExecutionContext } from "./tools/types.js";
export { emptyToolEffects, unknownToolEffects, inferredReadOnlyEffects, isEffectivelyReadOnly, effectsToResourceClaims, pathIsInsideRoot, DEFAULT_TOOL_RESOURCE_LIMITS, type EffectConfidence, type FileSystemEffect, type NetworkEffect, type ProcessEffect, type ExternalEffect, type WorkspaceEffect, type ToolEffects, type ToolEffectContext, type ToolResourceLimits, type ResourceClaim } from "./tools/effects.js";
export { resolveDefinitionEffects, isDefinitionCallReadOnly } from "./tools/compatibility.js";
export { adaptLegacyTool, inferToolSource, type ToolId, type ToolManifest, type ToolNamespace, type ToolSource } from "./tools/manifest.js";
export { ToolRegistry } from "./tools/registry.js";
export { type ToolApprovalFacts } from "./tools/approval.js";
export { ToolExecutor, isToolAuthorization, type ToolAuthorization, type ToolExecutorOptions, type ApprovalCallback, type ApprovalContext, type ApprovalResponse, type ApprovalDenial, type ApprovalCoordinator, type ApprovalLifecycleEvent, type ApprovalLifecycleHandler, type ApprovalLifecycleStatus, type ToolExecutionLifecycleEvent, type ToolExecutionLifecycleHandler, type ToolExecutionLifecycleStatus, type PostProcessCallback } from "./tools/executor.js";
export { DefaultToolPolicyEngine, createCapabilityGrant, type DefaultToolPolicyOptions, type AgentIdentity, type ApprovalRequest, type CapabilityGrant, type PolicyDecision, type PolicyRequest, type ResolvedToolCall, type ToolPolicyEngine, type WorkspaceIdentity } from "./policy/index.js";
export { DefaultExecutionBroker, TransparentExecutionBroker, ZapVmRuntime, HttpsZapVmCloudControlClient, buildZapVmExecArgs, createPlatformSandbox, hostPackageWriteRoots, NetworkProxy, DEFAULT_ALLOWED_DOMAINS, decideHost, type NetworkPolicy, createZapVmCloudExecutionBroker, deriveZapVmCloudComputerId, discoverZapVmCloudConfig, discoverZapVmInstallation, normalizeZapVmShellCommand, parseZapVmCloudConfig, readZapVmCapabilities, resolveZapVmGuestCwd, resolveZapVmNetworkPolicy, selectZapVmCloudConfigForWorkspace, type DefaultExecutionBrokerOptions, type PlatformSandboxOptions, type ExecutionBroker, type ExecutionBrokerRequest, type OsSandbox, type SandboxedCommand, type SandboxExecutionContext, type SandboxMode, type SandboxProviderKind, type SandboxStatus, type TransparentExecutionBrokerOptions, type ZapVmCloudConfig, type ZapVmCloudControlClient, type ZapVmCloudExecutionBrokerOptions, type ZapVmCloudFixedConfig, type ZapVmCloudLocalAutoConfig, type ZapVmCloudSubmit, type ZapVmCloudTask, type ZapVmCloudTaskEvent, type ZapVmInstallation, type ZapVmNetworkPolicy, type ZapVmRuntimeController, type ZapVmRuntimeOptions } from "./execution/index.js";
export { ToolBatchScheduler, resourceClaimsConflict, type BatchSchedulerOptions, type ToolRunStatus } from "./scheduler/index.js";
export { WorkspaceManager, WorkspaceRetentionManager, DEFAULT_WORKSPACE_RETENTION_POLICY, resolveWorkspaceTempRoot, WORKSPACE_BATCH_MARKER_FILE, WORKSPACE_BATCH_MARKER_VERSION, WorkspaceMarkerValidationError, readWorkspaceBatchMarker, validateWorkspaceBatchBoundary, writeWorkspaceBatchMarker, type HydrateWorkspaceInput, type WorkspaceManagerOptions, type WorkspaceRetentionPolicy, type WorkspaceRetentionReport, type WorkspaceBatchUsage, type WorkspaceRetentionRemoval, type WorkspaceRetentionSkip, type WorkspaceOwnerIdentity, type WorkspaceBatchMarker, type WorkspaceMode, type WorkspaceLease, type AgentArtifact, type MergeResult, type WorkspaceLifecycleEvent, type WorkspaceLifecycleHandler } from "./workspace/index.js";
export { MergeCoordinator, mergeAgentArtifactsTool, type MergeCoordinatorOptions, type MergeAgentArtifactsToolOptions, type MergeLifecycleEvent, type MergeLifecycleHandler } from "./merge/index.js";

// Agent — single-call, loop, events
export { SingleCallAgent, type SingleCallAgentOptions, type AgentResult } from "./agent/single-call.js";
export { resolvePromptProfile, type PromptProfile } from "./agent/prompt-profile.js";
export { LoopAgent, buildRuntimeTimeBudgetContext, type LoopAgentOptions, type LoopAgentResult, type RunOptions, type SteeringInput, type SubagentConfig, type SubagentFactory, type SubagentFactoryArgs, type RuntimeTimeBudget } from "./agent/loop.js";
export { AgentBudget, type AgentBudgetOptions, type AgentBudgetSnapshot } from "./agent/budget.js";
export { AgentEventEmitter, type AgentEvent, type AgentEventType, type AgentEventHandler, type AgentEventSource, type ContextDiagnostics, type ContextSegmentDiagnostics, type ConversationCacheDiagnostics, type ConversationCacheSliceDiagnostics } from "./agent/events.js";
export { AgentRunStore, type AgentRunStoreListener } from "./agent/run-store.js";
export { isTerminalAgentRunStatus, type AgentRunSnapshot, type AgentRunStatus } from "./agent/run-state.js";
export * from "./harness/index.js";
export * from "./coordinator/index.js";
export { computeCacheUsageStats, type CacheUsageInput, type CacheUsageStats } from "./agent/cache-metrics.js";
export { StreamingToolExecutor, type StreamingToolResult, StreamIdleTimeoutError, isStreamIdleTimeoutError } from "./agent/streaming-tool-executor.js";
export { type LoopState, createInitialLoopState, isOutputTokenLimit } from "./agent/state.js";

// Runtime — stable host protocol and shared production assembly
export * from "./runtime/index.js";

// Evals — pinned real-repository trajectories and deterministic graders
export * from "./evals/index.js";
export * from "./repo-index/index.js";
export * from "./host-protocol/index.js";

// Memory — conversation, auto-memory
export { ConversationManager, type ConversationManagerOptions } from "./memory/conversation.js";
export { AutoMemory } from "./memory/auto-memory.js";
export { persistCompactSummary } from "./memory/persist-compact-summary.js";
export { MD_MEMORY_TYPES, MD_MEMORY_PROVENANCE_ORIGINS, MD_MEMORY_CONFIDENCE_LEVELS, isMdMemoryType, mdMemoryContentHash, type MdFrontmatter, type MdMemoryType, type MdMemoryConfidence, type MdMemoryLifecycle, type MdMemoryLifecycleInput, type MdMemoryProvenance, type MdMemoryProvenanceEvent, type MdMemoryProvenanceInput, type MdMemoryProvenanceOrigin } from "./memory/md-types.js";
export { activeMdMemoryRecords, memoryConfidenceWeight, normalizeMdMemoryLifecycle, resolveMdMemoryLifecycles, type MdMemoryLifecycleProblem, type MdMemoryLifecycleProblemKind, type MdMemoryLifecycleResolution, type MdMemoryLifecycleState } from "./memory/md-lifecycle.js";
export { parseMdFile, serializeMdFile, type ParsedMdFile } from "./memory/md-frontmatter.js";
export { openMdStore, type MdMemoryRecord, type MdMemorySnapshot, type MdMemoryStore } from "./memory/md-store.js";
export { buildMdIndex, buildMdPack, type MdIndex, type MdPack, type MdPackOptions, type MdPackRecordDiagnostic, type MdPackSkipped, type MdPackSkipReason } from "./memory/md-pack.js";
export { reviewMemoryRecords, normalizeMemoryContent, normalizeMemoryIdentity, type MemoryReviewIssue, type MemoryReviewIssueKind, type MemoryReviewOptions, type MemoryReviewRecord, type MemoryReviewResult, type MemoryReviewScope, type MemoryReviewSuggestion, type MemoryReviewSuggestionKind, type MemoryReviewSuggestionSource, type MemoryReviewSuggestionTarget } from "./memory/review.js";
export { normalizeMemorySemanticScores, type MemorySemanticDocument, type MemorySemanticRequest, type MemorySemanticRetriever, type MemorySemanticScope } from "./memory/semantic.js";
export { LocalSparseMemoryRetriever, type LocalSparseMemoryRetrieverOptions } from "./memory/local-semantic.js";
export { evaluateMemoryRecall, assessMemoryRecallQuality, formatMemoryRecallEvalReport, type MemoryRecallEvalCase, type MemoryRecallEvalSelection, type MemoryRecallEvalRetriever, type MemoryRecallEvalOptions, type MemoryRecallEvalCaseResult, type MemoryRecallEvalReport, type MemoryRecallQualityThresholds, type MemoryRecallQualityAssessment } from "./memory/recall-eval.js";

// Context — token counting, compression
export { TokenCounter } from "./context/token-counter.js";
export { estimateImageTokens, resolveImageTokenRule, type ImageTokenContext, type ImageTokenRule, type ImageTokenEstimate } from "./context/image-tokens.js";
export { ResultCompressor, type ResultCompressorOptions } from "./context/result-compressor.js";
export { Microcompact, type MicrocompactOptions } from "./context/microcompact.js";
export { ReactiveCompact, type ReactiveCompactOptions } from "./context/reactive-compact.js";
export { AutoCompact, type AutoCompactOptions } from "./context/autocompact.js";
export { CompactInputReductionError, compactDecision, planCompact, type CompactOptions, type CompactPlan, type CompactResult } from "./context/compact.js";
export { restoreRecentFiles } from "./context/restore-files.js";
export { generateToolUseSummary, type ToolCallInfo } from "./context/tool-use-summary.js";

export { type BackgroundTaskLifecycle, type BackgroundTaskOwner } from "./tasks/lifecycle.js";

// MCP — Model Context Protocol integration
export {
  MCPManager,
  MCPError,
  type MCPErrorKind,
  type MCPEvent,
  type MCPEventHandler,
  type MCPServerCapabilities,
  type MCPServerConfig,
  type MCPServerSnapshot,
  type MCPStatus,
  type MCPTransportKind,
  type MCPResource,
  type MCPResourceTemplate,
  type MCPResourceContent,
  type MCPPrompt,
  type MCPPromptArg,
  type CompletionRef,
  type CompletionResult,
  namespaceToolName,
  denamespaceToolName,
  DEFAULTS as MCP_DEFAULTS,
  MCPTokenStore,
  type MCPOAuthEntry,
} from "./mcp/index.js";

// Skills — reusable agent templates
export { type SkillDefinition, type SkillParameter, type SkillInvocation } from "./skills/types.js";
export { SkillRegistry } from "./skills/registry.js";
export { SkillRunner, type SkillRunnerOptions } from "./skills/runner.js";

// Built-in Tools — general-purpose tools
export { createBuiltinRegistry, type BuiltinToolsOptions } from "./builtin-tools/index.js";
export { readFileTool, writeFileTool, listTreeTool } from "./builtin-tools/index.js";
export { editFileTool } from "./builtin-tools/index.js";
export { executeCommandTool } from "./builtin-tools/index.js";
export { taskStatusTool, taskStopTool, type TaskToolsOptions } from "./builtin-tools/index.js";
export { httpFetchTool, httpRequestTool, assertSafePublicHttpUrl } from "./builtin-tools/index.js";
export { searchFilesTool } from "./builtin-tools/index.js";
export { globFilesTool } from "./builtin-tools/index.js";
export { webSearchTool, createKeylessWebSearch, createSerpApiSearch, createSerperSearch, createBraveSearch, WebSearchBlockedError, type CurlRunner, type KeylessSearchOptions, type SearchResult, type SearchFunction, type WebSearchOptions } from "./builtin-tools/index.js";
export { currentTimeTool } from "./builtin-tools/index.js";
export { subagentTool, type SubagentToolOptions } from "./builtin-tools/index.js";
export { readDocumentTool, readPdfTool, readDocxTool } from "./builtin-tools/index.js";
export { todoWriteTool, renderTodoList, type TodoWriteToolOptions, type TodoStore, type Todo, type TodoStatus } from "./builtin-tools/index.js";
export { enterPlanModeTool, exitPlanModeTool, type PlanModeToolsOptions, type PlanModeCallbacks } from "./builtin-tools/index.js";
export { askUserQuestionTool, type AskUserToolOptions, type AskUserCallbacks, type AskUserQuestion, type AskUserAnswer } from "./builtin-tools/index.js";
export { browserScreenshotTool, findBrowser, type BrowserScreenshotOptions } from "./builtin-tools/index.js";
export { buildDiffMeta, buildUnifiedDiff, filetypeFromPath, isProbablyText, type DiffMeta } from "./builtin-tools/index.js";
export { memoryMergeTool, memoryReviewTool, memorySaveTool, type MemoryMergeToolOptions, type MemoryReviewToolOptions, type MemorySaveToolOptions } from "./builtin-tools/index.js";

// Debug — logging
export { Logger, type LogLevel, type LogEntry, type LoggerOptions } from "./debug/logger.js";
export { AgentLogger } from "./debug/agent-logger.js";

// Utils — platform helpers
export { getOS, IS_WINDOWS, IS_MACOS, IS_LINUX, detectShell, copyToClipboard, type OS } from "./utils/platform.js";
export { matchDangerous, DEFAULT_DANGEROUS_PATTERNS, type DangerousPattern } from "./utils/safety.js";
export type { ExecutionEnvironmentFacts, ShellExecutionEnvironment } from "./execution/types.js";
export { observeLocalExecutionCapacity, type ExecutionCapacityFacts } from "./execution/capacity.js";
export { EXECUTION_CONTRACT_VERSION, ExecutionOperationSchema, BackendCapabilitiesSchema,
  ResolvedExecutionPlanSchema, EnforcementReceiptSchema, ExecutionObservationSchema, OperationFailureSchema,
  type ExecutionOperation, type BackendCapabilities, type ResolvedExecutionPlan,
  type EnforcementReceipt, type ExecutionObservation, type OperationFailure,
  type OperationFailureCode } from "./execution/contracts.js";

// Optional Host service protocol; no tools or process owner are enabled by this export.
export * from "./services/index.js";

export { createResultSourceGuard, ResultSourcePolicySchema, type ResultSourcePolicy, type ToolResultGuard } from "./tools/result-source-policy.js";

export { planPrune, type PruneResult } from "./context/prune.js";

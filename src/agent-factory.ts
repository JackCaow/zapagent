import { modelCanonicalIds } from "./provider-metadata.js"
import { serviceTools } from "../zapsdk/services/tools.js"
// Builds the per-turn agent objects (provider, registry, executor) from
// the app config. Split out of App.tsx — pure factory, no React state.

import { join } from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import {
  OpenAICompatibleProvider,
  AnthropicProvider,
  RetryProvider,
  createBuiltinRegistry,
  ToolExecutor,
  createSerperSearch,
  type ApprovalCallback,
  type TodoStore,
  type PlanModeCallbacks,
  type AskUserCallbacks,
  DefaultToolPolicyEngine,
  type SandboxMode,
} from "../zapsdk/index.js"
import type { AppConfig } from "./config.js"
import { getActiveMaxOutputTokens, getActiveProvider, resolveVisionSupport } from "./config.js"
import type { CheckpointManager } from "../zapsdk/checkpoint/index.js"
import { loadAllSkills } from "../zapsdk/skills/loader.js"
import type { SkillDefinition } from "../zapsdk/skills/types.js"
import type { AgentEventHandler } from "../zapsdk/agent/events.js"
import { autoMemory, cronHandle, monitorHandle, taskStore, mdStore, globalMdStore, globalMemoryDir, delegateProviders, delegateEventBridge } from "./singletons.js"
import { memorySaveTool } from "../zapsdk/builtin-tools/memory.js"
import type { AgentObjects } from "./agent/types.js"
import { createMemoryReadPostProcess } from "./agent/memoryReadPostProcess.js"
import { createExecutionEnvironment, resolveExecutionBackend, type ExecutionEnvironment } from "./execution-environment.js"

const CWD_SENSITIVE_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "multi_edit",
  "delete_file", "move_file", "list_tree", "bash",
  "search_files", "glob_files", "read_document", "browser_screenshot", "delegate_agent",
])

function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return "" }
}

export function buildAgentObjects(
  config: AppConfig,
  onApproval?: ApprovalCallback,
  todoStore?: TodoStore,
  planCallbacks?: PlanModeCallbacks,
  checkpoint?: CheckpointManager | null,
  skills?: Map<string, SkillDefinition>,
  /** Override the working directory for tools that resolve relative paths
   *  (read_file, write_file, bash defaultCwd, …). Defaults to process.cwd().
   *  Used by `zapcode --cwd` and tests that run agents against fixtures. */
  cwdOverride?: string,
  /** Defaults to required. Headless eval harnesses may explicitly select
   *  disabled when an outer disposable container is the isolation boundary. */
  sandboxMode: SandboxMode = "required",
  executionEnvironment?: ExecutionEnvironment,
  /** Bind embedded/headless delegate events per registry, not to the TUI singleton. */
  delegateOnEvent?: AgentEventHandler,
  /** Interactive UI only: registers `ask_user_question`. Headless leaves it out. */
  askUserCallbacks?: AskUserCallbacks,
): AgentObjects {
  const effectiveCwd = cwdOverride ?? process.cwd()
  const environment = executionEnvironment ?? createExecutionEnvironment(effectiveCwd, sandboxMode, resolveExecutionBackend(config.executionBackend), config.allowUnsandboxedCommands !== false, config.sandboxNetwork, config.sandboxExcludedCommands)
  // The built-in read-only approvals are only safe while commands run inside the
  // OS sandbox or the VM; the caller hands this to its PermissionManager.
  let sandboxConfined = false
  try { sandboxConfined = environment.broker.sandboxStatus().available } catch { /* no status, no allowance */ }
  const allowedPaths = [effectiveCwd]
  const protectedPaths = [join(effectiveCwd, ".git"), join(effectiveCwd, ".zapcode")]
  const active = getActiveProvider(config)
  const baseURL = active?.baseURL ?? ""
  // First-run / unconfigured state: providers[] is empty so apiKey is "".
  // OpenAI + Anthropic SDKs both throw inside their constructors when key
  // is empty, which would crash App render before the user can reach
  // /connect. Pass a sentinel so construction succeeds; any actual send
  // will 401 and the user will be told to run /connect.
  const rawApiKey = active?.apiKey ?? ""
  const apiKey = rawApiKey || "unconfigured"
  const model = config.active.model
  const maxOutputTokens = getActiveMaxOutputTokens(config)
  // Protocol selection: explicit `protocol` field on the provider wins;
  // fall back to host substring detection so legacy configs (saved before
  // the field existed) still route the official Anthropic endpoint to
  // AnthropicProvider. Any third-party Anthropic-compatible service
  // (Z.AI/GLM, Kimi For Coding, LiteLLM, ccproxy, Bedrock proxy, etc.)
  // sets `protocol: "anthropic"` via its preset and works without
  // matching the api.anthropic.com host.
  const isAnthropic =
    active?.protocol === "anthropic" ||
    (active?.protocol === undefined && baseURL.toLowerCase().includes("api.anthropic.com"))
  // Anthropic SDK appends /v1/messages itself. User-facing baseURL keeps
  // the /v1 suffix for consistency with the OpenAI-compatible preset list,
  // so strip it here to avoid //v1/v1/messages → 404.
  const anthropicBaseURL = baseURL.replace(/\/v1\/?$/, "")
  // Moonshot's "Kimi For Coding" tier (api.kimi.com/coding/v1, also
  // api.moonshot.{cn,ai}) 403s any request whose User-Agent isn't on their
  // coding-agent allow-list (Kimi CLI, Claude Code, Roo, Kilo). The default
  // `openai` SDK UA + `x-stainless-*` fingerprint headers are rejected, so
  // impersonate claude-cli and null out the stainless leakers.
  const host = safeHost(baseURL)
  const needsKimiUA = /(^|\.)(kimi\.com|moonshot\.(cn|ai))$/i.test(host)
  const defaultHeaders = active?.authMode === "none"
    ? { "Authorization": null, "x-api-key": null } as unknown as Record<string, string>
    : needsKimiUA
    ? {
        "User-Agent": "claude-cli/1.0.0 (external, cli)",
        "x-stainless-arch": null,
        "x-stainless-lang": null,
        "x-stainless-os": null,
        "x-stainless-package-version": null,
        "x-stainless-retry-count": null,
        "x-stainless-runtime": null,
        "x-stainless-runtime-version": null,
      } as unknown as Record<string, string>
    : undefined
  const provider = new RetryProvider(
    isAnthropic
      ? new AnthropicProvider({
          maxRequestBytes: active?.maxRequestBytes,
          canonicalModelIds: modelCanonicalIds(active),
          model,
          client: new Anthropic({ apiKey, baseURL: anthropicBaseURL || undefined, maxRetries: 0,
            defaultHeaders: active?.authMode === "none" ? { "x-api-key": null, "Authorization": null } : undefined }),
          maxTokens: maxOutputTokens,
        })
      : new OpenAICompatibleProvider({
          maxRequestBytes: active?.maxRequestBytes,
          canonicalModelIds: modelCanonicalIds(active),
          model,
          baseURL,
          apiKey,
          maxTokens: maxOutputTokens,
          extraRequestParams: active?.extraRequestParams,
          defaultHeaders,
          // Up-front vision gate: explicit runtime override wins, followed by
          // models.dev modalities and positive name hints. Unknown preserves
          // images until an actual rejection triggers bounded runtime fallback.
          supportsVision: resolveVisionSupport(active, model),
        }),
    { maxRetries: 2, initialDelayMs: 1000 }
  )

  const registry = createBuiltinRegistry({
    readFile: { allowedPaths, useExecutionGrants: true },
    writeFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
    editFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
    multiEdit: { allowedPaths, protectedPaths, useExecutionGrants: true },
    deleteFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
    moveFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
    listTree: { allowedPaths, useExecutionGrants: true },
    searchFiles: { allowedPaths, useExecutionGrants: true },
    globFiles: { allowedPaths, useExecutionGrants: true },
    documentRead: { allowedPaths, useExecutionGrants: true },
    browserScreenshot: { allowedPaths },
    executeCommand: {
      timeoutMs: 60000,
      defaultCwd: effectiveCwd,
      // Main-agent bash gets the shared TaskStore so `run_in_background:true`
      // works. Sub-agent registries omit it (see subagent.ts), which strips
      // the field from the schema entirely — sub-agents don't spawn detached
      // tasks today; if they did, ownerAgentId routing + killByOwner would
      // be the path.
      store: taskStore,
      ...environment.commandOptions,
      executionShell: environment.facts?.shell,
    },
    webSearch: config.serperKey ? { searchFn: createSerperSearch(config.serperKey) } : undefined,
    // todo_write is registered only when a store is supplied — subagent
    // registries (constructed without this option) don't get the tool, which
    // matches CCB's "todos are main-agent-only" choice.
    todoWrite: todoStore ? { store: todoStore } : undefined,
    // Plan mode tools: main agent only. Blocks write/edit/bash while active
    // (enforced by the existing permissionMode=plan check in onApproval).
    planMode: planCallbacks ? { callbacks: planCallbacks } : undefined,
    askUser: askUserCallbacks ? { callbacks: askUserCallbacks } : undefined,
    // `skill` tool: lets the model pull in named-skill guidance mid-run
    // (CCB-parity). Main agent only; subagents don't get it.
    skill: skills ? {
      getSkill: (name) => skills.get(name) ?? null,
      listNames: () => Array.from(skills.keys()),
      refresh: () => {
        for (const [name, skill] of loadAllSkills(effectiveCwd)) {
          if (!skills.has(name)) skills.set(name, skill)
        }
      },
    } : undefined,
    // Cron + monitor: session-scoped singleton handles owned by the CLI
    // (see singletons.ts). Subagents strip these out of their cloned
    // registry — jobs created in a subagent would otherwise outlive it
    // and fire with main-agent authority.
    cronHandle,
    monitorHandle,
    taskTools: { store: taskStore },
    // Delegate (claude / codex CLI hand-off): only registered when the PATH
    // probe in singletons.ts found at least one provider. The onEvent forwards
    // through delegateEventBridge.handler so per-run code in useAgentRunner
    // can rebind the live sub-agent event handler without rebuilding the
    // registry on every turn.
    delegateAgent: delegateProviders.length > 0
      ? {
          providers: delegateProviders,
          onEvent: delegateOnEvent ?? ((ev) => delegateEventBridge.handler?.(ev)),
        }
      : undefined,
    exclude: [],
  })
  // The model can save a durable fact during normal work. Inventory review
  // and transactional maintenance are deliberately not ambient model tools;
  // /mem remains the explicit browse/delete surface until it gains dedicated
  // maintenance actions.
  try {
    registry.register(memorySaveTool({ store: mdStore, globalStore: globalMdStore }))
  } catch (err) {
    console.warn("[memory] tool registration failed:", err instanceof Error ? err.message : err)
  }
  const createRegistryForCwd = (workspaceCwd: string) => {
    const rebound = registry.clone()
    const allowedPaths = [workspaceCwd]
    const protectedPaths = [join(workspaceCwd, ".git"), join(workspaceCwd, ".zapcode")]
    const cwdBuiltins = createBuiltinRegistry({
      readFile: { allowedPaths, useExecutionGrants: true },
      writeFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
      editFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
      multiEdit: { allowedPaths, protectedPaths, useExecutionGrants: true },
      deleteFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
      moveFile: { allowedPaths, protectedPaths, useExecutionGrants: true },
      listTree: { allowedPaths, useExecutionGrants: true },
      searchFiles: { allowedPaths, useExecutionGrants: true },
      globFiles: { allowedPaths, useExecutionGrants: true },
      documentRead: { allowedPaths, useExecutionGrants: true },
      browserScreenshot: { allowedPaths },
      executeCommand: {
        timeoutMs: 60000,
        defaultCwd: workspaceCwd,
        ...environment.commandOptions,
        executionShell: environment.facts?.shell,
        disableBackgroundTasks: true,
        // Isolated subagent shells keep the brokered http tools as their only egress.
        sandboxNetwork: false,
      },
      webSearch: config.serperKey ? { searchFn: createSerperSearch(config.serperKey) } : undefined,
      exclude: [],
    })
    for (const definition of cwdBuiltins.definitions()) {
      if (!CWD_SENSITIVE_TOOLS.has(definition.name) || !rebound.has(definition.name)) continue
      rebound.unregister(definition.name)
      rebound.register(cwdBuiltins.get(definition.name)!)
    }
    // A child registry cannot inherit the root owner's service namespace.
    for (const definition of rebound.definitions()) if (definition.serviceOperation) rebound.unregister(definition.name)
    return rebound
  }
  const serviceWorkspace = { id: environment.workspaceId, root: effectiveCwd, mode: "root" as const }
  for (const tool of serviceTools(environment.broker, serviceWorkspace)) registry.register(tool)
  const executor = new ToolExecutor(registry, {
    timeoutMs: 120000,
    cwd: effectiveCwd,
    policyEngine: new DefaultToolPolicyEngine({ askOnUnknownEffects: true }),
    executionBroker: environment.broker,
    ...(environment.workspaceId ? { workspace: serviceWorkspace } : {}),
    onApproval,
    onTrackEdit: checkpoint?.createEditTracker(),
    postProcess: createMemoryReadPostProcess({ autoMemory, globalMemoryDir }),
  })

  return { provider, registry, executor, modelId: model, cwd: effectiveCwd, createRegistryForCwd, executionFacts: environment.facts, executionCapacity: environment.capacity, sandboxConfined }
}

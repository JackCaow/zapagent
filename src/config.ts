import { canonicalModelId } from "../zapsdk/core/model-identity.js"
import { existsSync, readFileSync } from "node:fs"
import { buildDefaultPrompt, type PromptContext } from "./prompts/index.js"
import { planDisciplineSection } from "./prompts/sections/plan-discipline.js"
import { skillsSection } from "./prompts/sections/skills.js"
import { toolPromptsSection } from "./prompts/sections/tool-prompts.js"
import { writeFileAtomic } from "./utils/secure-write.js"
import { DYNAMIC_BOUNDARY, escapeDynamicBoundaryText } from "../zapsdk/core/prompt-boundary.js"
import { resolvePromptProfile, type PromptProfile } from "../zapsdk/agent/prompt-profile.js"
import { concisePlanSection } from "./prompts/sections/concise.js"
import { recordPromptSection } from "./prompts/registry.js"
import { localExecutionShell } from "../zapsdk/execution/shell.js"

/** A built-in provider template. Templates are catalog-only: they seed the
 *  "Add Provider" wizard with sensible defaults, but never store runtime
 *  state. Once the user connects, a fresh `Provider` instance is created
 *  with a stable id (sp_<ts>) and templates play no further role. */
/** Wire protocol the provider speaks. Most third-party endpoints implement
 *  the OpenAI Chat Completions shape; Anthropic's official endpoint and a
 *  growing list of compatible proxies (Z.AI/GLM, Kimi For Coding, LiteLLM,
 *  ccproxy, Bedrock/Vertex Anthropic) speak the Anthropic Messages API.
 *  This field decides which SDK we instantiate in `agent-factory.ts`.
 *  Default (undefined) → "openai" with `api.anthropic.com` substring
 *  fallback so legacy configs without this field keep working. */
export type ProviderProtocol = "openai" | "anthropic"
export type ContextWindowMode = "auto" | "manual"

export interface ProviderPreset {
  id: string
  label: string
  baseURL: string
  requiresApiKey: boolean
  modelExamples: string[]
  contextWindow: number
  /** Provider id in the models.dev catalog. Omit for local/generic endpoints. */
  modelsDevProviderId?: string
  /** API protocol — see `ProviderProtocol`. Omit for OpenAI-compatible. */
  protocol?: ProviderProtocol
  /** Request-body opt-ins for this provider family (e.g. DeepSeek V4 thinking
   *  switch). Seeded onto new Provider instances created from the preset; the
   *  user can edit config.json to change them after. Providers that don't
   *  recognize the keys ignore them. */
  extraRequestParams?: Record<string, unknown>
  /** Reasoning effort values this provider family accepts. Drives the /model
   *  picker's effort cycler UI. The wire field is always flat top-level
   *  `reasoning_effort: string` (OpenAI-compat convention); the value sent is
   *  whatever the user picks, verbatim — server handles mapping if needed
   *  (DeepSeek maps low/medium→high, xhigh→max).
   *  - undefined  → picker uses OpenAI standard set (fallback for custom/self-host)
   *  - []         → no reasoning mode (picker disabled for this provider)
   *  - [...]      → cycler shows these values */
  effortValues?: readonly string[]
}

/** OpenAI's published reasoning_effort value set (o-series, gpt-5, etc.). Used
 *  as fallback for presets that don't define their own. `"none"` comes from
 *  OpenAI Responses API; we expose it as a first-class picker choice for the
 *  chat-completions endpoint too — if a provider rejects it, user sees 400. */
export const DEFAULT_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const

/** Stable subset of models.dev metadata persisted with a connected provider.
 *  Keeping this local means normal startup and model switching never depend on
 *  network access after /connect has completed. */
export interface ProviderModelMetadata {
  /** Underlying lab/model identity; never replaces the endpoint request model. */
  canonicalModelId?: string
  name?: string
  contextWindow?: number
  inputLimit?: number
  outputLimit?: number
  supportsVision?: boolean
  reasoning?: boolean
  toolCall?: boolean
  source?: "models.dev" | "provider" | "manual"
  /** Upstream publication date, not a claim of account access. */
  lastUpdated?: string
}

/** A user-owned provider binding. Single source of truth for everything
 *  associated with a provider: credentials, endpoint, available models.
 *  The `models[]` first entry is the default when switching to this
 *  provider via /connect. */
export interface Provider {
  /** Optional known endpoint JSON body limit in bytes; independent of tokens. */
  maxRequestBytes?: number
  id: string                   // "sp_<ts>" — stable identifier
  name: string                 // display alias (empty → falls back to baseURL)
  baseURL: string
  apiKey: string               // empty for keyless endpoints (Ollama)
  authMode?: "api-key" | "none"
  /** Exact public catalog identity, independent of endpoint and user alias. */
  catalogProviderId?: string
  contextWindow: number
  /** `auto` resolves per-model metadata/preset values. `manual` means the
   *  user explicitly overrode the context window in /connect. Optional only
   *  for legacy config compatibility; normalization always fills it. */
  contextWindowMode?: ContextWindowMode
  models: string[]
  sourcePresetId?: string      // which preset this was cloned from, for label/icon only
  /** API protocol — see `ProviderProtocol`. Omit for OpenAI-compatible. */
  protocol?: ProviderProtocol
  /** Passthrough kv-pairs spread into every chat.completions request body.
   *  Set by the preset at /connect time; user-editable via config.json. */
  extraRequestParams?: Record<string, unknown>
  /** Metadata keyed by model id. Populated during /connect and refreshed in
   *  the background at startup; /models remains the availability authority. */
  modelMetadata?: Record<string, ProviderModelMetadata>
  /** Per-model vision overrides. Keys are model ids; value `true` forces
   *  image content to be sent, `false` forces it to be stripped (replaced
   *  with a text breadcrumb). Otherwise catalog metadata and positive name
   *  hints apply; unknown capability preserves images. The host can persist
   *  LoopAgent's bounded image-rejection fallback here for subsequent runs. */
  visionByModel?: Record<string, boolean>
}

export interface CompactionConfig {
  auto: boolean      // auto-compact when approaching context limit
  prune: boolean     // tier 1: prune old tool outputs before summarizing
  reserved: number   // DEPRECATED: kept for config-file backwards compat. Thresholds are now derived from contextWindow via deriveCompaction().
}

export interface CompactionThresholds {
  /** Compress when estimated tokens exceed this. */
  triggerAt: number
  /** After compression, target total tokens at or below this. */
  keepFloorTokens: number
  /** Tokens reserved for the model's response (independent of compaction trigger). */
  reserveForOutput: number
}

export function deriveCompaction(contextWindow: number): CompactionThresholds {
  const normalizedWindow = positiveIntegerOrDefault(contextWindow, 128000)
  // Bytes the provider needs to reserve for the model's response. These
  // aren't available for input — clamping at 1k floor + 8k ceiling matches
  // most provider's expected response sizes (the 8k cap covers most replies
  // including long code edits; pinning at 10% of window so 1M-context
  // models don't waste 100k of headroom on a number that's actually constant
  // in practice).
  const reserveForOutput = Math.min(8192, Math.max(1024, Math.floor(normalizedWindow * 0.10)))
  // Effective window for input is the headroom we actually have. Used as
  // the basis for compact + warning thresholds so they fire on time even
  // for narrow context windows where the reservation is a meaningful slice.
  const effectiveWindow = normalizedWindow - reserveForOutput
  return {
    triggerAt: Math.floor(effectiveWindow * 0.80),
    keepFloorTokens: Math.floor(effectiveWindow * 0.40),
    reserveForOutput,
  }
}

export interface TokenWarningState {
  /** Percent of headroom remaining before auto-compact (0-100). */
  percentLeft: number
  /** True once usage crosses the 60% × window mark (heads-up). */
  isAboveWarningThreshold: boolean
  /** True once usage crosses the 70% × window mark (urgent — within
   *  ~10% of the auto-compact trigger). */
  isAboveErrorThreshold: boolean
  /** True when usage already past the auto-compact trigger (80% × window). */
  isAboveAutoCompactThreshold: boolean
}

/** Compute the warning state for the Prompt-side token usage indicator.
 *  Mirrors Claude Code's TokenWarning model: warning + error tiers below
 *  the auto-compact trigger so the user gets a heads-up well before the
 *  trigger fires. zap uses percentage tiers (vs Claude Code's absolute
 *  buffer) so the experience scales with both 200k and 1M context windows.
 *
 *  percentLeft is computed against `triggerAt` (auto-compact threshold),
 *  not the raw window — "5% until auto-compact" is the actionable number
 *  for the user, not "5% until prompt_too_long". */
export function calculateTokenWarningState(
  tokenUsage: number,
  contextWindow: number,
): TokenWarningState {
  // Warning tiers ladder up to the auto-compact triggerAt — using the
  // effective (output-reserved) window everywhere keeps "70% until
  // trigger" honest. Without subtracting the reserve, the 60/70%
  // markers and the eventual auto-compact trigger drift apart by
  // ~10% on narrow windows and we'd warn too late.
  const { triggerAt, reserveForOutput } = deriveCompaction(contextWindow)
  const effectiveWindow = Math.max(1, contextWindow - reserveForOutput)
  const percentLeft = Math.max(0, Math.round(((triggerAt - tokenUsage) / triggerAt) * 100))
  const warningAt = Math.floor(effectiveWindow * 0.60)
  const errorAt = Math.floor(effectiveWindow * 0.70)
  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningAt,
    isAboveErrorThreshold: tokenUsage >= errorAt,
    isAboveAutoCompactThreshold: tokenUsage >= triggerAt,
  }
}

// MCPServerConfig is owned by the SDK. We re-export the SDK shape so call
// sites that already import from "./config" don't have to change, but the
// authoritative definition lives in zapsdk/mcp/types.ts.
import type { MCPServerConfig as SDKMCPServerConfig } from "../zapsdk/mcp/types.js"
export type MCPServerConfig = SDKMCPServerConfig

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions"

/** Pointer to the currently active (provider, model) pair. Both fields
 *  must reference something that exists in `providers[]` — loadAppConfig
 *  normalises this on startup. */
export interface ActiveBinding {
  providerId: string
  model: string
}

export interface AppConfig {
  providers: Provider[]
  active: ActiveBinding
  serperKey: string
  maxTokens: number
  maxSteps: number
  customSystemPrompt: string
  promptProfile?: PromptProfile
  compaction: CompactionConfig
  mcpServers: MCPServerConfig[]
  permissionMode: PermissionMode
  followUpMode?: "queue" | "steer"
  /** Where project shell commands run. "local" (default) uses the host OS
   *  sandbox; "vm" routes them into zapVM. ZAPCODE_EXECUTION overrides. */
  executionBackend?: "local" | "vm"
  /** Let the model retry a sandbox-blocked bash command outside the OS
   *  sandbox, after explicit approval. Default true; false removes the option. */
  allowUnsandboxedCommands?: boolean
  /** Run every command that stays inside the OS sandbox without a prompt
   *  (Claude Code's default). false: only the read-only list skips the prompt. */
  autoAllowSandboxedCommands?: boolean
  /** Network policy for commands in the OS sandbox (enforced on macOS; other
   *  platforms keep open network for now). "allowlist" (default) lets commands
   *  reach package registries, git hosts and loopback only, plus allowedDomains;
   *  "open" turns the filter off. ZAPCODE_SANDBOX_NETWORK=open overrides. */
  /** Command patterns (bash-rule syntax, e.g. "*Google Chrome.app*", "docker:*") that
   *  always run outside the OS sandbox because they cannot work inside it. Each entry is
   *  your own risk decision. The command still goes through the normal permission rules
   *  (a prompt unless a rule allows it). Ignored when allowUnsandboxedCommands is false. */
  sandboxExcludedCommands?: string[]
  sandboxNetwork?: { mode?: "allowlist" | "open"; allowedDomains?: string[]; deniedDomains?: string[] }
  // Checkpoint / Rewind
  fileCheckpointingEnabled?: boolean
  maxSnapshotFileBytes?: number
  maxSnapshots?: number
  checkpointBlobDir?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai",     label: "OpenAI",                  baseURL: "https://api.openai.com/v1",                              requiresApiKey: true,  modelExamples: ["gpt-5", "gpt-5-mini"],                                contextWindow: 128000, modelsDevProviderId: "openai", effortValues: DEFAULT_EFFORT_VALUES },
  { id: "anthropic",  label: "Anthropic",                baseURL: "https://api.anthropic.com/v1",                           requiresApiKey: true,  modelExamples: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"], contextWindow: 1000000, modelsDevProviderId: "anthropic", effortValues: [], protocol: "anthropic" },
  { id: "anthropic-compat", label: "Anthropic Compatible (custom URL)", baseURL: "",                                          requiresApiKey: true,  modelExamples: ["glm-4.6", "kimi-k2", "claude-sonnet-4-6"],                  contextWindow: 200000,  effortValues: [], protocol: "anthropic" },
  { id: "gemini",     label: "Google Gemini",            baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",requiresApiKey: true,  modelExamples: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro"], contextWindow: 1000000, modelsDevProviderId: "google", effortValues: [] },
  { id: "xai",        label: "xAI (Grok)",               baseURL: "https://api.x.ai/v1",                                    requiresApiKey: true,  modelExamples: ["grok-4.20-0309-reasoning", "grok-4-1-fast-reasoning", "grok-code-fast-1"], contextWindow: 2000000, modelsDevProviderId: "xai" },
  { id: "moonshot",   label: "Moonshot (Kimi)",          baseURL: "https://api.moonshot.cn/v1",                             requiresApiKey: true,  modelExamples: ["kimi-k2.6", "kimi-k2.6-thinking", "kimi-k2.5"],       contextWindow: 256000, modelsDevProviderId: "moonshotai" },
  { id: "dashscope",  label: "阿里通义 DashScope",        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",       requiresApiKey: true,  modelExamples: ["qwen3-coder-plus", "qwen3-max", "qwen3-coder-flash"], contextWindow: 1000000, modelsDevProviderId: "alibaba" },
  { id: "openrouter", label: "OpenRouter",               baseURL: "https://openrouter.ai/api/v1",                           requiresApiKey: true,  modelExamples: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],     contextWindow: 128000, modelsDevProviderId: "openrouter" },
  { id: "deepseek",   label: "DeepSeek",                 baseURL: "https://api.deepseek.com/v1",                            requiresApiKey: true,  modelExamples: ["deepseek-v4-pro", "deepseek-v4-flash"],               contextWindow: 1000000, modelsDevProviderId: "deepseek", extraRequestParams: { thinking: { type: "enabled" } }, effortValues: ["high", "max"] },
  { id: "zhipu",      label: "Zhipu",                    baseURL: "https://open.bigmodel.cn/api/paas/v4",                   requiresApiKey: true,  modelExamples: ["glm-4.5", "glm-4.5-air"],                             contextWindow: 128000, modelsDevProviderId: "zhipuai" },
  { id: "minimax",    label: "MiniMax",                  baseURL: "https://api.minimaxi.com/v1",                            requiresApiKey: true,  modelExamples: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"], contextWindow: 200000, modelsDevProviderId: "minimax" },
  { id: "ollama",     label: "Ollama",                   baseURL: "http://127.0.0.1:11434/v1",                              requiresApiKey: false, modelExamples: ["qwen2.5-coder:7b", "llama3.1:8b"],                   contextWindow: 8192, effortValues: [] },
]

export const presetMap = new Map(PROVIDER_PRESETS.map(p => [p.id, p]))

/** Preset whose models.dev id equals `catalogProviderId`. The mapping is an
 *  explicit table (gemini→google, moonshot→moonshotai, ...), never inferred
 *  from a brand name or URL. */
export function presetForCatalogId(catalogProviderId: string | undefined): ProviderPreset | undefined {
  if (!catalogProviderId) return undefined
  return PROVIDER_PRESETS.find(preset => preset.modelsDevProviderId === catalogProviderId)
}

function sameHost(a: string, b: string): boolean {
  try { return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase() } catch { return false }
}

/** Preset for a connection identified by its catalog id, but only while the
 *  connection still points at the preset's own host. A gateway that merely
 *  carries the same catalog id (a different host) must not inherit preset
 *  request params, effort values or context window. */
export function presetForConnection(catalogProviderId: string | undefined, baseURL: string): ProviderPreset | undefined {
  const preset = presetForCatalogId(catalogProviderId)
  if (!preset) return undefined
  return !preset.baseURL || sameHost(preset.baseURL, baseURL) ? preset : undefined
}

/** The models.dev provider id to query for a connection. A preset id is not a
 *  models.dev id, so a preset-only legacy provider goes through the preset's
 *  `modelsDevProviderId` instead of being passed along verbatim. */
export function resolveCatalogProviderId(
  provider: Pick<Provider, "catalogProviderId" | "sourcePresetId">,
): string | undefined {
  if (provider.catalogProviderId) return provider.catalogProviderId
  return provider.sourcePresetId ? presetMap.get(provider.sourcePresetId)?.modelsDevProviderId : undefined
}

/** Detect which preset a baseURL was likely cloned from. Used to stamp
 *  `sourcePresetId` on env-var bootstrapped providers and to label legacy
 *  configurations. Returns undefined for URLs that don't match any preset. */
export function detectPresetId(baseURL: string): string | undefined {
  const n = baseURL.toLowerCase()
  if (n.includes("openrouter.ai"))                   return "openrouter"
  if (n.includes("deepseek.com"))                    return "deepseek"
  if (n.includes("bigmodel.cn"))                     return "zhipu"
  if (n.includes("11434"))                           return "ollama"
  if (n.includes("api.openai.com"))                  return "openai"
  if (n.includes("api.anthropic.com"))               return "anthropic"
  if (n.includes("generativelanguage.googleapis"))   return "gemini"
  if (n.includes("api.x.ai"))                        return "xai"
  if (n.includes("api.moonshot"))                    return "moonshot"
  if (n.includes("dashscope.aliyun"))                return "dashscope"
  if (n.includes("minimaxi.com") || n.includes("api.minimax")) return "minimax"
  return undefined
}

// ── Default / load / save ──────────────────────────────────────────────────

interface BootstrapEnvironment {
  baseURL: string
  apiKey: string
  model: string
  serperKey: string
}

type MutableEnvironment = Record<string, string | undefined>

/**
 * Capture the credentials injected by the zapVM Guest runner, then remove
 * them from the process environment before any Bash/tool child process can
 * inherit them. The returned values live only in this process and are reused
 * by later config reloads.
 */
export function consumeResidentCredentialEnvironment(env: MutableEnvironment): BootstrapEnvironment {
  const captured = {
    baseURL: env.OPENAI_BASE_URL ?? "",
    apiKey: env.OPENAI_API_KEY ?? "",
    model: env.MODEL ?? "",
    serperKey: env.SERPER_KEY ?? "",
  }
  delete env.OPENAI_API_KEY
  delete env.SERPER_KEY
  return captured
}

let residentBootstrapEnvironment: BootstrapEnvironment | undefined

function getBootstrapEnvironment(): BootstrapEnvironment {
  if (process.env.ZAPCODE_CONSUME_ENV_CREDENTIALS === "1") {
    residentBootstrapEnvironment ??= consumeResidentCredentialEnvironment(process.env)
    return residentBootstrapEnvironment
  }
  return {
    baseURL: process.env.OPENAI_BASE_URL ?? "",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.MODEL ?? "",
    serperKey: process.env.SERPER_KEY ?? "",
  }
}

export function getDefaultConfig(): AppConfig {
  // Seed from env vars if present — lets CI/one-shot users run without
  // going through /connect. If neither is set, providers[] starts empty.
  const bootstrap = getBootstrapEnvironment()
  const envBase = bootstrap.baseURL
  const envKey = bootstrap.apiKey
  const envModel = bootstrap.model
  const providers: Provider[] = []
  let active: ActiveBinding = { providerId: "", model: "" }
  if (envBase) {
    const presetId = detectPresetId(envBase)
    const preset = presetId ? presetMap.get(presetId) : undefined
    const sp: Provider = {
      id: `sp_${Date.now()}`,
      name: preset?.label ?? "",
      baseURL: envBase,
      apiKey: envKey,
      contextWindow: preset?.contextWindow ?? 128000,
      contextWindowMode: preset?.baseURL ? "auto" : "manual",
      models: envModel ? [envModel] : [],
      sourcePresetId: presetId,
      catalogProviderId: preset?.modelsDevProviderId,
      protocol: preset?.protocol,
      extraRequestParams: preset?.extraRequestParams,
    }
    providers.push(sp)
    active = { providerId: sp.id, model: envModel }
  }
  return {
    providers,
    active,
    followUpMode: "queue",
    executionBackend: "local",
    allowUnsandboxedCommands: true,
    autoAllowSandboxedCommands: true,
    serperKey: bootstrap.serperKey,
    // 64k 给推理模型 + 大 tool call payload（整页 write_file 脚本）
    // 留足余量。原值 4096 在 reasoning_content 也计入 max_tokens 的模型
    // 上直接打满、tool_call JSON 没闭合、agent 空转。
    maxTokens: 65536,
    maxSteps: 200,
    customSystemPrompt: "",
    promptProfile: "standard",
    compaction: { auto: true, prune: true, reserved: 20000 },
    mcpServers: [],
    permissionMode: "default",
    fileCheckpointingEnabled: true,
    maxSnapshotFileBytes: 10 * 1024 * 1024,
    maxSnapshots: 100,
  }
}

/** Enforce all config invariants:
 *   - every provider has a non-empty id and models array (may be empty)
 *   - active.providerId exists in providers[] (or is empty if providers[]=[])
 *   - active.model exists in its provider's models[] (fallback: models[0] or "")
 *
 *  Callers can rely on the result so read paths don't need defensive checks. */
function normalize(config: AppConfig): AppConfig {
  const defaults = getDefaultConfig()
  const providers = (config.providers ?? [])
    .map((p, index) => normalizeProvider(p, index))
    .filter((p): p is Provider => p !== null)
  let activeProviderId = config.active?.providerId ?? ""
  let activeModel = config.active?.model ?? ""
  const active = providers.find(p => p.id === activeProviderId)
  if (!active) {
    const fallback = providers[0]
    activeProviderId = fallback?.id ?? ""
    activeModel = fallback?.models[0] ?? ""
  } else if (activeModel && !active.models.includes(activeModel)) {
    activeModel = active.models[0] ?? ""
  } else if (!activeModel) {
    activeModel = active.models[0] ?? ""
  }
  const compaction = isRecord(config.compaction) ? config.compaction : defaults.compaction
  return {
    ...config,
    providers,
    promptProfile: resolvePromptProfile(config.promptProfile),
    followUpMode: config.followUpMode === "steer" ? "steer" : "queue",
    executionBackend: config.executionBackend === "vm" ? "vm" : "local",
    allowUnsandboxedCommands: config.allowUnsandboxedCommands !== false,
    autoAllowSandboxedCommands: config.autoAllowSandboxedCommands !== false,
    active: { providerId: activeProviderId, model: activeModel },
    maxTokens: nonNegativeIntegerOrDefault(config.maxTokens, defaults.maxTokens),
    maxSteps: nonNegativeIntegerOrDefault(config.maxSteps, defaults.maxSteps),
    compaction: {
      auto: typeof compaction.auto === "boolean" ? compaction.auto : defaults.compaction.auto,
      prune: typeof compaction.prune === "boolean" ? compaction.prune : defaults.compaction.prune,
      reserved: nonNegativeIntegerOrDefault(compaction.reserved, defaults.compaction.reserved),
    },
    maxSnapshotFileBytes: nonNegativeIntegerOrDefault(config.maxSnapshotFileBytes, defaults.maxSnapshotFileBytes ?? 10 * 1024 * 1024),
    maxSnapshots: nonNegativeIntegerOrDefault(config.maxSnapshots, defaults.maxSnapshots ?? 100),
  }
}

function normalizeProvider(value: unknown, index: number): Provider | null {
  if (!isRecord(value)) return null
  const modelMetadata = normalizeModelMetadata(value.modelMetadata)
  const provider = {
    ...value,
    id: typeof value.id === "string" && value.id.trim() ? value.id : `sp_${Date.now()}_${index}`,
    name: typeof value.name === "string" ? value.name : "",
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    authMode: value.authMode === "none" ? "none" : value.authMode === "api-key" ? "api-key" : undefined,
    catalogProviderId: typeof value.catalogProviderId === "string" ? value.catalogProviderId : undefined,
    contextWindow: positiveIntegerOrDefault(value.contextWindow, 128000),
    models: Array.isArray(value.models)
      ? value.models.filter((m): m is string => typeof m === "string" && !!m)
      : [],
    protocol: value.protocol === "anthropic" || value.protocol === "openai" ? value.protocol : undefined,
    modelMetadata,
  } as Provider
  provider.contextWindowMode = value.contextWindowMode === "auto" || value.contextWindowMode === "manual"
    ? value.contextWindowMode
    : inferLegacyContextWindowMode(provider)
  migratePresetIdentity(provider)
  return provider
}

/** Repair connections written by earlier versions. Providers saved with only a
 *  `sourcePresetId` lose models.dev metadata (the preset id is not a catalog
 *  id), and connections created from the provider directory without a preset
 *  never received the preset's request params (DeepSeek thinking) or effort
 *  values. Both are derived from the explicit preset/catalog tables. */
function migratePresetIdentity(provider: Provider): void {
  if (!provider.catalogProviderId && provider.sourcePresetId) {
    provider.catalogProviderId = presetMap.get(provider.sourcePresetId)?.modelsDevProviderId
  }
  if (!provider.sourcePresetId) {
    const preset = presetForConnection(provider.catalogProviderId, provider.baseURL)
    if (preset) {
      provider.sourcePresetId = preset.id
      if (!provider.extraRequestParams && preset.extraRequestParams) {
        provider.extraRequestParams = structuredClone(preset.extraRequestParams)
      }
    }
  }
}

/** Infer intent for configs written before contextWindowMode existed.
 *
 * Old preset creation always leaked the wizard's 128k initial value into the
 * saved provider. Treat that shape as auto only when it still points at the
 * preset endpoint. Divergent endpoints or deliberate non-default values stay
 * manual so migration does not silently rewrite custom deployments. */
export function inferLegacyContextWindowMode(provider: Provider): ContextWindowMode {
  const preset = provider.sourcePresetId ? presetMap.get(provider.sourcePresetId) : undefined
  if (!preset || !preset.baseURL) return "manual"
  const sameEndpoint = normalizeBaseURL(provider.baseURL) === normalizeBaseURL(preset.baseURL)
  if (!sameEndpoint) return "manual"
  const hasCatalogMetadata = Object.values(provider.modelMetadata ?? {})
    .some(metadata => metadata.source === "models.dev")
  if (hasCatalogMetadata || provider.contextWindow === 128000 || provider.contextWindow === preset.contextWindow) {
    return "auto"
  }
  return "manual"
}

function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase()
}

function normalizeModelMetadata(value: unknown): Record<string, ProviderModelMetadata> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, ProviderModelMetadata> = {}
  for (const [modelId, raw] of Object.entries(value)) {
    if (!modelId || !isRecord(raw)) continue
    const metadata: ProviderModelMetadata = {}
    if (typeof raw.name === "string" && raw.name) metadata.name = raw.name
    const identity = canonicalModelId(raw.canonicalModelId)
    if (identity) metadata.canonicalModelId = identity
    const contextWindow = nonNegativeInteger(raw.contextWindow)
    const inputLimit = nonNegativeInteger(raw.inputLimit)
    const outputLimit = nonNegativeInteger(raw.outputLimit)
    if (contextWindow && contextWindow > 0) metadata.contextWindow = contextWindow
    if (inputLimit && inputLimit > 0) metadata.inputLimit = inputLimit
    if (outputLimit && outputLimit > 0) metadata.outputLimit = outputLimit
    if (typeof raw.supportsVision === "boolean") metadata.supportsVision = raw.supportsVision
    if (typeof raw.reasoning === "boolean") metadata.reasoning = raw.reasoning
    if (typeof raw.toolCall === "boolean") metadata.toolCall = raw.toolCall
    if (raw.source === "models.dev" || raw.source === "provider" || raw.source === "manual") metadata.source = raw.source
    if (typeof raw.lastUpdated === "string") metadata.lastUpdated = raw.lastUpdated
    if (Object.keys(metadata).length > 0) result[modelId] = metadata
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number): number {
  return nonNegativeInteger(value) ?? fallback
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const numeric = nonNegativeInteger(value)
  return numeric !== undefined && numeric > 0 ? numeric : fallback
}

export function loadAppConfig(configPath: string): AppConfig {
  const defaults = getDefaultConfig()
  if (process.env.ZAP_DISABLE_FILE_CHECKPOINTING === "1") {
    defaults.fileCheckpointingEnabled = false
  }
  if (!existsSync(configPath)) {
    const withProjectMcp = mergeProjectMCPJson(defaults)
    return withProjectMcp
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<AppConfig>
    const merged: AppConfig = {
      ...defaults,
      ...parsed,
      providers: Array.isArray(parsed.providers) ? parsed.providers : defaults.providers,
      active: parsed.active ?? defaults.active,
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      permissionMode: "default",   // session-scoped
    }
    if (process.env.ZAP_DISABLE_FILE_CHECKPOINTING === "1") {
      merged.fileCheckpointingEnabled = false
    }
    return normalize(mergeProjectMCPJson(merged))
  } catch {
    return mergeProjectMCPJson(defaults)
  }
}

/**
 * Read `<cwd>/.mcp.json` (Claude Code's project-level MCP config format)
 * and fold its servers into the active config. Project-defined entries
 * take precedence over identically-named entries in user config — this is
 * the "project owns its tooling" inversion that Claude Code uses.
 *
 * .mcp.json format:
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 *
 * We map to our flat array shape and tag transport (stdio is the only
 * Claude Code-compatible transport, but a "url" key is treated as http).
 */
function mergeProjectMCPJson(base: AppConfig): AppConfig {
  try {
    const projectMcpPath = `${process.cwd()}/.mcp.json`
    if (!existsSync(projectMcpPath)) return base
    const raw = JSON.parse(readFileSync(projectMcpPath, "utf-8")) as {
      mcpServers?: Record<string, Record<string, unknown>>
    }
    const entries = raw.mcpServers ?? {}
    const projectServers: import("../zapsdk/mcp/types.js").MCPServerConfig[] = []
    for (const [name, def] of Object.entries(entries)) {
      const url = def.url as string | undefined
      const transport: "stdio" | "http" | "sse" = url
        ? ((def.transport as "http" | "sse") ?? "http")
        : "stdio"
      projectServers.push({
        name,
        transport,
        command: def.command as string | undefined,
        args: def.args as string[] | undefined,
        env: def.env as Record<string, string> | undefined,
        url,
        headers: def.headers as Record<string, string> | undefined,
      })
    }
    if (projectServers.length === 0) return base

    // Project overrides user config on name collision.
    const byName = new Map(base.mcpServers.map((s) => [s.name, s]))
    for (const s of projectServers) byName.set(s.name, s)
    return { ...base, mcpServers: [...byName.values()] }
  } catch {
    return base
  }
}

export function saveAppConfig(configPath: string, config: AppConfig): void {
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
}

// ── Vision capability detection ─────────────────────────────────────────────
//
// Decides whether a given model can accept image content blocks. Three layers:
//
//   1. `Provider.visionByModel` — per-model boolean overrides. `true` forces
//      pass-through, `false` forces stripping (text breadcrumb). User-editable
//      in config.json; LoopAgent also writes `false` here when a 400 image
//      rejection comes back, so the next turn skips the round-trip.
//
//   2. `Provider.modelMetadata` — models.dev's declared input modalities.
//
//   3. `inferVisionSupport(modelId)` — positive-list regex on the model id.
//      A matching name is a positive hint; an unmatched name is unknown,
//      not evidence of text-only support. Unknown models receive images so
//      a real schema-level rejection can trigger the bounded runtime fallback.

const VISION_MODEL_PATTERNS: RegExp[] = [
  /(^|[-/])gpt-(4o|4-vision|4-turbo|5)/i,                   // OpenAI gpt-4o, gpt-5, gpt-4-turbo (post-vision), gpt-4-vision
  /(^|[-/])o[1-9](-|$)/i,                                    // OpenAI o1, o3, o4 reasoning series
  /(^|[-/])claude-([3-9]|opus|sonnet|haiku)/i,               // All Claude 3+, all named tiers from 4.x onward
  /(^|[-/])gemini-([1-9]\.[5-9]|[2-9])/i,                    // Gemini 1.5+, 2.x, 3.x
  /(^|[-/])gemini-pro-vision/i,
  /(^|[-/])(pixtral|llava|cogvlm|internvl|minicpm-v)/i,      // Mistral / Meta / OpenGVLab / OpenBMB families
  /(^|[-/])qwen[0-9]?(\.[0-9])?-?vl/i,                       // qwen-vl, qwen2-vl, qwen2.5-vl, qwen3-vl
  /(^|[-/])deepseek.*vl/i,                                   // deepseek-vl, deepseek-vl2
  /(^|[-/])grok-(2|3|4)-vision/i,                            // xAI vision tiers
  /(^|[-/])(vision|-vl[-2]|-vl$)/i,                          // catch-all "*-vision" / "*-vl" suffixes
]

/** Positive model-name hints only. Absence of a match leaves capability unknown. */
export function inferVisionSupport(modelId: string): true | undefined {
  return VISION_MODEL_PATTERNS.some(re => re.test(modelId)) ? true : undefined
}

/** Resolve the effective vision support for (provider, model). Runtime/user
 *  override wins, then models.dev metadata, then the local heuristic. */
export function resolveVisionSupport(provider: Provider | null | undefined, modelId: string): boolean | undefined {
  if (!provider) return inferVisionSupport(modelId)
  const explicit = provider.visionByModel?.[modelId]
  if (typeof explicit === "boolean") return explicit
  const catalogValue = provider.modelMetadata?.[modelId]?.supportsVision
  if (typeof catalogValue === "boolean") return catalogValue
  return inferVisionSupport(modelId)
}

/** Persist a per-model vision flag onto a Provider. Used by LoopAgent's
 *  runtime fallback after a 400 image rejection — flipping `false` here
 *  prevents the same error on the next turn. Returns a new AppConfig. */
export function setVisionSupport(config: AppConfig, providerId: string, modelId: string, supported: boolean): AppConfig {
  const providers = config.providers.map(p => {
    if (p.id !== providerId) return p
    const next = { ...(p.visionByModel ?? {}) }
    next[modelId] = supported
    return { ...p, visionByModel: next }
  })
  return normalize({ ...config, providers })
}

// ── Provider / active accessors ─────────────────────────────────────────────

export function getActiveProvider(config: AppConfig): Provider | null {
  return config.providers.find(p => p.id === config.active.providerId) ?? null
}

export function getActiveContextWindow(config: AppConfig): number {
  const provider = getActiveProvider(config)
  return resolveProviderContextWindow(provider, config.active.model)
}

/** Resolve one provider/model context using the same precedence everywhere.
 * Manual is an explicit user contract. Auto follows model metadata, then the
 * preset family default, then the persisted compatibility snapshot. */
export function resolveProviderContextWindow(
  provider: Provider | null | undefined,
  modelId: string,
): number {
  if (!provider) return 128000
  const mode = provider.contextWindowMode ?? inferLegacyContextWindowMode(provider)
  if (mode === "manual") return positiveIntegerOrDefault(provider.contextWindow, 128000)
  const modelContext = provider.modelMetadata?.[modelId]?.contextWindow
  const presetContext = provider.sourcePresetId
    ? presetMap.get(provider.sourcePresetId)?.contextWindow
    : undefined
  return positiveIntegerOrDefault(
    modelContext,
    positiveIntegerOrDefault(presetContext, positiveIntegerOrDefault(provider.contextWindow, 128000)),
  )
}

/** User maxTokens capped to the selected model's advertised output limit. */
export function getActiveMaxOutputTokens(config: AppConfig): number {
  const provider = getActiveProvider(config)
  const modelLimit = provider?.modelMetadata?.[config.active.model]?.outputLimit
  const configured = nonNegativeIntegerOrDefault(config.maxTokens, getDefaultConfig().maxTokens)
  return modelLimit ? Math.min(configured, modelLimit) : configured
}

export function getProviderDisplayName(config: AppConfig): string {
  const p = getActiveProvider(config)
  if (!p) return "(no provider)"
  if (p.name) return p.name
  const preset = p.sourcePresetId ? presetMap.get(p.sourcePresetId) : undefined
  return preset?.label ?? p.baseURL
}

export function hasApiKey(config: AppConfig): boolean {
  const p = getActiveProvider(config)
  if (!p) return false
  if (p.authMode === "none") return true
  // Keyless endpoints (Ollama) are detected via their source preset's
  // requiresApiKey flag; providers with no sourcePresetId must always have a key.
  const preset = p.sourcePresetId ? presetMap.get(p.sourcePresetId) : undefined
  if (preset && !preset.requiresApiKey) return true
  return Boolean(p.apiKey.trim())
}

// ── Provider mutations (pure — all return new configs) ─────────────────────

export function upsertProvider(config: AppConfig, provider: Provider): AppConfig {
  const idx = config.providers.findIndex(p => p.id === provider.id)
  const providers = idx >= 0
    ? config.providers.map((p, i) => i === idx ? provider : p)
    : [...config.providers, provider]
  return normalize({ ...config, providers })
}

export function removeProvider(config: AppConfig, id: string): AppConfig {
  const providers = config.providers.filter(p => p.id !== id)
  // If we removed the active provider, normalize() will repoint active
  // at providers[0] (or clear it if the list is empty).
  const active = config.active.providerId === id
    ? { providerId: "", model: "" }
    : config.active
  return normalize({ ...config, providers, active })
}

export function setActive(config: AppConfig, providerId: string, model: string): AppConfig {
  return normalize({ ...config, active: { providerId, model } })
}

/** Append a model to a provider's models[]. If `makeActive` is true, also
 *  switches `active` to (providerId, model). Duplicate names are ignored. */
export function addModelToProvider(config: AppConfig, providerId: string, model: string, makeActive = false): AppConfig {
  const trimmed = model.trim()
  if (!trimmed) return config
  const providers = config.providers.map(p => {
    if (p.id !== providerId) return p
    if (p.models.includes(trimmed)) return p
    return { ...p, models: [...p.models, trimmed] }
  })
  const next = { ...config, providers }
  return normalize(makeActive ? { ...next, active: { providerId, model: trimmed } } : next)
}

/** Remove a model from a provider. If it was active, the active model
 *  falls back to the provider's next model (or any other provider's first
 *  model) via normalize(). */
export function removeModelFromProvider(config: AppConfig, providerId: string, model: string): AppConfig {
  const providers = config.providers.map(p =>
    p.id === providerId ? { ...p, models: p.models.filter(m => m !== model) } : p)
  return normalize({ ...config, providers })
}

// ── Reasoning effort accessors ─────────────────────────────────────────────
// The wire field is always flat `reasoning_effort: string` on the OpenAI-
// compatible chat-completions endpoint (OpenAI o-series, DeepSeek V4, Kimi
// k2-thinking all follow this). Stored at `provider.extraRequestParams.
// reasoning_effort`; "unset" = key absent, server uses its own default.

/** Values the /model picker cycler offers for this provider. Falls back to
 *  the default set when the preset doesn't constrain the range. `[]` means
 *  the provider has no reasoning mode and the cycler should be hidden. */
export function getEffortValuesForProvider(config: AppConfig, providerId: string): readonly string[] {
  const p = config.providers.find(x => x.id === providerId)
  const preset = p?.sourcePresetId ? presetMap.get(p.sourcePresetId) : undefined
  return preset?.effortValues ?? DEFAULT_EFFORT_VALUES
}

/** Whether the value set above was explicitly declared by the preset (true)
 *  or is the fallback default (false). Callers use this to decide between
 *  strict validation and permissive passthrough — for multi-backend proxies
 *  (sub2api, custom self-host, etc.) we have no authoritative value list,
 *  so `/effort <value>` must accept anything the user types and let the
 *  upstream server enforce its own rules. */
export function hasDeclaredEffortValues(config: AppConfig, providerId: string): boolean {
  const p = config.providers.find(x => x.id === providerId)
  const preset = p?.sourcePresetId ? presetMap.get(p.sourcePresetId) : undefined
  return preset?.effortValues !== undefined
}

/** Check a user-typed `/effort <value>` against the provider's declared values.
 *  Presets that declare their values are validated strictly (a typo would
 *  otherwise be persisted and sent upstream on every request). Providers with
 *  no declaration (self-hosted, multi-backend proxies) pass any value through
 *  and let the upstream enforce its own rules. Returns the canonical value. */
export function resolveEffortInput(
  config: AppConfig,
  providerId: string,
  input: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = input.trim()
  if (!hasDeclaredEffortValues(config, providerId)) return { ok: true, value }
  const values = getEffortValuesForProvider(config, providerId)
  const name = config.providers.find(p => p.id === providerId)?.name ?? "This provider"
  if (values.length === 0) {
    return { ok: false, message: `${name} has no reasoning effort setting` }
  }
  const match = values.find(candidate => candidate.toLowerCase() === value.toLowerCase())
  if (!match) {
    return { ok: false, message: `Unknown effort "${value}" for ${name}. Use: off, ${values.join(", ")}` }
  }
  return { ok: true, value: match }
}

/** Current effort, or undefined if unset (= use server default). */
export function getEffort(config: AppConfig, providerId: string): string | undefined {
  const p = config.providers.find(x => x.id === providerId)
  const v = p?.extraRequestParams?.reasoning_effort
  return typeof v === "string" ? v : undefined
}

/** Set or clear effort on a provider. `null` removes the key entirely so the
 *  request body doesn't carry `reasoning_effort` at all — servers apply their
 *  own default. Writes back through normalize(). */
export function setEffort(config: AppConfig, providerId: string, value: string | null): AppConfig {
  const providers = config.providers.map(p => {
    if (p.id !== providerId) return p
    const extra = { ...(p.extraRequestParams ?? {}) }
    if (value === null) delete extra.reasoning_effort
    else extra.reasoning_effort = value
    return { ...p, extraRequestParams: extra }
  })
  return normalize({ ...config, providers })
}

/** Return the next effort value in the cycle for this provider. Cycle shape:
 *   off → values[0] → values[1] → … → values[N-1] → off
 *  So passing the current effort always lands on a valid next state. */
export function cycleEffort(config: AppConfig, providerId: string): string | null {
  const values = getEffortValuesForProvider(config, providerId)
  if (values.length === 0) return null // no reasoning mode
  const current = getEffort(config, providerId)
  if (current === undefined) return values[0] // off → first
  const idx = values.indexOf(current)
  if (idx < 0 || idx === values.length - 1) return null // last or unknown → off
  return values[idx + 1]
}

// ── Factories ──────────────────────────────────────────────────────────────

export interface ConnectedProviderOptions {
  existing?: Provider | null
  preset?: ProviderPreset | null
  name: string
  baseURL: string
  apiKey: string
  models: string[]
  modelMetadata?: Record<string, ProviderModelMetadata>
  contextWindowInput: number
  /** Omit to inherit an existing mode or choose the natural default
   * (preset=auto, custom=manual). Passing a value is an explicit UI choice. */
  contextWindowMode?: ContextWindowMode
}

/** Single construction path for preset creation, custom creation, and edits. */
export function buildConnectedProvider(opts: ConnectedProviderOptions): Provider {
  const existing = opts.existing ?? null
  const preset = opts.preset ?? null
  const sourcePresetId = preset?.id ?? existing?.sourcePresetId ?? detectPresetId(opts.baseURL)
  const inheritedMode = existing
    ? existing.contextWindowMode ?? inferLegacyContextWindowMode(existing)
    : preset?.baseURL
      ? "auto"
      : "manual"
  const contextWindowMode: ContextWindowMode = opts.contextWindowMode ?? inheritedMode
  const fallbackContext = positiveIntegerOrDefault(
    opts.contextWindowInput,
    existing?.contextWindow ?? preset?.contextWindow ?? 128000,
  )
  const provider: Provider = {
    id: existing?.id ?? `sp_${Date.now()}`,
    name: opts.name,
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    contextWindow: fallbackContext,
    contextWindowMode,
    models: opts.models,
    sourcePresetId,
    protocol: existing?.protocol ?? preset?.protocol,
    maxRequestBytes: existing?.maxRequestBytes,
    // Copy: a connection owns its params, and the preset table must stay pristine.
    extraRequestParams: existing?.extraRequestParams
      ?? (preset?.extraRequestParams ? structuredClone(preset.extraRequestParams) : undefined),
    modelMetadata: opts.modelMetadata,
    visionByModel: existing?.visionByModel,
  }
  if (contextWindowMode === "auto") {
    provider.contextWindow = resolveProviderContextWindow(provider, provider.models[0] ?? "")
  }
  return provider
}

/** Create a fresh Provider instance. Used by /connect when the user
 *  selects a preset or fills in a custom form. */
export function createProviderFromPreset(preset: ProviderPreset, opts: {
  apiKey: string
  models: string[]
  name?: string
  contextWindow?: number
  /** Override the preset's baseURL. Used by empty-baseURL presets
   *  (e.g. `anthropic-compat`) where the user supplies the endpoint
   *  but everything else — protocol, default models, effort values —
   *  comes from the preset. */
  baseURL?: string
  modelMetadata?: Record<string, ProviderModelMetadata>
}): Provider {
  return buildConnectedProvider({
    preset,
    name: opts.name ?? preset.label,
    baseURL: opts.baseURL ?? preset.baseURL,
    apiKey: opts.apiKey,
    contextWindowInput: opts.contextWindow ?? preset.contextWindow,
    contextWindowMode: opts.contextWindow !== undefined ? "manual" : undefined,
    models: opts.models,
    modelMetadata: opts.modelMetadata,
  })
}

export function createCustomProvider(opts: {
  name: string
  baseURL: string
  apiKey: string
  contextWindow: number
  models: string[]
  modelMetadata?: Record<string, ProviderModelMetadata>
}): Provider {
  return buildConnectedProvider({
    name: opts.name,
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    contextWindowInput: opts.contextWindow,
    contextWindowMode: "manual",
    models: opts.models,
    modelMetadata: opts.modelMetadata,
  })
}

// ── Validation / formatting (mostly for CLI help text) ─────────────────────

export function validateConfig(config: AppConfig): string | null {
  const p = getActiveProvider(config)
  if (!p) return "No provider configured. Use /connect."
  if (!config.active.model.trim()) return "Model is empty. Use /model <name>."
  if (!p.baseURL.trim()) return "Base URL is empty. Use /connect to fix."
  if (!hasApiKey(config)) return `API key is missing for ${getProviderDisplayName(config)}. Use /connect.`
  return null
}

export function buildSystemPrompt(
  config: AppConfig,
  cwd: string,
  toolPrompts?: string,
  enabledTools?: Set<string>,
  availableSkills?: PromptContext["availableSkills"],
  executionFacts?: PromptContext["executionFacts"],
  onSection?: PromptContext["onSection"],
  executionCapacity?: PromptContext["executionCapacity"],
): string {
  const custom = config.customSystemPrompt.trim()
  const ctx: PromptContext = {
    cwd,
    enabledTools: enabledTools ?? new Set(),
    toolPromptsRaw: toolPrompts,
    model: config.active.model,
    customSystemPrompt: undefined,
    promptProfile: resolvePromptProfile(config.promptProfile),
    onSection,
    availableSkills,
    executionFacts,
    executionCapacity,
  }
  if (custom) {
    return buildCustomSystemPrompt(custom, ctx, [
      `Today: ${new Date().toISOString().split("T")[0]}`,
      `CWD: ${cwd}`,
    ])
  }

  return buildDefaultPrompt(ctx)
}

export function buildCustomSystemPrompt(
  customPrompt: string,
  ctx: PromptContext,
  dynamicLines: string[] = [],
): string {
  const cacheableSupportSections = [
    toolPromptsSection,
    skillsSection,
    ctx.promptProfile === "concise" ? concisePlanSection : planDisciplineSection,
  ].flatMap((section) => {
    const value = section.compute(ctx)
    const trimmed = value ? escapeDynamicBoundaryText(value).trim() : ""
    if (trimmed) recordPromptSection(ctx, section, trimmed)
    return trimmed ? [trimmed] : []
  })
  const dynamic = [
    ...dynamicLines,
    `Shell: ${ctx.executionFacts?.shell ?? localExecutionShell().executable}`,
    ...(ctx.executionFacts ? [`Process environment facts: ${JSON.stringify(ctx.executionFacts)}`] : []),
    ...(ctx.executionCapacity ? [`Local execution capacity observations (visible limits only): ${JSON.stringify(ctx.executionCapacity)}`] : []),
  ].map((line) => escapeDynamicBoundaryText(line).trim()).filter(Boolean)
  recordPromptSection(ctx, { name: "custom", purpose: "user", compute: () => null }, escapeDynamicBoundaryText(customPrompt).trim())
  recordPromptSection(ctx, { name: "custom-environment", purpose: "environment", dynamic: true, compute: () => null }, dynamic.join("\n"))
  return [
    escapeDynamicBoundaryText(customPrompt).trim(),
    ...cacheableSupportSections,
    ...(dynamic.length > 0 ? [DYNAMIC_BOUNDARY, ...dynamic] : []),
  ].filter(Boolean).join("\n")
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "not set"
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
}

export function formatStatus(config: AppConfig, configPath: string): string {
  const p = getActiveProvider(config)
  const effort = p ? getEffort(config, p.id) : undefined
  const lines = [
    "zapAgent Status",
    "",
    `Provider: ${getProviderDisplayName(config)}${p ? ` (${p.id})` : ""}`,
    `Model: ${config.active.model || "(none)"}`,
    `Base URL: ${p?.baseURL || "(empty)"}`,
  ]
  if (effort) lines.push(`Reasoning effort: ${effort}`)
  lines.push(
    `API key: ${maskSecret(p?.apiKey ?? "")}`,
    `Serper key: ${maskSecret(config.serperKey)}`,
    `Max tokens: ${config.maxTokens}`,
    `Max steps: ${config.maxSteps}`,
    `System prompt: ${config.customSystemPrompt.trim() ? "custom" : "default"}`,
    `Config file: ${configPath}`,
  )
  return lines.join("\n")
}

export function formatProviders(config: AppConfig): string {
  return [
    "Providers",
    "",
    ...config.providers.map(p => `- ${p.id}: ${p.name || p.baseURL}${p.id === config.active.providerId ? " [active]" : ""}`),
    "",
    "Usage: /connect",
  ].join("\n")
}

export function formatModels(config: AppConfig): string {
  const p = getActiveProvider(config)
  if (!p) return "No provider configured. Use /connect."
  return [
    `Models for ${getProviderDisplayName(config)}`,
    "",
    ...p.models.map(m => `- ${m}${m === config.active.model ? " [active]" : ""}`),
    "",
    "Usage: /model <name>",
  ].join("\n")
}

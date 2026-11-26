import { nativeCommand } from "./agent/official-agents.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { normalizeModelReasoning, type ModelReasoning } from "../zapsdk/core/reasoning-effort.js"
import { setActive, upsertProvider, type AppConfig, type Provider, type ProviderModelMetadata } from "./config.js"

/** Compatibility marker for an official Codex runtime connection. */
export function connectCodexProvider(config: AppConfig): { config: AppConfig; provider: Provider } {
  const existing = config.providers.find(p => p.authMode === "codex-oauth")
  const provider: Provider = { ...existing, id: existing?.id ?? "sp_codex_oauth", name: existing?.name ?? "OpenAI Codex (ChatGPT)",
    baseURL: "codex://local", apiKey: "", authMode: "codex-oauth", protocol: "openai-responses",
    contextWindow: existing?.contextWindow ?? 128000, contextWindowMode: existing?.contextWindowMode ?? "auto",
    models: existing?.models ?? [] }
  let next = upsertProvider(config, provider)
  if (provider.models.length && config.active.providerId === provider.id) next = setActive(next, provider.id, config.active.model)
  return { config: next, provider }
}

export async function discoverCodexModels(signal: AbortSignal): Promise<Array<{ id: string; metadata: ProviderModelMetadata; reasoning?: ModelReasoning }>> {
  const cli = await nativeCommand("codex")
  const { stdout } = await promisify(execFile)(cli.command, [...cli.args, "debug", "models"], {
    signal, timeout: 6500, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
  })
  const data = JSON.parse(stdout) as { models?: Array<Record<string, unknown>> }
  if (!Array.isArray(data.models)) throw new Error("Invalid Codex models response.")
  return data.models.flatMap(model => {
    // supported_in_api only gates API-key accounts; Codex OAuth can use backend-only models.
    if (typeof model.slug !== "string" || !model.slug || model.visibility === "hide" || model.visibility === "hidden") return []
    return [{ id: model.slug, reasoning: normalizeModelReasoning(model.supported_reasoning_levels, model.default_reasoning_level), metadata: {
      name: typeof model.display_name === "string" ? model.display_name : undefined,
      contextWindow: typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : undefined,
      supportsVision: Array.isArray(model.input_modalities) ? model.input_modalities.includes("image") : undefined,
      toolCall: true, reasoning: true, source: "provider" as const,
    } }]
  })
}

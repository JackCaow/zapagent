import { CODEX_BASE_URL, getCodexCredentials } from "./codex-auth.js"
import { VERSION } from "./version.js"
import { setActive, upsertProvider, type AppConfig, type Provider, type ProviderModelMetadata } from "./config.js"

/** One explicit account binding; secrets live only in codex-oauth.json. */
export function connectCodexProvider(config: AppConfig): { config: AppConfig; provider: Provider } {
  const existing = config.providers.find(p => p.authMode === "codex-oauth")
  const provider: Provider = { ...existing, id: existing?.id ?? "sp_codex_oauth", name: existing?.name ?? "OpenAI Codex (ChatGPT)",
    baseURL: CODEX_BASE_URL, apiKey: "", authMode: "codex-oauth", protocol: "openai-responses",
    contextWindow: existing?.contextWindow ?? 128000, contextWindowMode: existing?.contextWindowMode ?? "auto",
    models: existing?.models ?? [] }
  let next = upsertProvider(config, provider)
  if (provider.models.length && config.active.providerId === provider.id) next = setActive(next, provider.id, config.active.model)
  return { config: next, provider }
}

export async function discoverCodexModels(signal: AbortSignal): Promise<Array<{ id: string; metadata: ProviderModelMetadata }>> {
  const credentials = await getCodexCredentials(signal)
  const response = await fetch(`${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(VERSION)}`, {
    headers: { Authorization: `Bearer ${credentials.accessToken}`, originator: "zap",
      ...(credentials.accountId ? { "ChatGPT-Account-ID": credentials.accountId } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), redirect: "error",
  })
  if (!response.ok) throw new Error(`Codex model discovery failed (HTTP ${response.status}).`)
  const data = await response.json() as { models?: Array<Record<string, unknown>> }
  if (!Array.isArray(data.models)) throw new Error("Invalid Codex models response.")
  return data.models.flatMap(model => {
    // supported_in_api only gates API-key accounts; Codex OAuth can use backend-only models.
    if (typeof model.slug !== "string" || !model.slug || model.visibility === "hide" || model.visibility === "hidden") return []
    return [{ id: model.slug, metadata: {
      name: typeof model.display_name === "string" ? model.display_name : undefined,
      contextWindow: typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : undefined,
      supportsVision: Array.isArray(model.input_modalities) ? model.input_modalities.includes("image") : undefined,
      toolCall: true, reasoning: true, source: "provider" as const,
    } }]
  })
}

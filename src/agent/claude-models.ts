import { nativeCommand } from "./official-agents.js"

import { probeModelMetadata } from "./model-metadata-probe.js"
import { modelMetadataText, startupModelCachePath, type ExternalModelIdentity } from "./startup-model-cache.js"

const providerLabels = new Map([
  ["firstParty", "Anthropic"], ["bedrock", "Amazon Bedrock"], ["vertex", "Google Vertex AI"], ["foundry", "Microsoft Foundry"],
])

export function claudeProviderLabel(apiProvider?: string, servedByAnthropic?: boolean): string {
  if (apiProvider === "firstParty" && servedByAnthropic === false) return "Custom endpoint"
  if (apiProvider) return providerLabels.get(apiProvider) ?? apiProvider
  return servedByAnthropic ? "Anthropic" : "Claude Code"
}

export interface ClaudeModelChoice {
  value: string
  label: string
  resolvedModel?: string
}

export function claudeStartupCachePath(cwd: string, preference?: string): string {
  return startupModelCachePath("claude", cwd, [preference, process.env.CLAUDE_CONFIG_DIR, process.env.ANTHROPIC_BASE_URL,
    process.env.CLAUDE_CODE_USE_BEDROCK, process.env.CLAUDE_CODE_USE_VERTEX, process.env.CLAUDE_CODE_USE_FOUNDRY])
}

export async function discoverClaudeModels(cwd: string, signal: AbortSignal): Promise<ClaudeModelChoice[]> {
  return (await readClaudeMetadata(cwd, signal, "catalog")).models
}

export async function resolveClaudeStartupModel(cwd: string, signal: AbortSignal, preference?: string): Promise<ExternalModelIdentity | undefined> {
  return (await readClaudeMetadata(cwd, signal, "startup", preference)).identity
}

function isCustomEndpoint(baseURL: unknown): boolean {
  if (typeof baseURL !== "string" || !baseURL.trim()) return false
  try { return new URL(baseURL).origin !== "https://api.anthropic.com" } catch { return true }
}

async function readClaudeMetadata(cwd: string, signal: AbortSignal, mode: "catalog" | "startup", preference?: string): Promise<{
  models: ClaudeModelChoice[]
  identity?: ExternalModelIdentity
}> {
  const cli = await nativeCommand("claude")
  const args = [...cli.args,
    "--print", "--verbose", "--safe-mode", "--no-session-persistence", "--strict-mcp-config",
    "--tools", "", "--input-format", "stream-json", "--output-format", "stream-json",
    ...(preference ? [`--model=${preference}`] : []),
  ]
  return probeModelMetadata({ command: cli.command, args }, cwd, signal, async ({ send, receive }) => {
    const request = async (subtype: string) => {
      send({ type: "control_request", request_id: subtype, request: { subtype } })
      const { response } = await receive(event => event.type === "control_response" && event.response?.request_id === subtype)
      if (response.subtype !== "success") throw new Error("Claude Code did not return model metadata")
      return response.response
    }
    const initial = await request("initialize")
    if (mode === "startup") {
      const settings = await request("get_settings")
      const model = modelMetadataText(settings?.applied?.model)
      const apiProvider = modelMetadataText(initial?.account?.apiProvider)
      const custom = isCustomEndpoint(process.env.ANTHROPIC_BASE_URL) || isCustomEndpoint(settings?.effective?.env?.ANTHROPIC_BASE_URL)
      const provider = claudeProviderLabel(apiProvider, custom ? false : undefined)
      return { models: [], identity: model ? { model, provider } : undefined }
    }
    const models = initial?.models
    if (!Array.isArray(models)) throw new Error("Claude Code did not return a model list")
    const choices = new Map<string, ClaudeModelChoice>()
    for (const model of models) {
      const value = modelMetadataText(model?.value)
      if (!value || value !== model.value || value.startsWith("-") || choices.has(value)) continue
      choices.set(value, { value, label: modelMetadataText(model.displayName) ?? value, resolvedModel: modelMetadataText(model.resolvedModel) })
    }
    return { models: [...choices.values()] }
  })
}

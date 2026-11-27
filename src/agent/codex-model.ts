import type { AcpAgentSpec } from "../../zapsdk/acp-client/types.js"
import { VERSION } from "../version.js"
import { probeModelMetadata } from "./model-metadata-probe.js"
import { nativeCommand } from "./official-agents.js"
import { modelMetadataText, startupModelCachePath, type ExternalModelIdentity } from "./startup-model-cache.js"

export function codexStartupCachePath(cwd: string, custom?: AcpAgentSpec): string {
  return startupModelCachePath("codex", cwd, [
    custom, process.env.CODEX_HOME, process.env.CODEX_PATH, process.env.CODEX_CONFIG, process.env.MODEL_PROVIDER,
  ])
}

export function codexModelIdentity(value: unknown): ExternalModelIdentity | undefined {
  const model = modelMetadataText(value)
  return model ? { provider: "Codex", model } : undefined
}

export async function resolveCodexStartupModel(cwd: string, signal: AbortSignal, custom?: AcpAgentSpec): Promise<ExternalModelIdentity | undefined> {
  const configured = codexModelIdentity(custom?.config?.model ?? custom?.model)
  // A custom bridge may not implement the stock bridge's CLI passthrough.
  if (configured || (custom && custom.command !== "codex-acp")) return configured

  const env = custom?.env
  const bridgeConfig = env?.CODEX_CONFIG ?? process.env.CODEX_CONFIG
  if (bridgeConfig) {
    const identity = codexModelIdentity(JSON.parse(bridgeConfig)?.model)
    if (identity) return identity
  }
  const cli = await nativeCommand("codex-acp")
  return probeModelMetadata({ command: cli.command, args: [...cli.args, "cli", "app-server", "--stdio"] }, cwd, signal,
    async ({ send, receive }) => {
      let id = 0
      const request = async (method: string, params: object) => {
        const requestId = ++id
        send({ id: requestId, method, params })
        const reply = await receive(event => event.id === requestId)
        if (reply.error) throw new Error(`Codex App Server rejected ${method}`)
        return reply.result
      }
      await request("initialize", { clientInfo: { name: "zapcode", version: VERSION } })
      send({ method: "initialized" })
      const { config } = await request("config/read", { cwd, includeLayers: false })
      const effective = codexModelIdentity(config?.model)
      if (effective) return effective
      const catalog = await request("model/list", { includeHidden: false })
      const def = Array.isArray(catalog?.data) ? catalog.data.find((row: { isDefault?: boolean } | null) => row?.isDefault === true) : undefined
      return codexModelIdentity(def?.model ?? def?.id)
    }, env)
}

import { listModels } from "../zapsdk/core/list-models.js"
import { getModelsDevProvider, suggestedModelsDevIds } from "../zapsdk/core/models-dev.js"
import { resolveCatalogProviderId, upsertProvider, setActive, type AppConfig, type Provider, type ProviderModelMetadata } from "./config.js"
import { mergeModelMetadata, modelsDevMetadata, pickModelMetadata } from "./provider-metadata.js"

export type ModelSource = "saved" | "provider" | "models.dev" | "manual"
export interface CatalogRow { id: string; source: ModelSource; metadata?: ProviderModelMetadata }
export interface DiscoveredCatalog { rows: CatalogRow[]; error?: string }

/** Discovery is read-only: returning a model is not proof of inference access. */
export async function discoverProviderModels(provider: Provider, signal: AbortSignal): Promise<DiscoveredCatalog> {
  const catalogId = resolveCatalogProviderId(provider)
  const [live, catalog] = await Promise.allSettled([
    listModels(provider.baseURL, provider.authMode === "none" ? "" : provider.apiKey, 6000, signal, provider.protocol),
    catalogId ? getModelsDevProvider(catalogId) : Promise.resolve(null),
  ])
  signal.throwIfAborted()
  const directory = catalog.status === "fulfilled" ? catalog.value : null
  const metadata = mergeModelMetadata(provider.modelMetadata ?? {}, modelsDevMetadata(directory))
  const rows = new Map<string, CatalogRow>(provider.models.map(id => [id, { id, source: "saved", metadata: metadata[id] }]))
  const source: ModelSource = live.status === "fulfilled" ? "provider" : "models.dev"
  const ids = live.status === "fulfilled" ? live.value : directory ? suggestedModelsDevIds(directory) : []
  for (const id of ids) rows.set(id, { id, source, metadata: metadata[id] })
  return { rows: [...rows.values()], error: live.status === "rejected"
    ? "Endpoint discovery failed. Saved IDs and public suggestions are unverified; you can enter an ID manually." : undefined }
}

/** Selecting a row is the only catalog operation that changes configuration. */
export function selectCatalogModel(config: AppConfig, providerId: string, row: CatalogRow): AppConfig {
  const provider = config.providers.find(item => item.id === providerId)
  if (!provider) return config
  const models = [...new Set([...provider.models, row.id])]
  const modelMetadata = pickModelMetadata(mergeModelMetadata(provider.modelMetadata ?? {},
    row.metadata ? { [row.id]: row.metadata } : {}), models)
  return setActive(upsertProvider(config, { ...provider, models, modelMetadata }), providerId, row.id)
}

export function describeCatalogRow(row: CatalogRow): string {
  const metadata = row.metadata
  const capability = (value: boolean | undefined) => value === undefined ? "?" : value ? "yes" : "no"
  return `${row.source} · access unverified · context ${metadata?.contextWindow?.toLocaleString("en-US") ?? "?"}`
    + ` · tools ${capability(metadata?.toolCall)} · vision ${capability(metadata?.supportsVision)} · reasoning ${capability(metadata?.reasoning)}`
}

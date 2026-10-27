import type { ImageTokenContext } from "../zapsdk/context/image-tokens.js"
import { canonicalModelId } from "../zapsdk/core/model-identity.js"
import {
  inferLegacyContextWindowMode,
  resolveCatalogProviderId,
  resolveVisionSupport,
  resolveProviderContextWindow,
  type AppConfig,
  type Provider,
  type ProviderModelMetadata,
} from "./config.js"
import {
  getModelsDevProvider,
  type ModelsDevProvider,
} from "../zapsdk/core/models-dev.js"

/** Convert the remote catalog shape to the stable subset stored in config. */
export function modelsDevMetadata(
  catalog: ModelsDevProvider | null,
): Record<string, ProviderModelMetadata> {
  if (!catalog) return {}
  return Object.fromEntries(catalog.models.map(model => [model.id, {
    name: model.name,
    canonicalModelId: canonicalModelId(model.canonicalModelId),
    contextWindow: model.contextWindow,
    inputLimit: model.inputLimit,
    outputLimit: model.outputLimit,
    supportsVision: model.supportsVision,
    reasoning: model.reasoning,
    toolCall: model.toolCall,
    source: "models.dev" as const,
    lastUpdated: model.lastUpdated,
  }]))
}

export function pickModelMetadata(
  metadata: Record<string, ProviderModelMetadata>,
  modelIds: string[],
): Record<string, ProviderModelMetadata> | undefined {
  const picked = Object.fromEntries(
    modelIds.flatMap(modelId => metadata[modelId] ? [[modelId, metadata[modelId]] as const] : []),
  )
  return Object.keys(picked).length > 0 ? picked : undefined
}

/** Apply one catalog provider to a connected provider without changing model
 * availability. Only ids already returned/selected by the provider survive. */
export function enrichProviderMetadata(provider: Provider, catalog: ModelsDevProvider): Provider {
  const catalogMetadata = modelsDevMetadata(catalog)
  const directoryId = resolveCatalogProviderId(provider)
  const directoryMatches = directoryId === catalog.id || (!directoryId
    && !Object.values(provider.modelMetadata ?? {}).some(metadata => metadata.catalogRef))
  const remote = directoryMatches ? { ...catalogMetadata } : {}
  for (const id of provider.models) {
    const ref = provider.modelMetadata?.[id]?.catalogRef
    if (!ref) continue
    // An explicit alias binding wins over coincidentally equal endpoint IDs.
    const metadata = ref.providerId === catalog.id ? catalogMetadata[ref.modelId] : undefined
    delete remote[id]
    if (metadata) remote[id] = { ...metadata, catalogRef: ref }
  }
  const merged = mergeModelMetadata(provider.modelMetadata ?? {}, remote)
  // A successful provider snapshot also retires identities for removed model
  // entries. Keep offline facts/capabilities, but do not keep claiming a precise
  // identity that the catalog no longer publishes for this endpoint alias.
  for (const [id, metadata] of Object.entries(merged)) {
    if (metadata.catalogRef && metadata.catalogRef.providerId !== catalog.id) continue
    if (!metadata.catalogRef && !directoryMatches) continue
    if (metadata.source !== "models.dev" || Object.hasOwn(remote, id) || !metadata.canonicalModelId) continue
    merged[id] = { ...metadata }
    delete merged[id].canonicalModelId
  }
  const nextMetadata = pickModelMetadata(merged, provider.models)
  const contextWindowMode = provider.contextWindowMode ?? inferLegacyContextWindowMode(provider)
  const next: Provider = { ...provider, contextWindowMode, modelMetadata: nextMetadata }
  if (contextWindowMode === "auto") {
    next.contextWindow = resolveProviderContextWindow(next, next.models[0] ?? "")
  }
  return providerMetadataEqual(provider, next) ? provider : next
}

/** Best-effort startup refresh. Network failures leave the config untouched. */
export async function refreshModelsDevMetadata(config: AppConfig): Promise<AppConfig> {
  const providers = await Promise.all(config.providers.map(async provider => {
    if (provider.models.length === 0) return provider
    const ids = new Set([resolveCatalogProviderId(provider), ...provider.models.map(id =>
      provider.modelMetadata?.[id]?.catalogRef?.providerId)].filter((id): id is string => !!id))
    const catalogs = await Promise.all([...ids].map(id => getModelsDevProvider(id).catch(() => null)))
    return catalogs.reduce((current, catalog) => catalog ? enrichProviderMetadata(current, catalog) : current, provider)
  }))
  return providers.every((provider, index) => provider === config.providers[index])
    ? config
    : { ...config, providers }
}

function providerMetadataEqual(a: Provider, b: Provider): boolean {
  return a.contextWindow === b.contextWindow
    && a.contextWindowMode === b.contextWindowMode
    && JSON.stringify(a.modelMetadata ?? {}) === JSON.stringify(b.modelMetadata ?? {})
}

/** Explicit/endpoint metadata wins. An updated catalog identity must not leave
 * a removed/invalid old identity attached to a moving alias. Other unknown
 * catalog fields continue to preserve existing facts. */
export function mergeModelMetadata(existing: Record<string, ProviderModelMetadata>, remote: Record<string, ProviderModelMetadata>) {
  const merged = { ...existing }
  for (const [id, metadata] of Object.entries(remote)) {
    if (existing[id]?.source === "manual" || existing[id]?.source === "provider") continue
    merged[id] = { ...existing[id], ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) }
    if (metadata.source === "models.dev") {
      const identity = canonicalModelId(metadata.canonicalModelId)
      if (identity) merged[id].canonicalModelId = identity
      else delete merged[id].canonicalModelId
    }
  }
  return merged
}

/** Commit metadata only when the connection has not been edited since fetch.
 * Never replace a whole config after an await: model selection is user-owned. */
export function applyMetadataRefresh(current: AppConfig, initial: AppConfig, refreshed: AppConfig): AppConfig {
  const providers = current.providers.map(provider => {
    const before = initial.providers.find(item => item.id === provider.id)
    const after = refreshed.providers.find(item => item.id === provider.id)
    if (!before || !after || before === after || provider !== before) return provider
    return { ...provider, contextWindow: after.contextWindow,
      contextWindowMode: after.contextWindowMode, modelMetadata: after.modelMetadata }
  })
  return providers.every((provider, index) => provider === current.providers[index])
    ? current : { ...current, providers }
}

/** Also used before the first provider call and after catalog-only refreshes. */
export function resolveModelImageTokenContext(provider: Provider | null | undefined, model: string): ImageTokenContext {
  const anthropic = provider?.protocol === "anthropic" ||
    (provider?.protocol === undefined && !!provider?.baseURL.toLowerCase().includes("api.anthropic.com"))
  const effectiveModel = !anthropic && typeof provider?.extraRequestParams?.model === "string"
    ? provider.extraRequestParams.model : model
  return {
    model: effectiveModel,
    canonicalModelId: canonicalModelId(provider?.modelMetadata?.[effectiveModel]?.canonicalModelId),
    supportsVision: anthropic ? undefined : resolveVisionSupport(provider, model),
    supportsImageDetail: !anthropic,
  }
}

export function modelCanonicalIds(provider: Provider | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(provider?.modelMetadata ?? {}).flatMap(([model, metadata]) => {
    const identity = canonicalModelId(metadata.canonicalModelId)
    return identity ? [[model, identity]] : []
  }))
}

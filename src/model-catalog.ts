import type { Provider } from "./config.js"
import { discoverProviderModels, type CatalogRow, type DiscoveredCatalog } from "./provider-catalog.js"

export interface ConnectionCatalog extends DiscoveredCatalog {
  providerId: string
  loading: boolean
}

export function savedConnectionCatalogs(providers: readonly Provider[]): ConnectionCatalog[] {
  return providers.map(provider => ({ providerId: provider.id, loading: true,
    rows: provider.models.map(id => ({ id, source: "saved", metadata: provider.modelMetadata?.[id] })),
  }))
}

export function modelCatalogKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId])
}

export interface ConnectionModelRow extends CatalogRow { provider: Provider }

export function configuredModelRows(providers: readonly Provider[], catalogs: readonly ConnectionCatalog[], providerId: string | null, query: string): ConnectionModelRow[] {
  const search = query.trim().toLowerCase()
  return providers.filter(provider => providerId === null || provider.id === providerId).flatMap(provider => {
    const rows = catalogs.find(catalog => catalog.providerId === provider.id)?.rows ?? []
    return rows.filter(row => !search || [row.id, provider.name, provider.baseURL].some(value => value.toLowerCase().includes(search)))
      .map(row => ({ ...row, provider }))
  })
}

/** Each connection settles independently. One hung endpoint cannot block the list. */
export function discoverConfiguredModels(providers: readonly Provider[], onUpdate: (catalog: ConnectionCatalog) => void,
  discover: typeof discoverProviderModels = discoverProviderModels, timeoutMs = 6500): () => void {
  const disposers = providers.map(provider => {
    const controller = new AbortController()
    let finished = false
    const saved = savedConnectionCatalogs([provider])[0]
    const timer = setTimeout(() => {
      if (finished) return
      finished = true; controller.abort()
      onUpdate({ ...saved, loading: false, error: "Discovery timed out. Saved models remain available; press t to enter an ID." })
    }, timeoutMs)
    void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return discover(provider, controller.signal) }).then(result => {
      if (finished) return
      finished = true; clearTimeout(timer)
      onUpdate({ ...result, providerId: provider.id, loading: false })
    }).catch(() => {
      if (finished) return
      finished = true; clearTimeout(timer)
      onUpdate({ ...saved, loading: false, error: "Discovery unavailable. Saved models remain available; press r to retry." })
    })
    return () => { finished = true; controller.abort(); clearTimeout(timer) }
  })
  return () => { for (const dispose of disposers) dispose() }
}

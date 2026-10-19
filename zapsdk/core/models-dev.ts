/**
 * Lightweight adapter for the public models.dev catalog.
 *
 * The upstream response is currently a few megabytes, so callers share one
 * in-process request and a versioned disk snapshot. Stale snapshots remain
 * usable offline while a bounded background refresh updates public metadata.
 */

import { join } from "node:path"
import { homedir } from "node:os"
import { canonicalModelId } from "./model-identity.js"
import { ModelCatalogCache } from "./model-catalog-cache.js"

export const MODELS_DEV_API_URL = "https://models.dev/api.json"

export interface ModelsDevModel {
  id: string
  canonicalModelId?: string
  name: string
  contextWindow?: number
  inputLimit?: number
  outputLimit?: number
  supportsVision?: boolean
  reasoning?: boolean
  toolCall?: boolean
  status?: "alpha" | "beta" | "deprecated"
  releaseDate?: string
  lastUpdated?: string
  inputModalities: string[]
  outputModalities: string[]
}

export interface ModelsDevProvider {
  id: string
  name: string
  api?: string
  models: ModelsDevModel[]
}

export interface ModelsDevConnection {
  id: string
  name: string
  api?: string
  protocol?: "openai" | "anthropic"
}

/** Adapter IDs describe wire compatibility; this is not a vendor allowlist. */
export function parseModelsDevConnections(catalog: unknown): ModelsDevConnection[] {
  if (!isRecord(catalog)) return []
  return Object.entries(catalog).flatMap(([id, raw]) => {
    if (!id || /[\u0000-\u001f\u007f]/.test(id)) return []
    if (!isRecord(raw) || !isRecord(raw.models)) return []
    const protocol = raw.npm === "@ai-sdk/anthropic" ? "anthropic" as const
      : raw.npm === "@ai-sdk/openai" || raw.npm === "@ai-sdk/openai-compatible" ? "openai" as const : undefined
    let api: string | undefined
    try {
      const url = new URL(String(raw.api ?? ""))
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) api = url.toString().replace(/\/$/, "")
    } catch { /* Missing/templated endpoints require explicit user input. */ }
    return [{ id, name: (stringValue(raw.name) ?? id).replace(/[\u0000-\u001f\u007f]/g, ""), api, protocol }]
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

let catalogCache: ModelCatalogCache | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

/** Normalize just one provider instead of retaining the full remote catalog. */
export function parseModelsDevProvider(catalog: unknown, providerId: string): ModelsDevProvider | null {
  if (!isRecord(catalog)) return null
  const rawProvider = catalog[providerId]
  if (!isRecord(rawProvider) || !isRecord(rawProvider.models)) return null

  const models: ModelsDevModel[] = []
  for (const [catalogId, rawModel] of Object.entries(rawProvider.models)) {
    if (!isRecord(rawModel)) continue
    const id = stringValue(rawModel.id) ?? catalogId
    if (!id) continue
    const limit = isRecord(rawModel.limit) ? rawModel.limit : {}
    const modalities = isRecord(rawModel.modalities) ? rawModel.modalities : {}
    const inputModalities = stringArray(modalities.input)
    const outputModalities = stringArray(modalities.output)
    const status = rawModel.status === "alpha" || rawModel.status === "beta" || rawModel.status === "deprecated"
      ? rawModel.status
      : undefined
    models.push({
      id,
      name: stringValue(rawModel.name) ?? id,
      canonicalModelId: canonicalModelId(rawModel.canonical_model_id),
      contextWindow: positiveInteger(limit.context),
      inputLimit: positiveInteger(limit.input),
      outputLimit: positiveInteger(limit.output),
      supportsVision: inputModalities.length > 0
        ? inputModalities.includes("image")
        : undefined,
      reasoning: booleanValue(rawModel.reasoning),
      toolCall: booleanValue(rawModel.tool_call),
      status,
      releaseDate: stringValue(rawModel.release_date),
      lastUpdated: stringValue(rawModel.last_updated),
      inputModalities,
      outputModalities,
    })
  }

  // Newer catalog entries are more useful in the fallback picker. The model
  // id tie-breaker keeps test and UI ordering deterministic.
  models.sort((a, b) => {
    const dateOrder = (b.lastUpdated ?? b.releaseDate ?? "").localeCompare(a.lastUpdated ?? a.releaseDate ?? "")
    return dateOrder || a.id.localeCompare(b.id)
  })

  return {
    id: stringValue(rawProvider.id) ?? providerId,
    name: stringValue(rawProvider.name) ?? providerId,
    api: stringValue(rawProvider.api),
    models,
  }
}

/** Models suitable for Zap's text + tool-call agent fallback picker. */
export function suggestedModelsDevIds(provider: ModelsDevProvider): string[] {
  return provider.models
    .filter(model => model.status !== "deprecated")
    .filter(model => model.toolCall !== false)
    .filter(model => model.outputModalities.length === 0 || model.outputModalities.includes("text"))
    .filter(model => model.contextWindow !== undefined)
    .map(model => model.id)
}

async function fetchCatalog(timeoutMs: number): Promise<unknown> {
  const response = await fetch(MODELS_DEV_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
  return response.json()
}

async function getCatalog(timeoutMs = 4000, refresh = false): Promise<unknown> {
  if (!catalogCache) {
    catalogCache = new ModelCatalogCache({
      path: join(process.env.ZAPCODE_DATA_DIR ?? join(homedir(), ".zapcode"), "cache", "models-dev-v1.json"),
      load: () => fetchCatalog(timeoutMs),
    })
  }
  return refresh ? catalogCache.refresh() : catalogCache.get()
}

export async function getModelsDevConnections(timeoutMs = 4000): Promise<ModelsDevConnection[]> {
  return parseModelsDevConnections(await getCatalog(timeoutMs))
}

/** User-requested reload, unlike ordinary stale-while-revalidate reads. */
export async function refreshModelsDevConnections(timeoutMs = 4000): Promise<ModelsDevConnection[]> {
  return parseModelsDevConnections(await getCatalog(timeoutMs, true))
}

export async function getModelsDevProvider(providerId: string, timeoutMs = 4000): Promise<ModelsDevProvider | null> {
  return parseModelsDevProvider(await getCatalog(timeoutMs), providerId)
}

/** Test-only cache reset; harmless for callers that need an explicit refresh. */
export function clearModelsDevCache(): void {
  catalogCache = null
}

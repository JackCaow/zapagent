import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getDefaultConfig, loadAppConfig, saveAppConfig, resolveProviderContextWindow, type Provider } from "../src/config.js"
import { saveConnection } from "../src/ui/dialog-connect.js"
import { parseContextWindowInput } from "../src/ui/dialog-context-window.js"
import { associateModelMetadata, catalogModelMetadata, discoverProviderModels, selectCatalogModel } from "../src/provider-catalog.js"
import { enrichProviderMetadata, refreshModelsDevMetadata } from "../src/provider-metadata.js"
import { resolveActiveContextLimits } from "../src/context-budget.js"
import { clearModelsDevCache, parseModelsDevProvider } from "../zapsdk/core/models-dev.js"

const raw = {
  lab: { id: "lab", name: "Lab", models: {
    actual: { id: "actual", canonical_model_id: "lab/actual", limit: { context: 1048576, output: 65536 },
      modalities: { input: ["text", "image"], output: ["text"] }, tool_call: true },
    alias: { limit: { context: 4000 } },
  } },
  other: { id: "other", name: "Other", models: { actual: { limit: { context: 200000 } }, alias: { limit: { context: 3000 } } } },
}
const catalog = parseModelsDevProvider(raw, "lab")!
function connected() {
  const config = saveConnection({ ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }, {
    name: "StringInk fixture", baseURL: "https://gateway.example/v1", apiKey: "private-fixture-key",
    protocol: "openai-responses", authMode: "api-key",
  })
  return selectCatalogModel(config, config.providers[0]!.id, { id: "alias", source: "manual", metadata: catalogModelMetadata(catalog, "actual") })
}

describe("custom model metadata links", () => {
  const originalFetch = globalThis.fetch
  const originalDir = process.env.ZAPCODE_DATA_DIR
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zap-context-links-"))
    process.env.ZAPCODE_DATA_DIR = dir
    clearModelsDevCache()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalDir === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = originalDir
    clearModelsDevCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it("resolves a 1M catalog entry for a different wire alias without changing transport or availability", () => {
    const config = connected()
    const provider = config.providers[0]!
    expect(provider).toMatchObject({ baseURL: "https://gateway.example/v1", protocol: "openai-responses",
      apiKey: "private-fixture-key", contextWindowMode: "auto", models: ["alias"] })
    expect(config.active.model).toBe("alias")
    expect(provider.sourcePresetId).toBeUndefined()
    expect(provider.extraRequestParams).toBeUndefined()
    expect(resolveActiveContextLimits(config)).toMatchObject({ contextWindow: 1048576, compactAt: 831507, source: "models-dev" })
    expect(provider.modelMetadata?.alias).toMatchObject({ catalogRef: { providerId: "lab", modelId: "actual" }, supportsVision: true })
    expect(catalogModelMetadata(catalog, "not-published")).toBeUndefined()
  })

  it("refreshes explicit links at startup, without sending credentials to the public catalog", async () => {
    const config = connected()
    const changed = structuredClone(raw)
    changed.lab.models.actual.limit.context = 2000000
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://models.dev/api.json")
      expect(new Headers(init?.headers).has("Authorization")).toBe(false)
      return Response.json(changed)
    }) as typeof fetch
    const next = await refreshModelsDevMetadata(config)
    expect(resolveProviderContextWindow(next.providers[0], "alias")).toBe(2000000)
    expect(next.active).toEqual(config.active)
    expect(next.providers[0]?.models).toEqual(["alias"])
  })

  it("keeps explicit manual contexts when linked metadata refreshes", async () => {
    const config = connected()
    config.providers[0] = { ...config.providers[0]!, contextWindowMode: "manual", contextWindow: 256000 }
    globalThis.fetch = (async () => Response.json(raw)) as typeof fetch
    const refreshed = await refreshModelsDevMetadata(config)
    expect(resolveProviderContextWindow(refreshed.providers[0], "alias")).toBe(256000)
    expect(refreshed.providers[0]?.modelMetadata?.alias?.contextWindow).toBe(1048576)
  })

  it("uses last saved metadata offline", async () => {
    const config = connected()
    globalThis.fetch = (async () => { throw new Error("offline") }) as typeof fetch
    expect(await refreshModelsDevMetadata(config)).toBe(config)
    expect(resolveProviderContextWindow(config.providers[0], "alias")).toBe(1048576)
  })

  it("keeps links scoped to their selected catalog, even when IDs collide", () => {
    const original = connected().providers[0]!
    const provider: Provider = { ...original, catalogProviderId: "other", models: ["alias", "actual", "unlinked"],
      modelMetadata: { ...original.modelMetadata,
        actual: { ...catalogModelMetadata(catalog, "actual")! },
        unlinked: { contextWindow: 123456, source: "models.dev" },
      } }
    const other = parseModelsDevProvider(raw, "other")!
    const refreshed = enrichProviderMetadata(enrichProviderMetadata(provider, other), catalog)
    expect(refreshed.modelMetadata?.alias?.contextWindow).toBe(1048576)
    expect(refreshed.modelMetadata?.actual?.contextWindow).toBe(1048576)
    expect(refreshed.modelMetadata?.unlinked?.contextWindow).toBe(123456)
    expect(refreshed.modelMetadata?.alias?.catalogRef).toEqual({ providerId: "lab", modelId: "actual" })
  })

  it("retires stale canonical identity but retains offline limits when a linked entry disappears", () => {
    const provider = connected().providers[0]!
    const next = enrichProviderMetadata(provider, { ...catalog, models: [] })
    expect(next.modelMetadata?.alias?.canonicalModelId).toBeUndefined()
    expect(next.modelMetadata?.alias?.contextWindow).toBe(1048576)
    expect(next.modelMetadata?.alias?.catalogRef).toEqual({ providerId: "lab", modelId: "actual" })
  })

  it("discovers and refreshes custom alias metadata without modifying the endpoint IDs", async () => {
    const config = connected()
    globalThis.fetch = (async (url) => String(url).startsWith("https://models.dev/")
      ? Response.json(raw) : Response.json({ data: [{ id: "alias" }, { id: "new-wire-id" }] })) as typeof fetch
    const result = await discoverProviderModels(config.providers[0]!, new AbortController().signal)
    expect(result.rows.map(row => row.id)).toEqual(["alias", "new-wire-id"])
    expect(result.rows[0]?.metadata?.contextWindow).toBe(1048576)
    expect(config.providers[0]?.models).toEqual(["alias"])
  })

  it("persists explicit links and rejects malformed reference fields", () => {
    const path = join(dir, "config.json")
    saveAppConfig(path, connected())
    const restored = loadAppConfig(path)
    expect(restored.providers[0]?.modelMetadata?.alias?.catalogRef).toEqual({ providerId: "lab", modelId: "actual" })
    expect(resolveProviderContextWindow(restored.providers[0], "alias")).toBe(1048576)
    restored.providers[0]!.modelMetadata!.alias!.catalogRef = { providerId: "bad\nprovider", modelId: "actual" }
    saveAppConfig(path, restored)
    expect(loadAppConfig(path).providers[0]?.modelMetadata?.alias?.catalogRef).toBeUndefined()
  })

  it("validates manual context token counts without rounding or accepting non-numeric input", () => {
    expect(parseContextWindowInput(" 1048576 ")).toBe(1048576)
    for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "1e6", "1M", "9007199254740992"]) {
      expect(parseContextWindowInput(value)).toBeUndefined()
    }
  })

  it("replaces prior model facts on explicit reassociation while preserving manual context and selection", () => {
    const config = connected()
    const provider = config.providers[0]!
    provider.contextWindowMode = "manual"
    provider.contextWindow = 256000
    const unknown = parseModelsDevProvider({ other: { models: { unknown: {} } } }, "other")!
    for (const source of ["models.dev", "manual", "provider"] as const) {
      const previous = { ...config, providers: [{ ...provider, modelMetadata: { alias: {
        ...provider.modelMetadata!.alias!, inputLimit: 900000, source,
      } } }] }
      const next = associateModelMetadata(previous, provider.id, "alias", catalogModelMetadata(unknown, "unknown")!)
      expect(next.active).toBe(config.active)
      expect(next.providers[0]?.modelMetadata?.alias).toMatchObject({ source: "models.dev", catalogRef: { providerId: "other", modelId: "unknown" } })
      for (const field of ["contextWindow", "inputLimit", "outputLimit", "supportsVision", "canonicalModelId"] as const) {
        expect(next.providers[0]?.modelMetadata?.alias?.[field]).toBeUndefined()
      }
      expect(resolveProviderContextWindow(next.providers[0], "alias")).toBe(256000)
    }
  })

  it("does not activate the first model when metadata is linked during initial setup", () => {
    const base = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const config = saveConnection(base, { name: "Gateway", baseURL: "https://gateway.example/v1", apiKey: "k",
      protocol: "openai", authMode: "api-key" })
    const next = associateModelMetadata(config, config.providers[0]!.id, "alias", catalogModelMetadata(catalog, "actual")!)
    expect(next.active).toEqual(config.active)
    expect(next.active.model).toBe("")
    expect(next.providers[0]?.models).toEqual(["alias"])
  })
})

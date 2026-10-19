import { describe, expect, it } from "bun:test"
import { getDefaultConfig, presetMap } from "../src/config.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearModelsDevCache, MODELS_DEV_API_URL } from "../zapsdk/core/models-dev.js"
import { refreshModelsDevMetadata } from "../src/provider-metadata.js"
import { discoverProviderModels } from "../src/provider-catalog.js"

describe("provider environment bootstrap", () => {
  it("uses catalog identities for bootstrap hydration and public fallback", async () => {
    const keys = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "MODEL", "ZAPCODE_DATA_DIR"] as const
    const before = keys.map(key => process.env[key])
    const originalFetch = globalThis.fetch
    const dir = await mkdtemp(join(tmpdir(), "zap-bootstrap-catalog-"))
    try {
      process.env.ZAPCODE_DATA_DIR = dir
      process.env.OPENAI_API_KEY = "fake"
      process.env.MODEL = "model-x"
      const ids = ["moonshot", "gemini", "dashscope", "zhipu"]
      const catalog = Object.fromEntries(ids.map(id => [presetMap.get(id)!.modelsDevProviderId!, {
        models: { "model-x": { limit: { context: 123456 } }, "public-model": { limit: { context: 123456 } } },
      }]))
      clearModelsDevCache()
      globalThis.fetch = (async url => String(url) === MODELS_DEV_API_URL
        ? Response.json(catalog) : new Response("Denied", { status: 403 })) as typeof fetch
      for (const id of ids) {
        const preset = presetMap.get(id)!
        process.env.OPENAI_BASE_URL = preset.baseURL!
        const config = getDefaultConfig()
        const provider = config.providers[0]!
        expect(provider.catalogProviderId).toBe(preset.modelsDevProviderId)
        const hydrated = await refreshModelsDevMetadata(config)
        expect(hydrated.providers[0]?.modelMetadata?.["model-x"]?.contextWindow).toBe(123456)
        const discovered = await discoverProviderModels(provider, new AbortController().signal)
        expect(discovered.rows.find(row => row.id === "public-model")?.source).toBe("models.dev")
      }
    } finally {
      globalThis.fetch = originalFetch
      clearModelsDevCache()
      keys.forEach((key, index) => {
        if (before[index] === undefined) delete process.env[key]
        else process.env[key] = before[index]
      })
      await rm(dir, { recursive: true, force: true })
    }
  })
  it("inherits protocol and request parameters for environment bootstrap", () => {
    const before = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY, model: process.env.MODEL }
    try {
      process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1"
      process.env.OPENAI_API_KEY = "fake"
      process.env.MODEL = "test"
      expect(getDefaultConfig().providers[0]?.extraRequestParams).toEqual(presetMap.get("deepseek")?.extraRequestParams)
    } finally {
      for (const [key, value] of [["OPENAI_BASE_URL", before.base], ["OPENAI_API_KEY", before.key], ["MODEL", before.model]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

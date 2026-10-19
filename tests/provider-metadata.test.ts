import { afterEach, describe, expect, it } from "bun:test"
import type { AppConfig, Provider } from "../src/config.js"
import {
  enrichProviderMetadata,
  applyMetadataRefresh,
  mergeModelMetadata,
  refreshModelsDevMetadata,
} from "../src/provider-metadata.js"
import {
  clearModelsDevCache,
  type ModelsDevProvider,
} from "../zapsdk/core/models-dev.js"

const catalog: ModelsDevProvider = {
  id: "deepseek",
  name: "DeepSeek",
  models: [{
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    outputLimit: 384000,
    reasoning: true,
    toolCall: true,
    supportsVision: false,
    inputModalities: ["text"],
    outputModalities: ["text"],
  }],
}

function provider(mode: "auto" | "manual" = "auto"): Provider {
  return {
    id: "sp_deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "test-key",
    contextWindow: 128000,
    contextWindowMode: mode,
    models: ["deepseek-v4-flash"],
    sourcePresetId: "deepseek",
  }
}

function config(p: Provider): AppConfig {
  return {
    providers: [p],
    active: { providerId: p.id, model: p.models[0] ?? "" },
    serperKey: "",
    maxTokens: 65536,
    maxSteps: 10,
    customSystemPrompt: "",
    compaction: { auto: true, prune: true, reserved: 0 },
    mcpServers: [],
    permissionMode: "default",
  }
}

describe("provider models.dev enrichment", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearModelsDevCache()
  })

  it("updates metadata and the compatibility snapshot for auto providers", () => {
    const enriched = enrichProviderMetadata(provider("auto"), catalog)
    expect(enriched.contextWindow).toBe(1000000)
    expect(enriched.modelMetadata?.["deepseek-v4-flash"]).toMatchObject({
      contextWindow: 1000000,
      outputLimit: 384000,
      source: "models.dev",
    })
  })

  it("never overwrites an explicit manual context", () => {
    const manual = { ...provider("manual"), contextWindow: 256000 }
    const enriched = enrichProviderMetadata(manual, catalog)
    expect(enriched.contextWindow).toBe(256000)
    expect(enriched.modelMetadata?.["deepseek-v4-flash"]?.contextWindow).toBe(1000000)
  })

  it("does not replace a concurrent edit, deletion or selection", () => {
    const initial = config(provider())
    const refreshed = { ...initial, providers: [enrichProviderMetadata(initial.providers[0]!, catalog)] }
    const current = { ...initial, active: { ...initial.active, model: "new-selection" }, maxSteps: 42 }
    const merged = applyMetadataRefresh(current, initial, refreshed)
    expect(merged.active).toBe(current.active)
    expect(merged.maxSteps).toBe(42)
    expect(merged.providers[0]?.contextWindow).toBe(1000000)
    const edited = { ...current, providers: [{ ...initial.providers[0]!, apiKey: "changed" }] }
    expect(applyMetadataRefresh(edited, initial, refreshed)).toBe(edited)
    const removed = { ...current, providers: [] }
    expect(applyMetadataRefresh(removed, initial, refreshed)).toBe(removed)
  })

  it("keeps explicit metadata and treats missing catalog fields as unknown", () => {
    expect(mergeModelMetadata({ a: { contextWindow: 42, source: "manual" } },
      { a: { contextWindow: 100, source: "models.dev" } }).a?.contextWindow).toBe(42)
    expect(mergeModelMetadata({ a: { toolCall: true } },
      { a: { toolCall: undefined, source: "models.dev" } }).a?.toolCall).toBe(true)
  })

  it("hydrates legacy providers through the startup refresh path", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1000000, output: 384000 },
          },
        },
      },
    }), { status: 200 })) as typeof fetch

    const refreshed = await refreshModelsDevMetadata(config(provider("auto")))
    expect(refreshed.providers[0]?.contextWindow).toBe(1000000)
    expect(refreshed.providers[0]?.modelMetadata?.["deepseek-v4-flash"]?.reasoning).toBe(true)
  })
})

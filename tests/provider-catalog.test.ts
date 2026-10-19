import { afterEach, describe, expect, it } from "bun:test"
import { createCustomProvider, getDefaultConfig } from "../src/config.js"
import { describeCatalogRow, discoverProviderModels, selectCatalogModel } from "../src/provider-catalog.js"

const provider = createCustomProvider({ name: "Local", baseURL: "http://localhost:11434/v1", apiKey: "", models: ["manual"], contextWindow: 128000 })

describe("separate model directory", () => {
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original })
  it("discovers without mutating saved models and retains manual aliases", async () => {
    globalThis.fetch = (async () => Response.json({ data: [{ id: "live" }] })) as typeof fetch
    const result = await discoverProviderModels(provider, new AbortController().signal)
    expect(result.rows.map(row => [row.id, row.source])).toEqual([["manual", "saved"], ["live", "provider"]])
    expect(provider.models).toEqual(["manual"])
    expect(describeCatalogRow(result.rows[1]!)).toContain("tools ?")
    expect(describeCatalogRow(result.rows[1]!)).toContain("access unverified")
  })
  it("keeps saved models when endpoint discovery fails", async () => {
    globalThis.fetch = (async () => new Response("Denied", { status: 403 })) as typeof fetch
    const result = await discoverProviderModels(provider, new AbortController().signal)
    expect(result.rows.find(row => row.id === "manual")?.source).toBe("saved")
    expect(result.rows.map(row => row.id)).toEqual(["manual"])
    expect(result.error).toContain("unverified")
  })
  it("only explicit selection updates the active binding", () => {
    const config = { ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "manual" } }
    const next = selectCatalogModel(config, provider.id, { id: "new-model", source: "manual" })
    expect(next.active.model).toBe("new-model")
    expect(next.providers[0]?.models).toEqual(["manual", "new-model"])
    expect(config.active.model).toBe("manual")
    expect(selectCatalogModel(config, "deleted", { id: "new", source: "manual" })).toBe(config)
  })
})

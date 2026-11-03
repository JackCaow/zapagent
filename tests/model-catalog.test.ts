import { describe, expect, it } from "bun:test"
import { createCustomProvider, getDefaultConfig } from "../src/config.js"
import { configuredModelRows, discoverConfiguredModels, modelCatalogKey, savedConnectionCatalogs, type ConnectionCatalog } from "../src/model-catalog.js"
import { selectCatalogModel, type DiscoveredCatalog } from "../src/provider-catalog.js"

const providers = ["Alpha", "Beta"].map((name, i) => ({ ...createCustomProvider({ name, baseURL: `http://localhost:${12000 + i}/v1`, apiKey: `fixture-${name}`, models: ["shared", `${name.toLowerCase()}-only`], contextWindow: 128000 }), id: `fixture-${name}` }))
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe("configured model aggregation", () => {
  it("keeps same model IDs on different connections distinct and selects the right binding", () => {
    const catalogs = savedConnectionCatalogs(providers)
    const rows = configuredModelRows(providers, catalogs, null, "shared")
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => modelCatalogKey(row.provider.id, row.id))).size).toBe(2)
    const config = { ...getDefaultConfig(), providers, active: { providerId: providers[0].id, model: "shared" } }
    const row = rows[1]
    const next = selectCatalogModel(config, row.provider.id, row)
    expect(next.active).toEqual({ providerId: providers[1].id, model: "shared" })
    expect(next.providers[1].apiKey).toBe("fixture-Beta")
    expect(config.active.providerId).toBe(providers[0].id)
    expect(modelCatalogKey("a:b", "c")).not.toBe(modelCatalogKey("a", "b:c"))
  })
  it("searches all connections by model, connection label and endpoint, with an optional provider filter", () => {
    const catalogs = savedConnectionCatalogs(providers)
    expect(configuredModelRows(providers, catalogs, null, "BETA").map(row => row.provider.id)).toEqual([providers[1].id, providers[1].id])
    expect(configuredModelRows(providers, catalogs, null, "12000")).toHaveLength(2)
    expect(configuredModelRows(providers, catalogs, providers[0].id, "shared")).toHaveLength(1)
    expect(configuredModelRows([providers[0]], catalogs, null, "beta")).toHaveLength(0)
  })
  it("settles connections independently and never mutates the configured model lists", async () => {
    const slow = deferred<DiscoveredCatalog>(), updates: ConnectionCatalog[] = []
    const cancel = discoverConfiguredModels(providers, value => updates.push(value), async provider => provider.id === providers[0].id
      ? slow.promise : { rows: [{ id: "beta-live", source: "provider" }] }, 1000)
    try {
      await tick()
      expect(updates.map(row => row.providerId)).toEqual([providers[1].id])
      slow.resolve({ rows: [{ id: "alpha-live", source: "provider" }] }); await tick()
      expect(updates.map(row => row.providerId)).toEqual([providers[1].id, providers[0].id])
      expect(providers[0].models).toEqual(["shared", "alpha-only"])
    } finally { cancel() }
  })
  it("retains saved models on failures and timeouts, ignores late results and stops updates after disposal", async () => {
    const late = deferred<DiscoveredCatalog>(), updates: ConnectionCatalog[] = [], signals: AbortSignal[] = []
    let finished!: () => void
    const settled = new Promise<void>(resolve => { finished = resolve })
    const cancel = discoverConfiguredModels(providers, value => { updates.push(value); if (updates.length === 2) finished() }, async (provider, signal) => {
      signals.push(signal)
      if (provider.id === providers[0].id) return late.promise
      throw new Error("fixture offline")
    }, 10)
    try {
      await settled
      expect(updates).toHaveLength(2)
      expect(updates.every(update => !update.loading && update.error && update.rows.some(row => row.id === "shared"))).toBe(true)
      expect(signals[0].aborted).toBe(true)
      late.resolve({ rows: [{ id: "late", source: "provider" }] }); await tick()
      expect(updates).toHaveLength(2)
    } finally { cancel() }
    const never = deferred<DiscoveredCatalog>()
    const stop = discoverConfiguredModels(providers, value => updates.push(value), async () => never.promise)
    await tick(); stop(); never.resolve({ rows: [] }); await tick()
    expect(updates).toHaveLength(2)
  })
})

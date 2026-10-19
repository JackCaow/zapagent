import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelCatalogCache } from "../../core/model-catalog-cache.js"

const catalog = { test: { models: { a: { limit: { context: 1000 } } } } }

describe("public catalog cache", () => {
  it("explicit reload bypasses TTL, waits for fresh data, and deduplicates requests", async () => {
    let calls = 0
    let release!: (value: unknown) => void
    const fresh = { newVendor: { models: {} } }
    const cache = new ModelCatalogCache({ load: async () => {
      calls++
      return calls === 1 ? catalog : new Promise(resolve => { release = resolve })
    } })
    expect(await cache.get()).toEqual(catalog)
    expect(await cache.get()).toEqual(catalog)
    const reloads = [cache.refresh(), cache.refresh()]
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
    expect(await cache.get()).toEqual(catalog)
    release(fresh)
    expect(await Promise.all(reloads)).toEqual([fresh, fresh])
    expect(await cache.get()).toEqual(fresh)
  })

  it("failed reload preserves the snapshot and an explicit retry bypasses backoff", async () => {
    let calls = 0
    const fresh = { recovered: { models: {} } }
    const cache = new ModelCatalogCache({ load: async () => {
      calls++
      if (calls === 2) throw new Error("offline")
      return calls === 1 ? catalog : fresh
    } })
    expect(await cache.get()).toEqual(catalog)
    await expect(cache.refresh()).rejects.toThrow("offline")
    expect(await cache.get()).toEqual(catalog)
    expect(await cache.refresh()).toEqual(fresh)
    expect(calls).toBe(3)
  })
  it("deduplicates cold requests and retries failures", async () => {
    let calls = 0
    const cache = new ModelCatalogCache({ load: async () => {
      calls++
      if (calls === 1) throw new Error("offline")
      return catalog
    } })
    await expect(cache.get()).rejects.toThrow("offline")
    expect(await Promise.all([cache.get(), cache.get()])).toEqual([catalog, catalog])
    expect(calls).toBe(2)
  })

  it("serves disk data offline, refreshes stale data without blocking, and backs off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zap-catalog-"))
    try {
      const path = join(dir, "catalog.json")
      await new ModelCatalogCache({ path, now: () => 10, load: async () => catalog }).get()
      let calls = 0
      const cache = new ModelCatalogCache({ path, ttlMs: 1, now: () => 20,
        load: async () => { calls++; throw new Error("offline") } })
      expect(await cache.get()).toEqual(catalog)
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(await cache.get()).toEqual(catalog)
      expect(calls).toBe(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it("ignores corrupt snapshots and does not cache malformed responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zap-catalog-"))
    try {
      const path = join(dir, "catalog.json")
      await writeFile(path, "broken")
      const cache = new ModelCatalogCache({ path, load: async () => [] })
      await expect(cache.get()).rejects.toThrow("Invalid public model catalog")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

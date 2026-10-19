import { describe, expect, it } from "bun:test"
import {
  makePromptCacheScope,
  samePromptCacheScope,
  sanitizePromptCacheScope,
} from "../../src/agent/cacheScope.js"

describe("prompt cache scope", () => {
  it("normalizes provider and model identifiers", () => {
    expect(makePromptCacheScope(" provider_1 ", " model-a ")).toEqual({
      providerId: "provider_1",
      model: "model-a",
    })
  })

  it("rejects incomplete or malformed scopes", () => {
    expect(makePromptCacheScope("", "model-a")).toBeUndefined()
    expect(makePromptCacheScope("provider_1", 42)).toBeUndefined()
    expect(sanitizePromptCacheScope(["provider_1", "model-a"])).toBeUndefined()
  })

  it("bounds Unicode identifiers without splitting surrogate pairs", () => {
    const scope = makePromptCacheScope("😀".repeat(300), "🚀".repeat(600))

    expect(Array.from(scope?.providerId ?? "")).toHaveLength(256)
    expect(Array.from(scope?.model ?? "")).toHaveLength(512)
    expect(scope?.providerId.endsWith("😀")).toBe(true)
    expect(scope?.model.endsWith("🚀")).toBe(true)
  })

  it("requires both provider and model to match", () => {
    const current = { providerId: "provider_1", model: "model-a" }
    expect(samePromptCacheScope(current, { ...current })).toBe(true)
    expect(samePromptCacheScope(current, { providerId: "provider_2", model: "model-a" })).toBe(false)
    expect(samePromptCacheScope(current, { providerId: "provider_1", model: "model-b" })).toBe(false)
    expect(samePromptCacheScope(current, undefined)).toBe(false)
  })
})

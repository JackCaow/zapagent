import { describe, expect, it } from "bun:test"
import { getDefaultConfig, createCustomProvider, hasApiKey, getEffortValuesForProvider, hasDeclaredEffortValues, PROVIDER_PRESETS } from "../../src/config.js"
import { saveConnection } from "../../src/ui/dialog-connect.js"

describe("connection persistence before model selection", () => {
  it("persists exact public provider identity without a built-in preset", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const next = saveConnection(config, { name: "Arbitrary provider", catalogProviderId: "brand-new-vendor",
      baseURL: "https://future.example/v1", apiKey: "test", protocol: "openai", authMode: "api-key" })
    expect(next.providers[0]?.catalogProviderId).toBe("brand-new-vendor")
    expect(next.providers[0]?.sourcePresetId).toBeUndefined()
    expect(next.providers[0]?.contextWindowMode).toBe("auto")
    expect(next.providers[0]?.models).toEqual([])
  })
  it("saves a keyless custom connection without inventing a model", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const next = saveConnection(config, { name: "Local", baseURL: "http://localhost:11434/v1", apiKey: "",
      protocol: "openai", authMode: "none" })
    expect(next.providers[0]?.models).toEqual([])
    expect(next.active.model).toBe("")
    expect(hasApiKey(next)).toBe(true)
  })

  it("edits an inactive connection without changing the active model or preferences", () => {
    const first = createCustomProvider({ name: "First", baseURL: "http://localhost:1", apiKey: "a", models: ["chosen"], contextWindow: 1000 })
    const second = { ...first, id: "second", models: ["manual", "other"] }
    const config = { ...getDefaultConfig(), providers: [first, second], active: { providerId: first.id, model: "chosen" } }
    const next = saveConnection(config, { existing: second, name: "Edited", baseURL: second.baseURL,
      apiKey: "", protocol: "anthropic", authMode: "none" })
    expect(next.active).toEqual(config.active)
    expect(next.providers[1]?.models).toEqual(["manual", "other"])
    expect(next.providers[1]?.protocol).toBe("anthropic")
    expect(next.providers[1]?.apiKey).toBe("")
  })

  it("keeps the active model when a new connection is saved before selection or skipped", () => {
    const first = createCustomProvider({ name: "First", baseURL: "http://localhost:1", apiKey: "a", models: ["chosen"], contextWindow: 1000 })
    const config = { ...getDefaultConfig(), providers: [first], active: { providerId: first.id, model: "chosen" } }
    const next = saveConnection(config, { name: "New", baseURL: "http://localhost:2", apiKey: "b",
      protocol: "openai", authMode: "api-key" })
    expect(next.active).toEqual(config.active)
    expect(next.providers[1]?.models).toEqual([])
  })

  it("gives a directory-created DeepSeek connection its preset request params and effort values", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const next = saveConnection(config, { name: "DeepSeek", catalogProviderId: "deepseek",
      baseURL: "https://api.deepseek.com/v1", apiKey: "k", protocol: "openai", authMode: "api-key" })
    const provider = next.providers[0]!
    expect(provider.sourcePresetId).toBe("deepseek")
    expect(provider.catalogProviderId).toBe("deepseek")
    expect(provider.extraRequestParams).toEqual({ thinking: { type: "enabled" } })
    expect(hasDeclaredEffortValues(next, provider.id)).toBe(true)
    expect(getEffortValuesForProvider(next, provider.id)).toEqual(["high", "max"])
    // The preset table must not be shared by reference with saved config.
    ;(provider.extraRequestParams as { thinking: { type: string } }).thinking.type = "mutated"
    expect(PROVIDER_PRESETS.find(item => item.id === "deepseek")!.extraRequestParams).toEqual({ thinking: { type: "enabled" } })
  })

  it("maps directory ids that differ from preset ids", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const next = saveConnection(config, { name: "Gemini", catalogProviderId: "google",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "k", protocol: "openai", authMode: "api-key" })
    expect(next.providers[0]?.sourcePresetId).toBe("gemini")
    expect(next.providers[0]?.catalogProviderId).toBe("google")
  })

  it("does not attach a preset to a custom endpoint, even one that looks like DeepSeek", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const next = saveConnection(config, { name: "Proxy", baseURL: "https://api.deepseek.com/v1",
      apiKey: "k", protocol: "openai", authMode: "api-key" })
    expect(next.providers[0]?.sourcePresetId).toBeUndefined()
    expect(next.providers[0]?.extraRequestParams).toBeUndefined()
  })

  it("repairs a connection created without a preset when it is edited", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const created = saveConnection(config, { name: "DeepSeek", catalogProviderId: "deepseek",
      baseURL: "https://api.deepseek.com/v1", apiKey: "k", protocol: "openai", authMode: "api-key" })
    const legacy = { ...created.providers[0]!, sourcePresetId: undefined, extraRequestParams: undefined }
    const edited = saveConnection({ ...created, providers: [legacy] }, { existing: legacy, name: "DeepSeek",
      baseURL: legacy.baseURL, apiKey: "k", protocol: "openai", authMode: "api-key" })
    expect(edited.providers[0]?.sourcePresetId).toBe("deepseek")
    expect(edited.providers[0]?.extraRequestParams).toEqual({ thinking: { type: "enabled" } })
  })

  it("keeps a gateway on another host free of the preset even when it carries the catalog id", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const next = saveConnection(config, { name: "DeepSeek via gateway", catalogProviderId: "deepseek",
      baseURL: "https://my-gateway.example/v1", apiKey: "k", protocol: "openai", authMode: "api-key" })
    expect(next.providers[0]?.catalogProviderId).toBe("deepseek")
    expect(next.providers[0]?.sourcePresetId).toBeUndefined()
    expect(next.providers[0]?.extraRequestParams).toBeUndefined()
  })

  it("does not re-add params the user cleared when editing a legacy connection", () => {
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const created = saveConnection(config, { name: "DeepSeek", catalogProviderId: "deepseek",
      baseURL: "https://api.deepseek.com", apiKey: "k", protocol: "openai", authMode: "api-key" })
    const cleared = { ...created.providers[0]!, sourcePresetId: undefined, extraRequestParams: {} }
    const edited = saveConnection({ ...created, providers: [cleared] }, { existing: cleared, name: "DeepSeek",
      baseURL: cleared.baseURL, apiKey: "k", protocol: "openai", authMode: "api-key" })
    expect(edited.providers[0]?.extraRequestParams).toEqual({})
  })
})

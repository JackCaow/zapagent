import { describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  calculateTokenWarningState,
  consumeResidentCredentialEnvironment,
  deriveCompaction,
  getActiveContextWindow,
  getDefaultConfig,
  loadAppConfig,
  presetForCatalogId,
  presetForConnection,
  resolveCatalogProviderId,
  saveAppConfig,
} from "../src/config.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("config persistence", () => {
  it("persists Queue/Steer defaults and normalizes invalid modes to Queue", () => {
    const dir = makeTmpDir(), path = join(dir, "config.json")
    try {
      expect(getDefaultConfig().followUpMode).toBe("queue")
      saveAppConfig(path, { ...getDefaultConfig(), followUpMode: "steer" })
      expect(loadAppConfig(path).followUpMode).toBe("steer")
      writeFileSync(path, JSON.stringify({ ...getDefaultConfig(), followUpMode: "invalid" }))
      expect(loadAppConfig(path).followUpMode).toBe("queue")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("consumes resident VM credentials without leaving them for child tools", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_BASE_URL: "https://api.example.test/v1",
      OPENAI_API_KEY: "model-secret",
      MODEL: "test-model",
      SERPER_KEY: "search-secret",
      PATH: "/usr/bin",
    }

    expect(consumeResidentCredentialEnvironment(env)).toEqual({
      baseURL: "https://api.example.test/v1",
      apiKey: "model-secret",
      model: "test-model",
      serperKey: "search-secret",
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.SERPER_KEY).toBeUndefined()
    expect(env.OPENAI_BASE_URL).toBe("https://api.example.test/v1")
    expect(env.MODEL).toBe("test-model")
    expect(env.PATH).toBe("/usr/bin")
  })

  it("saves config atomically with owner-only permissions", () => {
    const dir = makeTmpDir()
    try {
      const path = join(dir, "nested", "config.json")
      const config = {
        ...getDefaultConfig(),
        providers: [{
          id: "p1",
          name: "OpenAI",
          baseURL: "https://api.openai.com/v1",
          apiKey: "secret-key",
          contextWindow: 128000,
          models: ["gpt-5"],
          modelMetadata: {
            "gpt-5": {
              name: "GPT-5",
              contextWindow: 400000,
              outputLimit: 128000,
              supportsVision: true,
              source: "models.dev" as const,
            },
          },
        }],
        active: { providerId: "p1", model: "gpt-5" },
      }

      saveAppConfig(path, config)

      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(path, "utf-8")).providers[0].apiKey).toBe("secret-key")
      expect(loadAppConfig(path).providers[0]?.apiKey).toBe("secret-key")
      expect(loadAppConfig(path).providers[0]?.modelMetadata?.["gpt-5"]?.contextWindow).toBe(400000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("tightens permissions when replacing an existing broad config file", () => {
    const dir = makeTmpDir()
    try {
      const path = join(dir, "config.json")
      writeFileSync(path, "{}\n", { mode: 0o666 })
      chmodSync(path, 0o666)

      saveAppConfig(path, getDefaultConfig())

      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("normalizes malformed numeric fields and provider shape on load", () => {
    const dir = makeTmpDir()
    try {
      const path = join(dir, "config.json")
      writeFileSync(path, JSON.stringify({
        providers: [
          null,
          "bad-provider",
          {
            id: "p1",
            name: 123,
            baseURL: 456,
            apiKey: 789,
            contextWindow: -1,
            models: ["m1", 123, "", "m2"],
            protocol: "bogus",
          },
        ],
        active: { providerId: "p1", model: "missing-model" },
        maxTokens: "bad",
        maxSteps: 12.9,
        compaction: { auto: "yes", prune: false, reserved: -10 },
        maxSnapshotFileBytes: "big",
        maxSnapshots: -2,
      }) + "\n")

      const loaded = loadAppConfig(path)

      expect(loaded.maxTokens).toBe(getDefaultConfig().maxTokens)
      expect(loaded.maxSteps).toBe(12)
      expect(loaded.compaction).toEqual({ auto: true, prune: false, reserved: 0 })
      expect(loaded.maxSnapshotFileBytes).toBe(10 * 1024 * 1024)
      expect(loaded.maxSnapshots).toBe(0)
      expect(loaded.providers).toHaveLength(1)
      expect(loaded.providers[0]).toMatchObject({
        id: "p1",
        name: "",
        baseURL: "",
        apiKey: "",
        contextWindow: 128000,
        models: ["m1", "m2"],
      })
      expect(loaded.providers[0]?.protocol).toBeUndefined()
      expect(loaded.providers[0]?.contextWindowMode).toBe("manual")
      expect(loaded.active).toEqual({ providerId: "p1", model: "m1" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("migrates the legacy preset 128k leak to auto context mode", () => {
    const dir = makeTmpDir()
    try {
      const path = join(dir, "config.json")
      writeFileSync(path, JSON.stringify({
        providers: [{
          id: "legacy-deepseek",
          name: "DeepSeek",
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "test-key",
          contextWindow: 128000,
          models: ["deepseek-v4-flash"],
          sourcePresetId: "deepseek",
        }],
        active: { providerId: "legacy-deepseek", model: "deepseek-v4-flash" },
      }) + "\n")

      const loaded = loadAppConfig(path)
      expect(loaded.providers[0]?.contextWindowMode).toBe("auto")
      expect(loaded.providers[0]?.contextWindow).toBe(128000)
      // Runtime resolution immediately uses the preset's 1M while background
      // models.dev hydration later persists model-specific metadata.
      expect(getActiveContextWindow(loaded)).toBe(1000000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves a divergent legacy preset context as a manual override", () => {
    const dir = makeTmpDir()
    try {
      const path = join(dir, "config.json")
      writeFileSync(path, JSON.stringify({
        providers: [{
          id: "custom-deepseek",
          name: "DeepSeek custom context",
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "test-key",
          contextWindow: 256000,
          models: ["deepseek-v4-flash"],
          sourcePresetId: "deepseek",
        }],
        active: { providerId: "custom-deepseek", model: "deepseek-v4-flash" },
      }) + "\n")

      const loaded = loadAppConfig(path)
      expect(loaded.providers[0]?.contextWindowMode).toBe("manual")
      expect(getActiveContextWindow(loaded)).toBe(256000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("compaction thresholds", () => {
  it("normalizes invalid context windows before deriving thresholds", () => {
    expect(deriveCompaction(0)).toEqual(deriveCompaction(128000))
    expect(deriveCompaction(Number.NaN)).toEqual(deriveCompaction(128000))
    expect(deriveCompaction(-1).triggerAt).toBeGreaterThan(0)
  })

  it("keeps token warnings finite for invalid context windows", () => {
    const warning = calculateTokenWarningState(1000, 0)

    expect(Number.isFinite(warning.percentLeft)).toBe(true)
    expect(warning.percentLeft).toBeGreaterThanOrEqual(0)
  })
})

describe("preset and catalog identity", () => {
  it("maps preset ids to models.dev ids through the explicit table", () => {
    expect(resolveCatalogProviderId({ sourcePresetId: "gemini" })).toBe("google")
    expect(resolveCatalogProviderId({ sourcePresetId: "moonshot" })).toBe("moonshotai")
    expect(resolveCatalogProviderId({ sourcePresetId: "dashscope" })).toBe("alibaba")
    expect(resolveCatalogProviderId({ sourcePresetId: "zhipu" })).toBe("zhipuai")
    expect(resolveCatalogProviderId({ sourcePresetId: "anthropic-compat" })).toBeUndefined()
    expect(resolveCatalogProviderId({ catalogProviderId: "brand-new-vendor", sourcePresetId: "gemini" })).toBe("brand-new-vendor")
    expect(presetForCatalogId("google")?.id).toBe("gemini")
    expect(presetForCatalogId("brand-new-vendor")).toBeUndefined()
  })

  it("backfills catalogProviderId for providers saved with only a preset id", () => {
    const dir = makeTmpDir(), path = join(dir, "config.json")
    try {
      const legacy = { id: "sp_old", name: "Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "k", contextWindow: 1000000, models: ["gemini-2.5-pro"], sourcePresetId: "gemini" }
      writeFileSync(path, JSON.stringify({ ...getDefaultConfig(), providers: [legacy], active: { providerId: "sp_old", model: "gemini-2.5-pro" } }))
      const loaded = loadAppConfig(path).providers[0]!
      expect(loaded.catalogProviderId).toBe("google")
      expect(loaded.sourcePresetId).toBe("gemini")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("repairs directory-created connections that never received their preset", () => {
    const dir = makeTmpDir(), path = join(dir, "config.json")
    try {
      const broken = { id: "sp_dir", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", apiKey: "k",
        contextWindow: 128000, models: ["deepseek-chat"], catalogProviderId: "deepseek" }
      const custom = { id: "sp_custom", name: "Mine", baseURL: "https://api.deepseek.com/v1", apiKey: "k",
        contextWindow: 128000, models: ["m"] }
      writeFileSync(path, JSON.stringify({ ...getDefaultConfig(), providers: [broken, custom], active: { providerId: "sp_dir", model: "deepseek-chat" } }))
      const [fixed, untouched] = loadAppConfig(path).providers
      expect(fixed?.sourcePresetId).toBe("deepseek")
      expect(fixed?.extraRequestParams).toEqual({ thinking: { type: "enabled" } })
      // A custom endpoint is never promoted to a preset by URL.
      expect(untouched?.sourcePresetId).toBeUndefined()
      expect(untouched?.catalogProviderId).toBeUndefined()
      expect(untouched?.extraRequestParams).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("does not give a preset to a gateway on another host that shares the catalog id", () => {
    expect(presetForConnection("deepseek", "https://api.deepseek.com")?.id).toBe("deepseek")
    expect(presetForConnection("deepseek", "https://API.DeepSeek.com/v1")?.id).toBe("deepseek")
    expect(presetForConnection("deepseek", "https://my-gateway.example/v1")).toBeUndefined()
    expect(presetForConnection("deepseek", "not a url")).toBeUndefined()
    const dir = makeTmpDir(), path = join(dir, "config.json")
    try {
      const gateway = { id: "sp_gw", name: "Gateway", baseURL: "https://my-gateway.example/v1", apiKey: "k",
        contextWindow: 64000, models: ["m"], catalogProviderId: "deepseek" }
      writeFileSync(path, JSON.stringify({ ...getDefaultConfig(), providers: [gateway], active: { providerId: "sp_gw", model: "m" } }))
      const loaded = loadAppConfig(path).providers[0]!
      expect(loaded.sourcePresetId).toBeUndefined()
      expect(loaded.extraRequestParams).toBeUndefined()
      expect(loaded.contextWindow).toBe(64000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("migrates idempotently and leaves explicitly emptied request params alone", () => {
    const dir = makeTmpDir(), path = join(dir, "config.json")
    try {
      const emptied = { id: "sp_e", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", apiKey: "k",
        contextWindow: 128000, models: ["m"], catalogProviderId: "deepseek", sourcePresetId: "deepseek", extraRequestParams: {} }
      writeFileSync(path, JSON.stringify({ ...getDefaultConfig(), providers: [emptied], active: { providerId: "sp_e", model: "m" } }))
      const first = loadAppConfig(path)
      expect(first.providers[0]?.extraRequestParams).toEqual({})
      saveAppConfig(path, first)
      expect(loadAppConfig(path).providers[0]).toEqual(first.providers[0])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

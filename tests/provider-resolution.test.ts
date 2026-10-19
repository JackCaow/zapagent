import { describe, expect, it } from "bun:test"
import {
  buildConnectedProvider,
  getActiveContextWindow,
  presetMap,
  type AppConfig,
  type Provider,
} from "../src/config.js"

const deepseek = presetMap.get("deepseek")!

function configWith(provider: Provider): AppConfig {
  return {
    providers: [provider],
    active: { providerId: provider.id, model: provider.models[0] ?? "" },
    serperKey: "",
    maxTokens: 65536,
    maxSteps: 10,
    customSystemPrompt: "",
    compaction: { auto: true, prune: true, reserved: 0 },
    mcpServers: [],
    permissionMode: "default",
  }
}

function connect(overrides: Partial<Parameters<typeof buildConnectedProvider>[0]> = {}) {
  return buildConnectedProvider({
    preset: deepseek,
    name: "DeepSeek",
    baseURL: deepseek.baseURL,
    apiKey: "test-key",
    models: ["deepseek-v4-flash"],
    modelMetadata: {
      "deepseek-v4-flash": {
        contextWindow: 1000000,
        outputLimit: 384000,
        source: "models.dev",
      },
    },
    contextWindowInput: 128000,
    ...overrides,
  })
}

describe("connected provider context resolution", () => {
  it("creates normal presets in auto mode using model metadata", () => {
    const provider = connect()
    expect(provider.contextWindowMode).toBe("auto")
    expect(provider.contextWindow).toBe(1000000)
    expect(getActiveContextWindow(configWith(provider))).toBe(1000000)
  })

  it("preserves auto mode when an existing provider is edited without touching context", () => {
    const legacy: Provider = {
      id: "sp_legacy",
      name: "DeepSeek",
      baseURL: deepseek.baseURL,
      apiKey: "test-key",
      contextWindow: 128000,
      contextWindowMode: "auto",
      models: ["deepseek-v4-flash"],
      sourcePresetId: "deepseek",
    }
    const provider = connect({ existing: legacy })
    expect(provider.id).toBe("sp_legacy")
    expect(provider.contextWindowMode).toBe("auto")
    expect(provider.contextWindow).toBe(1000000)
  })

  it("records a manual override only when context was explicitly changed", () => {
    const provider = connect({ contextWindowInput: 256000, contextWindowMode: "manual" })
    expect(provider.contextWindowMode).toBe("manual")
    expect(provider.contextWindow).toBe(256000)
    expect(getActiveContextWindow(configWith(provider))).toBe(256000)
  })

  it("preserves an existing manual override when editing other fields", () => {
    const existing = connect({ contextWindowInput: 256000, contextWindowMode: "manual" })
    const provider = connect({ existing, name: "DeepSeek renamed", contextWindowInput: 256000 })
    expect(provider.name).toBe("DeepSeek renamed")
    expect(provider.contextWindowMode).toBe("manual")
    expect(provider.contextWindow).toBe(256000)
  })

  it("allows an existing manual provider to opt back into auto mode", () => {
    const existing = connect({ contextWindowInput: 256000, contextWindowMode: "manual" })
    const provider = connect({ existing, contextWindowMode: "auto" })
    expect(provider.contextWindowMode).toBe("auto")
    expect(provider.contextWindow).toBe(1000000)
  })

  it("uses the preset fallback in auto mode when catalog metadata is unavailable", () => {
    const provider = connect({ modelMetadata: undefined })
    expect(provider.contextWindowMode).toBe("auto")
    expect(provider.contextWindow).toBe(1000000)
  })
})

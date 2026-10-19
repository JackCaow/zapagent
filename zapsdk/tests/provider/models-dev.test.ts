import { describe, expect, it } from "bun:test"
import {
  parseModelsDevProvider,
  suggestedModelsDevIds,
  parseModelsDevConnections,
} from "../../core/models-dev.js"

const catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "old-model": {
        id: "old-model",
        name: "Old",
        tool_call: true,
        status: "deprecated",
        last_updated: "2024-01-01",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 8192, output: 1024 },
      },
      "image-only": {
        id: "image-only",
        name: "Image Only",
        attachment: true,
        tool_call: false,
        last_updated: "2026-03-01",
        modalities: { input: ["text", "image"], output: ["image"] },
        limit: { context: 0, output: 0 },
      },
      "gpt-agent": {
        id: "gpt-agent",
        name: "GPT Agent",
        reasoning: true,
        tool_call: true,
        last_updated: "2026-02-01",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 400000, input: 272000, output: 128000 },
      },
    },
  },
}

describe("models.dev catalog adapter", () => {
  it("accepts arbitrary new providers from the directory without a brand allowlist", () => {
    const rows = parseModelsDevConnections({
      "future-vendor": { name: "Future Vendor", npm: "@ai-sdk/openai-compatible", api: "https://future.example/v1", models: {} },
      "messages-vendor": { name: "Messages Vendor", npm: "@ai-sdk/anthropic", models: {} },
      unsupported: { name: "Unsupported", npm: "@ai-sdk/google", models: {} },
    })
    expect(rows.find(row => row.id === "future-vendor")).toMatchObject({ api: "https://future.example/v1", protocol: "openai" })
    expect(rows.find(row => row.id === "messages-vendor")).toMatchObject({ protocol: "anthropic" })
    expect(rows.find(row => row.id === "messages-vendor")?.api).toBeUndefined()
    expect(rows.find(row => row.id === "unsupported")?.protocol).toBeUndefined()
  })

  it("does not trust embedded credentials or non-HTTP endpoints", () => {
    const rows = parseModelsDevConnections({ a: { api: "https://secret:password@example.com", models: {} },
      b: { api: "file:///etc/passwd", models: {} }, c: { api: "https://example.com?key=secret", models: {} } })
    expect(rows.every(row => row.api === undefined)).toBe(true)
    expect(parseModelsDevConnections(null)).toEqual([])
  })
  it("normalizes model limits and capabilities", () => {
    const provider = parseModelsDevProvider(catalog, "openai")!
    const model = provider.models.find(item => item.id === "gpt-agent")!

    expect(provider.name).toBe("OpenAI")
    expect(model).toMatchObject({
      name: "GPT Agent",
      contextWindow: 400000,
      inputLimit: 272000,
      outputLimit: 128000,
      supportsVision: true,
      reasoning: true,
      toolCall: true,
    })
  })

  it("keeps fallback suggestions to current text tool-call models", () => {
    const provider = parseModelsDevProvider(catalog, "openai")!
    expect(suggestedModelsDevIds(provider)).toEqual(["gpt-agent"])
  })

  it("returns null for missing or malformed providers", () => {
    expect(parseModelsDevProvider(catalog, "missing")).toBeNull()
    expect(parseModelsDevProvider([], "openai")).toBeNull()
  })
})

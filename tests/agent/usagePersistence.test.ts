import { describe, expect, it } from "bun:test"
import { persistRunUsage } from "../../src/agent/usagePersistence.js"

describe("persistRunUsage", () => {
  it("retains reported counters while marking missing abandoned-request usage", () => {
    const writes: unknown[][] = []
    persistRunUsage({ inputTokens: 10, outputTokens: 3, providerUsageReported: true, usageIncomplete: true },
      { getLocalEstimate: () => 0, appendUsage: (...args) => { writes.push(args) } })
    expect(writes[0]?.slice(0, 3)).toEqual([10, 0, 3])
    expect(writes[0]?.[3]).toMatchObject({ inputTokens: 10, providerUsageReported: true, usageIncomplete: true })
  })
  it("persists total prompt tokens and cache details", () => {
    const writes: unknown[][] = []
    let promptOverhead = 0

    const result = persistRunUsage(
      {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        outputTokens: 7,
        step: 3,
        finishReason: "stop",
        cacheScope: { providerId: "provider_1", model: "model-a" },
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
        setPromptOverhead: (n) => { promptOverhead = n },
      },
    )

    expect(result).toEqual({ used: 100, localEstimateAtTime: 20, promptOverhead: 80 })
    expect(promptOverhead).toBe(80)
    expect(writes).toEqual([
      [
        100,
        20,
        7,
        {
          inputTokens: 10,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 10,
          totalPromptInputTokens: 100,
          cacheHitRatio: 0.8,
          cacheReuseRatio: 80 / 90,
          cacheWriteRatio: 0.1,
          step: 3,
          finishReason: "stop",
          cacheScope: { providerId: "provider_1", model: "model-a" },
        },
      ],
    ])
  })

  it("persists context diagnostics alongside cache usage", () => {
    const writes: unknown[][] = []
    const contextDiagnostics = {
      totalChars: 400,
      estimatedTokens: 100,
      hash: "ctx_hash",
      segments: [
        {
          name: "memory_index",
          chars: 360,
          estimatedTokens: 90,
          hash: "mem_hash",
          meta: { budgetTokens: 768, queryHash: "queryabc1234" },
        },
      ],
    }

    persistRunUsage(
      {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        outputTokens: 7,
        contextDiagnostics,
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
      },
    )

    expect(writes[0]?.[3]).toMatchObject({
      inputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      contextDiagnostics,
    })
  })

  it("persists prompt cache diagnostics alongside cache usage", () => {
    const writes: unknown[][] = []
    const promptCacheDiagnostics = {
      boundaryPresent: true,
      staticPrefix: {
        chars: 40000,
        estimatedTokens: 10000,
        hash: "promptstatic",
      },
      dynamicSuffix: {
        chars: 600,
        estimatedTokens: 150,
        hash: "promptdyn123",
      },
    }

    persistRunUsage(
      {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        outputTokens: 7,
        promptCacheDiagnostics,
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
      },
    )

    expect(writes[0]?.[3]).toMatchObject({
      inputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      promptCacheDiagnostics,
    })
  })

  it("sanitizes diagnostics before persisting usage", () => {
    const writes: unknown[][] = []

    persistRunUsage(
      {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        outputTokens: 7,
        contextDiagnostics: {
          totalChars: Number.NaN,
          estimatedTokens: -5,
          hash: "ctx_hash",
          segments: [
            {
              name: "memory_index",
              chars: -1,
              estimatedTokens: Number.POSITIVE_INFINITY,
              hash: "mem_hash",
              meta: { included: ["a.md"] },
            },
            {
              name: "",
              chars: 10,
              estimatedTokens: 3,
              hash: "empty_name_is_allowed",
            },
            {
              name: "bad_segment",
              chars: 10,
              estimatedTokens: 3,
              hash: 123,
            },
          ],
        } as any,
        promptCacheDiagnostics: {
          boundaryPresent: "yes",
          staticPrefix: {
            chars: -100,
            estimatedTokens: Number.NaN,
            hash: "static_hash",
          },
          dynamicSuffix: {
            chars: 40,
            estimatedTokens: Number.POSITIVE_INFINITY,
            hash: "dynamic_hash",
          },
          toolSchemas: {
            count: -2,
            chars: -200,
            estimatedTokens: Number.POSITIVE_INFINITY,
            hash: "tools_hash",
            names: ["bash", 42, "read_file"],
          },
        } as any,
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
      },
    )

    expect(writes[0]?.[3]).toMatchObject({
      contextDiagnostics: {
        totalChars: 0,
        estimatedTokens: 0,
        hash: "ctx_hash",
        segments: [
          {
            name: "memory_index",
            chars: 0,
            estimatedTokens: 0,
            hash: "mem_hash",
            meta: { included: ["a.md"] },
          },
          {
            name: "",
            chars: 10,
            estimatedTokens: 3,
            hash: "empty_name_is_allowed",
          },
        ],
      },
      promptCacheDiagnostics: {
        boundaryPresent: false,
        staticPrefix: {
          chars: 0,
          estimatedTokens: 0,
          hash: "static_hash",
        },
        dynamicSuffix: {
          chars: 40,
          estimatedTokens: 0,
          hash: "dynamic_hash",
        },
        toolSchemas: {
          count: 0,
          chars: 0,
          estimatedTokens: 0,
          hash: "tools_hash",
          names: ["bash", "read_file"],
        },
      },
    })
  })

  it("does not lower prompt overhead when local estimate exceeds provider prompt usage", () => {
    let promptOverhead = 123

    const result = persistRunUsage(
      {
        inputTokens: 10,
        outputTokens: 1,
      },
      {
        getLocalEstimate: () => 50,
        appendUsage: () => {},
        setPromptOverhead: (n) => { promptOverhead = n },
      },
    )

    expect(result.promptOverhead).toBe(0)
    expect(promptOverhead).toBe(123)
  })

  it("does not persist cache ratios when the provider omitted cache accounting", () => {
    const writes: unknown[][] = []

    persistRunUsage(
      {
        inputTokens: 10,
        outputTokens: 1,
      },
      {
        getLocalEstimate: () => 5,
        appendUsage: (...args) => { writes.push(args) },
      },
    )

    expect(writes).toEqual([
      [
        10,
        5,
        1,
        {
          inputTokens: 10,
          totalPromptInputTokens: 10,
          step: undefined,
          finishReason: undefined,
        },
      ],
    ])
  })

  it("persists output-only usage without treating it as prompt context truth", () => {
    const writes: unknown[][] = []
    let promptOverhead = 77

    const result = persistRunUsage(
      {
        inputTokens: 0,
        outputTokens: 42,
        finishReason: "stop",
      },
      {
        getLocalEstimate: () => 120,
        appendUsage: (...args) => { writes.push(args) },
        setPromptOverhead: (n) => { promptOverhead = n },
      },
    )

    expect(result).toEqual({ used: 0, localEstimateAtTime: 120, promptOverhead: 0 })
    expect(promptOverhead).toBe(77)
    expect(writes).toEqual([
      [
        0,
        120,
        42,
        {
          inputTokens: 0,
          totalPromptInputTokens: 0,
          step: undefined,
          finishReason: "stop",
        },
      ],
    ])
  })

  it("persists the provider usage source when available", () => {
    const writes: unknown[][] = []

    persistRunUsage(
      {
        inputTokens: 0,
        outputTokens: 0,
        providerUsageReported: true,
      },
      {
        getLocalEstimate: () => 0,
        appendUsage: (...args) => { writes.push(args) },
      },
    )

    expect(writes).toEqual([
      [
        0,
        0,
        0,
        {
          inputTokens: 0,
          providerUsageReported: true,
          totalPromptInputTokens: 0,
          step: undefined,
          finishReason: undefined,
        },
      ],
    ])
  })

  it("does not persist synthetic provider-missing prompt usage as API truth", () => {
    const writes: unknown[][] = []
    let promptOverhead = 44

    const result = persistRunUsage(
      {
        inputTokens: 999,
        outputTokens: 7,
        cacheReadInputTokens: 888,
        cacheCreationInputTokens: 777,
        providerUsageReported: false,
        step: 2,
        finishReason: "stop",
        promptCacheDiagnostics: {
          boundaryPresent: true,
          staticPrefix: {
            chars: 40000,
            estimatedTokens: 10000,
            hash: "promptstatic",
          },
        },
      },
      {
        getLocalEstimate: () => 123,
        appendUsage: (...args) => { writes.push(args) },
        setPromptOverhead: (n) => { promptOverhead = n },
      },
    )

    expect(result).toEqual({ used: 0, localEstimateAtTime: 123, promptOverhead: 0 })
    expect(promptOverhead).toBe(44)
    expect(writes).toEqual([
      [
        0,
        123,
        7,
        {
          providerUsageReported: false,
          step: 2,
          finishReason: "stop",
          promptCacheDiagnostics: {
            boundaryPresent: true,
            staticPrefix: {
              chars: 40000,
              estimatedTokens: 10000,
              hash: "promptstatic",
            },
          },
        },
      ],
    ])
  })

  it("does not persist negative or non-finite usage values", () => {
    const writes: unknown[][] = []

    const result = persistRunUsage(
      {
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        cacheReadInputTokens: -80,
        cacheCreationInputTokens: 10,
      },
      {
        getLocalEstimate: () => 5,
        appendUsage: (...args) => { writes.push(args) },
      },
    )

    expect(result).toEqual({ used: 10, localEstimateAtTime: 5, promptOverhead: 5 })
    expect(writes).toEqual([
      [
        10,
        5,
        0,
        {
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 10,
          totalPromptInputTokens: 10,
          cacheHitRatio: 0,
          cacheReuseRatio: null,
          cacheWriteRatio: 1,
          step: undefined,
          finishReason: undefined,
        },
      ],
    ])
  })
})

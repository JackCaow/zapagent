import { describe, expect, it } from "bun:test"
import {
  buildContextBudgetSnapshot,
  legacyContextUsage,
  updateContextUsage,
  type ContextUsageState,
} from "../src/context-budget.js"
import { getDefaultConfig, type AppConfig } from "../src/config.js"

function configWithModelLimits(options: {
  contextWindow: number
  inputLimit?: number
  mode?: "auto" | "manual"
}): AppConfig {
  const config = getDefaultConfig()
  const provider = {
    id: "test-provider",
    name: "Test",
    baseURL: "https://api.openai.com/v1",
    apiKey: "test",
    contextWindow: options.contextWindow,
    contextWindowMode: options.mode ?? "auto",
    models: ["test-model"],
    sourcePresetId: "openai",
    modelMetadata: {
      "test-model": {
        contextWindow: options.contextWindow,
        ...(options.inputLimit ? { inputLimit: options.inputLimit } : {}),
        source: "models.dev" as const,
      },
    },
  }
  config.providers = [provider]
  config.active = { providerId: provider.id, model: "test-model" }
  return config
}

describe("buildContextBudgetSnapshot", () => {
  it("keeps advertised context separate from effective input and compaction limits", () => {
    const config = configWithModelLimits({ contextWindow: 1_000_000 })
    const snapshot = buildContextBudgetSnapshot(config, legacyContextUsage(14_100))

    expect(snapshot.limits.contextWindow).toBe(1_000_000)
    expect(snapshot.limits.reservedOutputTokens).toBe(8192)
    expect(snapshot.limits.safetyMarginTokens).toBe(1000)
    expect(snapshot.limits.effectiveInputLimit).toBe(990_808)
    expect(snapshot.limits.compactAt).toBe(792_646)
    expect(snapshot.limits.source).toBe("models-dev")
    expect(snapshot.remaining.untilCompact).toBe(778_546)
  })

  it("honors a smaller catalog input limit", () => {
    const config = configWithModelLimits({ contextWindow: 1_000_000, inputLimit: 700_000 })
    const snapshot = buildContextBudgetSnapshot(config, legacyContextUsage(560_000))

    expect(snapshot.limits.effectiveInputLimit).toBe(699_000)
    expect(snapshot.limits.compactAt).toBe(559_200)
    expect(snapshot.severity).toBe("critical")
  })

  it("does not warn from a pending local estimate", () => {
    const config = configWithModelLimits({ contextWindow: 128_000 })
    const snapshot = buildContextBudgetSnapshot(config, legacyContextUsage(100_000, true))

    expect(snapshot.usage.currentPromptTokens).toBe(100_000)
    expect(snapshot.pressure).toBeNull()
    expect(snapshot.severity).toBe("unknown")
    expect(snapshot.remaining.untilCompact).toBeNull()
  })

  it("derives severity from the auto-compact boundary", () => {
    const config = configWithModelLimits({ contextWindow: 1_000_000 })
    const compactAt = buildContextBudgetSnapshot(config, legacyContextUsage(0)).limits.compactAt

    expect(buildContextBudgetSnapshot(config, legacyContextUsage(Math.floor(compactAt * 0.74))).severity).toBe("normal")
    expect(buildContextBudgetSnapshot(config, legacyContextUsage(Math.ceil(compactAt * 0.75))).severity).toBe("notice")
    expect(buildContextBudgetSnapshot(config, legacyContextUsage(Math.ceil(compactAt * 0.875))).severity).toBe("warning")
    expect(buildContextBudgetSnapshot(config, legacyContextUsage(compactAt)).severity).toBe("critical")
  })
})

describe("updateContextUsage", () => {
  const empty: ContextUsageState = {
    currentPromptTokens: null,
    lastMeasuredPromptTokens: null,
    source: "pending",
    approximate: true,
  }

  it("retains the last provider measurement when current usage becomes estimated", () => {
    const measured = updateContextUsage(empty, 14_100, "provider")
    const estimated = updateContextUsage(measured, 15_300, "estimated")

    expect(measured).toEqual({
      currentPromptTokens: 14_100,
      lastMeasuredPromptTokens: 14_100,
      source: "provider",
      approximate: false,
    })
    expect(estimated).toEqual({
      currentPromptTokens: 15_300,
      lastMeasuredPromptTokens: 14_100,
      source: "estimated",
      approximate: true,
    })
  })
})

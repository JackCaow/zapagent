import { describe, expect, it } from "bun:test"
import {
  buildMemoryQueryHistoryFromLogs,
  buildMemoryQueryHistoryFromMessages,
  buildResetRunDiagnosticsState,
  estimateProviderInputTokens,
  getMemoryInstructionsForRun,
  persistFinalRunUsageIfNeeded,
  preTurnCompactFailureReason,
  shouldPreTurnAutoCompact,
  syncConversationCompactionThresholds,
} from "../../src/hooks/useAgentRunner.js"
import { buildMemoryQueryForRun, normalizeMemoryQuery } from "../../src/agent/contextAttachments.js"
import { deriveCompaction } from "../../src/config.js"

describe("buildMemoryQueryHistoryFromLogs", () => {
  it("stores normalized display text instead of restoreText for memory recall history", () => {
    const fullPaste = `review cache behavior\n${"full pasted body ".repeat(300)}\nthen continue`
    const history = buildMemoryQueryHistoryFromLogs([
      {
        type: "user",
        text: "review cache behavior\n[Pasted #1 · 1 lines · 5100 chars]\nthen continue",
        restoreText: fullPaste,
      },
    ])

    expect(history).toEqual([
      "review cache behavior\n[pasted text omitted from memory query]\nthen continue",
    ])
    expect(buildMemoryQueryForRun("继续", history)).toContain("[pasted text omitted from memory query]")
    expect(buildMemoryQueryForRun("继续", history)).not.toContain("full pasted body")
  })

  it("folds raw long multiline user text before storing memory recall history", () => {
    const longLine = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ")
    const history = buildMemoryQueryHistoryFromLogs([
      { type: "user", text: `Investigate cache\n${longLine}\nkeep memory stable` },
    ])

    expect(history).toEqual([
      "Investigate cache\n[long line omitted from memory query]\nkeep memory stable",
    ])
    expect(history[0]).toBe(normalizeMemoryQuery(`Investigate cache\n${longLine}\nkeep memory stable`))
    expect(history[0]).not.toContain(longLine)
  })

  it("skips display-only and runtime logs when restoring memory recall history", () => {
    const history = buildMemoryQueryHistoryFromLogs([
      { type: "user", text: "/mcp.docs.summarize text=\"[Pasted #1 · 2 lines · 22 chars]\"", restore: false },
      { type: "task-notification", text: "<task-notification>done</task-notification>" },
      { type: "system", text: "not user input" },
      { type: "user", text: "review prompt cache behavior" },
    ])

    expect(history).toEqual(["review prompt cache behavior"])
  })

  it("skips low-signal and artifact-only logs when restoring memory recall history", () => {
    const history = buildMemoryQueryHistoryFromLogs([
      { type: "user", text: "继续" },
      { type: "user", text: "[Pasted #1 · 140 lines · 60000 chars]" },
      { type: "user", text: "[Pasted #3 unavailable in history; paste again to resend full text]" },
      { type: "user", text: "```ts\nconst onlyCode = true\n```" },
      { type: "user", text: "review prompt cache behavior" },
    ])

    expect(history).toEqual(["review prompt cache behavior"])
  })

  it("does not let low-signal restored history evict meaningful memory queries", () => {
    const history = buildMemoryQueryHistoryFromLogs([
      { type: "user", text: "review memory layer design" },
      { type: "user", text: "继续" },
      { type: "user", text: "[Pasted #1 · 140 lines · 60000 chars]" },
      { type: "user", text: "[Pasted #3 unavailable in history; paste again to resend full text]" },
      { type: "user", text: "review prompt cache behavior" },
    ], 2)

    expect(history).toEqual([
      "review memory layer design",
      "review prompt cache behavior",
    ])
  })

  it("keeps only the most recent queryable user display entries", () => {
    const history = buildMemoryQueryHistoryFromLogs([
      { type: "user", text: "first" },
      { type: "user", text: "second" },
      { type: "user", text: "third" },
    ], 2)

    expect(history).toEqual(["second", "third"])
  })
})

describe("buildMemoryQueryHistoryFromMessages", () => {
  it("stores normalized recent user messages for continuation memory recall", () => {
    const longLine = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ")
    const history = buildMemoryQueryHistoryFromMessages([
      { role: "user", content: "review memory architecture" },
      { role: "assistant", content: "I will inspect the memory layer." },
      { role: "user", content: "继续" },
      { role: "user", content: `Investigate cache\n${longLine}\nkeep memory stable` },
    ])

    expect(history).toEqual([
      "review memory architecture",
      "Investigate cache\n[long line omitted from memory query]\nkeep memory stable",
    ])
    expect(history.join("\n")).not.toContain(longLine)
  })

  it("scans from the tail and stops after the requested number of queryable user messages", () => {
    const history = buildMemoryQueryHistoryFromMessages([
      { role: "user", content: "old raw text that should not be inspected" },
      { role: "user", content: "first kept" },
      { role: "assistant", content: "assistant ignored" },
      { role: "user", content: "继续" },
      { role: "user", content: "second kept" },
      { role: "user", content: "third kept" },
    ], 2)

    expect(history).toEqual(["second kept", "third kept"])
  })
})

describe("getMemoryInstructionsForRun", () => {
  it("loads memory instructions synchronously for the first run when the cache is empty", async () => {
    let calls = 0
    const cache = { current: "" }
    const source = {
      async buildInstructions() {
        calls++
        return "# Persistent Memory\nrules"
      },
    }

    const result = await getMemoryInstructionsForRun(source, cache)

    expect(result).toBe("# Persistent Memory\nrules")
    expect(cache.current).toBe("# Persistent Memory\nrules")
    expect(calls).toBe(1)
  })

  it("uses cached instructions without rebuilding on subsequent runs", async () => {
    let calls = 0
    const cache = { current: "# Persistent Memory\ncached" }
    const source = {
      async buildInstructions() {
        calls++
        return "# Persistent Memory\nfresh"
      },
    }

    const result = await getMemoryInstructionsForRun(source, cache)

    expect(result).toBe("# Persistent Memory\ncached")
    expect(cache.current).toBe("# Persistent Memory\ncached")
    expect(calls).toBe(0)
  })

  it("fails open with the existing cache when memory instructions cannot be loaded", async () => {
    const cache = { current: "" }
    const source = {
      async buildInstructions() {
        throw new Error("disk unavailable")
      },
    }

    const result = await getMemoryInstructionsForRun(source, cache)

    expect(result).toBe("")
    expect(cache.current).toBe("")
  })

  it("reports memory instruction load failures to diagnostics", async () => {
    const cache = { current: "" }
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = []
    const source = {
      async buildInstructions() {
        throw new Error("disk unavailable")
      },
    }

    const result = await getMemoryInstructionsForRun(source, cache, {
      warn: (event, fields) => { warnings.push({ event, fields }) },
    })

    expect(result).toBe("")
    expect(warnings).toEqual([
      {
        event: "memory_operation_failed",
        fields: {
          operation: "instructions",
          error: "disk unavailable",
        },
      },
    ])
  })
})

describe("buildResetRunDiagnosticsState", () => {
  it("clears usage and context diagnostics when a restored session has no persisted usage", () => {
    const state = buildResetRunDiagnosticsState()

    expect(state.tokens).toEqual({ i: 0, o: 0 })
    expect(state.usageHistory).toEqual([])
    expect(state.contextDiagnostics).toBeUndefined()
    expect(state.contextDiagnosticsHistory).toEqual([])
    expect(state.promptCacheDiagnostics).toBeUndefined()
    expect(state.memoryAttachmentFailure).toBeUndefined()
    expect(state.promptSectionFailure).toBeUndefined()
    expect(state.compactFailure).toBeUndefined()
    expect(state.memoryFailure).toBeUndefined()
    expect(state.usagePersistenceFailure).toBeUndefined()
    expect(state.contextPending).toBe(false)
  })

  it("seeds the restored session with its own latest usage and context diagnostics", () => {
    const context = {
      totalChars: 400,
      estimatedTokens: 100,
      hash: "ctx_hash",
      segments: [
        { name: "memory_index", chars: 360, estimatedTokens: 90, hash: "mem_hash" },
      ],
    }
    const state = buildResetRunDiagnosticsState({
      i: 10,
      o: 3,
      providerUsageReported: true,
      cacheRead: 90,
      cacheWrite: 0,
    }, context)

    expect(state.tokens).toEqual({
      i: 10,
      o: 3,
      providerUsageReported: true,
      cacheRead: 90,
      cacheWrite: 0,
    })
    expect(state.usageHistory).toEqual([state.tokens])
    expect(state.contextDiagnostics).toEqual(context)
    expect(state.contextDiagnosticsHistory).toEqual([context])
    expect(state.memoryAttachmentFailure).toBeUndefined()
    expect(state.promptSectionFailure).toBeUndefined()
    expect(state.compactFailure).toBeUndefined()
    expect(state.memoryFailure).toBeUndefined()
    expect(state.usagePersistenceFailure).toBeUndefined()
    expect(state.contextPending).toBe(false)
  })

  it("restores recent usage and context diagnostic history for status trends", () => {
    const usageHistory = Array.from({ length: 14 }, (_, i) => ({
      i: i + 1,
      o: i,
      cacheRead: 100 - i,
      cacheWrite: i % 2,
    }))
    const contextHistory = Array.from({ length: 14 }, (_, i) => ({
      totalChars: (i + 1) * 100,
      estimatedTokens: (i + 1) * 25,
      hash: `ctx_${i}`,
      segments: [
        { name: "memory_index", chars: 100, estimatedTokens: 25, hash: `mem_${i}` },
      ],
    }))

    const state = buildResetRunDiagnosticsState(
      usageHistory.at(-1),
      contextHistory.at(-1),
      usageHistory,
      contextHistory,
    )

    expect(state.tokens).toEqual(usageHistory.at(-1))
    expect(state.usageHistory).toEqual(usageHistory.slice(-12))
    expect(state.contextDiagnostics).toEqual(contextHistory.at(-1))
    expect(state.contextDiagnosticsHistory).toEqual(contextHistory.slice(-12))
  })

  it("restores prompt cache diagnostics for status cache-cause analysis", () => {
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

    const state = buildResetRunDiagnosticsState(
      { i: 10, o: 3, cacheRead: 90 },
      undefined,
      [],
      [],
      promptCacheDiagnostics,
    )

    expect(state.promptCacheDiagnostics).toEqual(promptCacheDiagnostics)
  })

  it("falls back to prompt cache diagnostics from the latest restored usage", () => {
    const promptCacheDiagnostics = {
      boundaryPresent: true,
      staticPrefix: {
        chars: 32000,
        estimatedTokens: 8000,
        hash: "restoredstat",
      },
      dynamicSuffix: {
        chars: 400,
        estimatedTokens: 100,
        hash: "restoreddyn1",
      },
    }

    const state = buildResetRunDiagnosticsState({
      i: 12,
      o: 4,
      cacheRead: 88,
      promptCacheDiagnostics,
    })

    expect(state.promptCacheDiagnostics).toEqual(promptCacheDiagnostics)
  })

  it("falls back to prompt cache diagnostics from restored usage history", () => {
    const olderPromptCacheDiagnostics = {
      boundaryPresent: true,
      staticPrefix: {
        chars: 28000,
        estimatedTokens: 7000,
        hash: "olderstatic",
      },
    }
    const latestPromptCacheDiagnostics = {
      boundaryPresent: false,
      staticPrefix: {
        chars: 42000,
        estimatedTokens: 10500,
        hash: "lateststatic",
      },
    }

    const state = buildResetRunDiagnosticsState(
      undefined,
      undefined,
      [
        {
          i: 10,
          o: 2,
          cacheRead: 70,
          promptCacheDiagnostics: olderPromptCacheDiagnostics,
        },
        {
          i: 20,
          o: 3,
          cacheRead: 90,
          promptCacheDiagnostics: latestPromptCacheDiagnostics,
        },
      ],
      [],
    )

    expect(state.tokens.promptCacheDiagnostics).toEqual(latestPromptCacheDiagnostics)
    expect(state.promptCacheDiagnostics).toEqual(latestPromptCacheDiagnostics)
  })
})

describe("persistFinalRunUsageIfNeeded", () => {
  it("persists final result usage with context and prompt cache diagnostics when no run_usage fired", () => {
    const writes: unknown[][] = []
    const failures: unknown[] = [{ error: "old failure" }]
    let promptOverhead = 0
    const contextDiagnostics = {
      totalChars: 400,
      estimatedTokens: 100,
      hash: "ctx_hash",
      segments: [
        { name: "memory_working_pack", chars: 360, estimatedTokens: 90, hash: "mem_hash" },
      ],
    }
    const promptCacheDiagnostics = {
      boundaryPresent: true,
      staticPrefix: {
        chars: 40000,
        estimatedTokens: 10000,
        hash: "promptstatic",
      },
    }

    const persisted = persistFinalRunUsageIfNeeded({
      sawRunUsage: false,
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 5,
        outputTokens: 2,
        providerUsageReported: true,
      },
      contextDiagnostics,
      promptCacheDiagnostics,
      cacheScope: { providerId: "provider_1", model: "model-a" },
      getLocalEstimate: () => 20,
      appendUsage: (...args) => { writes.push(args) },
      setPromptOverhead: (overhead) => { promptOverhead = overhead },
      onUsagePersistenceFailure: (failure) => { failures.push(failure) },
    })

    expect(persisted).toBe(true)
    expect(promptOverhead).toBe(75)
    expect(failures).toEqual([{ error: "old failure" }, undefined])
    expect(writes).toEqual([
      [
        95,
        20,
        2,
        {
          inputTokens: 10,
          providerUsageReported: true,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 5,
          totalPromptInputTokens: 95,
          cacheHitRatio: 80 / 95,
          cacheReuseRatio: 80 / 90,
          cacheWriteRatio: 5 / 95,
          step: undefined,
          finishReason: undefined,
          cacheScope: { providerId: "provider_1", model: "model-a" },
          contextDiagnostics,
          promptCacheDiagnostics,
        },
      ],
    ])
  })

  it("does not duplicate persistence when a run_usage event already handled the run", () => {
    const writes: unknown[][] = []

    const persisted = persistFinalRunUsageIfNeeded({
      sawRunUsage: true,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
      },
      getLocalEstimate: () => 20,
      appendUsage: (...args) => { writes.push(args) },
    })

    expect(persisted).toBe(false)
    expect(writes).toEqual([])
  })

  it("reports fallback usage persistence failures", () => {
    const failures: unknown[] = []

    const persisted = persistFinalRunUsageIfNeeded({
      sawRunUsage: false,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
      },
      getLocalEstimate: () => 20,
      appendUsage: () => {
        throw new Error("history write failed")
      },
      onUsagePersistenceFailure: (failure) => { failures.push(failure) },
    })

    expect(persisted).toBe(false)
    expect(failures).toEqual([{ error: "history write failed" }])
  })
})

describe("pre-turn auto-compact token estimate", () => {
  it("uses conversation tokens plus learned prompt overhead", () => {
    expect(estimateProviderInputTokens(100, 25)).toBe(125)
  })

  it("triggers pre-turn compact when provider-input estimate crosses the soft threshold", () => {
    expect(shouldPreTurnAutoCompact(70, 40, 100)).toBe(true)
    expect(shouldPreTurnAutoCompact(70, 20, 100)).toBe(false)
  })

  it("sanitizes invalid or negative estimates", () => {
    expect(estimateProviderInputTokens(Number.NaN, -20)).toBe(0)
    expect(shouldPreTurnAutoCompact(Number.POSITIVE_INFINITY, 10, 100)).toBe(false)
  })
})

describe("syncConversationCompactionThresholds", () => {
  it("syncs ConversationManager token limits from the active context window", () => {
    const calls: Array<[string, number]> = []
    const conversation = {
      setMaxTokens: (value: number) => { calls.push(["max", value]) },
      setTriggerAtTokens: (value: number) => { calls.push(["trigger", value]) },
      setTargetTokensAfterCompress: (value: number) => { calls.push(["target", value]) },
    }
    const thresholds = deriveCompaction(200_000)

    const result = syncConversationCompactionThresholds(conversation, 200_000)

    expect(result).toEqual(thresholds)
    expect(calls).toEqual([
      ["max", 200_000],
      ["trigger", thresholds.triggerAt],
      ["target", thresholds.keepFloorTokens],
    ])
  })

  it("uses the shared effective-input budget when a model has a smaller input limit", () => {
    const calls: Array<[string, number]> = []
    const conversation = {
      setMaxTokens: (value: number) => { calls.push(["max", value]) },
      setTriggerAtTokens: (value: number) => { calls.push(["trigger", value]) },
      setTargetTokensAfterCompress: (value: number) => { calls.push(["target", value]) },
    }

    const result = syncConversationCompactionThresholds(conversation, {
      contextWindow: 1_000_000,
      inputLimit: 700_000,
      reservedOutputTokens: 8192,
      safetyMarginTokens: 1000,
      effectiveInputLimit: 699_000,
      compactAt: 559_200,
      keepFloorTokens: 279_600,
      source: "models-dev",
    })

    expect(result).toEqual({
      triggerAt: 559_200,
      keepFloorTokens: 279_600,
      reserveForOutput: 8192,
    })
    expect(calls).toEqual([
      ["max", 699_000],
      ["trigger", 559_200],
      ["target", 279_600],
    ])
  })
})

describe("preTurnCompactFailureReason", () => {
  it("treats null compact results as failed pre-turn compaction", () => {
    expect(preTurnCompactFailureReason(null)).toBe("summarizer returned no usable compact summary")
    expect(preTurnCompactFailureReason(undefined)).toBe("summarizer returned no usable compact summary")
  })

  it("prefers detailed compression failure diagnostics when available", () => {
    expect(preTurnCompactFailureReason(
      null,
      "summarizer returned an unusable compact summary (empty required sections: Next steps)",
    )).toBe("summarizer returned an unusable compact summary (empty required sections: Next steps)")
  })

  it("treats empty compact summaries as failed pre-turn compaction", () => {
    expect(preTurnCompactFailureReason({ summary: "" })).toBe("summarizer returned an empty compact summary")
    expect(preTurnCompactFailureReason({ summary: "  \n" })).toBe("summarizer returned an empty compact summary")
  })

  it("rejects compact results with structurally incomplete summaries", () => {
    expect(preTurnCompactFailureReason({ summary: "# Primary Request and Intent\n..." }))
      .toContain("missing required sections: All user messages (verbatim)")
  })

  it("accepts compact results with a complete structured summary", () => {
    expect(preTurnCompactFailureReason({ summary: validCompactSummary() })).toBeUndefined()
  })
})

function validCompactSummary(): string {
  return [
    "# Primary Request and Intent",
    "- goal",
    "# All user messages (verbatim)",
    "- message",
    "# Current task status",
    "- status",
    "# Files read / modified",
    "- file",
    "# Commands run",
    "- command",
    "# Key facts discovered",
    "- fact",
    "# Decisions made",
    "- decision",
    "# Errors encountered and their resolution",
    "- none",
    "# Code changes summary",
    "- change",
    "# Next steps",
    "- continue",
  ].join("\n")
}

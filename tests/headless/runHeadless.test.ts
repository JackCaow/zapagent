import { describe, expect, it, spyOn } from "bun:test"
import { join } from "node:path"
import { getDefaultConfig } from "../../src/config.js"
import { parseHeadlessArgs } from "../../src/headless/args.js"
import {
  EXIT_NO_PROVIDER,
  buildHeadlessMemoryQuery,
  formatCompactMemoryPersistenceWarning,
  formatArgsShort,
  formatUsagePersistenceWarning,
  persistHeadlessFinalRunUsageIfNeeded,
  persistHeadlessCompactSummary,
  persistHeadlessRunUsage,
  persistHeadlessTranscriptEntry,
  resolveRunStopReason,
  runHeadless,
  stopReasonExitCode,
} from "../../src/headless/runHeadless.js"
import type { AutoMemory } from "../../zapsdk/memory/auto-memory.js"

describe("headless provider setup", () => {
  it("directs a fresh user to the installed zap command", async () => {
    const parsed = parseHeadlessArgs(["-p", "hello"])
    if (!parsed.ok) throw new Error(parsed.message)
    const config = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const stderr = spyOn(process.stderr, "write").mockReturnValue(true)
    try {
      expect(await runHeadless(parsed.args, { config })).toBe(EXIT_NO_PROVIDER)
      expect(stderr.mock.calls).toEqual([["no provider configured. Run `zap` interactively once to set one up with /connect.\n"]])
    } finally { stderr.mockRestore() }
  })
})

describe("buildHeadlessMemoryQuery", () => {
  it("uses the latest meaningful user message for continuation prompts", () => {
    expect(buildHeadlessMemoryQuery("继续", [
      { role: "user", content: "帮我排查缓存命中率为什么很低" },
      { role: "assistant", content: "我会先看 provider cache diagnostics。" },
      { role: "user", content: "继续" },
    ])).toBe("zap_low_signal_continue\n帮我排查缓存命中率为什么很低")
  })

  it("keeps explicit prompts as the memory query", () => {
    expect(buildHeadlessMemoryQuery("继续优化 cache diagnostics", [
      { role: "user", content: "帮我看长文本粘贴显示问题" },
    ])).toBe("继续优化 cache diagnostics")
  })

  it("sanitizes prior long-paste placeholders when recovering continuation context", () => {
    const query = buildHeadlessMemoryQuery("continue", [
      { role: "user", content: "/run_skill review [Pasted #1 · 3 lines · 3400 chars]\nthen check memory cache" },
    ])

    expect(query).toContain("[pasted text omitted from memory query]")
    expect(query).toContain("then check memory cache")
    expect(query).not.toContain("3400 chars]")
  })

  it("prefers compact restored display history over expanded restoreText for continuation prompts", () => {
    const restoredFullPaste = [
      "review cache behavior",
      ...Array.from({ length: 10 }, (_, i) => `FULL_PASTE_SENTINEL_${i} ${"body ".repeat(20)}`),
      "then continue",
    ].join("\n")
    const restoredDisplay = "review cache behavior\n[Pasted #1 · 10 lines · 1100 chars]\nthen continue"

    const query = buildHeadlessMemoryQuery(
      "继续",
      [{ role: "user", content: restoredFullPaste }],
      [restoredDisplay],
    )

    expect(query).toBe("zap_low_signal_continue\nreview cache behavior\n[pasted text omitted from memory query]\nthen continue")
    expect(query).not.toContain("FULL_PASTE_SENTINEL")
  })
})

describe("formatArgsShort", () => {
  it("strips the resolved runtime cwd before truncating", () => {
    const cwd = "/Users/example/workspace/zap"
    const command = `find ${join(cwd, "src")} -name "*.ts" -maxdepth 2`

    expect(formatArgsShort({ command }, cwd)).toBe('find src -name "*.ts" -maxdepth 2')
  })

  it("keeps non-cwd paths intact", () => {
    expect(formatArgsShort({ path: "/tmp/zap-output.log" }, "/Users/example/workspace/zap")).toBe("/tmp/zap-output.log")
  })

  it("still truncates long one-line values after path normalization", () => {
    const cwd = "/Users/example/workspace/zap"
    const longQuery = `${join(cwd, "src")} ${"x".repeat(100)}`

    const formatted = formatArgsShort({ query: longQuery }, cwd)

    expect(formatted.startsWith("src ")).toBe(true)
    expect(formatted.length).toBe(80)
    expect(formatted.endsWith("…")).toBe(true)
  })
})

describe("resolveRunStopReason", () => {
  it("reports permission_denied even when the model produced final text", () => {
    expect(resolveRunStopReason(undefined, true)).toBe("permission_denied")
  })

  it("keeps an evaluator run gradeable after a denied non-terminal tool", () => {
    expect(resolveRunStopReason(undefined, true, true)).toBe("end_turn")
    expect(resolveRunStopReason("max_steps", true, true)).toBe("max_steps")
  })

  it("preserves provider stop reasons when no permission was denied", () => {
    expect(resolveRunStopReason("max_steps", false)).toBe("max_steps")
    expect(resolveRunStopReason("timeout", false)).toBe("timeout")
  })

  it("defaults to end_turn when the run finished cleanly", () => {
    expect(resolveRunStopReason(undefined, false)).toBe("end_turn")
  })
})

describe("persistHeadlessTranscriptEntry", () => {
  it("persists image-only user rows but still skips empty assistant rows", () => {
    const rows: Array<[string, string]> = []
    const writer = (type: string, text: string) => { rows.push([type, text]) }
    const images = [{ type: "image" as const, filePath: "/tmp/test.png", mediaType: "image/png", source: "test" }]
    expect(persistHeadlessTranscriptEntry("user", "", writer, images)).toBe(true)
    expect(persistHeadlessTranscriptEntry("agent", "", writer, images)).toBe(false)
    expect(persistHeadlessTranscriptEntry("user", "", writer)).toBe(false)
    expect(rows).toEqual([["user", ""]])
  })
  it("stores restorable user and assistant rows and skips empty output", () => {
    const rows: Array<[string, string]> = []
    const writer = (type: string, text: string) => { rows.push([type, text]) }

    expect(persistHeadlessTranscriptEntry("user", "remember this", writer)).toBe(true)
    expect(persistHeadlessTranscriptEntry("agent", "done", writer)).toBe(true)
    expect(persistHeadlessTranscriptEntry("agent", "  ", writer)).toBe(false)
    expect(rows).toEqual([["user", "remember this"], ["agent", "done"]])
  })
})

describe("persistHeadlessRunUsage", () => {
  it("journals maintenance without recalibrating the main context", () => {
    const writes: unknown[][] = []
    persistHeadlessRunUsage({ type: "run_usage", purpose: "maintenance", step: 1,
      inputTokens: 200, cacheReadInputTokens: 10, outputTokens: 5 }, {
      getLocalEstimate: () => { throw new Error("must not read main context estimate") },
      setPromptOverhead: () => { throw new Error("must not calibrate main context") },
      appendUsage: (...args) => { writes.push(args) },
      writeWarning: text => { throw new Error(text) },
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.slice(0, 3)).toEqual([210, 0, 5])
    expect(writes[0]?.[3]).toMatchObject({ purpose: "maintenance", inputTokens: 200, cacheReadInputTokens: 10 })
  })

  it("persists usage and updates prompt overhead", () => {
    const writes: unknown[][] = []
    let promptOverhead = 0

    persistHeadlessRunUsage(
      {
        type: "run_usage",
        step: 1,
        inputTokens: 10,
        cacheReadInputTokens: 40,
        outputTokens: 2,
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
        setPromptOverhead: (overhead) => { promptOverhead = overhead },
      },
    )

    expect(promptOverhead).toBe(30)
    expect(writes[0]?.[0]).toBe(50)
    expect(writes[0]?.[3]).toMatchObject({
      inputTokens: 10,
      cacheReadInputTokens: 40,
      totalPromptInputTokens: 50,
    })
  })

  it("persists cache and context diagnostics with usage", () => {
    const writes: unknown[][] = []
    const contextDiagnostics = {
      totalChars: 120,
      estimatedTokens: 30,
      hash: "ctxhash123",
      segments: [
        { name: "memory_index", chars: 80, estimatedTokens: 20, hash: "memhash123" },
      ],
    }
    const promptCacheDiagnostics = {
      boundaryPresent: true,
      staticPrefix: {
        chars: 4000,
        estimatedTokens: 1000,
        hash: "staticcache1",
      },
      toolSchemas: {
        count: 2,
        hash: "toolhash1234",
        names: ["agent", "read_file"],
      },
    }

    persistHeadlessRunUsage(
      {
        type: "run_usage",
        step: 1,
        inputTokens: 10,
        cacheReadInputTokens: 40,
        outputTokens: 2,
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
        setPromptOverhead: () => {},
        contextDiagnostics,
        promptCacheDiagnostics,
        cacheScope: { providerId: "provider_1", model: "model-a" },
      },
    )

    expect(writes[0]?.[3]).toMatchObject({
      cacheScope: { providerId: "provider_1", model: "model-a" },
      contextDiagnostics,
      promptCacheDiagnostics,
    })
  })

  it("warns when usage persistence fails", () => {
    const warnings: string[] = []

    persistHeadlessRunUsage(
      {
        type: "run_usage",
        step: 1,
        inputTokens: 10,
        outputTokens: 2,
      },
      {
        getLocalEstimate: () => 20,
        appendUsage: () => {
          throw new Error("history write failed")
        },
        setPromptOverhead: () => {},
        writeWarning: (text) => { warnings.push(text) },
      },
    )

    expect(warnings).toEqual([
      "warning: failed saving usage history: history write failed\n",
    ])
  })

  it("ignores non-usage events", () => {
    const writes: unknown[][] = []

    persistHeadlessRunUsage(
      { type: "run_started", input: "hello" },
      {
        getLocalEstimate: () => 20,
        appendUsage: (...args) => { writes.push(args) },
        setPromptOverhead: () => {},
      },
    )

    expect(writes).toEqual([])
  })
})

describe("persistHeadlessFinalRunUsageIfNeeded", () => {
  it("persists final result usage when no run_usage event fired", () => {
    const writes: unknown[][] = []
    let promptOverhead = 0
    const contextDiagnostics = {
      totalChars: 120,
      estimatedTokens: 30,
      hash: "ctxhash123",
      segments: [
        { name: "memory_working_pack", chars: 80, estimatedTokens: 20, hash: "memhash123" },
      ],
    }
    const promptCacheDiagnostics = {
      boundaryPresent: true,
      staticPrefix: {
        chars: 4000,
        estimatedTokens: 1000,
        hash: "staticcache1",
      },
      toolSchemas: {
        count: 2,
        hash: "toolhash1234",
        names: ["agent", "read_file"],
      },
    }

    const persisted = persistHeadlessFinalRunUsageIfNeeded({
      sawRunUsage: false,
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 5,
        outputTokens: 2,
        providerUsageReported: true,
      },
      getLocalEstimate: () => 20,
      appendUsage: (...args) => { writes.push(args) },
      setPromptOverhead: (overhead) => { promptOverhead = overhead },
      contextDiagnostics,
      promptCacheDiagnostics,
      cacheScope: { providerId: "provider_1", model: "model-a" },
    })

    expect(persisted).toBe(true)
    expect(promptOverhead).toBe(35)
    expect(writes[0]?.[0]).toBe(55)
    expect(writes[0]?.[3]).toMatchObject({
      inputTokens: 10,
      providerUsageReported: true,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 5,
      totalPromptInputTokens: 55,
      cacheScope: { providerId: "provider_1", model: "model-a" },
      contextDiagnostics,
      promptCacheDiagnostics,
    })
  })

  it("does not duplicate usage rows when run_usage already persisted the run", () => {
    const writes: unknown[][] = []

    const persisted = persistHeadlessFinalRunUsageIfNeeded({
      sawRunUsage: true,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
      },
      getLocalEstimate: () => 20,
      appendUsage: (...args) => { writes.push(args) },
      setPromptOverhead: () => {},
    })

    expect(persisted).toBe(false)
    expect(writes).toEqual([])
  })

  it("warns when final usage fallback persistence fails", () => {
    const warnings: string[] = []

    const persisted = persistHeadlessFinalRunUsageIfNeeded({
      sawRunUsage: false,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
      },
      getLocalEstimate: () => 20,
      appendUsage: () => {
        throw new Error("history write failed")
      },
      setPromptOverhead: () => {},
      writeWarning: (text) => { warnings.push(text) },
    })

    expect(persisted).toBe(false)
    expect(warnings).toEqual([
      "warning: failed saving usage history: history write failed\n",
    ])
  })
})

describe("persistHeadlessCompactSummary", () => {
  it("persists durable sections from headless in-loop autocompact summaries", async () => {
    const writes: string[] = []

    persistHeadlessCompactSummary(
      {
        type: "observation",
        kind: "autocompact_done",
        detail: {
          messagesBefore: 12,
          messagesAfter: 2,
          summary: "# Decisions made\n- keep headless compact summaries durable",
        },
      },
      {
        autoMemory: { memoryDir: "/tmp/zap-memory" } as AutoMemory,
        persistCompactSummary: async (summary) => {
          writes.push(summary)
          return "/tmp/zap-memory/project_compact_state.md"
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toEqual([
      "# Decisions made\n- keep headless compact summaries durable",
    ])
  })

  it("warns when headless compact summary persistence fails", async () => {
    const warnings: string[] = []

    persistHeadlessCompactSummary(
      {
        type: "observation",
        kind: "autocompact_done",
        detail: {
          messagesBefore: 12,
          messagesAfter: 2,
          summary: "# Decisions made\n- keep diagnostics visible",
        },
      },
      {
        autoMemory: { memoryDir: "/tmp/zap-memory" } as AutoMemory,
        persistCompactSummary: async () => {
          throw new Error("memory write failed")
        },
        writeWarning: (text) => { warnings.push(text) },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warnings).toEqual([
      "warning: failed saving compact memory: memory write failed\n",
    ])
  })

  it("ignores failed or empty autocompact observations", async () => {
    const writes: string[] = []

    for (const detail of [
      { failed: true, messagesBefore: 12, summary: "# Decisions made\n- skipped" },
      { messagesBefore: 12, summary: "" },
      { messagesBefore: 0, summary: "# Decisions made\n- skipped" },
    ]) {
      persistHeadlessCompactSummary(
        { type: "observation", kind: "autocompact_done", detail },
        {
          autoMemory: { memoryDir: "/tmp/zap-memory" } as AutoMemory,
          persistCompactSummary: async (summary) => {
            writes.push(summary)
            return "/tmp/zap-memory/project_compact_state.md"
          },
        },
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toEqual([])
  })
})

describe("formatUsagePersistenceWarning", () => {
  it("formats unknown thrown values", () => {
    expect(formatUsagePersistenceWarning("disk full")).toBe("warning: failed saving usage history: disk full\n")
  })
})

describe("formatCompactMemoryPersistenceWarning", () => {
  it("formats unknown thrown values", () => {
    expect(formatCompactMemoryPersistenceWarning("disk full")).toBe("warning: failed saving compact memory: disk full\n")
  })
})


describe("headless delivery completion", () => {
  it("does not turn a natural response with incomplete evidence into success", () => {
    expect(resolveRunStopReason(undefined, false, false, "incomplete")).toBe("incomplete")
    expect(stopReasonExitCode("incomplete")).toBe(1)
    expect(resolveRunStopReason(undefined, false, false, "completed")).toBe("end_turn")
    expect(resolveRunStopReason("timeout", false, false, "incomplete")).toBe("timeout")
    expect(resolveRunStopReason(undefined, true, false, "incomplete")).toBe("permission_denied")
  })
})

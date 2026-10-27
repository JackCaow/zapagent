import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contextTokensFromRunUsage, createRunHandlers } from "../../src/agent/wireRunHandlers.js"
import { buildMemoryUtilityCandidates } from "../../src/agent/memoryUtility.js"
import type { AgentEvent, ContextDiagnostics } from "../../zapsdk/agent/events.js"
import type { LogEntry } from "../../src/ui/types.js"
import { batchAgentGroups, groupLogs, partitionRenderItems } from "../../src/ui/group-logs.js"
import { PERSISTED_OUTPUT_TAG, PERSIST_THRESHOLD_CHARS } from "../../zapsdk/utils/tool-result-storage.js"
import { tokenAccounting } from "../../src/singletons.js"

describe("contextTokensFromRunUsage", () => {
  it("sums fresh input, cache reads, and cache writes for context occupancy", () => {
    expect(contextTokensFromRunUsage({
      inputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 5,
    })).toBe(95)
  })

  it("returns null when usage contains no prompt accounting", () => {
    expect(contextTokensFromRunUsage({
      inputTokens: 0,
    })).toBeNull()
  })

  it("returns null when usage was synthesized because the provider omitted usage", () => {
    expect(contextTokensFromRunUsage({
      inputTokens: 100,
      providerUsageReported: false,
    })).toBeNull()
  })

  it("does not treat explicitly reported zero cache fields as context occupancy", () => {
    expect(contextTokensFromRunUsage({
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })).toBeNull()
  })

  it("ignores negative and non-finite usage fields", () => {
    expect(contextTokensFromRunUsage({
      inputTokens: Number.NaN,
      cacheReadInputTokens: -80,
      cacheCreationInputTokens: 10,
    })).toBe(10)

    expect(contextTokensFromRunUsage({
      inputTokens: Number.POSITIVE_INFINITY,
      cacheReadInputTokens: Number.NEGATIVE_INFINITY,
      cacheCreationInputTokens: Number.NaN,
    })).toBeNull()
  })
})

describe("createRunHandlers context diagnostics", () => {
  it("uses complete compact request estimates without double overhead and exposes lossy/soft-target status", () => {
    const agent = new FakeAgent(), values: number[] = [], logs: string[] = []
    const previous = tokenAccounting.promptOverhead
    tokenAccounting.promptOverhead = 9000
    try {
      createRunHandlers({
        currentConfig: { providers: [], active: { providerId: "", model: "" }, serperKey: "", maxTokens: 100,
          maxSteps: 10, customSystemPrompt: "", compaction: { auto: true, prune: true, reserved: 0 }, mcpServers: [], permissionMode: "default" },
        controller: new AbortController(), preview: {} as any,
        setStatus() {}, setStep() {}, setActiveTool() {}, setActiveToolBytes() {}, setContextPending() {},
        setContextTokens: value => values.push(value), compactLogs() {},
        addLog: (_type, text) => logs.push(text), replaceLog() {}, peekNextLogId: () => 0,
        persistCompactSummary: async () => null,
      }).wire(agent as any)
      agent.emit({ type: "observation", kind: "autocompact_start", detail: { tokenEstimate: 831508, trigger: "tokens", messageCount: 40 } })
      expect(values.at(-1)).toBe(831508)
      agent.emit({ type: "observation", kind: "autocompact_done", detail: { outputTokens: 500000,
        status: "target_not_met", sourceTruncated: true, summary: "summary", messagesBefore: 40, messagesAfter: 5 } })
      expect(values.at(-1)).toBe(500000)
      expect(logs.some(line => line.includes("soft target"))).toBe(true)
      expect(logs.some(line => line.includes("historical detail was omitted"))).toBe(true)
    } finally { tokenAccounting.promptOverhead = previous }
  })

  it("updates one recovery row and names payload limits accurately", () => {
    const agent = new FakeAgent()
    const added: string[] = []
    const replaced: string[] = []
    let row: LogEntry
    createRunHandlers({
      currentConfig: { providers: [], active: { providerId: "", model: "" }, serperKey: "",
        maxTokens: 100, maxSteps: 10, customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 }, mcpServers: [], permissionMode: "default" },
      controller: new AbortController(), preview: {} as any,
      setStatus: () => {}, setStep: () => {}, setActiveTool: () => {}, setActiveToolBytes: () => {},
      setContextTokens: () => {}, setContextPending: () => {}, compactLogs: () => {},
      addLog: (type, text, _tool, _images, _path, extra) => { added.push(text); row = { type, text, id: 42, ...extra } },
      replaceLog: (id, type, text, _tool, _path, extra) => { expect(id).toBe(42); replaced.push(text); row = { ...row, type, text, ...extra } },
      peekNextLogId: () => 42,
    }).wire(agent as any)
    // Old bare events do not fabricate an attempt number.
    agent.emit({ type: "observation", kind: "reactive_compact" })
    for (const attempt of [1, 2]) {
      agent.emit({ type: "observation", kind: "reactive_compact",
        detail: { reason: "request_body", attempt, maxAttempts: 2,
          before: { messageBytes: 10485760 }, after: { messageBytes: 5242880 } } })
      expect(partitionRenderItems(batchAgentGroups(groupLogs([row!]))).committed).toHaveLength(0)
    }
    agent.emit({ type: "observation", kind: "request_recovered", detail: { reason: "request_body" } })
    expect(added).toHaveLength(1)
    expect(added[0]).toContain("Request body too large")
    expect(added[0]).toContain("10.00 → 5.00 MiB")
    expect(added[0]).not.toContain("Context overflowed")
    expect(replaced).toHaveLength(2)
    expect(replaced[1]).toContain("text retained")
    expect(partitionRenderItems(batchAgentGroups(groupLogs([row!]))).dynamic).toHaveLength(0)
    agent.emit({ type: "observation", kind: "historical_images_retired",
      detail: { retiredGroups: 12, beforeImageBytes: 33554432, afterImageBytes: 16777216 } })
    expect(added.at(-1)).toContain("Historical images retired in 12 tool groups")
    expect(added.at(-1)).toContain("32.00 → 16.00 MiB")
    expect(added.at(-1)).not.toContain("retry")
    expect(row!.pending).not.toBe(true)
  })

  for (const ending of ["failure", "abort", "run_end"] as const) it(`settles the pending recovery row on ${ending}`, () => {
    const agent = new FakeAgent()
    const controller = new AbortController()
    let row: LogEntry
    createRunHandlers({
      currentConfig: { providers: [], active: { providerId: "", model: "" }, serperKey: "",
        maxTokens: 100, maxSteps: 10, customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 }, mcpServers: [], permissionMode: "default" },
      controller, preview: {} as any,
      setStatus: () => {}, setStep: () => {}, setActiveTool: () => {}, setActiveToolBytes: () => {},
      setContextTokens: () => {}, setContextPending: () => {}, compactLogs: () => {},
      addLog: (type, text, _tool, _images, _path, extra) => { if (extra?.pending) row = { type, text, id: 42, ...extra } },
      replaceLog: (_id, type, text, _tool, _path, extra) => { row = { ...row, type, text, ...extra } },
      peekNextLogId: () => 42,
    }).wire(agent as any)
    agent.emit({ type: "observation", kind: "reactive_compact", detail: { attempt: 1, reason: "request_body" } })
    expect(row!.pending).toBe(true)
    if (ending === "failure") agent.emit({ type: "error", step: 1, error: "recovery exhausted" })
    else {
      if (ending === "abort") controller.abort()
      agent.emit({ type: "run_ended", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } })
    }
    expect(row!.pending).toBe(false)
    expect(row!.text).toContain(ending === "failure" ? "failed" : ending === "abort" ? "cancelled" : "without confirmation")
  })

  it("persists oversized root tool result logs before they enter session restore context", () => {
    const agent = new FakeAgent()
    const dataDir = mkdtempSync(join(tmpdir(), "zap-wire-tool-output-"))
    const projectCwd = mkdtempSync(join(tmpdir(), "zap-wire-project-"))
    const previousDataDir = process.env.ZAPCODE_DATA_DIR
    let replaced:
      | {
          text: string
          tool?: {
            output?: string
            success?: boolean
          }
        }
      | undefined

    try {
      process.env.ZAPCODE_DATA_DIR = dataDir

      createRunHandlers({
        currentConfig: {
          providers: [],
          active: { providerId: "", model: "" },
          serperKey: "",
          maxTokens: 100,
          maxSteps: 10,
          customSystemPrompt: "",
          compaction: { auto: true, prune: true, reserved: 0 },
          mcpServers: [],
          permissionMode: "default",
        },
        controller: new AbortController(),
        preview: { interruptPreviews: () => {} } as any,
        setStatus: () => {},
        setStep: () => {},
        setActiveTool: () => {},
        setActiveToolBytes: () => {},
        setContextTokens: () => {},
        setContextPending: () => {},
        toolOutputSessionId: "session-ui",
        toolOutputProjectCwd: projectCwd,
        addLog: () => {},
        replaceLog: (_id, _type, text, tool) => {
          replaced = { text, tool }
        },
        peekNextLogId: () => 1,
        compactLogs: () => {},
      }).wire(agent as any)

      agent.emit({
        type: "content_final",
        kind: "tool_call",
        id: "tool-big",
        step: 1,
        toolName: "bash",
        arguments: { command: "noisy" },
      })
      const huge = "stderr ".repeat(PERSIST_THRESHOLD_CHARS)
      agent.emit({
        type: "content_final",
        kind: "tool_result",
        id: "tool-big",
        step: 1,
        toolName: "bash",
        result: { success: false, output: "", error: huge },
      })

      const loggedOutput = replaced?.tool?.output ?? ""
      expect(replaced?.tool?.success).toBe(false)
      expect(loggedOutput).not.toBe(huge)
      expect(loggedOutput.length).toBeLessThan(huge.length)
      expect(loggedOutput).toContain(`<${PERSISTED_OUTPUT_TAG}>`)
      expect(loggedOutput).toContain("path:")
      expect(replaced?.text.length).toBeLessThanOrEqual(100)

      const persistedPath = /path: (.+)/.exec(loggedOutput)?.[1]?.trim()
      expect(persistedPath).toBeTruthy()
      expect(existsSync(persistedPath!)).toBe(true)
      expect(readFileSync(persistedPath!, "utf-8")).toBe(huge)
    } finally {
      if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
      else process.env.ZAPCODE_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(projectCwd, { recursive: true, force: true })
    }
  })

  it("keeps failed tool-output persistence bounded in transcript state", () => {
    const agent = new FakeAgent()
    const container = mkdtempSync(join(tmpdir(), "zap-wire-tool-output-failure-"))
    const blockedDataDir = join(container, "not-a-directory")
    const projectCwd = mkdtempSync(join(tmpdir(), "zap-wire-project-failure-"))
    const previousDataDir = process.env.ZAPCODE_DATA_DIR
    let loggedOutput = ""

    try {
      writeFileSync(blockedDataDir, "blocked")
      process.env.ZAPCODE_DATA_DIR = blockedDataDir
      createRunHandlers({
        currentConfig: {
          providers: [],
          active: { providerId: "", model: "" },
          serperKey: "",
          maxTokens: 100,
          maxSteps: 10,
          customSystemPrompt: "",
          compaction: { auto: true, prune: true, reserved: 0 },
          mcpServers: [],
          permissionMode: "default",
        },
        controller: new AbortController(),
        preview: { interruptPreviews: () => {} } as any,
        setStatus: () => {},
        setStep: () => {},
        setActiveTool: () => {},
        setActiveToolBytes: () => {},
        setContextTokens: () => {},
        setContextPending: () => {},
        toolOutputSessionId: "session-ui-failure",
        toolOutputProjectCwd: projectCwd,
        addLog: () => {},
        replaceLog: (_id, _type, _text, tool) => {
          loggedOutput = tool?.output ?? ""
        },
        peekNextLogId: () => 1,
        compactLogs: () => {},
      }).wire(agent as any)

      agent.emit({
        type: "content_final",
        kind: "tool_call",
        id: "tool-storage-failure",
        step: 1,
        toolName: "bash",
        arguments: { command: "noisy" },
      })
      const huge = `HEAD:${"stderr ".repeat(PERSIST_THRESHOLD_CHARS)}:TAIL`
      agent.emit({
        type: "content_final",
        kind: "tool_result",
        id: "tool-storage-failure",
        step: 1,
        toolName: "bash",
        result: { success: false, output: "", error: huge },
      })

      expect(loggedOutput.length).toBeLessThan(huge.length / 2)
      expect(loggedOutput).toContain("HEAD:")
      expect(loggedOutput).toContain(":TAIL")
      expect(loggedOutput).toContain('status="unavailable"')
      expect(loggedOutput).toContain("rerun the tool with narrower output")
      expect(loggedOutput).not.toContain("path:")
    } finally {
      if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
      else process.env.ZAPCODE_DATA_DIR = previousDataDir
      rmSync(container, { recursive: true, force: true })
      rmSync(projectCwd, { recursive: true, force: true })
    }
  })

  it("forwards run_step transient context diagnostics to the UI state setter", () => {
    const agent = new FakeAgent()
    let lastContext: ContextDiagnostics | undefined
    let lastStep = 0
    const diagnostics: ContextDiagnostics = {
      totalChars: 100,
      estimatedTokens: 25,
      hash: "ctxhash",
      segments: [
        { name: "memory_index", chars: 100, estimatedTokens: 25, hash: "memhash" },
      ],
    }

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: (step) => { lastStep = step },
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      setContextDiagnostics: (context) => { lastContext = context },
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "run_step",
      step: 3,
      messageCount: 7,
      context: diagnostics,
    })

    expect(lastStep).toBe(3)
    expect(lastContext).toEqual(diagnostics)
  })

  it("sanitizes run_step transient context diagnostics before forwarding them", () => {
    const agent = new FakeAgent()
    let lastContext: ContextDiagnostics | undefined

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      setContextDiagnostics: (context) => { lastContext = context },
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "run_step",
      step: 3,
      messageCount: 7,
      context: {
        totalChars: Number.NaN,
        estimatedTokens: -5,
        hash: "ctxhash",
        segments: [
          { name: "memory_index", chars: -1, estimatedTokens: Number.POSITIVE_INFINITY, hash: "memhash" },
          { name: "bad", chars: 1, estimatedTokens: 1, hash: 42 },
        ],
      },
    } as AgentEvent)

    expect(lastContext).toEqual({
      totalChars: 0,
      estimatedTokens: 0,
      hash: "ctxhash",
      segments: [
        { name: "memory_index", chars: 0, estimatedTokens: 0, hash: "memhash" },
      ],
    })
  })

  it("forwards autocompact failures to the status diagnostic callback", () => {
    const agent = new FakeAgent()
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      onCompactFailure: (failure) => { compactFailure = failure },
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "observation",
      kind: "autocompact_done",
      detail: {
        failed: true,
        error: "summary missing required headings",
        consecutiveFailures: 2,
        breakerTripped: false,
      },
    })

    expect(compactFailure).toEqual({
      phase: "in_loop",
      error: "summary missing required headings",
      consecutiveFailures: 2,
      breakerTripped: false,
    })
  })

  it("forwards in-loop compact summary persistence failures to memory diagnostics", async () => {
    const agent = new FakeAgent()
    const memoryFailures: unknown[] = []

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      onMemoryFailure: (failure) => { memoryFailures.push(failure) },
      persistCompactSummary: async () => {
        throw new Error("memory write failed")
      },
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "observation",
      kind: "autocompact_done",
      detail: {
        messagesBefore: 12,
        messagesAfter: 2,
        summary: "# Decisions made\n- keep compact memory diagnostics visible",
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(memoryFailures).toEqual([
      {
        operation: "compact_summary",
        error: "memory write failed",
      },
    ])
  })

  it("clears stale memory diagnostics after successful in-loop compact summary persistence", async () => {
    const agent = new FakeAgent()
    const memoryFailures: unknown[] = [{ operation: "compact_summary", error: "old failure" }]

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      onMemoryFailure: (failure) => { memoryFailures.push(failure) },
      persistCompactSummary: async () => "/tmp/project_compact_state.md",
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "observation",
      kind: "autocompact_done",
      detail: {
        messagesBefore: 12,
        messagesAfter: 2,
        summary: "# Decisions made\n- compact memory diagnostics recovered",
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(memoryFailures).toEqual([
      { operation: "compact_summary", error: "old failure" },
      undefined,
    ])
  })

  it("forwards usage persistence failures to status diagnostics", () => {
    const agent = new FakeAgent()
    let usageFailure: { error: string } | undefined

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      onUsagePersistenceFailure: (failure) => { usageFailure = failure },
      appendUsage: () => {
        throw new Error("history write failed")
      },
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "run_usage",
      step: 1,
      inputTokens: 10,
      outputTokens: 2,
    })

    expect(usageFailure).toEqual({ error: "history write failed" })
  })

  it("clears stale usage persistence diagnostics after a successful usage write", () => {
    const agent = new FakeAgent()
    const usageFailures: unknown[] = [{ error: "old write failure" }]

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      onUsagePersistenceFailure: (failure) => { usageFailures.push(failure) },
      appendUsage: () => {},
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "run_usage",
      step: 1,
      inputTokens: 10,
      outputTokens: 2,
    })

    expect(usageFailures).toEqual([
      { error: "old write failure" },
      undefined,
    ])
  })

  it("persists the latest prompt cache diagnostics from a getter", () => {
    const agent = new FakeAgent()
    const writes: unknown[][] = []
    const oldPromptCache = {
      boundaryPresent: true,
      staticPrefix: { chars: 40, estimatedTokens: 10, hash: "oldprompt" },
    }
    const latestPromptCache = {
      boundaryPresent: true,
      staticPrefix: { chars: 44, estimatedTokens: 11, hash: "newprompt" },
      toolSchemas: {
        count: 2,
        hash: "newtools1234",
        names: ["agent", "read_file"],
      },
    }

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "provider_1", model: "model-a" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      promptCacheDiagnostics: oldPromptCache,
      getPromptCacheDiagnostics: () => latestPromptCache,
      appendUsage: (...args) => { writes.push(args) },
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "run_usage",
      step: 1,
      inputTokens: 10,
      outputTokens: 2,
      providerUsageReported: true,
    })

    expect(writes[0]?.[3]).toMatchObject({
      cacheScope: { providerId: "provider_1", model: "model-a" },
      promptCacheDiagnostics: latestPromptCache,
    })
  })

  it("forwards per-call run_usage to the UI usage state callback", () => {
    const agent = new FakeAgent()
    const usages: unknown[] = []

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: {} as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      onRunUsage: (usage) => { usages.push(usage) },
      appendUsage: () => {},
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({
      type: "run_usage",
      step: 1,
      inputTokens: 10,
      outputTokens: 2,
      providerUsageReported: true,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 5,
    })

    expect(usages).toEqual([
      {
        inputTokens: 10,
        outputTokens: 2,
        providerUsageReported: true,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 5,
      },
    ])
  })

  it("writes one cache/memory audit entry when the root run ends", () => {
    const agent = new FakeAgent()
    const entries: unknown[] = []
    const memoryBody = "Stable memory utility evidence should reach the root audit tracker.\n"
    const memoryUtilityCandidates = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/memory",
      records: [{
        filename: "utility_rule.md",
        frontmatter: { name: "utility_rule", description: "utility rule", type: "project" },
        body: memoryBody,
      }],
      included: ["utility_rule.md"],
    })

    createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "provider-1", model: "model-1" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: { onTextFinal: () => {} } as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      cacheMemoryAuditSessionId: "session-1",
      memoryUtilityCandidates,
      memoryUtilityCwd: "/repo",
      appendCacheMemoryAudit: (entry) => { entries.push(entry) },
      getPromptCacheDiagnostics: () => ({
        boundaryPresent: true,
        staticPrefix: { chars: 40, estimatedTokens: 10, hash: "static-hash" },
      }),
      addLog: () => {},
      replaceLog: () => {},
      peekNextLogId: () => 1,
      compactLogs: () => {},
    }).wire(agent as any)

    agent.emit({ type: "run_started", input: "private input" })
    agent.emit({
      type: "run_step",
      step: 1,
      messageCount: 2,
      context: { totalChars: 40, estimatedTokens: 10, hash: "ctx", segments: [] },
    })
    agent.emit({ type: "content_final", kind: "text", id: "text-1", text: memoryBody })
    agent.emit({
      type: "run_ended",
      steps: 1,
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 2,
      },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sessionId: "session-1",
      cacheScope: { providerId: "provider-1", model: "model-1" },
      usage: { inputTokens: 10, cacheReadInputTokens: 90 },
      contextDiagnostics: { hash: "ctx" },
      promptCacheDiagnostics: { staticPrefix: { hash: "static-hash" } },
      memoryUtility: {
        selected: 1,
        used: 1,
        avoidedReRead: 1,
      },
    })
    expect(JSON.stringify(entries[0])).not.toContain("private input")
    expect(JSON.stringify(entries[0])).not.toContain(memoryBody.trim())
  })
})

describe("createRunHandlers AgentRun correlation", () => {
  it("uses toolCallId instead of matching duplicate task text", () => {
    const replacements: Array<{ id: number; subagentId?: string }> = []
    const runs: string[] = []
    let nextLogId = 1
    const handlers = createRunHandlers({
      currentConfig: {
        providers: [],
        active: { providerId: "", model: "" },
        serperKey: "",
        maxTokens: 100,
        maxSteps: 10,
        customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 },
        mcpServers: [],
        permissionMode: "default",
      },
      controller: new AbortController(),
      preview: { interruptPreviews: () => {} } as any,
      setStatus: () => {},
      setStep: () => {},
      setActiveTool: () => {},
      setActiveToolBytes: () => {},
      setContextTokens: () => {},
      setContextPending: () => {},
      addLog: () => { nextLogId += 1 },
      replaceLog: (id, _type, _text, tool) => {
        replacements.push({
          id,
          subagentId: (tool?.meta as { subagentId?: string } | undefined)?.subagentId,
        })
      },
      peekNextLogId: () => nextLogId,
      compactLogs: () => {},
      onAgentRunState: (run) => { runs.push(run.runId) },
    })
    const agent = new FakeAgent()
    handlers.wire(agent as any)

    for (const id of ["call-a", "call-b"]) {
      agent.emit({
        type: "content_final",
        kind: "tool_call",
        id,
        step: 1,
        toolName: "agent",
        arguments: { task: "same task" },
      })
    }
    handlers.subAgentEventHandler({
      type: "agent_run_state",
      run: {
        runId: "sa-b",
        toolCallId: "call-b",
        agentType: "explore",
        task: "same task",
        status: "running",
        sequence: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    })

    expect(runs).toEqual(["sa-b"])
    expect(replacements.at(-1)).toEqual({ id: 2, subagentId: "sa-b" })
  })
})

describe("createRunHandlers request lifecycle", () => {
  it("resets on each step and ignores child or cancelled-run telemetry", () => {
    const agent = new FakeAgent()
    const requests: unknown[] = []
    const throughputs: unknown[] = []
    const statuses: string[] = []
    const steps: number[] = []
    const diagnostics: unknown[] = []
    const controller = new AbortController()
    createRunHandlers({
      currentConfig: { providers: [], active: { providerId: "", model: "" }, serperKey: "", maxTokens: 100,
        maxSteps: 10, customSystemPrompt: "", compaction: { auto: false, prune: false, reserved: 0 },
        mcpServers: [], permissionMode: "default" },
      controller, preview: {} as any,
      setStatus: status => statuses.push(status), setProviderRequest: event => requests.push(event),
      setOutputThroughput: sample => throughputs.push(sample),
      setStep: step => steps.push(step), setContextDiagnostics: context => diagnostics.push(context),
      setActiveTool: () => {}, setActiveToolBytes: () => {}, setContextTokens: () => {}, setContextPending: () => {},
      addLog: () => {}, replaceLog: () => {}, peekNextLogId: () => 1, compactLogs: () => {},
    }).wire(agent as any)
    const event = { type: "provider_request" as const, step: 0, request: {
      phase: "waiting_output" as const, attempt: 1, maxAttempts: 3, startedAt: 1, at: 1, elapsedMs: 0,
    } }
    agent.emit(event)
    agent.emit({ ...event, path: ["child"] })
    agent.emit({ type: "run_step", step: 5, messageCount: 2, path: ["child"] })
    expect(requests).toEqual([event.request])
    expect(throughputs).toEqual([undefined])
    expect(statuses).toEqual([])
    expect(steps).toEqual([])
    expect(diagnostics).toEqual([])
    agent.emit({ type: "run_step", step: 1, messageCount: 2 })
    expect(requests.at(-1)).toBeUndefined()
    expect(statuses).toEqual(["preparing"])
    expect(steps).toEqual([1])
    expect(diagnostics).toHaveLength(1)
    controller.abort()
    agent.emit(event)
    agent.emit({ type: "run_step", step: 2, messageCount: 2 })
    expect(requests).toHaveLength(2)
    expect(throughputs).toHaveLength(2)
    expect(statuses).toEqual(["preparing"])
    expect(steps).toEqual([1])
    expect(diagnostics).toHaveLength(1)
  })
})

class FakeAgent {
  private handlers = new Map<string, Array<(event: AgentEvent) => void>>()

  on(type: string, handler: (event: AgentEvent) => void): void {
    const existing = this.handlers.get(type) ?? []
    existing.push(handler)
    this.handlers.set(type, existing)
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event)
    for (const handler of this.handlers.get("*") ?? []) handler(event)
  }
}

import { describe, expect, it } from "bun:test"
import { dispatchSlashCommand } from "../../src/commands/dispatcher.js"
import { conversation } from "../../src/singletons.js"
import type { AppConfig } from "../../src/config.js"
import { z } from "zod"

describe("dispatchSlashCommand /compact diagnostics", () => {
  it("keeps the last actual runtime schemas when the factory registry is smaller", async () => {
    const original = conversation.compress
    const context = conversation.getCompactionContext()
    const runtimeTools = [{ name: "runtime_agent", description: "runtime-only", parameters: z.object({ task: z.string() }) }]
    let used: unknown
    conversation.setCompactionContext({ tools: runtimeTools })
    conversation.compress = async (_provider, options) => { used = options?.tools; return null }
    try {
      await dispatchSlashCommand("/compact", makeDeps({ agentRef: { current: { provider: {}, registry: { definitions: () => [] } } as any } }))
      expect(used).toEqual(runtimeTools)
    } finally { conversation.compress = original; conversation.setCompactionContext(context) }
  })

  it("records manual compact failures for /status diagnostics", async () => {
    const originalCompress = conversation.compress
    const toasts: Array<{ text: string; variant?: string }> = []
    const statuses: string[] = []
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined

    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => {
      throw new Error("summarizer offline")
    }

    try {
      const handled = await dispatchSlashCommand("/compact", {
        exit: () => {},
        bumpTranscript: () => {},
        setLogs: () => {},
        setTodos: () => {},
        todosRef: { current: [] },
        subagentTodosRef: { current: new Map() },
        checkpointRef: { current: {} as any },
        turnStartLogIndexRef: { current: 0 },
        setDialog: () => {},
        addLog: () => {},
        configRef: { current: makeConfig() },
        updateConfig: () => {},
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        compactLogs: () => {},
        agentRef: { current: { provider: {} } as any },
        skillsRef: { current: new Map() },
        dispatchUserTurn: async () => {},
        getContextTokens: () => 0,
        setStatus: (status) => {
          statuses.push(status)
        },
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(statuses).toEqual(["compacting", "ready"])
      expect(toasts).toEqual([
        { text: "Compact failed: summarizer offline", variant: "error" },
      ])
      expect(compactFailure).toEqual({
        phase: "manual",
        error: "summarizer offline",
      })
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
    }
  })

  it("records manual compact failures when summarizer returns no usable summary", async () => {
    const originalCompress = conversation.compress
    const originalGetMessages = conversation.getMessages
    const originalGetAllMessages = conversation.getAllMessages
    const originalGetTurns = conversation.getTurns
    const toasts: Array<{ text: string; variant?: string }> = []
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined

    ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = () =>
      Array.from({ length: 11 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }))
    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () =>
      Array.from({ length: 11 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }))
    ;(conversation as unknown as { getTurns: typeof conversation.getTurns }).getTurns = () =>
      Array.from({ length: 11 }, (_, i) => ({ kind: "user" as const, content: `turn ${i}` }))
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => null

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(toasts.some((toast) =>
        toast.text === "Compact failed: summarizer returned no usable compact summary" &&
        toast.variant === "error",
      )).toBe(true)
      expect(compactFailure).toEqual({
        phase: "manual",
        error: "summarizer returned no usable compact summary",
      })
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = originalGetMessages
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
      ;(conversation as unknown as { getTurns: typeof conversation.getTurns }).getTurns = originalGetTurns
    }
  })

  it("treats expanded tool messages inside ten turns as a genuine no-op", async () => {
    const originalCompress = conversation.compress
    const originalGetAllMessages = conversation.getAllMessages
    const originalGetTurns = conversation.getTurns
    const toasts: Array<{ text: string; variant?: string }> = []
    let compactFailure: unknown = { phase: "manual", error: "stale" }

    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () =>
      Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "assistant" : "tool_result", content: `message ${i}` })) as any
    ;(conversation as unknown as { getTurns: typeof conversation.getTurns }).getTurns = () =>
      Array.from({ length: 9 }, (_, i) => ({ kind: "user" as const, content: `turn ${i}` }))
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => null

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        getContextTokens: () => 20_000,
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
      }))

      expect(handled).toBe(true)
      expect(toasts.some((toast) =>
        toast.text === "Nothing to compact" && toast.variant === "warning",
      )).toBe(true)
      expect(compactFailure).toBeUndefined()
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
      ;(conversation as unknown as { getTurns: typeof conversation.getTurns }).getTurns = originalGetTurns
    }
  })

  it("keeps manual compact pending and cancels it through the shared controller", async () => {
    const originalCompress = conversation.compress
    const statuses: string[] = []
    const toasts: Array<{ text: string; variant?: string }> = []
    const controller = new AbortController()
    let releasedController: AbortController | undefined

    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async (_provider, options) =>
      await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("aborted"))
        }, { once: true })
      })

    try {
      const pending = dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        setStatus: status => {
          statuses.push(status)
        },
        beginManualCompact: () => controller,
        endManualCompact: current => {
          releasedController = current
        },
      }))

      expect(pending).toBeInstanceOf(Promise)
      expect(statuses).toEqual(["compacting"])
      controller.abort(new Error("user cancelled"))

      await expect(pending).resolves.toBe(true)
      expect(statuses).toEqual(["compacting", "ready"])
      expect(toasts.some((toast) =>
        toast.text === "Compact cancelled" && toast.variant === "warning",
      )).toBe(true)
      expect(releasedController).toBe(controller)
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
    }
  })

  it("records detailed manual compact failures from conversation diagnostics", async () => {
    const originalCompress = conversation.compress
    const originalGetMessages = conversation.getMessages
    const originalGetAllMessages = conversation.getAllMessages
    const toasts: Array<{ text: string; variant?: string }> = []
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined
    const detailedReason =
      "summarizer returned an unusable compact summary (empty required sections: Next steps)"

    ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = () =>
      Array.from({ length: 11 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }))
    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () =>
      Array.from({ length: 11 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }))
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => null
    Object.defineProperty(conversation, "lastCompressionFailureReason", {
      configurable: true,
      get: () => detailedReason,
    })

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(toasts.some((toast) =>
        toast.text === `Compact failed: ${detailedReason}` &&
        toast.variant === "error",
      )).toBe(true)
      expect(compactFailure).toEqual({
        phase: "manual",
        error: detailedReason,
      })
    } finally {
      delete (conversation as unknown as { lastCompressionFailureReason?: string }).lastCompressionFailureReason
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = originalGetMessages
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
    }
  })

  it("keeps manual compact no-op feedback when there is no history to compact", async () => {
    const originalCompress = conversation.compress
    const originalGetMessages = conversation.getMessages
    const originalGetAllMessages = conversation.getAllMessages
    const toasts: Array<{ text: string; variant?: string }> = []
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined

    ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = () => [
      { role: "user", content: "only prompt" },
    ]
    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () => [
      { role: "user", content: "only prompt" },
    ]
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => null

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(toasts.some((toast) =>
        toast.text === "Nothing to compact" &&
        toast.variant === "warning",
      )).toBe(true)
      expect(compactFailure).toBeUndefined()
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = originalGetMessages
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
    }
  })

  it("clears stale manual compact failures after a successful compact", async () => {
    const originalCompress = conversation.compress
    const originalGetAllMessages = conversation.getAllMessages
    const toasts: Array<{ text: string; variant?: string }> = []
    const memoryFailures: unknown[] = [{ operation: "compact_summary", error: "previous memory failure" }]
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined = { phase: "manual", error: "previous failure" }

    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () =>
      Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }))
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => ({
      summary: [
        "# Primary Request and Intent",
        "request",
        "# All user messages (verbatim)",
        "message",
        "# Current task status",
        "done",
        "# Files read / modified",
        "- none",
        "# Commands run",
        "- none",
        "# Key facts discovered",
        "- fact",
        "# Decisions made",
        "- decision",
        "# Errors encountered and their resolution",
        "- none",
        "# Code changes summary",
        "- none",
        "# Next steps",
        "- continue",
      ].join("\n"),
      before: 12,
      after: 2,
    })

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        compactLogs: () => {},
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
        onMemoryFailure: (failure) => {
          memoryFailures.push(failure)
        },
        persistCompactSummary: async () => "/tmp/project_compact_state.md",
      }))

      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(compactFailure).toBeUndefined()
      expect(memoryFailures).toEqual([
        { operation: "compact_summary", error: "previous memory failure" },
        undefined,
      ])
      expect(toasts.some((toast) =>
        toast.text === "Compacted 12→2 msgs" &&
        toast.variant === "success",
      )).toBe(true)
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
    }
  })

  it("records manual compact summary persistence failures without failing compact", async () => {
    const originalCompress = conversation.compress
    const originalGetAllMessages = conversation.getAllMessages
    const toasts: Array<{ text: string; variant?: string }> = []
    const memoryFailures: unknown[] = []

    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () =>
      Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }))
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => ({
      summary: [
        "# Primary Request and Intent",
        "request",
        "# All user messages (verbatim)",
        "message",
        "# Current task status",
        "done",
        "# Files read / modified",
        "- src/commands/dispatcher.ts",
        "# Commands run",
        "- none",
        "# Key facts discovered",
        "- fact",
        "# Decisions made",
        "- surface memory persistence failures",
        "# Errors encountered and their resolution",
        "- none",
        "# Code changes summary",
        "- none",
        "# Next steps",
        "- continue",
      ].join("\n"),
      before: 12,
      after: 2,
    })

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        compactLogs: () => {},
        onMemoryFailure: (failure) => {
          memoryFailures.push(failure)
        },
        persistCompactSummary: async () => {
          throw new Error("memory write failed")
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(toasts.some((toast) =>
        toast.text === "Compacted 12→2 msgs" &&
        toast.variant === "success",
      )).toBe(true)
      expect(memoryFailures).toEqual([
        {
          operation: "compact_summary",
          error: "memory write failed",
        },
      ])
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
    }
  })

  it("records manual compact failures for short history when context is already over threshold", async () => {
    const originalCompress = conversation.compress
    const originalGetMessages = conversation.getMessages
    const originalGetAllMessages = conversation.getAllMessages
    const toasts: Array<{ text: string; variant?: string }> = []
    let compactFailure:
      | {
          phase: "pre_turn" | "in_loop" | "manual"
          error: string
          consecutiveFailures?: number
          breakerTripped?: boolean
        }
      | undefined

    ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = () => [
      { role: "user", content: "huge pasted context" },
      { role: "assistant", content: "response" },
    ]
    ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = () => [
      { role: "user", content: "huge pasted context" },
      { role: "assistant", content: "response" },
    ]
    ;(conversation as unknown as { compress: typeof conversation.compress }).compress = async () => null

    try {
      const handled = await dispatchSlashCommand("/compact", makeDeps({
        addToast: (text, options) => {
          toasts.push({ text, variant: options?.variant })
        },
        getContextTokens: () => 200_000,
        onCompactFailure: (failure) => {
          compactFailure = failure
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(handled).toBe(true)
      expect(toasts.some((toast) =>
        toast.text === "Compact failed: summarizer returned no usable compact summary" &&
        toast.variant === "error",
      )).toBe(true)
      expect(compactFailure).toEqual({
        phase: "manual",
        error: "summarizer returned no usable compact summary",
      })
    } finally {
      ;(conversation as unknown as { compress: typeof conversation.compress }).compress = originalCompress
      ;(conversation as unknown as { getMessages: typeof conversation.getMessages }).getMessages = originalGetMessages
      ;(conversation as unknown as { getAllMessages: typeof conversation.getAllMessages }).getAllMessages = originalGetAllMessages
    }
  })
})

function makeConfig(): AppConfig {
  return {
    providers: [],
    active: { providerId: "", model: "" },
    serperKey: "",
    maxTokens: 100,
    maxSteps: 10,
    customSystemPrompt: "",
    compaction: { auto: true, prune: true, reserved: 0 },
    mcpServers: [],
    permissionMode: "default",
  }
}

function makeDeps(
  overrides: Partial<Parameters<typeof dispatchSlashCommand>[1]> = {},
): Parameters<typeof dispatchSlashCommand>[1] {
  return {
    exit: () => {},
    bumpTranscript: () => {},
    setLogs: () => {},
    setTodos: () => {},
    todosRef: { current: [] },
    subagentTodosRef: { current: new Map() },
    checkpointRef: { current: {} as any },
    turnStartLogIndexRef: { current: 0 },
    setDialog: () => {},
    addLog: () => {},
    configRef: { current: makeConfig() },
    updateConfig: () => {},
    addToast: () => {},
    compactLogs: () => {},
    agentRef: { current: { provider: {} } as any },
    skillsRef: { current: new Map() },
    dispatchUserTurn: async () => {},
    getContextTokens: () => 0,
    setStatus: () => {},
    ...overrides,
  }
}

import { describe, expect, it } from "bun:test"
import { parseCommand } from "../../src/commands.js"
import { dispatchSlashCommand, latestUserInputText } from "../../src/commands/dispatcher.js"
import type { AppConfig } from "../../src/config.js"
import type { LogEntry } from "../../src/ui/types.js"

describe("/copy-input", () => {
  it("parses copy-input aliases", () => {
    expect(parseCommand("/copy-input")).toEqual({ type: "copy_input" })
    expect(parseCommand("/copyinput")).toEqual({ type: "copy_input" })
  })

  it("uses restoreText from the latest restorable user input", () => {
    const logs: LogEntry[] = [
      { id: 1, type: "user", text: "plain older" },
      { id: 2, type: "user", text: "/copy-input", restore: false },
      {
        id: 3,
        type: "user",
        text: "[Pasted #1 · 3 lines · 42 chars]",
        restoreText: "first line\nsecond line\nthird line",
      },
    ]

    expect(latestUserInputText(logs)).toBe("first line\nsecond line\nthird line")
  })

  it("uses restoreText from command rows that are display-only for replay", () => {
    const logs: LogEntry[] = [
      { id: 1, type: "user", text: "plain older" },
      {
        id: 2,
        type: "user",
        text: '/mcp.docs.summarize text="[Pasted #1 · 3 lines · 42 chars]"',
        restore: false,
        restoreText: '/mcp.docs.summarize text="first line\nsecond line\nthird line"',
      },
    ]

    expect(latestUserInputText(logs)).toBe('/mcp.docs.summarize text="first line\nsecond line\nthird line"')
  })

  it("skips legacy /copy-input command rows even when restore:false is missing", () => {
    const logs: LogEntry[] = [
      {
        id: 1,
        type: "user",
        text: "[Pasted #1 · 3 lines · 42 chars]",
        restoreText: "first line\nsecond line\nthird line",
      },
      {
        id: 2,
        type: "user",
        text: "/copy-input",
      },
    ]

    expect(latestUserInputText(logs)).toBe("first line\nsecond line\nthird line")
  })

  it("skips legacy /copyinput alias rows when finding the latest input", () => {
    const logs: LogEntry[] = [
      { id: 1, type: "user", text: "plain older" },
      { id: 2, type: "user", text: "/copyinput" },
    ]

    expect(latestUserInputText(logs)).toBe("plain older")
  })

  it("skips legacy /copy-input rows with ignored arguments", () => {
    const logs: LogEntry[] = [
      {
        id: 1,
        type: "user",
        text: "[Pasted #1 · 2 lines · 22 chars]",
        restoreText: "first line\nsecond line",
      },
      {
        id: 2,
        type: "user",
        text: "/copy-input please",
      },
    ]

    expect(parseCommand("/copy-input please")).toEqual({ type: "copy_input" })
    expect(latestUserInputText(logs)).toBe("first line\nsecond line")
  })

  it("does not skip ordinary inputs that only start with a copy-input-looking token", () => {
    const logs: LogEntry[] = [
      { id: 1, type: "user", text: "plain older" },
      { id: 2, type: "user", text: "/copy-input-extra should stay copyable" },
    ]

    expect(latestUserInputText(logs)).toBe("/copy-input-extra should stay copyable")
  })

  it("copies the latest expanded pasted input instead of its compact placeholder", () => {
    let copied = ""
    const toasts: string[] = []
    const handled = dispatchSlashCommand("/copy-input", makeDeps({
      getLogs: () => [
        {
          id: 1,
          type: "user",
          text: "[Pasted #1 · 140 lines · 1171 chars]",
          restoreText: "full pasted body",
        },
      ],
      copyToClipboard: (text) => {
        copied = text
        return true
      },
      addToast: (text) => { toasts.push(text) },
    }))

    expect(handled).toBe(true)
    expect(copied).toBe("full pasted body")
    expect(toasts).toContain("Copied last input to clipboard")
  })

  it("copies expanded pasted command input even though command rows are not replay-restorable", () => {
    let copied = ""
    const toasts: string[] = []
    const handled = dispatchSlashCommand("/copy-input", makeDeps({
      getLogs: () => [
        {
          id: 1,
          type: "user",
          text: '/mcp.docs.summarize text="[Pasted #1 · 3 lines · 42 chars]"',
          restore: false,
          restoreText: '/mcp.docs.summarize text="full pasted body"',
        },
      ],
      copyToClipboard: (text) => {
        copied = text
        return true
      },
      addToast: (text) => { toasts.push(text) },
    }))

    expect(handled).toBe(true)
    expect(copied).toBe('/mcp.docs.summarize text="full pasted body"')
    expect(toasts).toContain("Copied last input to clipboard")
  })

  it("falls back to persisted session logs after compaction hides prior transcript rows", () => {
    let copied = ""
    const toasts: string[] = []
    const handled = dispatchSlashCommand("/copy-input", makeDeps({
      getLogs: () => [
        {
          type: "compacted",
          text: "",
        },
      ],
      getSessionLogs: () => [
        {
          type: "user",
          text: "[Pasted #1 · 140 lines · 1171 chars]",
          restoreText: "full pasted body from jsonl",
        },
      ],
      copyToClipboard: (text) => {
        copied = text
        return true
      },
      addToast: (text) => { toasts.push(text) },
    }))

    expect(handled).toBe(true)
    expect(copied).toBe("full pasted body from jsonl")
    expect(toasts).toContain("Copied last input to clipboard")
  })

  it("reports when there is no restorable user input", () => {
    const toasts: string[] = []
    const handled = dispatchSlashCommand("/copy-input", makeDeps({
      getLogs: () => [{ id: 1, type: "user", text: "/status", restore: false }],
      addToast: (text) => { toasts.push(text) },
    }))

    expect(handled).toBe(true)
    expect(toasts).toContain("No user input to copy")
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

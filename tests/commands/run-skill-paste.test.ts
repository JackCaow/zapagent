import { describe, expect, it } from "bun:test"
import { parseCommand } from "../../src/commands.js"
import { dispatchSlashCommand } from "../../src/commands/dispatcher.js"
import type { AppConfig } from "../../src/config.js"
import type { SkillDefinition } from "../../zapsdk/skills/types.js"

describe("dispatchSlashCommand /run_skill paste handling", () => {
  it("preserves multiline slash command arguments after the command token", () => {
    expect(parseCommand("/fix first line\n  indented line\nlast line")).toEqual({
      type: "run_skill",
      skill: "fix",
      skillInput: "first line\n  indented line\nlast line",
    })
  })

  it("keeps expanded long-paste skill input out of display text and memory query text", async () => {
    const calls: Array<{
      text: string
      systemPrompt?: string
      displayText?: string
      restoreText?: string
      memoryQueryText?: string
    }> = []
    const fullPaste = `first line\n${"full pasted body ".repeat(200)}\nlast line`
    const display = "/fix [Pasted #1 · 3 lines · 3400 chars]"
    const expanded = `/fix ${fullPaste}`

    const handled = await dispatchSlashCommand(
      expanded,
      makeDeps({
        skillsRef: {
          current: new Map<string, SkillDefinition>([
            ["fix", {
              name: "fix",
              description: "Fix bugs",
              systemPrompt: "Debug {{issue}}",
              tools: [],
              parameters: [{ name: "issue", description: "Bug report", required: true }],
            }],
          ]),
        },
        dispatchUserTurn: async (text, systemPrompt, _images, displayText, _silent, restoreText, memoryQueryText) => {
          calls.push({ text, systemPrompt, displayText, restoreText, memoryQueryText })
        },
      }),
      {
        displayText: display,
        restoreText: expanded,
      },
    )

    expect(handled).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe(fullPaste)
    expect(calls[0]?.systemPrompt).toBe(`Debug ${fullPaste}`)
    expect(calls[0]?.displayText).toBe("[Pasted #1 · 3 lines · 3400 chars]")
    expect(calls[0]?.restoreText).toBe(fullPaste)
    expect(calls[0]?.memoryQueryText).toBe("[Pasted #1 · 3 lines · 3400 chars]")
    expect(calls[0]?.displayText).not.toContain("full pasted body")
    expect(calls[0]?.memoryQueryText).not.toContain("full pasted body")
  })

  it("preserves expanded long-paste skill input leading and trailing whitespace", async () => {
    const calls: Array<{
      text: string
      systemPrompt?: string
      displayText?: string
      restoreText?: string
      memoryQueryText?: string
    }> = []
    const fullPaste = `  first line\n${"  indented pasted body\n".repeat(20)}last line  `
    const display = "/fix [Pasted #1 · 22 lines · 500 chars]"
    const expanded = `/fix ${fullPaste}`

    const handled = await dispatchSlashCommand(
      expanded,
      makeDeps({
        skillsRef: {
          current: new Map<string, SkillDefinition>([
            ["fix", {
              name: "fix",
              description: "Fix bugs",
              systemPrompt: "Debug {{issue}}",
              tools: [],
              parameters: [{ name: "issue", description: "Bug report", required: true }],
            }],
          ]),
        },
        dispatchUserTurn: async (text, systemPrompt, _images, displayText, _silent, restoreText, memoryQueryText) => {
          calls.push({ text, systemPrompt, displayText, restoreText, memoryQueryText })
        },
      }),
      {
        displayText: display,
        restoreText: expanded,
      },
    )

    expect(handled).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe(fullPaste)
    expect(calls[0]?.systemPrompt).toBe(`Debug ${fullPaste}`)
    expect(calls[0]?.restoreText).toBe(fullPaste)
    expect(calls[0]?.displayText).toBe("[Pasted #1 · 22 lines · 500 chars]")
    expect(calls[0]?.memoryQueryText).toBe("[Pasted #1 · 22 lines · 500 chars]")
    expect(calls[0]?.text.startsWith("  ")).toBe(true)
    expect(calls[0]?.text.endsWith("  ")).toBe(true)
  })
})

function makeConfig(): AppConfig {
  return {
    providers: [
      {
        id: "p1",
        name: "Test",
        baseURL: "https://example.test/v1",
        apiKey: "key",
        contextWindow: 1000,
        models: ["m1"],
      },
    ],
    active: { providerId: "p1", model: "m1" },
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
    checkpointRef: { current: {} as never },
    turnStartLogIndexRef: { current: 0 },
    setDialog: () => {},
    addLog: () => {},
    configRef: { current: makeConfig() },
    updateConfig: () => {},
    addToast: () => {},
    compactLogs: () => {},
    agentRef: { current: { provider: {} } as never },
    skillsRef: { current: new Map() },
    dispatchUserTurn: async () => {},
    getContextTokens: () => 0,
    setStatus: () => {},
    ...overrides,
  }
}

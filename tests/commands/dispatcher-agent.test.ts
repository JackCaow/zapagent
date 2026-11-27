import { describe, expect, it } from "bun:test"
import { dispatchSlashCommand } from "../../src/commands/dispatcher.js"
import type { AppConfig } from "../../src/config.js"

async function run(input: string, activeAgent?: string) {
  const configRef = { current: { permissionMode: "default", activeAgent, providers: [], active: { providerId: "", model: "" } } as unknown as AppConfig }
  const logs: string[] = []
  const turns: unknown[][] = []
  await dispatchSlashCommand(input, {
    exit: () => {}, bumpTranscript: () => {}, setLogs: () => {},
    checkpointRef: { current: {} as any },
    turnStartLogIndexRef: { current: 0 }, setDialog: () => {}, addLog: (_type, text) => logs.push(text),
    configRef, updateConfig: next => { configRef.current = next }, addToast: () => {}, compactLogs: () => {},
    agentRef: { current: { provider: {} } as any }, skillsRef: { current: new Map() },
    dispatchUserTurn: async (...args: unknown[]) => { turns.push(args) }, getContextTokens: () => 0, setStatus: () => {},
  })
  return { logs, turns }
}

describe("zap-prompt commands in agent mode", () => {
  it("leaves compaction and effort to agents that own their model", async () => {
    for (const cmd of ["/compact", "/effort high"]) {
      expect((await run(cmd, "claude-code")).logs.join(" ")).toContain("managed by claude-code")
    }
    expect((await run("/agent", "claude-code")).logs.join(" ")).toContain("› claude-code")
  })
  it("refuses /review, /commit and /init instead of dropping their zap prompts", async () => {
    for (const command of ["/review", "/commit", "/init"]) {
      const { logs, turns } = await run(command, "agy")
      expect(turns).toHaveLength(0)
      expect(logs.join("\n")).toContain("runs on zap's own model, not agy")
    }
  })
})

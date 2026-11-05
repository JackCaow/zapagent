import { describe, expect, it } from "bun:test"
import { dispatchSlashCommand } from "../../src/commands/dispatcher.js"
import type { AppConfig } from "../../src/config.js"

async function setMode(value: string) {
  const configRef = { current: { permissionMode: "default" } as AppConfig }
  const logs: string[] = []
  await dispatchSlashCommand(`/mode ${value}`, {
    exit: () => {}, bumpTranscript: () => {}, setLogs: () => {}, setTodos: () => {},
    todosRef: { current: [] }, subagentTodosRef: { current: new Map() }, checkpointRef: { current: {} as any },
    turnStartLogIndexRef: { current: 0 }, setDialog: () => {}, addLog: (_type, text) => logs.push(text),
    configRef, updateConfig: next => { configRef.current = next }, addToast: () => {}, compactLogs: () => {},
    agentRef: { current: { provider: {} } as any }, skillsRef: { current: new Map() },
    dispatchUserTurn: async () => {}, getContextTokens: () => 0, setStatus: () => {},
  })
  return { mode: configRef.current.permissionMode, logs }
}

describe("/mode", () => {
  it("stores presets as their modes", async () => {
    expect((await setMode("balanced")).mode).toBe("acceptEdits")
    expect((await setMode("bypass")).mode).toBe("bypassPermissions")
  })

  it("refuses unknown names without changing the mode", async () => {
    const result = await setMode("yolo")
    expect(result.mode).toBe("default")
    expect(result.logs.join("\n")).toContain("Unknown permission mode: yolo")
  })
})

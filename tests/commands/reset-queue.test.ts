import { beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchSlashCommand } from "../../src/commands/dispatcher.js"
import type { AppConfig } from "../../src/config.js"
import {
  _resetForTest as resetInputQueueForTest,
  enqueue,
  getQueueLength,
  type QueuedCommand,
} from "../../src/queue/inputQueue.js"
import {
  _resetForTest as resetSystemInboxForTest,
  getSystemInboxLength,
  pushSystemEvent,
} from "../../src/queue/systemInbox.js"

beforeEach(() => {
  resetInputQueueForTest()
  resetSystemInboxForTest()
})

describe("dispatchSlashCommand reset commands", () => {
  it("/clear drops queued user input and system events as part of the reset", () => {
    enqueue(cmd("stale follow-up"))
    pushSystemEvent({ kind: "task-notification", payload: "<task-notification />", ts: 1 })
    let resetRuntime = 0

    const handled = dispatchSlashCommand("/clear", makeDeps({
      onResetRuntimeState: () => { resetRuntime++ },
    }))

    expect(handled).toBe(true)
    expect(getQueueLength()).toBe(0)
    expect(getSystemInboxLength()).toBe(0)
    expect(resetRuntime).toBe(1)
  })

  it("/new drops queued user input and system events before rebinding the session", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-reset-queue-"))
    try {
      const script = [
        'import { dispatchSlashCommand } from "./src/commands/dispatcher.ts";',
        'import { enqueue, getQueueLength } from "./src/queue/inputQueue.ts";',
        'import { getSystemInboxLength, pushSystemEvent } from "./src/queue/systemInbox.ts";',
        'enqueue({ text: "stale follow-up", displayForm: "stale follow-up" });',
        'pushSystemEvent({ kind: "task-notification", payload: "<task-notification />", ts: 1 });',
        'let rebound = false;',
        'let resetRuntime = 0;',
        'const deps = {',
        '  exit: () => {},',
        '  bumpTranscript: () => {},',
        '  setLogs: () => {},',
        '  setTodos: () => {},',
        '  todosRef: { current: [] },',
        '  subagentTodosRef: { current: new Map() },',
        '  checkpointRef: { current: { setSessionId: () => { rebound = true; } } },',
        '  turnStartLogIndexRef: { current: 0 },',
        '  setDialog: () => {},',
        '  addLog: () => {},',
        '  configRef: { current: { providers: [], active: { providerId: "", model: "" }, serperKey: "", maxTokens: 100, maxSteps: 10, customSystemPrompt: "", compaction: { auto: true, prune: true, reserved: 0 }, mcpServers: [], permissionMode: "default" } },',
        '  updateConfig: () => {},',
        '  addToast: () => {},',
        '  compactLogs: () => {},',
        '  agentRef: { current: { provider: {} } },',
        '  skillsRef: { current: new Map() },',
        '  dispatchUserTurn: async () => {},',
        '  getContextTokens: () => 0,',
        '  onResetRuntimeState: () => { resetRuntime++; },',
        '  setStatus: () => {},',
        '};',
        'const handled = dispatchSlashCommand("/new", deps);',
        'console.log(JSON.stringify({ handled, rebound, resetRuntime, queueLength: getQueueLength(), inboxLength: getSystemInboxLength() }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        handled: true,
        rebound: true,
        resetRuntime: 1,
        queueLength: 0,
        inboxLength: 0,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

function cmd(text: string): QueuedCommand {
  return { text, displayForm: text }
}

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
    checkpointRef: { current: { setSessionId: () => {} } as never },
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

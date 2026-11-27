import { describe, expect, it } from "bun:test"
import { agent } from "@agentclientprotocol/sdk"
import { RemoteAgentManager } from "../../src/agent/remote-agent.js"
import { formatPlan } from "../../src/agent/remote-turn.js"
import { parseCommand } from "../../src/commands.js"
import { inProcessTransport } from "../../zapsdk/acp-client/connection.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import { fakeAgent, text } from "../../zapsdk/tests/acp-client/fake-agent.js"

const spec = { id: "fake", command: "fake-agent" }

describe("RemoteAgentManager (session mode)", () => {
  it("keeps one ACP session across turns and maps events at the root path", async () => {
    let turns = 0
    const { app, log } = fakeAgent({ async script(turn) {
      turns += 1
      await turn.update({ sessionUpdate: "usage_update", used: 125 * turns, size: 1000 })
      await turn.update(text(`turn ${turns}: ${turn.prompt[0]?.type === "text" ? turn.prompt[0].text : ""}`))
    } })
    let spawned = 0
    const manager = new RemoteAgentManager(() => { spawned += 1; return inProcessTransport(app) })
    const events: AgentEvent[] = []
    const windows: { used: number; size: number }[] = []
    const started: string[] = []
    const run = (task: string) => manager.prompt(spec, "/w", task, undefined, {
      onContextUsage: usage => windows.push(usage),
      signal: new AbortController().signal, onEvent: event => events.push(event), onStarted: session => started.push(session.agentName),
    })
    expect((await run("hello")).report).toBe("turn 1: hello")
    expect((await run("again")).report).toBe("turn 2: again")
    expect(windows).toEqual([{ used: 125, size: 1000 }, { used: 250, size: 1000 }])
    expect(spawned).toBe(1)
    expect(started).toEqual(["fake-agent"])
    expect(log.calls.filter(call => call.method === "session/new")).toHaveLength(1)
    expect(events.filter(event => event.type === "content_final").every(event => !event.path?.length)).toBe(true)
    expect(manager.current?.spec.id).toBe("fake")
    await manager.reset()
    expect(manager.current).toBeUndefined()
  })

  it("reports the acknowledged session model and changes during the turn", async () => {
    const configOptions = (model: string) => [{
      id: "model", name: "Model", type: "select" as const, category: "model",
      currentValue: model, options: [{ value: model, name: model }],
    }]
    const app = agent({ name: "model-fixture" })
      .onRequest("initialize", () => ({ protocolVersion: 1 }))
      .onRequest("session/new", () => ({ sessionId: "s-model", configOptions: configOptions("initial") }))
      .onRequest("session/set_config_option", () => ({ configOptions: configOptions("acknowledged") }))
      .onRequest("session/prompt", async ({ client }) => {
        await client.notify("session/update", { sessionId: "s-model",
          update: { sessionUpdate: "config_option_update", configOptions: configOptions("actual") } })
        return { stopReason: "end_turn" }
      })
    const manager = new RemoteAgentManager(() => inProcessTransport(app))
    const models: string[] = []
    try {
      await manager.prompt({ ...spec, model: "requested" }, "/w", "task", undefined,
        { signal: new AbortController().signal, onEvent() {}, onModelId: model => models.push(model) })
      expect(models).toEqual(["acknowledged", "actual"])
      expect(manager.current?.session.modelId).toBe("actual")
    } finally { await manager.reset() }
  })

  it("applies permission changes on the original thread before the next prompt", async () => {
    const { app, log } = fakeAgent({ async script(turn) { await turn.update(text("ok")) } })
    const manager = new RemoteAgentManager(() => inProcessTransport(app))
    try {
      const threads = []
      for (const mode of ["read-only", "workspace-write", "workspace-write", "read-only"]) {
        const result = await manager.prompt({ ...spec, mode, requireSettings: true }, "/w", "task", undefined,
          { signal: new AbortController().signal, onEvent() {} })
        threads.push(result.session.sessionId)
      }
      expect(new Set(threads).size).toBe(1)
      expect(log.calls.map(call => call.method)).toEqual(["session/new", "session/set_mode", "session/prompt",
        "session/set_mode", "session/prompt", "session/prompt", "session/set_mode", "session/prompt"])
    } finally { await manager.reset() }
  })

  it("discards an unconfirmed mode change before delivering the next message", async () => {
    const { app, log } = fakeAgent({ rejectMode: "workspace-write", async script() {} })
    const manager = new RemoteAgentManager(() => inProcessTransport(app))
    const options = { signal: new AbortController().signal, onEvent() {} }
    try {
      await manager.prompt({ ...spec, mode: "read-only", requireSettings: true }, "/w", "analysis", undefined, options)
      await expect(manager.prompt({ ...spec, mode: "workspace-write", requireSettings: true }, "/w", "work", undefined, options)).rejects.toThrow()
      expect(manager.current).toBeUndefined()
      expect(log.calls.filter(call => call.method === "session/prompt")).toHaveLength(1)
    } finally { await manager.reset() }
  })

  it("starts a fresh agent when the cwd changes or after a failed turn", async () => {
    let fail = true
    const { app } = fakeAgent({ async script(turn) {
      if (fail) { fail = false; throw new Error("boom") }
      await turn.update(text("ok"))
    } })
    let spawned = 0
    const manager = new RemoteAgentManager(() => { spawned += 1; return inProcessTransport(app) })
    const options = { signal: new AbortController().signal, onEvent() {} }
    // The agent-side exception reaches the client as a JSON-RPC internal error.
    await expect(manager.prompt(spec, "/a", "x", undefined, options)).rejects.toThrow("Internal error")
    expect(manager.current).toBeUndefined()
    expect((await manager.prompt(spec, "/a", "x", undefined, options)).report).toBe("ok")
    await manager.prompt(spec, "/b", "x", undefined, options)
    expect(spawned).toBe(3)
    await manager.reset()
  })

  it("routes agent permission requests through the current host approval", async () => {
    const { app } = fakeAgent({ async script(turn) {
      const response = await turn.client.request("session/request_permission", { sessionId: turn.sessionId,
        toolCall: { toolCallId: "t", title: "Run ls", kind: "execute", rawInput: { command: "ls" } },
        options: [{ optionId: "y", name: "Yes", kind: "allow_once" }, { optionId: "n", name: "No", kind: "reject_once" }] }) as { outcome: { optionId?: string } }
      await turn.update(text(response.outcome.optionId ?? "none"))
    } })
    const manager = new RemoteAgentManager(() => inProcessTransport(app))
    const asked: string[] = []
    const result = await manager.prompt(spec, "/w", "go", undefined, {
      signal: new AbortController().signal, onEvent() {},
      approve: async name => { asked.push(name); return false },
    })
    expect(asked).toEqual(["bash"])
    expect(result.report).toBe("n")
    await manager.reset()
  })
})

describe("RemoteAgentManager lifecycle", () => {
  it("discards a session that finishes starting after reset() and closes its transport", async () => {
    const { app } = fakeAgent({ async script(turn) { await turn.update(text("hi")) } })
    let disposed = 0
    let releaseInit!: () => void
    const gate = new Promise<void>(resolve => { releaseInit = resolve })
    const manager = new RemoteAgentManager(() => {
      const transport = inProcessTransport(app)
      return { ...transport, open: (client) => {
        const connection = transport.open(client)
        // Hold initialize until the test has called reset().
        const request = connection.agent.request.bind(connection.agent)
        connection.agent.request = (async (method: string, params: unknown) => { if (method === "initialize") await gate; return request(method as never, params as never) }) as never
        return connection
      }, dispose: async () => { disposed += 1; await transport.dispose() } }
    })
    const pending = manager.prompt(spec, "/w", "x", undefined, { signal: new AbortController().signal, onEvent() {} })
    await manager.reset()
    releaseInit()
    await expect(pending).rejects.toThrow("start was cancelled")
    expect(manager.current).toBeUndefined()
    expect(disposed).toBe(1)
  })

  it("refuses to start an agent when host policy blocks host processes", async () => {
    let spawned = 0
    const manager = new RemoteAgentManager(() => { spawned += 1; throw new Error("unreachable") })
    manager.host.blocked = "blocked by policy"
    await expect(manager.prompt(spec, "/w", "x", undefined, { signal: new AbortController().signal, onEvent() {} })).rejects.toThrow("blocked by policy")
    expect(spawned).toBe(0)
  })
})

describe("/agent command", () => {
  it("parses list, switch and back", () => {
    expect(parseCommand("/agent")).toEqual({ type: "set_agent", value: "" })
    expect(parseCommand("/agent agy")).toEqual({ type: "set_agent", value: "agy" })
    expect(parseCommand("/agent zap")).toEqual({ type: "set_agent", value: "zap" })
  })

  it("formats agent plans", () => {
    expect(formatPlan("agy", [
      { content: "Read code", priority: "high", status: "completed" },
      { content: "Edit", priority: "medium", status: "in_progress" },
    ])).toBe("agy plan:\n  ✓ Read code\n  ▸ Edit")
  })
})

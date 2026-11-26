import { describe, expect, it } from "bun:test"
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
      await turn.update(text(`turn ${turns}: ${turn.prompt[0]?.type === "text" ? turn.prompt[0].text : ""}`))
    } })
    let spawned = 0
    const manager = new RemoteAgentManager(() => { spawned += 1; return inProcessTransport(app) })
    const events: AgentEvent[] = []
    const started: string[] = []
    const run = (task: string) => manager.prompt(spec, "/w", task, undefined, {
      signal: new AbortController().signal, onEvent: event => events.push(event), onStarted: session => started.push(session.agentName),
    })
    expect((await run("hello")).report).toBe("turn 1: hello")
    expect((await run("again")).report).toBe("turn 2: again")
    expect(spawned).toBe(1)
    expect(started).toEqual(["fake-agent"])
    expect(log.calls.filter(call => call.method === "session/new")).toHaveLength(1)
    expect(events.filter(event => event.type === "content_final").every(event => !event.path?.length)).toBe(true)
    expect(manager.current?.spec.id).toBe("fake")
    await manager.reset()
    expect(manager.current).toBeUndefined()
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
    manager.host.approve = Object.assign(async (name: string) => { asked.push(name); return false }, {})
    const result = await manager.prompt(spec, "/w", "go", undefined, { signal: new AbortController().signal, onEvent() {} })
    expect(asked).toEqual(["bash"])
    expect(result.report).toBe("n")
    await manager.reset()
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

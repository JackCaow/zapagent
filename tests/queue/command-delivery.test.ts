import { describe, expect, it } from "bun:test"
import { dispatchSlashCommand, type DispatchSlashCommandDeps } from "../../src/commands/dispatcher.js"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { deliverNextMessage, type QueueDelivery } from "../../src/queue/delivery.js"

function bridge(queue: MessageQueue, run: (accepted: () => void) => Promise<unknown>, ready = true): QueueDelivery {
  return {
    providerReady: () => ready,
    dispatch: async (_entry, accepted) => run(accepted),
    command: async (entry, accepted) => {
      let inputRequired = false, result: unknown
      const deps = {
        configRef: { current: { providers: ready ? [{ id: "test", name: "Test", baseURL: "http://127.0.0.1:1/v1", apiKey: "test-only", models: ["test"] }] : [],
          active: { providerId: "test", model: "test" } } },
        skillsRef: { current: new Map([["fixture", { name: "fixture", description: "test", tools: [], systemPrompt: "test" }]]) },
        addLog: () => {},
        dispatchUserTurn: () => run(accepted),
      } as unknown as DispatchSlashCommandDeps
      await dispatchSlashCommand(entry.text, deps, {
        onInputRequired: () => { inputRequired = true }, onRunResult: value => { result = value },
      })
      return { inputRequired, result }
    },
    onError: () => {},
  }
}

describe("queue delivery through the real slash dispatcher", () => {
  for (const text of ["/review", "/commit", "/init", "/fixture input"]) {
    it(`waits for canonical acceptance and completion of ${text}`, async () => {
      const queue = new MessageQueue()
      const entry = queue.enqueue({ text, displayForm: text })
      queue.enqueue({ text: "next", displayForm: "next" })
      let acceptInput!: () => void, finish!: () => void, settled = false
      const acceptance = new Promise<void>(resolve => { acceptInput = resolve })
      const completion = new Promise<void>(resolve => { finish = resolve })
      const delivery = bridge(queue, async accepted => {
        queue.beginRun("slash-run")
        await acceptance; accepted(); await completion
        queue.endRun("slash-run")
        return { stopped: "end_turn" }
      })
      const pending = deliverNextMessage(queue, delivery).then(value => { settled = true; return value })
      await Promise.resolve()
      expect(queue.getSnapshot()[0]).toMatchObject({ id: entry.id, state: "dispatching" })
      expect(settled).toBe(false)
      acceptInput(); await Promise.resolve(); await Promise.resolve()
      expect(queue.getSnapshot().map(item => item.text)).toEqual(["next"])
      expect(settled).toBe(false)
      finish()
      expect(await pending).toBe(true)
    })
  }

  it("retains an agent command rejected by provider setup", async () => {
    const queue = new MessageQueue()
    queue.enqueue({ text: "/review", displayForm: "/review" })
    let calls = 0
    expect(await deliverNextMessage(queue, bridge(queue, async () => { calls++; return {} }, false))).toBe(false)
    expect(calls).toBe(0)
    expect(queue.getSnapshot()[0]).toMatchObject({ text: "/review", state: "failed" })
  })

  it("holds follow-ups after an agent-command budget stop", async () => {
    const queue = new MessageQueue()
    queue.enqueue({ text: "/review", displayForm: "/review" }); queue.enqueue({ text: "next", displayForm: "next" })
    expect(await deliverNextMessage(queue, bridge(queue, async accepted => { accepted(); return { stopped: "budget" } }))).toBe(false)
    expect(queue.getSnapshot().map(item => [item.text, item.state])).toEqual([["next", "failed"]])
  })

  it("propagates a rejected agent-command promise instead of replaying accepted input", async () => {
    for (const acceptFirst of [false, true]) {
      const queue = new MessageQueue()
      queue.enqueue({ text: "/review", displayForm: "/review" }); queue.enqueue({ text: "next", displayForm: "next" })
      expect(await deliverNextMessage(queue, bridge(queue, async accepted => {
        if (acceptFirst) accepted()
        throw new Error("model failed")
      }))).toBe(false)
      expect(queue.getSnapshot().map(item => item.text)).toEqual(acceptFirst ? ["next"] : ["/review", "next"])
      expect(queue.getSnapshot().every(item => item.state === "failed")).toBe(true)
    }
  })
})

import { describe, expect, it } from "bun:test"
import { MessageQueue } from "../../src/queue/messageQueue.js"
import { deliverNextMessage, type QueueDelivery } from "../../src/queue/delivery.js"

function setup(overrides: Partial<QueueDelivery> = {}) {
  const queue = new MessageQueue()
  const delivered: string[] = [], errors: string[] = []
  const delivery: QueueDelivery = {
    providerReady: () => true,
    dispatch: async (entry, accepted) => { delivered.push(entry.text); accepted(); return {} },
    command: async entry => { delivered.push(entry.text) },
    onError: error => { errors.push(error) }, ...overrides,
  }
  return { queue, delivery, delivered, errors }
}
describe("independent follow-up delivery", () => {
  it("sends each message as its own turn and keeps slash command ordering", async () => {
    const { queue, delivery, delivered } = setup()
    for (const text of ["first", "/status", "second", "third"]) queue.enqueue({ text, displayForm: text })
    for (let i = 0; i < 4; i++) expect(await deliverNextMessage(queue, delivery)).toBe(true)
    expect(delivered).toEqual(["first", "/status", "second", "third"])
    expect(queue.getSnapshot()).toHaveLength(0)
  })
  it("retains a failed provider precheck and blocks following inputs", async () => {
    const { queue, delivery, delivered } = setup({ providerReady: () => false })
    queue.enqueue({ text: "first", displayForm: "first" }); queue.enqueue({ text: "second", displayForm: "second" })
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
    expect(delivered).toEqual([])
    expect(queue.getSnapshot().map(entry => entry.state)).toEqual(["failed", "failed"])
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
  })
  it("retains setup failures but never replays input accepted before an API error", async () => {
    for (const acceptedFirst of [false, true]) {
      const { queue, delivery } = setup({ dispatch: async (_entry, accepted) => {
        if (acceptedFirst) accepted()
        throw new Error("model request failed")
      } })
      queue.enqueue({ text: "first", displayForm: "first" }); queue.enqueue({ text: "second", displayForm: "second" })
      expect(await deliverNextMessage(queue, delivery)).toBe(false)
      expect(queue.getSnapshot().map(entry => entry.text)).toEqual(acceptedFirst ? ["second"] : ["first", "second"])
      expect(queue.getSnapshot().every(entry => entry.state === "failed")).toBe(true)
    }
  })
  it("requires an explicit canonical receipt rather than a successful return value", async () => {
    const { queue, delivery, errors } = setup({ dispatch: async () => ({ text: "done" }) })
    queue.enqueue({ text: "first", displayForm: "first" })
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
    expect(queue.getSnapshot()[0]?.state).toBe("failed")
    expect(errors[0]).toContain("did not accept")
  })
  it("does not replay agent-backed slash commands already accepted before an API failure", async () => {
    const { queue, delivery } = setup({ command: async (_entry, accepted) => { accepted(); throw new Error("review model failed") } })
    queue.enqueue({ text: "/review", displayForm: "/review" })
    queue.enqueue({ text: "next", displayForm: "next" })
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
    expect(queue.getSnapshot().map(entry => [entry.text, entry.state])).toEqual([["next", "failed"]])
  })
  it("holds remaining inputs after cancellation or forced budget completion", async () => {
    for (const result of [undefined, { stopped: "budget" }, { stopped: "timeout" }]) {
      const { queue, delivery } = setup({ dispatch: async (_entry, accepted) => { accepted(); return result } })
      queue.enqueue({ text: "first", displayForm: "first" }); queue.enqueue({ text: "second", displayForm: "second" })
      expect(await deliverNextMessage(queue, delivery)).toBe(false)
      expect(queue.getSnapshot()).toHaveLength(1)
      expect(queue.getSnapshot()[0]).toMatchObject({ text: "second", state: "failed" })
    }
  })
  it("does not automatically deliver after a failed pause write recovers", async () => {
    let failWrite = false
    const queue = new MessageQueue("/unused-fixture", () => { if (failWrite) throw new Error("disk full") })
    const { delivery, errors } = setup({ dispatch: async (_entry, accepted) => {
      accepted(); failWrite = true; return { stopped: "budget" }
    } })
    queue.enqueue({ text: "first", displayForm: "first" }); queue.enqueue({ text: "next", displayForm: "next" })
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
    expect(errors.some(error => error.includes("disk full"))).toBe(true)
    expect(queue.getSnapshot()[0]).toMatchObject({ text: "next", state: "failed" })
    failWrite = false
    queue.enqueue({ text: "new", displayForm: "new" })
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
  })
  it("passes attachment ownership unchanged and never dispatches an editing head", async () => {
    const { queue, delivery } = setup()
    const a = queue.enqueue({ text: "first", displayForm: "first", pastedContents: { "1": "  pasted\n" } })
    queue.edit(a.id)
    expect(await deliverNextMessage(queue, delivery)).toBe(false)
    queue.cancelEdit(a.id)
    delivery.dispatch = async (entry, accepted) => { expect(entry.pastedContents?.["1"]).toBe("  pasted\n"); accepted(); return {} }
    expect(await deliverNextMessage(queue, delivery)).toBe(true)
  })
})

import { describe, it, expect, beforeEach } from "bun:test"
import {
  pushSystemEvent,
  drainSystemInbox,
  clearSystemInbox,
  getSystemInboxLength,
  subscribeToSystemInbox,
  _resetForTest,
  type SystemEvent,
} from "../src/queue/systemInbox.js"

beforeEach(() => {
  _resetForTest()
})

const event = (payload: string, kind: SystemEvent["kind"] = "task-notification"): SystemEvent => ({
  kind,
  payload,
  ts: Date.now(),
})

describe("systemInbox: basic operations", () => {
  it("starts empty", () => {
    expect(getSystemInboxLength()).toBe(0)
  })

  it("push then drain returns FIFO and empties", () => {
    pushSystemEvent(event("a"))
    pushSystemEvent(event("b"))
    pushSystemEvent(event("c"))
    const drained = drainSystemInbox()
    expect(drained.map((e) => e.payload)).toEqual(["a", "b", "c"])
    expect(getSystemInboxLength()).toBe(0)
  })

  it("drain on empty inbox returns []", () => {
    expect(drainSystemInbox()).toEqual([])
  })

  it("clearSystemInbox empties without returning events", () => {
    pushSystemEvent(event("a"))
    pushSystemEvent(event("b"))

    clearSystemInbox()

    expect(getSystemInboxLength()).toBe(0)
    expect(drainSystemInbox()).toEqual([])
  })
})

describe("systemInbox: subscribers", () => {
  it("notifies on push", () => {
    let calls = 0
    const unsub = subscribeToSystemInbox(() => { calls++ })
    pushSystemEvent(event("a"))
    expect(calls).toBe(1)
    pushSystemEvent(event("b"))
    expect(calls).toBe(2)
    unsub()
  })

  it("notifies on drain only when inbox had items", () => {
    let calls = 0
    const unsub = subscribeToSystemInbox(() => { calls++ })
    drainSystemInbox()
    expect(calls).toBe(0)
    pushSystemEvent(event("a"))
    expect(calls).toBe(1)
    drainSystemInbox()
    expect(calls).toBe(2)
    unsub()
  })

  it("unsubscribe stops notifications", () => {
    let calls = 0
    const unsub = subscribeToSystemInbox(() => { calls++ })
    pushSystemEvent(event("a"))
    expect(calls).toBe(1)
    unsub()
    pushSystemEvent(event("b"))
    expect(calls).toBe(1)
  })
})

describe("systemInbox: shape invariants (cannot impersonate user input)", () => {
  it("drained entries carry only kind/payload/ts — no displayForm or images", () => {
    pushSystemEvent(event("<task-notification>...</task-notification>"))
    const [drained] = drainSystemInbox()
    const keys = Object.keys(drained ?? {}).sort()
    expect(keys).toEqual(["kind", "payload", "ts"])
  })
})

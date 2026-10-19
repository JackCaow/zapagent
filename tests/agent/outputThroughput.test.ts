import { describe, expect, it, spyOn } from "bun:test"
import { OutputThroughput } from "../../src/agent/outputThroughput.js"
import { ProviderRequest } from "../../zapsdk/core/provider-request.js"
import type { ProviderRequestEvent } from "../../zapsdk/core/llm.js"

function request(phase: ProviderRequestEvent["phase"] = "completed", extra: Partial<ProviderRequestEvent> = {}): ProviderRequestEvent {
  return { phase, attempt: 1, maxAttempts: 3, startedAt: 1000, at: 12000, elapsedMs: 11000,
    output: { firstThinkingMs: 10000, thinkingChars: 80, textChars: 200, toolArgumentChars: 120 }, ...extra }
}

describe("root output throughput", () => {
  it("updates live estimates from all output channels, excluding first-output wait", () => {
    const tracker = new OutputThroughput()
    expect(tracker.observe(1, request("streaming"))).toEqual({ tokensPerSecond: 100, estimated: true })
    expect(tracker.observe(1, request("streaming", { elapsedMs: 12000 }))).toEqual({ tokensPerSecond: 50, estimated: true })
  })
  it("calibrates with matching provider output usage without including later tool time", () => {
    const tracker = new OutputThroughput(); tracker.observe(1, request())
    expect(tracker.usage(1, 75)).toEqual({ tokensPerSecond: 75, estimated: false })
  })
  it("keeps estimates when usage is missing or belongs to a different step", () => {
    for (const [step, reported] of [[2, true], [1, false]] as const) {
      const tracker = new OutputThroughput(); tracker.observe(1, request())
      expect(tracker.usage(step, 500, reported)).toEqual({ tokensPerSecond: 100, estimated: true })
    }
  })
  it("does not apply combined continuation usage to only the last request's duration", () => {
    const tracker = new OutputThroughput(); tracker.observe(1, request(), "request-1")
    tracker.observe(1, request("completed", { startedAt: 15000 }), "request-2")
    expect(tracker.usage(1, 500)).toEqual({ tokensPerSecond: 100, estimated: true })
  })
  it("clears stale throughput while waiting, retrying, failing or resetting", () => {
    const tracker = new OutputThroughput()
    for (const phase of ["requesting", "waiting_output", "retrying", "failed"] as const) {
      tracker.observe(1, request()); expect(tracker.observe(1, request(phase))).toBeUndefined()
    }
    tracker.reset(); expect(tracker.usage(1, 100)).toBeUndefined()
  })
  it("does not fabricate rates for nonstreaming, zero-time, tiny, or invalid samples", () => {
    const tracker = new OutputThroughput()
    for (const event of [request("completed", { output: undefined }), request("completed", { elapsedMs: 10000 }),
      request("completed", { elapsedMs: 10001 }), request("completed", { elapsedMs: Infinity })]) {
      expect(tracker.observe(1, event)).toBeUndefined(); expect(tracker.usage(1, 100)).toBeUndefined()
    }
    tracker.observe(1, request()); expect(tracker.usage(1, Infinity)).toBeUndefined()
  })
  it("starts the next step independently and accepts its measured usage", () => {
    const tracker = new OutputThroughput(); tracker.observe(1, request(), "old")
    tracker.observe(2, request(), "new")
    expect(tracker.usage(2, 40)).toEqual({ tokensPerSecond: 40, estimated: false })
  })
})

it("publishes bounded live snapshots before the provider finishes streaming", async () => {
  const events: ProviderRequestEvent[] = []
  const clock = spyOn(Date, "now").mockReturnValue(1000)
  const provider = new ProviderRequest({ onRequestEvent: event => events.push(event) })
  async function* chunks() {
    yield { type: "text_delta" as const, text: "first" }
    clock.mockReturnValue(1099)
    yield { type: "text_delta" as const, text: "a" }
    clock.mockReturnValue(1100)
    yield { type: "thinking_delta" as const, text: "thought" }
    clock.mockReturnValue(1101)
    yield { type: "text_delta" as const, text: "end" }
  }
  try {
    for await (const _chunk of provider.watch(chunks())) { /* consume the real telemetry source */ }
    const streaming = events.filter(event => event.phase === "streaming")
    expect(streaming).toHaveLength(2)
    expect(streaming[1]?.output?.thinkingChars).toBe(7)
    expect(streaming[1]?.output?.textChars).toBe(6)
    expect(events.at(-1)?.output?.textChars).toBe(9)
  } finally { provider.close(); clock.mockRestore() }
})

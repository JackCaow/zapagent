import { describe, it, expect } from "bun:test"
import {
  withStreamIdleTimeout,
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
  getStreamIdleMs,
} from "../../core/stream-idle.js"
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js"
import { AnthropicProvider } from "../../core/providers/anthropic.js"

// ─── Utility-level coverage ──────────────────────────────────────────────
//
// These tests exercise the wrapper directly. They guarantee the watchdog
// itself behaves correctly regardless of which adapter wires it up.

describe("withStreamIdleTimeout (utility)", () => {
  it("throws StreamIdleTimeoutError when no value arrives within idleMs", async () => {
    async function* src() {
      yield 1
      await new Promise((r) => setTimeout(r, 200)) // exceeds idle window
      yield 2
    }
    const wrapped = withStreamIdleTimeout(src(), 50)
    let caught: Error | null = null
    try {
      for await (const _v of wrapped) { void _v }
    } catch (e) { caught = e as Error }
    expect(isStreamIdleTimeoutError(caught)).toBe(true)
    expect(caught).toBeInstanceOf(StreamIdleTimeoutError)
  })

  it("does NOT throw if frames keep arriving below idleMs", async () => {
    async function* src() {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 30))
        yield i
      }
    }
    const wrapped = withStreamIdleTimeout(src(), 100)
    const got: number[] = []
    for await (const v of wrapped) got.push(v as number)
    expect(got).toEqual([0, 1, 2, 3, 4])
  })

  it("cancels within a tick when AbortSignal fires mid-stall (doesn't wait idleMs)", async () => {
    const controller = new AbortController()
    async function* src() {
      yield 1
      await new Promise((r) => setTimeout(r, 10_000))
      yield 2
    }
    setTimeout(() => controller.abort(), 30)
    const t0 = Date.now()
    const wrapped = withStreamIdleTimeout(src(), 60_000, controller.signal)
    for await (const _v of wrapped) { void _v }
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(2_000)
  })

  it("getStreamIdleMs reads an explicit env value", () => {
    expect(getStreamIdleMs("12345")).toBe(12345)
  })

  it("getStreamIdleMs falls back to default when env value is missing/invalid", () => {
    expect(getStreamIdleMs(undefined)).toBe(180_000)
    expect(getStreamIdleMs("garbage")).toBe(180_000)
  })
})

// ─── Provider-level regression for issue #10 ─────────────────────────────
//
// The bug: the watchdog used to wrap the adapter's typed yield, so any SSE
// keep-alive frame the adapter dropped (Anthropic `ping`, OpenAI empty-
// delta) was invisible to the watchdog. A healthy upstream that batched
// deltas across the idle window got falsely killed.
//
// Now the watchdog wraps the SDK iterator inside the adapter, so frames the
// adapter chooses not to forward still count as liveness.

function fakeOpenAIClient(chunks: any[], chunkDelayMs = 10) {
  return {
    chat: {
      completions: {
        create: async () => {
          async function* gen() {
            for (const c of chunks) {
              if (chunkDelayMs > 0) await new Promise((r) => setTimeout(r, chunkDelayMs))
              yield c
            }
          }
          return gen()
        },
      },
    },
  } as any
}

function fakeAnthropicClient(events: any[], chunkDelayMs = 10) {
  return {
    messages: {
      stream: async () => {
        const iter = (async function* () {
          for (const e of events) {
            if (chunkDelayMs > 0) await new Promise((r) => setTimeout(r, chunkDelayMs))
            yield e
          }
        })()
        const wrapped: any = {
          [Symbol.asyncIterator]() { return iter },
          finalMessage: async () => ({
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: "end_turn",
          }),
        }
        return wrapped
      },
    },
  } as any
}

describe("OpenAI adapter — stream-idle keep-alive (issue #10 regression)", () => {
  it("does NOT trip on empty-delta keep-alive chunks (the bug)", async () => {
    // Real text once, then 5 empty-delta keep-alive chunks at 30ms each
    // (totaling 150ms — well past the 60ms watchdog), then a real done.
    // Pre-fix this would throw StreamIdleTimeoutError after 60ms because
    // the adapter dropped the empty-delta chunks before the watchdog saw
    // them.
    const chunks = [
      { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]
    const provider = new OpenAICompatibleProvider({ model: "x", baseURL: "", apiKey: "k", streamIdleMs: 60 })
    ;(provider as any).client = fakeOpenAIClient(chunks, 30)
    const got: any[] = []
    for await (const c of provider.stream!([{ role: "user", content: "hi" }])) got.push(c)
    expect(got.find(c => c.type === "done")).toBeTruthy()
  })

  it("DOES trip when SDK truly stops yielding past idleMs", async () => {
    // Real text once, then SDK silence for 200ms, then done.
    const provider = new OpenAICompatibleProvider({ model: "x", baseURL: "", apiKey: "k", streamIdleMs: 50 })
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async () => {
            async function* gen() {
              yield { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }
              await new Promise((r) => setTimeout(r, 200))
              yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
            }
            return gen()
          },
        },
      },
    }
    let caught: Error | null = null
    try {
      for await (const _c of provider.stream!([{ role: "user", content: "hi" }])) { void _c }
    } catch (e) { caught = e as Error }
    expect(isStreamIdleTimeoutError(caught)).toBe(true)
  })
})

describe("Anthropic adapter — stream-idle keep-alive (issue #10 regression)", () => {
  it("does NOT trip when SDK keeps emitting ping frames (the bug)", async () => {
    // ping events are dropped by the adapter; pre-fix this would time out
    // even though the SDK kept yielding well-formed Anthropic SSE frames.
    const events = [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "ping" },
      { type: "ping" },
      { type: "ping" },
      { type: "ping" },
      { type: "ping" },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]
    const provider = new AnthropicProvider({
      model: "claude-x",
      client: fakeAnthropicClient(events, 30),
      promptCaching: false,
      streamIdleMs: 60,
    })
    const got: any[] = []
    for await (const c of provider.stream!([{ role: "user", content: "hi" }])) got.push(c)
    expect(got.find(c => c.type === "done")).toBeTruthy()
  })

  it("DOES trip when SDK truly stops yielding past idleMs", async () => {
    const provider = new AnthropicProvider({
      model: "claude-x",
      client: {
        messages: {
          stream: async () => {
            const iter = (async function* () {
              yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
              await new Promise((r) => setTimeout(r, 200))
              yield { type: "message_stop" }
            })()
            return {
              [Symbol.asyncIterator]() { return iter },
              finalMessage: async () => ({ usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }),
            } as any
          },
        },
      } as any,
      promptCaching: false,
      streamIdleMs: 50,
    })
    let caught: Error | null = null
    try {
      for await (const _c of provider.stream!([{ role: "user", content: "hi" }])) { void _c }
    } catch (e) { caught = e as Error }
    expect(isStreamIdleTimeoutError(caught)).toBe(true)
  })
})

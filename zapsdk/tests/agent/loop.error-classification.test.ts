/**
 * Regression: a Kiro provider returning `401 Token已失效，请重试` (auth
 * failure, not context overflow) was being matched by isContextError's
 * loose `.includes("token")` check and routed into autoCompact → retry →
 * rewrap as "Context length exceeded after compaction". The user saw a
 * "start a new session or switch to a larger model" hint when actually
 * their API key was expired.
 *
 * We can't directly call the private isContextError; instead exercise
 * the LoopAgent end-to-end: a 401-throwing provider should bubble up
 * verbatim instead of triggering compaction + the friendly-overflow
 * wrapper.
 */
import { describe, it, expect } from "bun:test"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import type { LLMProvider } from "../../core/llm.js"

function mockProvider(throwOn: (msgs: any[]) => Error | null): LLMProvider {
  return {
    // autoCompact's summarizer call() — return a benign summary string so
    // the compaction step itself completes; the retry still re-runs stream
    // (where throwOn fires again) so the test sees the same error twice.
    async call() {
      return { type: "text" as const, text: "summary", usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async *stream(msgs: any[]) {
      const err = throwOn(msgs)
      if (err) throw err
      yield { type: "text_delta" as const, text: "ok" }
      yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

describe("LoopAgent: 401/403/429 not misclassified as context overflow", () => {
  it("propagates Kiro-style 401 Token失效 verbatim, no autoCompact", async () => {
    let callCount = 0
    const provider = mockProvider(() => {
      callCount++
      return new Error("401 Token已失效，请重试")
    })
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry)
    const agent = new LoopAgent({ provider, registry, executor, maxSteps: 5 })
    try {
      await agent.run("hello")
      expect.unreachable("should have thrown")
    } catch (err) {
      const msg = (err as Error).message
      // Bug repro: would have become "Context length exceeded after compaction: ...".
      expect(msg).not.toContain("Context length exceeded after compaction")
      expect(msg).not.toContain("/new or switch")
      // Original error should still be visible.
      expect(msg).toContain("401")
      expect(msg).toContain("Token")
    }
    // No retry (autoCompact would re-attempt the call).
    expect(callCount).toBe(1)
  })

  it("propagates 403 Forbidden as-is", async () => {
    const provider = mockProvider(() => new Error("403 Forbidden: insufficient permissions"))
    const agent = new LoopAgent({ provider, registry: new ToolRegistry(), executor: new ToolExecutor(new ToolRegistry()) })
    try {
      await agent.run("hi")
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).not.toContain("Context length exceeded")
      expect((err as Error).message).toContain("403")
    }
  })

  it("propagates 429 Rate limit as-is (also contains 'token' in some providers' bodies)", async () => {
    const provider = mockProvider(() => new Error("429 Too Many Requests — token rate limit per minute"))
    const agent = new LoopAgent({ provider, registry: new ToolRegistry(), executor: new ToolExecutor(new ToolRegistry()) })
    try {
      await agent.run("hi")
      expect.unreachable()
    } catch (err) {
      // Even though this error contains BOTH "token" AND "limit", the 429
      // short-circuit prevents the context-overflow classification.
      expect((err as Error).message).not.toContain("Context length exceeded after compaction")
      expect((err as Error).message).toContain("429")
    }
  })

  it("still classifies a genuine token-limit error as context overflow", async () => {
    // Both stream AND call() throw the same overflow message so every
    // recovery path (reactiveCompact, autoCompact retry) hits the same
    // error. The final wrap should fire makeFriendlyOverflowError →
    // "Context length exceeded after compaction" + /new hint.
    const overflow = "This model's maximum context length is 128000 tokens, however your messages resulted in 145000 tokens"
    const provider: LLMProvider = {
      async call() { throw new Error(overflow) },
      async *stream() {
        throw new Error(overflow)
        // eslint-disable-next-line @typescript-eslint/no-unreachable
        yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const agent = new LoopAgent({ provider, registry: new ToolRegistry(), executor: new ToolExecutor(new ToolRegistry()), maxSteps: 5 })
    try {
      await agent.run("hi")
      expect.unreachable("should have thrown")
    } catch (err) {
      // Tightening didn't kill the legit overflow detection: `token +
      // maximum + context` still matches.
      const msg = (err as Error).message
      expect(msg).toContain("Context length exceeded after compaction")
      expect(msg).toContain("no smaller valid context")
    }
  })
})

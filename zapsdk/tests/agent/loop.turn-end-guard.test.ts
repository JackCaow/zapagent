import { describe, it, expect } from "bun:test"
import { AgentBudget } from "../../agent/budget.js"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, LLMResponse } from "../../core/types.js"
import type { AgentEvent } from "../../agent/events.js"

/**
 * Counting provider: each call returns a plain-text done chunk with no tool
 * calls, so the agent would normally exit after one step. Tracks how many
 * times `stream()` was invoked so tests can assert the guard-driven extra
 * iteration actually happened.
 */
function makeCountingProvider(): { provider: LLMProvider; calls: () => number } {
  let streamCalls = 0
  return {
    provider: {
      async call(): Promise<LLMResponse> {
        streamCalls++
        return {
          type: "text" as const,
          text: "done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        streamCalls++
        yield { type: "text_delta", text: "done" }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    },
    calls: () => streamCalls,
  }
}

describe("LoopAgent turnEndGuard", () => {
  it("runs an extra iteration when guard returns a continuation", async () => {
    const { provider, calls } = makeCountingProvider()
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })

    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    let guardCalls = 0
    const observations: string[] = []
    agent.on("observation", (evt: AgentEvent) => {
      if (evt.type === "observation") observations.push(evt.kind)
    })

    await agent.run("hi", {
      turnEndGuard: () => {
        guardCalls++
        // Always return a continuation — the one-shot flag in loop.ts
        // should still cap firing at 1.
        return "finish up the plan"
      },
    })

    // First natural finish → guard fires → extra iteration → second natural
    // finish → guard is NOT consulted again (already fired) → turn ends.
    expect(calls()).toBe(2)
    // Guard was consulted exactly once (second finish short-circuits).
    expect(guardCalls).toBe(1)
    // Observation was emitted.
    expect(observations).toContain("turn_end_guard_fired")

    // The synthetic user-role continuation must be in the conversation,
    // sitting between the two assistant replies.
    const msgs = conversation.getMessages()
    const userMsgs = msgs.filter((m) => m.role === "user")
    const synthetic = userMsgs.find((m) =>
      typeof m.content === "string" && m.content.includes("finish up the plan"),
    )
    expect(synthetic).toBeDefined()
  })

  it("ends normally when guard returns null or empty", async () => {
    const { provider, calls } = makeCountingProvider()
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })

    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("hi", {
      turnEndGuard: () => null,
    })

    expect(calls()).toBe(1)
  })

  it("swallows guard exceptions and lets the turn end", async () => {
    const { provider, calls } = makeCountingProvider()
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})

    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      maxSteps: 5,
    })

    await expect(
      agent.run("hi", {
        turnEndGuard: () => {
          throw new Error("guard kaboom")
        },
      }),
    ).resolves.toBeDefined()

    // Guard threw → treated as "no continuation" → single iteration.
    expect(calls()).toBe(1)
  })
})


describe("async turn-end guard bounds", () => {
  it("cancels a hanging guard at the finalization boundary", async () => {
    const { provider, calls } = makeCountingProvider()
    const registry = new ToolRegistry()
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      maxSteps: 5, timeoutMs: 60, forceFinishTimeoutMs: 10, now: () => 0 })
    let guardSignal: AbortSignal | undefined
    const result = await agent.run("hi", { turnEndGuard: (_candidate, signal) => {
      guardSignal = signal
      return new Promise<string>(() => {})
    } })
    expect(result.stopped).toBe("timeout")
    expect(guardSignal?.aborted).toBe(true)
    expect(calls()).toBe(1)
  })

  it("does not request a continuation when no model turns remain", async () => {
    const { provider, calls } = makeCountingProvider()
    const registry = new ToolRegistry()
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 5, budget: new AgentBudget({ maxSteps: 1 }) })
    let guards = 0
    const result = await agent.run("hi", { turnEndGuard: async candidate => {
      expect(candidate.text).toBe("done")
      guards++
      return "verify the missing artifact"
    } })
    expect(calls()).toBe(1)
    expect(guards).toBe(0)
    expect(result.stopped).toBeUndefined()
  })
})

import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { LoopAgent, type LoopAgentOptions } from "../../agent/loop.js"
import { AgentBudget } from "../../agent/budget.js"
import { ContextOverflowError } from "../../core/errors.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js"

/** Provider stub that records the last `opts.maxOutputTokens` it was called
 *  with. Used to assert that LoopAgent's budget planner flows through the
 *  dynamic cap instead of silently using provider defaults. */
function makeRecordingProvider(): {
  provider: LLMProvider
  lastMaxOutputTokens: () => number | undefined
} {
  let lastOpts: { maxOutputTokens?: number } | undefined
  return {
    provider: {
      async call(_msgs, _tools, opts): Promise<LLMResponse> {
        lastOpts = opts as any
        return {
          type: "text" as const,
          text: "ok",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 1 },
        }
      },
      async *stream(_msgs, _tools, opts): AsyncIterable<LLMChunk> {
        lastOpts = opts as any
        yield { type: "text_delta", text: "ok" }
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 1 }, finishReason: "stop" }
      },
    },
    lastMaxOutputTokens: () => lastOpts?.maxOutputTokens,
  }
}

function makeAgent(overrides: Partial<LoopAgentOptions> = {}): LoopAgent {
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry, {})
  const conversation = new ConversationManager({ maxMessages: 100 })
  return new LoopAgent({
    provider: { async call() { throw new Error("not used") } },
    registry,
    executor,
    conversation,
    ...overrides,
  })
}

describe("LoopAgent budget planner", () => {
  describe("constructor limit normalization", () => {
    it("falls back when run-limit options are non-finite", () => {
      const agent = makeAgent({
        maxSteps: Number.NaN,
        maxTokens: Number.NaN,
        reserveSteps: Number.POSITIVE_INFINITY,
        contextWindow: Number.NaN,
        inputTokenLimit: Number.NaN,
        outputTokenCeiling: Number.NaN,
        reservedOutputTokens: Number.NaN,
      }) as any

      expect(agent.maxSteps).toBe(10)
      expect(agent.maxTokens).toBe(Infinity)
      expect(agent.reserveSteps).toBe(2)
      expect(agent.contextWindow).toBeUndefined()
      expect(agent.inputTokenLimit).toBeUndefined()
      expect(agent.outputTokenCeiling).toBeUndefined()
      expect(agent.reservedOutputTokens).toBe(8192)
      expect(agent.computeCallBudget([{ role: "user", content: "hi" }], [])).toBeUndefined()
    })

    it("clamps negative run-limit options to zero", () => {
      const agent = makeAgent({
        maxSteps: -1,
        maxTokens: -1,
        reserveSteps: -1,
        contextWindow: -1,
        inputTokenLimit: -1,
        outputTokenCeiling: -1,
        reservedOutputTokens: -1,
      }) as any

      expect(agent.maxSteps).toBe(0)
      expect(agent.maxTokens).toBe(0)
      expect(agent.reserveSteps).toBe(0)
      expect(agent.contextWindow).toBe(0)
      expect(agent.inputTokenLimit).toBe(0)
      expect(agent.outputTokenCeiling).toBe(0)
      expect(agent.reservedOutputTokens).toBe(0)
      expect(agent.computeCallBudget([{ role: "user", content: "hi" }], [])).toBeUndefined()
    })

    it("floors fractional run-limit options", () => {
      const agent = makeAgent({
        maxSteps: 5.9,
        maxTokens: 100.9,
        reserveSteps: 1.9,
        contextWindow: 2000.9,
        inputTokenLimit: 1800.9,
        outputTokenCeiling: 20.9,
        reservedOutputTokens: 3.9,
      }) as any

      expect(agent.maxSteps).toBe(5)
      expect(agent.maxTokens).toBe(100)
      expect(agent.reserveSteps).toBe(1)
      expect(agent.contextWindow).toBe(2000)
      expect(agent.inputTokenLimit).toBe(1800)
      expect(agent.outputTokenCeiling).toBe(20)
      expect(agent.reservedOutputTokens).toBe(3)
      expect(agent.computeCallBudget([{ role: "user", content: "hi" }], [])).toBe(20)
    })
  })

  describe("computeCallBudget", () => {
    it("returns undefined when contextWindow is not set (legacy path)", () => {
      const agent = makeAgent() as any
      expect(agent.computeCallBudget([{ role: "user", content: "hi" }], [])).toBeUndefined()
    })

    it("returns ceiling when input is small", () => {
      const agent = makeAgent({ contextWindow: 128_000, outputTokenCeiling: 65_536 }) as any
      const result = agent.computeCallBudget([{ role: "user", content: "hi" }], [])
      expect(result).toBe(65_536)
    })

    it("caps below ceiling when input grows", () => {
      const agent = makeAgent({ contextWindow: 128_000, outputTokenCeiling: 65_536 }) as any
      // ~80k tokens of input (280k chars of alphanumeric)
      const msgs: Message[] = [{ role: "user", content: "x".repeat(280_000) }]
      const result = agent.computeCallBudget(msgs, []) as number
      expect(result).toBeLessThan(65_536)
      expect(result).toBeGreaterThan(8_192) // still well above reserved floor
    })

    it("throws ContextOverflowError when remaining falls below reservedOutputTokens", () => {
      const agent = makeAgent({
        contextWindow: 128_000,
        outputTokenCeiling: 65_536,
        reservedOutputTokens: 8_192,
      }) as any
      const msgs: Message[] = [{ role: "user", content: "x".repeat(500_000) }] // ~140k tokens
      expect(() => agent.computeCallBudget(msgs, [])).toThrow(ContextOverflowError)
    })

    it("enforces a separate prompt input limit", () => {
      const agent = makeAgent({
        contextWindow: 128_000,
        inputTokenLimit: 20_000,
        outputTokenCeiling: 8_192,
        reservedOutputTokens: 4_096,
      }) as any
      agent.budgetTokenCounter = {
        countMessages: () => 19_001,
        countText: () => 0,
      }

      expect(() => agent.computeCallBudget([{ role: "user", content: "hi" }], []))
        .toThrow(ContextOverflowError)
    })

    it("ContextOverflowError carries input/reserved/contextWindow fields", () => {
      const agent = makeAgent({
        contextWindow: 128_000,
        outputTokenCeiling: 65_536,
        reservedOutputTokens: 8_192,
      }) as any
      const msgs: Message[] = [{ role: "user", content: "x".repeat(500_000) }]
      try {
        agent.computeCallBudget(msgs, [])
        throw new Error("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ContextOverflowError)
        const e = err as ContextOverflowError
        expect(e.contextWindow).toBe(128_000)
        expect(e.reservedOutput).toBe(8_192)
        expect(e.inputTokens).toBeGreaterThan(120_000)
      }
    })

    it("tools contribute to input token count", () => {
      const agent = makeAgent({ contextWindow: 128_000, outputTokenCeiling: 65_536 }) as any
      // Input already near ceiling so tool schema pushes output below it.
      const msgs: Message[] = [{ role: "user", content: "x".repeat(200_000) }] // ~57k tokens
      const tool = {
        name: "test_tool",
        description: "x".repeat(60_000), // ~17k extra tokens
        parameters: z.object({ q: z.string() }),
      }
      const withoutTools = agent.computeCallBudget(msgs, []) as number
      const withTools = agent.computeCallBudget(msgs, [tool]) as number
      expect(withTools).toBeLessThan(withoutTools)
    })

    it("canonicalizes raw tool schemas before estimating input token budget", () => {
      const agent = makeAgent({ contextWindow: 128_000, outputTokenCeiling: 65_536 }) as any
      let toolsJson = ""
      agent.budgetTokenCounter = {
        countMessages: () => 0,
        countText: (text: string) => {
          toolsJson = text
          return 1
        },
      }
      const tool = {
        name: "write_file",
        description: "write a file",
        parameters: z.object({}),
        rawSchema: {
          type: "object",
          zLast: true,
          required: ["path", "content"],
          properties: {
            path: { type: "string", enum: ["z", "a"] },
            content: { type: ["string", "null"] },
            choice: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
      }

      agent.computeCallBudget([{ role: "user", content: "hi" }], [tool])

      const parameters = JSON.parse(toolsJson)[0].parameters
      expect(Object.keys(parameters)).toEqual(["properties", "required", "type", "zLast"])
      expect(Object.keys(parameters.properties)).toEqual(["choice", "content", "path"])
      expect(parameters.properties.choice.anyOf).toEqual([{ type: "number" }, { type: "string" }])
      expect(parameters.properties.content.type).toEqual(["null", "string"])
      expect(parameters.properties.path.enum).toEqual(["a", "z"])
      expect(parameters.required).toEqual(["content", "path"])
    })

    it("outputTokenCeiling defaults to safe 8192 when only contextWindow set", () => {
      const agent = makeAgent({ contextWindow: 200_000 }) as any
      expect(agent.computeCallBudget([{ role: "user", content: "hi" }], [])).toBe(8_192)
    })

    it("reservedOutputTokens is configurable", () => {
      const agent = makeAgent({
        contextWindow: 128_000,
        outputTokenCeiling: 65_536,
        reservedOutputTokens: 32_000, // aggressive floor
      }) as any
      // Input at ~100k tokens → remaining = 128k - 100k - 1k = 27k, below 32k floor
      const msgs: Message[] = [{ role: "user", content: "x".repeat(350_000) }]
      expect(() => agent.computeCallBudget(msgs, [])).toThrow(ContextOverflowError)
    })
  })

  describe("integration — maxOutputTokens reaches provider", () => {
    it("provider receives budget-capped maxOutputTokens via opts", async () => {
      const { provider, lastMaxOutputTokens } = makeRecordingProvider()
      const registry = new ToolRegistry()
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 1,
        contextWindow: 128_000,
        outputTokenCeiling: 65_536,
      })
      await agent.run("hi")
      expect(lastMaxOutputTokens()).toBe(65_536)
    })

    it("provider receives undefined maxOutputTokens when budget planning disabled", async () => {
      const { provider, lastMaxOutputTokens } = makeRecordingProvider()
      const registry = new ToolRegistry()
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 1,
        // NO contextWindow → budget planning off
      })
      await agent.run("hi")
      expect(lastMaxOutputTokens()).toBeUndefined()
    })

    it("uses reactive compaction when local budget overflows and autocompact cannot summarize", async () => {
      const streamMessages: Message[][] = []
      const hugeInput = `BEGIN ${"x".repeat(80_000)} END`
      const provider: LLMProvider = {
        async call(): Promise<LLMResponse> {
          throw new Error("summarizer unavailable")
        },
        async *stream(messages): AsyncIterable<LLMChunk> {
          streamMessages.push(messages)
          yield { type: "text_delta", text: "recovered" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }
        },
      }
      const registry = new ToolRegistry()
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 1,
        contextWindow: 20_000,
        reservedOutputTokens: 1_000,
        outputTokenCeiling: 1_000,
      })

      const result = await agent.run(hugeInput)

      expect(result.text).toBe("recovered")
      expect(streamMessages).toHaveLength(1)
      const sentUser = streamMessages[0].find((m) => m.role === "user" && m.content.includes("BEGIN"))
      expect(sentUser?.content).toContain("chars compacted to fit context limit")
      expect(sentUser?.content).toContain("END")
      expect(sentUser?.content).not.toBe(hugeInput)
      const persistedUser = conversation.getMessages().find((m) => m.role === "user" && m.content.includes("BEGIN"))
      expect(persistedUser?.content).toContain("chars compacted to fit context limit")
    })

    it("reactively compacts oversized transient context without persisting it", async () => {
      const streamMessages: Message[][] = []
      const hugeContext = `<system-context>\nBEGIN ${"x".repeat(80_000)} END\n</system-context>`
      const provider: LLMProvider = {
        async call(): Promise<LLMResponse> {
          throw new Error("summarizer unavailable")
        },
        async *stream(messages): AsyncIterable<LLMChunk> {
          streamMessages.push(messages)
          yield { type: "text_delta", text: "recovered" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }
        },
      }
      const registry = new ToolRegistry()
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 1,
        contextWindow: 20_000,
        reservedOutputTokens: 1_000,
        outputTokenCeiling: 1_000,
      })

      const result = await agent.run("short request", {
        contextPrefix: () => hugeContext,
      })

      expect(result.text).toBe("recovered")
      expect(streamMessages).toHaveLength(1)
      // Stable run context now sits immediately before the current user turn
      // so its position remains cacheable across tool steps.
      const sentContext = streamMessages[0].find((message) =>
        message.cache?.transient && message.content.includes("system-context")
      )
      expect(sentContext?.content).toContain("chars compacted to fit context limit")
      expect(sentContext?.content).toContain("END")
      expect(sentContext?.cache?.transient).toBe(true)
      expect(conversation.getMessages().some((m) => m.content.includes("system-context"))).toBe(false)
    })
  })

  describe("integration — cached prompt tokens count toward token budgets", () => {
    it("maxTokens stop condition includes cache read/write prompt tokens", async () => {
      let streamCalls = 0
      const provider: LLMProvider = {
        async call(): Promise<LLMResponse> {
          return {
            type: "text",
            text: "forced summary",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
        async *stream(): AsyncIterable<LLMChunk> {
          streamCalls++
          yield { type: "tool_call_start", toolCallId: "t1", toolName: "bash" }
          yield { type: "tool_call_delta", toolCallId: "t1", partialJson: JSON.stringify({ command: "echo hi" }) }
          yield {
            type: "done",
            usage: {
              inputTokens: 1,
              cacheReadInputTokens: 80,
              cacheCreationInputTokens: 10,
              outputTokens: 1,
            },
            finishReason: "tool_calls",
          }
        },
      }
      const registry = new ToolRegistry()
      registry.register({
        definition: { name: "bash", description: "fake", parameters: z.object({ command: z.string() }) },
        handler: async () => ({ success: true, output: "ok" }),
      })
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 10,
        maxTokens: 50,
      })

      const result = await agent.run("run once")

      expect(streamCalls).toBe(1)
      expect(result.stopped).toBe("max_tokens")
      expect(result.text).toContain("completion remains unverified")
      expect(conversation.getMessages().at(-1)).toMatchObject({
        role: "assistant",
        content: result.text,
      })
    })

    it("shared AgentBudget token accounting includes cached prompt tokens", async () => {
      const budget = new AgentBudget({ maxSteps: 10, maxTokens: 0 })
      const provider: LLMProvider = {
        async call(): Promise<LLMResponse> {
          return {
            type: "text",
            text: "ok",
            toolCalls: [],
            usage: { inputTokens: 2, cacheReadInputTokens: 40, outputTokens: 3 },
          }
        },
      }
      const registry = new ToolRegistry()
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 1,
        budget,
      })

      await agent.run("hi")

      expect(budget.tokensUsed).toBe(45)
    })

    it("shared AgentBudget token cap stops after the current tool step without another model call", async () => {
      let streamCalls = 0
      let toolRuns = 0
      const budget = new AgentBudget({ maxSteps: 10, maxTokens: 50 })
      const provider: LLMProvider = {
        async call(): Promise<LLMResponse> {
          throw new Error("force-finish should not run after shared token budget exhaustion")
        },
        async *stream(): AsyncIterable<LLMChunk> {
          streamCalls++
          yield { type: "tool_call_start", toolCallId: "t1", toolName: "bash" }
          yield { type: "tool_call_delta", toolCallId: "t1", partialJson: JSON.stringify({ command: "echo hi" }) }
          yield {
            type: "done",
            usage: {
              inputTokens: 1,
              cacheReadInputTokens: 80,
              cacheCreationInputTokens: 10,
              outputTokens: 1,
            },
            finishReason: "tool_calls",
          }
        },
      }
      const registry = new ToolRegistry()
      registry.register({
        definition: { name: "bash", description: "fake", parameters: z.object({ command: z.string() }) },
        handler: async () => {
          toolRuns++
          return { success: true, output: "ok" }
        },
      })
      const executor = new ToolExecutor(registry, {})
      const conversation = new ConversationManager({ maxMessages: 100 })
      const agent = new LoopAgent({
        provider,
        registry,
        executor,
        conversation,
        maxSteps: 10,
        budget,
      })

      const result = await agent.run("run once")

      expect(streamCalls).toBe(1)
      expect(toolRuns).toBe(1)
      expect(result.toolResults.length).toBe(1)
      expect(result.stopped).toBe("budget")
      expect(result.text).toContain("Token budget exhausted")
      expect(budget.tokensUsed).toBe(92)
    })
  })

  describe("makeFriendlyOverflowError", () => {
    it("replaces developer-oriented message with user-facing hint", () => {
      const agent = makeAgent({ contextWindow: 128_000 }) as any
      const original = new ContextOverflowError({
        inputTokens: 125_000,
        reservedOutput: 8_192,
        contextWindow: 128_000,
      })
      const friendly = agent.makeFriendlyOverflowError(original) as Error
      expect(friendly.message).toContain("too long")
      expect(friendly.message).toContain("/new")
      expect(friendly.message).not.toContain("reserved output") // developer-speak gone
    })

    it("wraps non-typed errors too", () => {
      const agent = makeAgent({ contextWindow: 128_000 }) as any
      const original = new Error("prompt too long for model context")
      const friendly = agent.makeFriendlyOverflowError(original) as Error
      expect(friendly.message).toContain("/new")
      expect(friendly.message).toContain("prompt too long for model context")
    })
  })
})

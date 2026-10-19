import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, LLMResponse } from "../../core/types.js"

/**
 * Mock provider that streams thinking deltas, then signals that the caller
 * should abort before emitting a tool call. Used to reproduce the real-world
 * flow where the user hits Ctrl+C mid-thought.
 */
function makeAbortMidStreamProvider(controller: AbortController): LLMProvider {
  return {
    async call(): Promise<LLMResponse> {
      throw new Error("stream-only provider")
    },
    async *stream(): AsyncIterable<LLMChunk> {
      yield { type: "thinking_delta", text: "I'll use python-pptx library" }
      yield { type: "thinking_delta", text: " to create a PowerPoint file." }
      // User hits Ctrl+C here, before the model emits a tool_call.
      controller.abort()
      yield { type: "thinking_delta", text: " Let me check the library..." }
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }
    },
  }
}

describe("LoopAgent abort recovery", () => {
  it("atomically commits a native tool turn when aborted during execution", async () => {
    const controller = new AbortController()
    let markToolStarted!: () => void
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve })
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("stream-only provider")
      },
      async *stream(): AsyncIterable<LLMChunk> {
        yield { type: "text_delta", text: "Writing the marker." }
        yield { type: "tool_call_start", toolCallId: "write_1", toolName: "write_marker" }
        yield { type: "tool_call_delta", toolCallId: "write_1", partialJson: `{"value":"started"}` }
        await toolStarted
        controller.abort()
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        name: "write_marker",
        description: "test write",
        parameters: z.object({ value: z.string() }),
      },
      handler: async (_args, signal) => {
        markToolStarted()
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
        }
        return { success: false, output: "", error: "aborted" }
      },
    })
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

    let caught: Error | null = null
    try {
      await agent.run("write it", { signal: controller.signal })
    } catch (error) {
      caught = error as Error
    }

    expect(caught?.message).toBe("aborted")
    const messages = conversation.getMessages()
    const assistant = messages.find((message) =>
      message.role === "assistant" && message.toolCalls?.some((call) => call.id === "write_1"))
    const result = messages.find((message) =>
      message.role === "tool_result" && message.toolCallId === "write_1")
    expect(assistant?.content).toBe("Writing the marker.")
    expect(result?.content).toContain("aborted")
    expect(messages.some((message) =>
      message.role === "user" && message.content === "[Request interrupted by user]"),
    ).toBe(true)
  })

  it("persists interrupted thinking into conversation so next turn can resume", async () => {
    const controller = new AbortController()
    const provider = makeAbortMidStreamProvider(controller)
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

    let caught: Error | null = null
    try {
      await agent.run("开始做 ppt 吧", { signal: controller.signal })
    } catch (e) {
      caught = e as Error
    }

    expect(caught?.message).toBe("aborted")

    const messages = conversation.getMessages()

    // User message must be there (added by initMessages).
    expect(messages.some((m) => m.role === "user" && m.content === "开始做 ppt 吧")).toBe(true)

    // Root-cause check: there must be an assistant message capturing what the
    // model was doing before interruption. Without this, the next "continue"
    // turn would see user→user with no assistant reply and the model would
    // re-plan from scratch.
    const resumeMsg = messages.find(
      (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("python-pptx"),
    )
    expect(resumeMsg).toBeTruthy()
  })

  it("does not split non-BMP characters when truncating interrupted thinking", async () => {
    const controller = new AbortController()
    const emoji = String.fromCodePoint(0x1f600)
    const interruptedThinking = `${"a".repeat(399)}${emoji}tail`
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        throw new Error("stream-only provider")
      },
      async *stream(): AsyncIterable<LLMChunk> {
        yield { type: "thinking_delta", text: interruptedThinking }
        controller.abort()
        yield { type: "thinking_delta", text: " ignored after abort" }
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
      systemPrompt: "test",
      maxSteps: 5,
    })

    let caught: Error | null = null
    try {
      await agent.run("start", { signal: controller.signal })
    } catch (e) {
      caught = e as Error
    }

    expect(caught?.message).toBe("aborted")
    const resumeMsg = conversation.getMessages().find(
      (m) => m.role === "assistant" && m.content.includes("Interrupted mid-thought"),
    )
    expect(resumeMsg).toBeTruthy()
    expect(resumeMsg!.content).toContain("…")
    expect(hasUnpairedSurrogate(resumeMsg!.content)).toBe(false)
  })

  it("passes the run AbortSignal to non-streaming providers", async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const provider: LLMProvider = {
      async call(_messages, _tools, opts): Promise<LLMResponse> {
        seenSignal = opts?.signal
        return {
          type: "text",
          text: "ok",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 1 },
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
      systemPrompt: "test",
      maxSteps: 1,
    })

    await agent.run("hi", { signal: controller.signal })

    expect(seenSignal).toBe(controller.signal)
  })

  it("keeps force-finish cancellable and applies the dynamic output budget", async () => {
    const controller = new AbortController()
    let forceSignal: AbortSignal | undefined
    let forceMaxOutputTokens: number | undefined
    let finishInstruction = ""
    const provider: LLMProvider = {
      async call(messages, tools, opts): Promise<LLMResponse> {
        expect(tools).toEqual([])
        forceSignal = opts?.signal
        forceMaxOutputTokens = opts?.maxOutputTokens
        finishInstruction = messages.at(-1)?.content ?? ""
        controller.abort(new Error("user cancelled during force-finish"))
        throw new Error("transport aborted")
      },
      async *stream(): AsyncIterable<LLMChunk> {
        yield { type: "tool_call_start", toolCallId: "read_1", toolName: "read_once" }
        yield { type: "tool_call_delta", toolCallId: "read_1", partialJson: "{}" }
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "tool_use" }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        name: "read_once",
        description: "test read",
        parameters: z.object({}),
        readOnly: true,
      },
      handler: async () => ({ success: true, output: "done" }),
    })
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 1,
      contextWindow: 128_000,
      outputTokenCeiling: 1_024,
      reservedOutputTokens: 128,
    })

    let caught: Error | null = null
    try {
      await agent.run("read once", { signal: controller.signal })
    } catch (error) {
      caught = error as Error
    }

    expect(caught?.message).toBe("aborted")
    expect(forceSignal).toBeDefined()
    expect(forceSignal?.aborted).toBe(true)
    expect(forceMaxOutputTokens).toBe(1_024)
    expect(finishInstruction).toContain("step limit")
    expect(conversation.getMessages().some((message) =>
      message.role === "user" && message.content === "[Request interrupted by user]",
    )).toBe(true)
  })

  it("bounds force-finish when a provider ignores its abort signal", async () => {
    let finishSignal: AbortSignal | undefined
    let finishSignalObservedAbort = false
    const provider: LLMProvider = {
      async call(_messages, tools, opts): Promise<LLMResponse> {
        expect(tools).toEqual([])
        finishSignal = opts?.signal
        finishSignal?.addEventListener("abort", () => {
          finishSignalObservedAbort = true
        }, { once: true })
        return new Promise<LLMResponse>(() => {})
      },
      async *stream(): AsyncIterable<LLMChunk> {
        yield { type: "tool_call_start", toolCallId: "read_1", toolName: "read_once" }
        yield { type: "tool_call_delta", toolCallId: "read_1", partialJson: "{}" }
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "tool_use" }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        name: "read_once",
        description: "test read",
        parameters: z.object({}),
        readOnly: true,
      },
      handler: async () => ({ success: true, output: "done" }),
    })
    const executor = new ToolExecutor(registry, {})
    let timeoutObservation: { reason?: unknown; timeoutMs?: unknown } | undefined
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      systemPrompt: "test",
      maxSteps: 1,
      forceFinishTimeoutMs: 15,
    })
    agent.on("observation", (event) => {
      if (event.type === "observation" && event.kind === "force_finish_timeout") {
        timeoutObservation = event.detail
      }
    })

    const startedAt = performance.now()
    const result = await agent.run("read once")
    const elapsedMs = performance.now() - startedAt

    expect(result.stopped).toBe("max_steps")
    expect(finishSignal).toBeDefined()
    expect(finishSignal?.aborted).toBe(true)
    expect(finishSignalObservedAbort).toBe(true)
    expect(timeoutObservation).toEqual({ reason: "max_steps", timeoutMs: 15 })
    expect(elapsedMs).toBeLessThan(1_000)
  })

  it("cancels fallback non-streaming tool execution through the run signal", async () => {
    const controller = new AbortController()
    let handlerSignal: AbortSignal | undefined
    let handlerObservedAbort = false
    let markToolStarted: (() => void) | undefined
    let releaseMissingSignal: (() => void) | undefined
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve
    })
    const missingSignalGate = new Promise<void>((resolve) => {
      releaseMissingSignal = resolve
    })
    const primary: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return {
          type: "text",
          text: "fallback work summarized",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        throw new Error("primary unavailable")
      },
    }
    const fallback: LLMProvider = {
      async call(_messages, _tools, opts): Promise<LLMResponse> {
        expect(opts?.signal).toBe(controller.signal)
        return {
          type: "tool_call",
          text: "",
          toolCalls: [{ id: "fallback_1", name: "fallback_tool", arguments: {} }],
          usage: { inputTokens: 4, outputTokens: 2 },
          finishReason: "tool_use",
        }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        name: "fallback_tool",
        description: "test fallback tool",
        parameters: z.object({}),
      },
      handler: async (_args, signal) => {
        handlerSignal = signal
        markToolStarted?.()
        if (!signal) {
          await missingSignalGate
          return { success: true, output: "fallback tool completed without cancellation" }
        }
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }
        handlerObservedAbort = signal.aborted
        return { success: false, output: "", error: "aborted" }
      },
    })
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: primary,
      fallbackProvider: fallback,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 1,
    })

    const run = agent.run("use fallback", { signal: controller.signal })
    await toolStarted
    controller.abort(new Error("user cancelled fallback tool"))
    releaseMissingSignal?.()

    await expect(run).rejects.toThrow("aborted")
    expect(handlerSignal).toBeDefined()
    expect(handlerObservedAbort).toBe(true)
    expect(conversation.getMessages().some((message) =>
      message.role === "user" && message.content === "[Request interrupted by user]",
    )).toBe(true)
  })
})

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

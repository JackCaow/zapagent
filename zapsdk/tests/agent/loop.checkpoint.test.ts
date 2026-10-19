import { describe, it, expect } from "bun:test"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js"

/**
 * Minimal stub provider that immediately yields a done chunk with no tool
 * calls, causing the agent to finish in a single step with empty text.
 * forceFinish then issues a .call() — stub it to return empty text too.
 */
function makeInstantFinishProvider(): LLMProvider {
  return {
    async call(): Promise<LLMResponse> {
      return {
        type: "text" as const,
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
    async *stream(): AsyncIterable<LLMChunk> {
      yield { type: "text_delta", text: "done" }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

function makeRecordingStreamProvider(calls: Message[][]): LLMProvider {
  return {
    async call(): Promise<LLMResponse> {
      throw new Error("stream expected")
    },
    async *stream(messages): AsyncIterable<LLMChunk> {
      calls.push(messages.map((message) => ({ ...message })))
      yield { type: "text_delta", text: "done" }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

describe("LoopAgent onRunEnd hook", () => {
  it("fires onRunEnd with turnStartIndex equal to conversation length at run start", async () => {
    const calls: Array<{ turnStartIndex: number; sessionId: string }> = []

    const provider = makeInstantFinishProvider()
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
      sessionId: "sess-test",
      onRunEnd: async (ctx) => {
        calls.push(ctx)
      },
    })

    // First run: conversation is empty. ensureSessionSystemPrompt adds the
    // system prompt BEFORE turnStartIndex is captured, so turnStartIndex=1
    // (points to this turn's first message, not to the persistent system
    // prompt — so rewind can revert the turn without dropping the system).
    await agent.run("hi")

    expect(calls.length).toBe(1)
    expect(calls[0].sessionId).toBe("sess-test")
    expect(calls[0].turnStartIndex).toBe(1)

    // Second run: turnStartIndex = current length (no new session system
    // prompt added because one is already present).
    const afterFirstRun = conversation.getMessages().length
    expect(afterFirstRun).toBeGreaterThan(0)

    await agent.run("again")

    expect(calls.length).toBe(2)
    expect(calls[1].sessionId).toBe("sess-test")
    expect(calls[1].turnStartIndex).toBe(afterFirstRun)
    expect(calls[1].turnStartIndex).toBeGreaterThan(calls[0].turnStartIndex)
  })

  it("uses the full backing history for turnStartIndex when provider view is truncated", async () => {
    const calls: Array<{ turnStartIndex: number; sessionId: string }> = []
    const conversation = new ConversationManager({
      maxMessages: 3,
      maxTokens: 1_000_000,
      triggerAtTokens: 1,
      autoCompress: true,
    })
    for (let i = 0; i < 8; i++) {
      conversation.add({ role: "user", content: `historic ${i}` })
    }
    expect(conversation.getMessages()).toHaveLength(3)
    expect(conversation.getAllMessages()).toHaveLength(8)

    const agent = new LoopAgent({
      provider: makeInstantFinishProvider(),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "system",
      maxSteps: 5,
      sessionId: "sess-truncated",
      onRunEnd: async (ctx) => {
        calls.push(ctx)
      },
    })

    await agent.run("fresh")

    expect(calls).toHaveLength(1)
    // ensureSessionSystemPrompt adds one system turn before capturing the
    // snapshot boundary, so the full pre-turn history is 8 + 1.
    expect(calls[0].turnStartIndex).toBe(9)
  })

  it("detects prior user turns from full history before deciding protocol injection", async () => {
    const calls: Message[][] = []
    const conversation = new ConversationManager({
      maxMessages: 2,
      maxTokens: 1_000_000,
      triggerAtTokens: 1,
      autoCompress: true,
    })
    conversation.add({ role: "user", content: "prior user" })
    conversation.add({ role: "assistant", content: "assistant 1" })
    conversation.add({ role: "assistant", content: "assistant 2" })
    conversation.add({ role: "assistant", content: "assistant 3" })
    expect(conversation.getMessages().some((m) => m.role === "user")).toBe(false)
    expect(conversation.getAllMessages().some((m) => m.role === "user")).toBe(true)

    const agent = new LoopAgent({
      provider: makeRecordingStreamProvider(calls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "",
      maxSteps: 5,
    })

    await agent.run("fresh")

    expect(calls).toHaveLength(1)
    expect(calls[0].some((m) => m.content.includes("[AGENT PROTOCOL]"))).toBe(false)
    expect(calls[0].at(-1)?.content).toBe("fresh")
  })

  it("updates the persisted session system prompt when a later run rebuilds it", async () => {
    const calls: Message[][] = []
    const provider = makeRecordingStreamProvider(calls)
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })

    const firstAgent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "system prompt v1",
      maxSteps: 5,
    })
    await firstAgent.run("hi")

    const secondAgent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "system prompt v2",
      maxSteps: 5,
    })
    await secondAgent.run("again")

    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toMatchObject({ role: "system" })
    expect(calls[0][0].content).toContain("system prompt v1")
    expect(calls[1][0]).toMatchObject({ role: "system" })
    expect(calls[1][0].content).toContain("system prompt v2")
    expect(calls[1][0].content).not.toContain("system prompt v1")

    const persistedSystemMessages = conversation.getMessages().filter((m) => m.role === "system")
    expect(persistedSystemMessages).toHaveLength(1)
    expect(persistedSystemMessages[0].content).toContain("system prompt v2")
    expect(persistedSystemMessages[0].content).not.toContain("system prompt v1")
  })

  it("preserves non-leading historical system turns when rebuilding the session system prompt", async () => {
    const calls: Message[][] = []
    const conversation = new ConversationManager({ maxMessages: 100 })
    conversation.add({ role: "system", content: "old leading system" })
    conversation.add({ role: "user", content: "old user request" })
    conversation.add({ role: "system", content: "late system note should stay historical" })
    conversation.add({ role: "user", content: "latest historical user" })

    const agent = new LoopAgent({
      provider: makeRecordingStreamProvider(calls),
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry(), {}),
      conversation,
      systemPrompt: "new session system",
      maxSteps: 5,
    })

    await agent.run("fresh")

    expect(calls).toHaveLength(1)
    const sent = calls[0].map((m) => `${m.role}:${m.content}`)
    expect(sent[0]).toContain("system:new session system")
    expect(sent.slice(1)).toEqual([
      "user:old user request",
      "system:late system note should stay historical",
      "user:latest historical user",
      "user:fresh",
    ])

    const persisted = conversation.getAllMessages().map((m) => `${m.role}:${m.content}`)
    expect(persisted[0]).toContain("system:new session system")
    expect(persisted).toContain("system:late system note should stay historical")
    expect(persisted.indexOf("user:old user request"))
      .toBeLessThan(persisted.indexOf("system:late system note should stay historical"))
  })

  it("swallows errors thrown by onRunEnd and still emits run_ended", async () => {
    const provider = makeInstantFinishProvider()
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})

    const runEndedEvents: unknown[] = []

    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      maxSteps: 5,
      onRunEnd: async () => {
        throw new Error("checkpoint failure")
      },
    })

    agent.on("run_ended", (evt) => runEndedEvents.push(evt))

    // Should not throw despite onRunEnd throwing.
    await expect(agent.run("hi")).resolves.toBeDefined()
    expect(runEndedEvents.length).toBe(1)
  })
})

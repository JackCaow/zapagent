import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { LoopAgent, type SteeringInput, type LoopAgentOptions } from "../../agent/loop.js"
import { AgentBudget } from "../../agent/budget.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, Message } from "../../core/types.js"

function harness(provider: LLMProvider, maxSteps = 8, registry = new ToolRegistry(), options: Partial<LoopAgentOptions> = {}) {
  const conversation = new ConversationManager({ maxMessages: 200 })
  const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, {}), conversation, systemPrompt: "test", maxSteps,
    budget: new AgentBudget({ maxSteps }), ...options })
  return { agent, conversation }
}
const done = { type: "text" as const, text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
function assertPairs(messages: Message[]) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (!message.toolCalls?.length) continue
    const results = messages.slice(i + 1, i + 1 + message.toolCalls.length)
    expect(results.every(result => result.role === "tool_result")).toBe(true)
    expect(new Set(results.map(result => result.toolCallId))).toEqual(new Set(message.toolCalls.map(call => call.id)))
  }
}

describe("LoopAgent canonical input receipts and safe Steering", () => {
  it("acknowledges initial input only after it is committed, even if the API fails", async () => {
    const { agent, conversation } = harness({ call: async () => { throw new Error("provider down") } })
    let received = 0
    await expect(agent.run("real input", { onInputAccepted: () => {
      expect(conversation.getMessages().some(message => message.role === "user" && message.content === "real input")).toBe(true)
      received++
    } })).rejects.toThrow("provider down")
    expect(received).toBe(1)
  })

  it("accepts Steering after all parallel native tool results, with images and raw sidecars preserved", async () => {
    const pending: SteeringInput[] = []
    const requests: Message[][] = []
    let toolsFinished = 0, calls = 0
    const registry = new ToolRegistry()
    registry.register({ definition: { name: "inspect", description: "test", parameters: z.object({ n: z.number() }) },
      handler: async () => {
        if (!toolsFinished) pending.push({ id: "live", text: "change direction", images: [{ type: "image", filePath: "/tmp/test.png", mediaType: "image/png", source: "test", base64: "AQ==" }] })
        toolsFinished++
        return { success: true, output: "observed" }
      } })
    const provider: LLMProvider = {
      call: async () => done,
      async *stream(messages): AsyncIterable<LLMChunk> {
        requests.push(structuredClone(messages)); calls++
        if (calls === 1) {
          for (const n of [1, 2, 3]) {
            yield { type: "tool_call_start", toolCallId: `t${n}`, toolName: "inspect" }
            yield { type: "tool_call_delta", toolCallId: `t${n}`, partialJson: JSON.stringify({ n }) }
          }
          yield { type: "done", finishReason: "tool_calls", usage: done.usage, raw: { reasoning_content: "sidecar" } }
        } else { yield { type: "text_delta", text: "done" }; yield { type: "done", usage: done.usage } }
      },
    }
    const { agent, conversation } = harness(provider, 8, registry)
    let received = 0
    await agent.run("original", { hasSteering: () => pending.length > 0, takeSteering: () => pending.shift(),
      onSteeringAccepted: input => {
        expect(input.id).toBe("live")
        expect(toolsFinished).toBe(3)
        assertPairs(conversation.getMessages())
        received++
      } })
    expect(received).toBe(1)
    expect(calls).toBe(2)
    assertPairs(requests[1]!)
    expect(requests[1]!.find(message => message.toolCalls)?.raw).toEqual({ reasoning_content: "sidecar" })
    expect(requests[1]!.find(message => message.content === "change direction")?.contentBlocks?.[1]).toMatchObject({ type: "image", base64: "AQ==" })
  })

  it("continues the same run when a Steer arrives while final output streams", async () => {
    const pending: SteeringInput[] = []
    let calls = 0, starts = 0
    const provider: LLMProvider = { call: async () => done,
      async *stream(): AsyncIterable<LLMChunk> {
        calls++
        yield { type: "text_delta", text: `answer ${calls}` }
        if (calls === 1) pending.push({ id: "during-final", text: "one more detail" })
        yield { type: "done", usage: done.usage }
      } }
    const { agent, conversation } = harness(provider)
    agent.on("run_started", () => { starts++ })
    await agent.run("original", { hasSteering: () => pending.length > 0, takeSteering: () => pending.shift() })
    expect(starts).toBe(1)
    expect(calls).toBe(2)
    expect(conversation.getMessages().filter(message => message.role === "user").map(message => message.content)).toEqual(["original", "one more detail"])
  })

  it("does not claim a pending Steer beyond the current run's model budget", async () => {
    const pending: SteeringInput[] = []
    let claims = 0, calls = 0
    const { agent, conversation } = harness({ call: async () => done,
      async *stream(): AsyncIterable<LLMChunk> {
        calls++
        yield { type: "text_delta", text: "answer" }
        pending.push({ id: "after-budget", text: "pending direction" })
        yield { type: "done", usage: done.usage }
      } }, 1)
    const result = await agent.run("original", { hasSteering: () => pending.length > 0,
      takeSteering: () => { const input = pending.shift(); if (input) claims++; return input } })
    expect(result.stopped).toBe("budget")
    expect(calls).toBe(1)
    expect(claims).toBe(0)
    expect(pending).toHaveLength(1)
    expect(conversation.getMessages().some(message => message.content === "pending direction")).toBe(false)
  })

  it("deduplicates a repeated delivery ID without discarding its receipt", async () => {
    const pending = [{ id: "same", text: "direction" }, { id: "same", text: "direction" }]
    const { agent, conversation } = harness({ call: async () => done })
    let receipts = 0
    await agent.run("original", { takeSteering: () => pending.shift(), onSteeringAccepted: () => { receipts++ } })
    expect(receipts).toBe(2)
    expect(conversation.getMessages().filter(message => message.content === "direction")).toHaveLength(1)
  })

  it("does not claim Steering after cancellation", async () => {
    const controller = new AbortController()
    const { agent, conversation } = harness({ call: async () => done })
    let claims = 0
    await expect(agent.run("original", { signal: controller.signal, onInputAccepted: () => controller.abort(),
      takeSteering: () => { claims++; return { id: "pending", text: "should remain queued" } } })).rejects.toThrow("aborted")
    expect(claims).toBe(0)
    expect(conversation.getMessages().some(message => message.content === "should remain queued")).toBe(false)
  })

  it("does not continue final-output Steering beyond maxTokens", async () => {
    const pending: SteeringInput[] = []
    let calls = 0, claims = 0
    const { agent, conversation } = harness({ call: async () => done,
      async *stream(): AsyncIterable<LLMChunk> {
        calls++
        yield { type: "text_delta", text: "answer" }
        pending.push({ id: "too-late", text: "pending direction" })
        yield { type: "done", usage: { inputTokens: 2, outputTokens: 2 } }
      } }, 8, new ToolRegistry(), { maxTokens: 3 })
    const result = await agent.run("original", { hasSteering: () => pending.length > 0,
      takeSteering: () => { const input = pending.shift(); if (input) claims++; return input } })
    expect(result.stopped).toBe("max_tokens")
    expect(calls).toBe(1)
    expect(claims).toBe(0)
    expect(pending).toHaveLength(1)
    expect(conversation.getAllMessages().some(message => message.content === "pending direction")).toBe(false)
  })

  for (const interrupted of ["cancel", "deadline"] as const) {
    it(`does not acknowledge Steering after ${interrupted} during auto-compaction`, async () => {
      const pending: SteeringInput[] = [{ id: "pending", text: "pending direction" }]
      const controller = new AbortController()
      let now = 0, claims = 0, receipts = 0, calls = 0, compacts = 0
      const { agent, conversation } = harness({ call: async () => done,
        async *stream(): AsyncIterable<LLMChunk> { calls++; yield { type: "done", usage: done.usage } } }, 8,
        new ToolRegistry(), { autoCompactThreshold: 1, timeoutMs: 1000, forceFinishTimeoutMs: 200, now: () => now,
          summarizer: { call: async () => {
            compacts++
            if (interrupted === "cancel") controller.abort()
            else now = 1001
            throw new Error("summarizer interrupted")
          } } })
      for (let i = 0; i < 30; i++) conversation.add({ role: i % 2 ? "assistant" : "user", content: `history ${i} ${"x".repeat(100)}` })
      const run = agent.run("original", { signal: controller.signal,
        takeSteering: () => { claims++; return pending.shift() }, onSteeringAccepted: () => { receipts++ } })
      if (interrupted === "cancel") await expect(run).rejects.toThrow("aborted")
      else expect((await run).stopped).toBe("timeout")
      expect(compacts).toBe(1)
      expect(calls).toBe(0)
      expect(claims).toBe(0)
      expect(receipts).toBe(0)
      expect(pending).toHaveLength(1)
      expect(conversation.getAllMessages().some(message => message.content === "pending direction")).toBe(false)
    })
  }
})

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { makeTurnEndGuard } from "../../src/agent/contextAttachments.js"
import { AgentBudget } from "../../zapsdk/agent/budget.js"
import { LoopAgent } from "../../zapsdk/agent/loop.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { ConversationManager } from "../../zapsdk/memory/conversation.js"
import type { Todo } from "../../zapsdk/index.js"

async function runFixture(options: {
  work?: boolean
  activeTodo?: boolean
  clearTodoAfterWork?: boolean
  sharedTokens?: number
  localTokens?: number
  firstAnswer?: string
} = {}) {
  let calls = 0, effects = 0, reviews = 0
  let todos: Todo[] = options.activeTodo
    ? [{ content: "Complete the requested work", activeForm: "Completing work", status: "in_progress" }]
    : []
  const requests: string[] = []
  const registry = new ToolRegistry()
  registry.register({ definition: { name: "observe", description: "Return a synthetic observation", parameters: z.object({}) }, handler: async () => {
    effects++
    if (options.clearTodoAfterWork) todos = []
    return { success: true, output: "Command exit 0; functional check FAILED." }
  } })
  const conversation = new ConversationManager({ maxMessages: 100 })
  const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry, { onApproval: async () => true }), conversation,
    budget: new AgentBudget({ maxTokens: options.sharedTokens }), maxTokens: options.localTokens, maxSteps: 8,
    provider: {
      async call() { throw new Error("Unexpected synthesis") },
      async *stream(messages) {
        calls++
        requests.push(JSON.stringify(messages))
        if (options.work && calls === 1) {
          yield { type: "tool_call_start" as const, toolCallId: "observe-once", toolName: "observe" }
          yield { type: "tool_call_delta" as const, toolCallId: "observe-once", partialJson: "{}" }
          yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
          return
        }
        const firstFinish = calls === (options.work ? 2 : 1)
        yield { type: "text_delta" as const, text: firstFinish ? options.firstAnswer ?? "Done." : "Task remains unverified; the check failed." }
        yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }
      },
    } })
  agent.on("observation", event => { if (event.type === "observation" && event.kind === "turn_end_guard_fired") reviews++ })
  const result = await agent.run("Satisfy the original request and verify the result.", { turnEndGuard: makeTurnEndGuard(() => todos) })
  return { calls, effects, reviews, requests, result, messages: conversation.getMessages() }
}

describe("application finish evidence review", () => {
  test("reviews settled observations even after a Todo list is cleared, without replaying work", async () => {
    const run = await runFixture({ work: true, activeTodo: true, clearTodoAfterWork: true })
    expect(run.calls).toBe(3)
    expect(run.reviews).toBe(1)
    expect(run.effects).toBe(1)
    expect(run.result.toolResults).toHaveLength(1)
    expect(run.result.text).toBe("Task remains unverified; the check failed.")
    expect(run.requests[2]).toContain("Satisfy the original request")
    expect(run.requests[2]).toContain("functional check FAILED")
    expect(run.result.stopped).toBeUndefined()
  })

  test("allows an honest incomplete final answer with an active Todo and no forced tool call", async () => {
    const run = await runFixture({ activeTodo: true, firstAnswer: "Missing input; cannot complete this task." })
    expect(run.calls).toBe(2)
    expect(run.reviews).toBe(1)
    expect(run.effects).toBe(0)
    expect(run.requests[1]).toContain("You may finish with an honest incomplete or unverified result")
    expect(run.requests[1]).not.toContain("Do not reply with text only")
    expect(run.result.stopped).toBeUndefined()
  })

  test("direct conversation with no work or active Todo ends after one response", async () => {
    const run = await runFixture()
    expect(run.calls).toBe(1)
    expect(run.reviews).toBe(0)
    expect(run.effects).toBe(0)
  })

  test("read-only tool work receives at most one review without requiring mutation", async () => {
    const run = await runFixture({ work: true })
    expect(run.calls).toBe(3)
    expect(run.effects).toBe(1)
    expect(run.reviews).toBe(1)
    expect(run.result.text).toContain("unverified")
  })

  for (const kind of ["sharedTokens", "localTokens"] as const) {
    test(`does not start review after the natural answer exactly consumes ${kind}`, async () => {
      const run = await runFixture({ work: true, activeTodo: true, [kind]: 4, firstAnswer: "The check failed." })
      expect(run.calls).toBe(2)
      expect(run.reviews).toBe(0)
      expect(run.result.text).toBe("The check failed.")
      expect(run.result.stopped).toBeUndefined()
    })
  }
})

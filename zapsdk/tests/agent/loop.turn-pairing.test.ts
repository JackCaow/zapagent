import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, LLMResponse } from "../../core/types.js"

// End-to-end regression for issue #12. Drives a real LoopAgent with a
// fake streaming provider that reproduces the exact pathology: model
// emits N tool_uses, but the Nth one's JSON never closes (mid-stream cut).
// Pre-refactor that pattern produced orphan tool_results in conversation
// history; post-refactor (Turn-based commit) the conversation must always
// be wire-valid.

function makeFakeWriteFile() {
  return {
    definition: {
      name: "write_file",
      description: "fake",
      parameters: z.object({ path: z.string(), content: z.string() }),
    },
    handler: async () => ({ success: true, output: "Written" }),
  }
}

/** First turn: stream emits 3 tool_use blocks; only the first 2 close
 *  their JSON. Tool 3's args remain `{...incomplete` when the stream's
 *  `done` chunk fires.
 *  Second turn (after the loop sends the conversation back): emit a
 *  text-only "all done" so the loop terminates. */
function makeTruncatedThirdToolProvider(): LLMProvider {
  let turn = 0
  return {
    async call(): Promise<LLMResponse> {
      return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async *stream(): AsyncIterable<LLMChunk> {
      turn++
      if (turn === 1) {
        // Turn 1: 3 tool_use_starts, full JSON for t1/t2, partial for t3.
        yield { type: "tool_call_start", toolCallId: "tu1", toolName: "write_file" }
        yield { type: "tool_call_delta", toolCallId: "tu1", partialJson: JSON.stringify({ path: "a.md", content: "A" }) }
        yield { type: "tool_call_start", toolCallId: "tu2", toolName: "write_file" }
        yield { type: "tool_call_delta", toolCallId: "tu2", partialJson: JSON.stringify({ path: "b.md", content: "B" }) }
        yield { type: "tool_call_start", toolCallId: "tu3", toolName: "write_file" }
        // Mid-stream cut: only an open brace, no closing.
        yield { type: "tool_call_delta", toolCallId: "tu3", partialJson: '{"path":"c.md","content":"' }
        yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 }, finishReason: "tool_calls" }
        return
      }
      // Turn 2: simple text reply so the loop ends.
      yield { type: "text_delta", text: "all done" }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

describe("LoopAgent — Turn-based atomic commit (issue #12 regression)", () => {
  it("never persists orphan tool_use ↔ tool_result references when a tool's JSON is truncated mid-stream", async () => {
    const provider = makeTruncatedThirdToolProvider()
    const registry = new ToolRegistry()
    registry.register(makeFakeWriteFile())
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("write three files")

    const msgs = conversation.getMessages()
    // Walk the conversation: every tool_result must reference a tool_use
    // declared by some prior assistant; every assistant.toolCalls entry
    // must have a matching tool_result somewhere later. Bedrock's strict
    // pairing model encoded as a unit test.
    const declaredToolUseIds = new Set<string>()
    const seenToolResultIds = new Set<string>()
    for (const m of msgs) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) declaredToolUseIds.add(tc.id)
      }
      if (m.role === "tool_result" && m.toolCallId) {
        seenToolResultIds.add(m.toolCallId)
      }
    }
    for (const id of seenToolResultIds) {
      expect(declaredToolUseIds.has(id)).toBe(true)
    }
    for (const id of declaredToolUseIds) {
      expect(seenToolResultIds.has(id)).toBe(true)
    }
  })

  it("synthesizes a failure tool_result for the truncated tool — model sees what didn't run", async () => {
    const provider = makeTruncatedThirdToolProvider()
    const registry = new ToolRegistry()
    registry.register(makeFakeWriteFile())
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider, registry, executor, conversation,
      systemPrompt: "test", maxSteps: 5,
    })

    await agent.run("write three files")

    const msgs = conversation.getMessages()
    // tu1 + tu2 succeed → success results; tu3 truncated → synthesized
    // failure result with a "stream truncated" reason.
    const tu3Result = msgs.find(m => m.role === "tool_result" && m.toolCallId === "tu3")
    expect(tu3Result).toBeTruthy()
    expect(tu3Result!.content).toMatch(/stream truncated/)
  })

  it("does not execute non-streaming tool calls whose arguments failed to parse", async () => {
    let providerCall = 0
    let toolExecuted = false
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        providerCall++
        if (providerCall === 1) {
          return {
            type: "tool_call",
            text: "",
            toolCalls: [{
              id: "bad_args",
              name: "write_file",
              arguments: {},
              argumentParseError: "Malformed tool arguments JSON from provider.",
            }],
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        }
        return {
          type: "text",
          text: "handled",
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      ...makeFakeWriteFile(),
      handler: async () => {
        toolExecuted = true
        return { success: true, output: "Written" }
      },
    })
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("write one file")

    const badResult = conversation.getMessages()
      .find(m => m.role === "tool_result" && m.toolCallId === "bad_args")
    expect(toolExecuted).toBe(false)
    expect(badResult?.content).toContain("Malformed tool arguments JSON from provider.")
  })

  // The "pruneOrphanedToolCalls is a no-op" test was deleted in Phase 4
  // along with the method itself — Turn-shaped storage can't represent
  // orphans so the legacy defense was nothing to assert against. The two
  // tests above carry the load-bearing invariant: after a real loop run
  // with mid-stream truncation, history is wire-valid and the truncated
  // tool surfaces a synthesized failure result.
})

import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { LoopAgent } from "../../agent/loop.js"
import type { LLMProvider } from "../../core/llm.js"
import { ConversationManager } from "../../memory/conversation.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ToolRegistry } from "../../tools/registry.js"
import type { ToolResult } from "../../tools/types.js"

type Call = { name: string; args: Record<string, unknown> }

/** Streams one scripted tool call per turn, then a final answer. */
function scripted(calls: Call[], summary = "") {
  let turn = 0
  const provider: LLMProvider = {
    async call() { return { type: "text", text: summary, usage: { inputTokens: 1, outputTokens: 1 } } },
    async *stream() {
      const call = calls[turn++]
      if (!call) {
        yield { type: "text_delta", text: "done" }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
        return
      }
      yield { type: "tool_call_start", toolCallId: `c${turn}`, toolName: call.name }
      yield { type: "tool_call_delta", toolCallId: `c${turn}`, partialJson: JSON.stringify(call.args) }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
    },
  }
  return provider
}

function registryWith(tools: Record<string, { readOnly?: boolean; run: (args: Record<string, unknown>) => ToolResult }>) {
  const registry = new ToolRegistry()
  for (const [name, tool] of Object.entries(tools)) {
    registry.register({
      definition: { name, description: name, parameters: z.object({}).passthrough(), readOnly: tool.readOnly },
      handler: async args => tool.run(args),
    })
  }
  return registry
}

const toolResults = (conversation: ConversationManager) =>
  conversation.getMessages().filter(message => message.role === "tool_result").map(message => message.content)

describe("observations stay fresh", () => {
  it("shows a file that changed outside the agent's tools", async () => {
    let version = 0
    const registry = registryWith({ read_file: { readOnly: true, run: () => ({ success: true, output: `contents v${++version}` }) } })
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({ provider: scripted([{ name: "read_file", args: { path: "a.ts" } }, { name: "read_file", args: { path: "a.ts" } }]),
      registry, executor: new ToolExecutor(registry), conversation, maxSteps: 5 })
    await agent.run("read twice")
    const results = toolResults(conversation)
    expect(results.some(content => content.includes("contents v2"))).toBe(true)
    expect(results.some(content => content.includes("File already read"))).toBe(false)
  })

  it("never points at a result that compaction removed", async () => {
    const body = "line\n".repeat(8_000)
    const registry = registryWith({ read_file: { readOnly: true, run: () => ({ success: true, output: body }) } })
    const conversation = new ConversationManager({ maxMessages: 100 })
    const summary = ["Primary Request and Intent", "All user messages (verbatim)", "Current task status", "Files read / modified",
      "Commands run", "Key facts discovered", "Decisions made", "Errors encountered and their resolution", "Code changes summary", "Next steps"]
      .map(heading => `# ${heading}\n- fixture`).join("\n")
    const agent = new LoopAgent({ provider: scripted([{ name: "read_file", args: { path: "big.ts" } }, { name: "read_file", args: { path: "big.ts" } }], summary),
      registry, executor: new ToolExecutor(registry), conversation, maxSteps: 5, autoCompactThreshold: 20_000 })
    let compactions = 0
    agent.on("observation", event => { if (event.type === "observation" && /compact|prune/.test(event.kind) && /done|end|complete/.test(event.kind)) compactions++ })
    await agent.run("read, then read again")
    expect(compactions).toBeGreaterThan(0)
    expect(toolResults(conversation).some(content => content.includes("File already read"))).toBe(false)
  })
})

describe("repeated failures", () => {
  async function failures(calls: Call[], outputs: string[]) {
    let index = 0
    const registry = registryWith({
      bash: { run: () => ({ success: false, output: outputs[index++] ?? "", error: "Command failed: npm test\n\nType: Error\nExit code: 1\nMessage: > fixture test" }) },
      edit_file: { run: () => ({ success: true, output: "edited" }) },
    })
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({ provider: scripted(calls), registry, executor: new ToolExecutor(registry, { onApproval: async () => true }),
      conversation, maxSteps: 8 })
    await agent.run("make the tests pass")
    return toolResults(conversation).filter(content => content.includes("[SYSTEM] Failed"))
  }
  const test = { name: "bash", args: { command: "npm test" } }
  const edit = { name: "edit_file", args: { path: "src/a.ts" } }

  it("does not stop a rerun whose failure changed", async () => {
    expect(await failures([test, test], ["FAIL add: expected 3 got 2", "FAIL parse: KeyError name"])).toHaveLength(0)
  })

  it("does not stop a rerun after the workspace changed", async () => {
    expect(await failures([test, edit, test], ["FAIL add: expected 3 got 2", "FAIL add: expected 3 got 2"])).toHaveLength(0)
  })

  it("still flags the identical call failing identically", async () => {
    expect(await failures([test, test], ["FAIL add: expected 3 got 2", "FAIL add: expected 3 got 2"])).toHaveLength(1)
  })
})

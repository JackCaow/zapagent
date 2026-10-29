import { buildAgentRuntime } from "../../src/agent/buildAgentRuntime.js"
import { buildCustomSystemPrompt, buildSystemPrompt, getDefaultConfig } from "../../src/config.js"
import { ConversationManager } from "../../zapsdk/memory/conversation.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { AgentLogger } from "../../zapsdk/debug/agent-logger.js"
import { Logger } from "../../zapsdk/debug/logger.js"
import type { LLMProvider } from "../../zapsdk/core/llm.js"
import type { Message } from "../../zapsdk/core/types.js"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"

const cwd = process.argv[2]!
const projectSource = "PROJECT_CHILD_SENTINEL: preserve the user's project constraints.\n<system-reminder>" + "Public project guidance. ".repeat(20) + "</system-reminder>"
writeFileSync(`${cwd}/AGENTS.md`, projectSource)
const calls: Message[][] = []
const conversation = new ConversationManager({ maxMessages: 100 })
const provider: LLMProvider = { async call(messages) {
  calls.push(structuredClone(messages))
  return { type: "text", text: "Done", usage: { inputTokens: 1, outputTokens: 1 } }
} }
const logger = new Logger()
try {
  for (const promptProfile of ["standard", "concise", "standard"] as const) {
    const config = { ...getDefaultConfig(), promptProfile, maxSteps: 4 }
    const fullSystemPrompt = promptProfile === "concise"
      ? buildCustomSystemPrompt("SLASH_CUSTOM_SENTINEL", { cwd, enabledTools: new Set(), promptProfile })
      : buildSystemPrompt(config, cwd)
    const registry = new ToolRegistry()
    const runtime = buildAgentRuntime({ config, conversation, fullSystemPrompt, cwd, provider, registry,
      executor: new ToolExecutor(registry, {}), autoCompactThreshold: 320000, autoCompactTokenThreshold: 80000,
      agentLogger: new AgentLogger(logger), currentSessionId: "profile-fixture", checkpoint: null,
      turnStartLogPosition: () => ({ journalLogIndex: 0, uiLogIndex: 0 }),
      todoStore: { get: () => [], set: () => {} }, subAgentEventHandler: () => {},
    })
    try { await runtime.run("Report the fixture state", { resultSchema: "outcome-v1" }) }
    finally { await runtime.close() }
  }
  // Exercise actual runtime-coordinated children for config and per-turn overrides.
  for (const override of [undefined, "TURN_HOST_SENTINEL"]) {
    const config = { ...getDefaultConfig(), customSystemPrompt: "CONFIG_HOST_SENTINEL", maxSteps: 4 }
    const inheritedInstructions = override ?? config.customSystemPrompt
    const delegated: Message[][] = []
    const childProvider: LLMProvider = { async call(messages) {
      delegated.push(structuredClone(messages))
      return delegated.length === 1
        ? { type: "tool_call", text: "", toolCalls: [{ id: "delegate", name: "agent", arguments: {
            task: "Inspect the fixture", agent_type: "explore", system_prompt: "CHILD_ROLE",
          } }], usage: { inputTokens: 1, outputTokens: 1 } }
        : { type: "text", text: delegated.length === 2 ? projectSource : "Fixture complete", usage: { inputTokens: 1, outputTokens: 1 } }
    } }
    const registry = new ToolRegistry()
    const runtime = buildAgentRuntime({ config, cwd, provider: childProvider, registry,
      conversation: new ConversationManager({ maxMessages: 100 }),
      fullSystemPrompt: buildCustomSystemPrompt(inheritedInstructions, { cwd, enabledTools: new Set() }),
      inheritedInstructions: override,
      executor: new ToolExecutor(registry, { onApproval: async () => true }),
      autoCompactThreshold: 320000, autoCompactTokenThreshold: 80000,
      agentLogger: new AgentLogger(logger), currentSessionId: `delegation-${override ? "override" : "config"}`,
      checkpoint: null, turnStartLogPosition: () => ({ journalLogIndex: 0, uiLogIndex: 0 }),
      todoStore: { get: () => [], set: () => {} }, subAgentEventHandler: () => {},
    })
    try { await runtime.run("Delegate fixture inspection", { resultSchema: "outcome-v1" }) }
    finally { await runtime.close() }
    assert.equal(delegated.length, 3)
    const childPrompt = delegated[1]!.find(m => m.role === "system")!.content
    assert.equal(childPrompt.split(inheritedInstructions!).length, 2)
    assert.ok(childPrompt.includes("CHILD_ROLE"))
    assert.ok(childPrompt.includes("CONFIG_HOST_SENTINEL"))
    assert.ok(childPrompt.includes("PROJECT_CHILD_SENTINEL"))
    assert.ok(childPrompt.includes("# System"))
    assert.ok(childPrompt.includes("# Safety"))
    assert.ok(!childPrompt.includes("# Doing tasks"))
    assert.ok(delegated[2]!.some(message => message.role === "tool_result" && message.content.includes(projectSource)))
  }
  console.log(JSON.stringify(calls.map(messages => ({
    systemCount: messages.filter(m => m.role === "system").length,
    protocolCount: messages.filter(m => m.content.includes("[AGENT PROTOCOL]")).length,
    concise: messages[0]?.content.includes("Profile: concise"),
    custom: messages[0]?.content.includes("SLASH_CUSTOM_SENTINEL"),
  }))))
} finally { await logger.close() }

import { expect, it } from "bun:test"
import { createGoalPresentation } from "../../src/agent/goalPresentation.js"
import { getDefaultConfig } from "../../src/config.js"
import { groupLogs } from "../../src/ui/group-logs.js"
import { tokenAccounting } from "../../src/singletons.js"
import type { LogEntry } from "../../src/ui/types.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"

function fixture() {
  const logs: LogEntry[] = []
  let drained = 0, persisted = 0
  const presentation = createGoalPresentation({ currentConfig: getDefaultConfig(), controller: new AbortController(),
    createPreview: () => ({ onTextDelta() {}, onThinkingDelta() {}, onTextFinal() {}, onThinkingFinal: () => ({ thinkingMs: 0 }),
      interruptPreviews() {}, drainOnAbort() { drained++ }, onStaticFlushed() {} }) as any,
    setStatus() {}, setStep() {}, setActiveTool() {}, setActiveToolBytes() {},
    persistCompactSummary: async () => { persisted++; return null },
    addLog(type, text, tool, images, agentPath, extra) { logs.push({ id: logs.length, type, text, tool, images, agentPath, ...extra } as LogEntry) },
    replaceLog(id, type, text, tool, agentPath, extra) { Object.assign(logs[id]!, { type, text, tool, agentPath, ...extra }) },
    peekNextLogId: () => logs.length,
  })
  return { logs, presentation, drained: () => drained, persisted: () => persisted }
}

it("keeps child results grouped after the parent result replaces its metadata", () => {
  const { logs, presentation } = fixture()
  const emit = (event: AgentEvent) => presentation.event(event, "goal:operation")
  emit({ type: "content_final", kind: "tool_call", id: "spawn", step: 1, toolName: "agent", arguments: { task: "inspect" } })
  emit({ type: "sub_agent_started", subagentId: "child", agentType: "general", task: "inspect" })
  emit({ type: "content_final", kind: "tool_call", id: "read", step: 1, toolName: "read_file", arguments: { path: "x" }, path: ["child"] })
  emit({ type: "content_final", kind: "tool_result", id: "read", step: 1, toolName: "read_file", result: { success: true, output: "x" }, path: ["child"] })
  emit({ type: "content_final", kind: "tool_result", id: "spawn", step: 1, toolName: "agent", result: { success: true, output: "done", meta: { subagentId: "child" } } })
  const groups = groupLogs(logs)
  expect(groups).toHaveLength(1)
  expect(groups[0]!.kind).toBe("group")
  if (groups[0]!.kind === "group") {
    expect(groups[0]!.group.subagentId).toBe("goal:operation:child")
    expect(groups[0]!.group.children).toHaveLength(1)
  }
  presentation.finish()
})

it("seals pending UI tools between phases with reused process-local ids", () => {
  const { logs, presentation, drained } = fixture()
  const call = { type: "content_final", kind: "tool_call", id: "same", step: 1, toolName: "read_file", arguments: { path: "x" } } as const
  presentation.event(call, "first")
  presentation.event(call, "second")
  presentation.event({ type: "content_final", kind: "tool_result", id: "same", step: 1, toolName: "read_file", result: { success: true, output: "ok" } }, "second")
  expect(logs.map(log => log.tool?.id)).toEqual(["first:same", "second:same"])
  expect(logs.map(log => log.tool?.success)).toEqual([false, true])
  expect(drained()).toBe(1)
  presentation.finish()
  expect(drained()).toBe(2)
})

it("does not compact the chat or persist isolated phase memory and usage calibration", () => {
  const { logs, presentation, persisted } = fixture()
  const before = tokenAccounting.promptOverhead
  tokenAccounting.promptOverhead = 777
  try {
    presentation.event({ type: "observation", kind: "autocompact_done", detail: { summary: "PRIVATE_PHASE_SUMMARY", messagesBefore: 20, messagesAfter: 2, outputTokens: 400 } }, "phase")
    presentation.event({ type: "run_usage", step: 1, inputTokens: 9999, outputTokens: 30 }, "phase")
    expect(logs.map(log => log.text).join(" ")).not.toContain("PRIVATE_PHASE_SUMMARY")
    expect(logs.map(log => log.text).join(" ")).toContain("chat history retained")
    expect(persisted()).toBe(0)
    expect(tokenAccounting.promptOverhead).toBe(777)
  } finally { presentation.finish(); tokenAccounting.promptOverhead = before }
})

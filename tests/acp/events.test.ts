import { describe, expect, it } from "bun:test"
import { acpStopReason, AcpEventMapper } from "../../src/acp/events.js"
import { operationFailure } from "../../zapsdk/execution/failure.js"

describe("ACP event translation", () => {
  it("marks a failed thought attempt without appending it to a new message", () => {
    const mapper = new AcpEventMapper("turn")
    expect(mapper.map({ type: "content_abandoned", kind: "thinking", id: "old", step: 0,
      attempt: 1, reason: "CONNECTION_ERROR", usageUnknown: true })[0]).toMatchObject({
      sessionUpdate: "agent_thought_chunk", messageId: "turn::old",
      content: { text: "\n[Interrupted attempt abandoned; retrying.]\n" },
    })
    expect(mapper.map({ type: "content_delta", kind: "thinking", id: "new", text: "fresh" })[0])
      .toMatchObject({ messageId: "turn::new" })
  })
  it("carries the shared structured failure without reclassifying legacy error prose", () => {
    const failure = operationFailure("EXECUTION_FAILED", "unknown", "execution:call")
    const [update] = new AcpEventMapper("turn").map({ type: "content_final", kind: "tool_result",
      id: "call", step: 1, toolName: "bash",
      result: { success: false, output: "", error: "sandbox denied", failure } })
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed",
      rawOutput: { failure, error: "sandbox denied" } })
  })
  it("does not duplicate streamed text, keeps nested tool IDs, and reports failures", () => {
    const mapper = new AcpEventMapper("turn")
    expect(mapper.map({ type: "content_delta", kind: "thinking", id: "thought", text: "reason" })[0]?.sessionUpdate).toBe("agent_thought_chunk")
    expect(mapper.map({ type: "content_final", kind: "thinking", id: "thought", text: "reason" })).toEqual([])
    const event = { type: "content_final", kind: "tool_call", id: "call", path: ["child"], step: 1,
      toolName: "edit_file", arguments: { path: "/workspace/a.ts" } } as const
    const start = mapper.map({ ...event, path: [...event.path] })[0]
    expect(start).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "turn:child:call", kind: "edit" })
    const end = mapper.map({ type: "content_final", kind: "tool_result", id: "call", path: ["child"], step: 1,
      toolName: "edit_file", result: { success: false, output: "", error: "denied" } })[0]
    expect(end).toMatchObject({ toolCallId: "turn:child:call", status: "failed" })
  })
  it("maps runtime soft stops without reporting successful completion", () => {
    expect(acpStopReason("max_steps")).toBe("max_turn_requests")
    expect(acpStopReason("timeout")).toBe("max_turn_requests")
    expect(acpStopReason("aborted")).toBe("cancelled")
    expect(acpStopReason("permission_denied")).toBe("refusal")
    expect(acpStopReason("end_turn")).toBe("end_turn")
  })
})

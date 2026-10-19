import { describe, it, expect } from "bun:test"
import { buildToolTurn, turnToMessages, turnsToMessages, type Turn, type CompletedCall } from "../../core/turn.js"
import { ConversationManager } from "../../memory/conversation.js"

const completed = (id: string, name = "bash"): CompletedCall => ({
  id,
  name,
  arguments: { command: `echo ${id}` },
  result: { success: true, output: `output of ${id}` },
})

describe("Turn — invariants", () => {
  it("buildToolTurn synthesizes failure ToolResult for incomplete calls so every call is paired", () => {
    const turn = buildToolTurn({
      text: "I'll write three files",
      completed: [completed("t1", "write_file"), completed("t2", "write_file")],
      incomplete: [{ id: "t3", name: "write_file", arguments: {}, reason: "stream cut mid-args" }],
    })
    expect(turn.kind).toBe("tool_turn")
    if (turn.kind !== "tool_turn") return
    expect(turn.calls.length).toBe(3)
    const t3 = turn.calls.find(c => c.id === "t3")!
    expect(t3.result.success).toBe(false)
    expect(t3.result.error).toBe("stream cut mid-args")
  })

  it("buildToolTurn with no incomplete calls just packs the completed list", () => {
    const turn = buildToolTurn({
      text: "",
      completed: [completed("t1"), completed("t2")],
    })
    if (turn.kind !== "tool_turn") throw new Error("wrong kind")
    expect(turn.calls.length).toBe(2)
    expect(turn.calls.every(c => c.result.success)).toBe(true)
  })
})

describe("Turn — turnToMessages serialization", () => {
  it("user turn becomes a single user Message", () => {
    const turn: Turn = { kind: "user", content: "hi" }
    const msgs = turnToMessages(turn)
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe("user")
    expect(msgs[0].content).toBe("hi")
  })

  it("user turn preserves cache placement hints", () => {
    const turn: Turn = { kind: "user", content: "hi", cache: { skipBreakpoint: true } }
    const msgs = turnToMessages(turn)
    expect(msgs.length).toBe(1)
    expect(msgs[0].cache).toEqual({ skipBreakpoint: true })
  })

  it("user turn with images carries contentBlocks", () => {
    const turn: Turn = {
      kind: "user",
      content: "describe this",
      images: [{ type: "image", filePath: "/tmp/a.png", mediaType: "image/png", source: "/tmp/a.png" }],
    }
    const msgs = turnToMessages(turn)
    expect(msgs[0].contentBlocks?.length).toBe(2)
    expect(msgs[0].contentBlocks?.[0].type).toBe("text")
    expect(msgs[0].contentBlocks?.[1].type).toBe("image")
  })

  it("assistant text turn becomes a single assistant Message (no toolCalls)", () => {
    const turn: Turn = { kind: "assistant", text: "I'm done" }
    const msgs = turnToMessages(turn)
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe("assistant")
    expect(msgs[0].toolCalls).toBeUndefined()
  })

  it("assistant text turn preserves raw sidecar (reasoning_content etc)", () => {
    const turn: Turn = { kind: "assistant", text: "answer", raw: { reasoning_content: "thought process" } }
    const msgs = turnToMessages(turn)
    expect(msgs[0].raw).toEqual({ reasoning_content: "thought process" })
  })

  it("tool_turn becomes assistant + N tool_results, paired in order", () => {
    const turn = buildToolTurn({
      text: "running 3 commands",
      completed: [completed("t1"), completed("t2"), completed("t3")],
    })
    const msgs = turnToMessages(turn)
    expect(msgs.length).toBe(4)
    expect(msgs[0].role).toBe("assistant")
    expect(msgs[0].toolCalls?.map(tc => tc.id)).toEqual(["t1", "t2", "t3"])
    for (let i = 1; i <= 3; i++) {
      expect(msgs[i].role).toBe("tool_result")
      expect(msgs[i].toolCallId).toBe(`t${i}`)
    }
  })

  it("tool_turn with synthesized failure for incomplete call still emits a tool_result", () => {
    const turn = buildToolTurn({
      text: "trying three writes",
      completed: [completed("t1", "write_file"), completed("t2", "write_file")],
      incomplete: [{ id: "t3", name: "write_file", arguments: {}, reason: "stream cut" }],
    })
    const msgs = turnToMessages(turn)
    // 1 assistant + 3 tool_results — INCLUDING the synthesized failure
    expect(msgs.length).toBe(4)
    const t3Result = msgs.find(m => m.role === "tool_result" && m.toolCallId === "t3")!
    expect(t3Result.content).toBe("stream cut")
  })

  it("turnsToMessages flattens a sequence of turns in order", () => {
    const turns: Turn[] = [
      { kind: "user", content: "list" },
      buildToolTurn({ text: "ok", completed: [completed("t1")] }),
      { kind: "assistant", text: "all done" },
    ]
    const msgs = turnsToMessages(turns)
    expect(msgs.map(m => m.role)).toEqual(["user", "assistant", "tool_result", "assistant"])
  })
})

describe("ConversationManager.commitTurn — façade", () => {
  it("commits a tool_turn atomically — assistant + every tool_result are present", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "list" })
    cm.commitTurn(buildToolTurn({
      text: "ok",
      completed: [completed("t1"), completed("t2")],
    }))
    const out = cm.getMessages()
    expect(out.length).toBe(4)
    expect(out[0].role).toBe("user")
    expect(out[1].role).toBe("assistant")
    expect(out[1].toolCalls?.length).toBe(2)
    expect(out[2].role).toBe("tool_result"); expect(out[2].toolCallId).toBe("t1")
    expect(out[3].role).toBe("tool_result"); expect(out[3].toolCallId).toBe("t2")
  })

  it("commitTurn cannot produce orphan tool_results — incomplete calls become synthesized failures", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "write 3 files" })
    // The exact pathology from issue #12: stream cuts before all tool_uses
    // get their JSON closed. The Turn builder synthesizes a failure result
    // for the truncated call so the assistant.toolCalls and tool_results
    // are still 1:1.
    cm.commitTurn(buildToolTurn({
      text: "writing",
      completed: [completed("tu1", "write_file"), completed("tu2", "write_file")],
      incomplete: [{ id: "tu3", name: "write_file", arguments: {}, reason: "stream truncated" }],
    }))
    const out = cm.getMessages()
    // Turn-shaped storage can't represent orphans — every tool_use has a
    // paired result by construction (the truncated tu3 got a synthesized
    // failure ToolResult).
    expect(out.length).toBe(5)
    const assistant = out.find(m => m.role === "assistant")!
    expect(assistant.toolCalls?.map(tc => tc.id)).toEqual(["tu1", "tu2", "tu3"])
    const tu3Result = out.find(m => m.role === "tool_result" && m.toolCallId === "tu3")!
    expect(tu3Result.content).toBe("stream truncated")
  })
})

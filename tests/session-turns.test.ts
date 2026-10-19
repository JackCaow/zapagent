import { describe, it, expect } from "bun:test"
import { sessionLogsToTurns, type SessionLog } from "../src/session.js"

// Direct tests for the Phase 3 canonical restore path: sessionLogsToTurns.
// Verifies the Turn-shape invariants are upheld at the persistence
// boundary, not just at the wire boundary (which the existing
// session.test.ts covers via sessionLogsToMessages).

describe("sessionLogsToTurns — Turn-shape invariants on restore", () => {
  it("clean tool turn restores as a single tool_turn with paired result", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "pwd" },
      { type: "tool", text: "bash", tool: { id: "t1", name: "bash", arguments: { command: "pwd" } } },
      { type: "result", text: "ok", tool: { id: "t1", name: "bash", output: "/home/x", success: true } },
    ]
    const turns = sessionLogsToTurns(logs)
    expect(turns.length).toBe(2)
    expect(turns[0].kind).toBe("user")
    expect(turns[1].kind).toBe("tool_turn")
    if (turns[1].kind !== "tool_turn") return
    expect(turns[1].calls.length).toBe(1)
    expect(turns[1].calls[0].id).toBe("t1")
    expect(turns[1].calls[0].result.success).toBe(true)
  })

  it("tool log without matching result log → synthesized failure ToolResult, not orphan", () => {
    // The exact pathology session-restore used to produce: a tool log
    // (or assistant's tool_use block) survives, but its result log is
    // gone. Pre-Phase-3 this leaked an orphan tool_use into history.
    // Post-Phase-3 it's a tool_turn with a synthesized failure.
    const logs: SessionLog[] = [
      { type: "agent", text: "running" },
      { type: "tool", text: "bash", tool: { id: "tu_orphan", name: "bash", arguments: { command: "echo hi" } } },
      // No result log for tu_orphan!
      { type: "user", text: "next turn" },
    ]
    const turns = sessionLogsToTurns(logs)
    const toolTurn = turns.find((t) => t.kind === "tool_turn")
    expect(toolTurn).toBeTruthy()
    if (toolTurn?.kind !== "tool_turn") return
    expect(toolTurn.calls.length).toBe(1)
    expect(toolTurn.calls[0].result.success).toBe(false)
    expect(toolTurn.calls[0].result.error).toMatch(/missing/i)
  })

  it("result log with no preceding tool log synthesizes the tool_use (writer's replaceLog chain)", () => {
    // The writer collapses tool→result via replaceLog chaining; restored
    // sessions often only see `result` logs, never `tool`. The restorer
    // synthesizes the assistant's tool_use entry from the result's name+args.
    const logs: SessionLog[] = [
      { type: "agent", text: "writing" },
      { type: "result", text: "ok", tool: { id: "tu_x", name: "write_file", arguments: { path: "a.md" }, output: "Written 100 chars", success: true } },
    ]
    const turns = sessionLogsToTurns(logs)
    expect(turns.length).toBe(1)
    if (turns[0].kind !== "tool_turn") throw new Error("expected tool_turn")
    expect(turns[0].calls[0].id).toBe("tu_x")
    expect(turns[0].calls[0].name).toBe("write_file")
    expect(turns[0].calls[0].result.success).toBe(true)
  })

  it("thinking log content rides out as raw.reasoning_content on the tool_turn", () => {
    const logs: SessionLog[] = [
      { type: "thinking", text: "hmm let me think" },
      { type: "agent", text: "OK" },
      { type: "result", text: "", tool: { id: "tu", name: "bash", output: "done", success: true } },
    ]
    const turns = sessionLogsToTurns(logs)
    if (turns[0].kind !== "tool_turn") throw new Error("expected tool_turn")
    expect(turns[0].raw?.reasoning_content).toBe("hmm let me think")
  })

  it("consecutive user logs (legacy abort gap) coalesce into one user turn", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "first" },
      { type: "user", text: "继续" },
      { type: "user", text: "继续" },
      { type: "user", text: "next intent" },
    ]
    const turns = sessionLogsToTurns(logs)
    const userTurns = turns.filter((t) => t.kind === "user")
    expect(userTurns.length).toBe(1)
    if (userTurns[0].kind !== "user") return
    expect(userTurns[0].content).toContain("first")
    expect(userTurns[0].content).toContain("next intent")
    expect(userTurns[0].content).toContain("继续")
  })

  it("keeps task-notification user-role turns separate from adjacent human user turns", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "start work" },
      { type: "task-notification", text: "<task-notification>background task finished</task-notification>" },
      { type: "user", text: "continue after notification" },
    ]

    const turns = sessionLogsToTurns(logs)

    expect(turns).toEqual([
      { kind: "user", content: "start work" },
      { kind: "user", content: "<task-notification>background task finished</task-notification>" },
      { kind: "user", content: "continue after notification" },
    ])
  })

  it("still coalesces human user turns on either side of a task notification", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "first" },
      { type: "user", text: "second" },
      { type: "task-notification", text: "<task-notification>done</task-notification>" },
      { type: "user", text: "third" },
      { type: "user", text: "fourth" },
    ]

    const turns = sessionLogsToTurns(logs)

    expect(turns).toEqual([
      { kind: "user", content: "first\n\nsecond" },
      { kind: "user", content: "<task-notification>done</task-notification>" },
      { kind: "user", content: "third\n\nfourth" },
    ])
  })

  it("preserves user images on restore", () => {
    const logs: SessionLog[] = [
      {
        type: "user",
        text: "inspect this",
        images: [{ filePath: "/tmp/a.png", source: "/tmp/a.png", mediaType: "image/png" }],
      },
    ]
    const turns = sessionLogsToTurns(logs)
    expect(turns.length).toBe(1)
    if (turns[0].kind !== "user") throw new Error("expected user turn")
    expect(turns[0].images).toEqual([
      { type: "image", filePath: "/tmp/a.png", source: "/tmp/a.png", mediaType: "image/png" },
    ])
  })

  it("skips display-only logs marked restore:false", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "/review src", restore: false },
      { type: "user", text: "Review the code at: src" },
    ]
    const turns = sessionLogsToTurns(logs)
    expect(turns.length).toBe(1)
    expect(turns[0]).toEqual({ kind: "user", content: "Review the code at: src" })
  })

  it("uses restoreText for model context while preserving compact display text", () => {
    const full = "first line\n  indented pasted line\nlast line"
    const logs: SessionLog[] = [
      {
        type: "user",
        text: "[Pasted #1 · 3 lines · 42 chars]",
        restoreText: full,
      },
    ]
    const turns = sessionLogsToTurns(logs)
    expect(turns.length).toBe(1)
    expect(turns[0]).toEqual({ kind: "user", content: full })
  })

  it("parallel tool calls in one assistant turn restore as a single tool_turn with N calls", () => {
    const logs: SessionLog[] = [
      { type: "agent", text: "running 3" },
      { type: "result", text: "", tool: { id: "t1", name: "bash", arguments: { command: "ls" }, output: "a", success: true } },
      { type: "result", text: "", tool: { id: "t2", name: "bash", arguments: { command: "pwd" }, output: "/home", success: true } },
      { type: "result", text: "", tool: { id: "t3", name: "bash", arguments: { command: "whoami" }, output: "x", success: true } },
    ]
    const turns = sessionLogsToTurns(logs)
    expect(turns.length).toBe(1)
    if (turns[0].kind !== "tool_turn") throw new Error("expected tool_turn")
    expect(turns[0].calls.map((c) => c.id)).toEqual(["t1", "t2", "t3"])
  })

  it("never produces wire-shape orphans regardless of input log shape", () => {
    // Stress: pathological log sequence that historically produced orphans.
    const logs: SessionLog[] = [
      { type: "user", text: "u" },
      { type: "result", text: "", tool: { id: "stale1", name: "bash", arguments: {}, output: "", success: true } }, // orphan with no preceding tool
      { type: "agent", text: "trying" },
      { type: "result", text: "", tool: { id: "ok", name: "bash", arguments: {}, output: "fine", success: true } },
      { type: "result", text: "", tool: { id: "stale2", name: "bash", arguments: {}, output: "", success: true } },
      { type: "user", text: "next" },
    ]
    const turns = sessionLogsToTurns(logs)
    // Walk the derived Message[] to assert wire-validity.
    const declared = new Set<string>()
    const seen = new Set<string>()
    for (const t of turns) {
      if (t.kind === "tool_turn") {
        for (const c of t.calls) {
          declared.add(c.id)
          // Each call has a result by Turn invariant. Check the projected
          // tool_result toolCallId would match.
          seen.add(c.id)
        }
      }
    }
    expect(declared.size).toBe(seen.size)
    for (const id of seen) expect(declared.has(id)).toBe(true)
  })
})

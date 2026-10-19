import { describe, it, expect } from "bun:test"
import { ConversationManager } from "../../memory/conversation.js"
import { buildToolTurn } from "../../core/turn.js"
import type { Message } from "../../core/types.js"

function structuredSummary(marker = "SUMMARY"): string {
  return [
    "# Primary Request and Intent",
    `- ${marker}`,
    "# All user messages (verbatim)",
    "- continue",
    "# Current task status",
    "- compacting",
    "# Files read / modified",
    "- zapsdk/memory/conversation.ts",
    "# Commands run",
    "- bun test",
    "# Key facts discovered",
    "- turn granularity matters",
    "# Decisions made",
    "- keep tool turns atomic",
    "# Errors encountered and their resolution",
    "- none",
    "# Code changes summary",
    "- updated compression test fixture",
    "# Next steps",
    "- continue",
  ].join("\n")
}

describe("ConversationManager — Turn-based storage (Phase 2)", () => {
  it("commitTurn appends a Turn directly, getMessages derives the wire shape", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "list" })
    cm.commitTurn(
      buildToolTurn({
        text: "running",
        completed: [
          { id: "t1", name: "bash", arguments: { command: "ls" }, result: { success: true, output: "a b c" } },
        ],
      })
    )
    const out = cm.getMessages()
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool_result"])
    expect(out[1].toolCalls?.[0].id).toBe("t1")
    expect(out[2].toolCallId).toBe("t1")

    // Storage is Turn-shaped, not Message-shaped — verify via getTurns().
    const turns = cm.getTurns()
    expect(turns.length).toBe(2)
    expect(turns[0].kind).toBe("user")
    expect(turns[1].kind).toBe("tool_turn")
  })

  it("legacy add(assistant_with_toolCalls) + add(tool_result) buffers and coalesces into one Turn", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "go" })
    cm.add({
      role: "assistant",
      content: "ok",
      toolCalls: [
        { id: "t1", name: "bash", arguments: {} },
        { id: "t2", name: "bash", arguments: {} },
      ],
    })
    cm.add({ role: "tool_result", toolCallId: "t1", content: "out1" })
    cm.add({ role: "tool_result", toolCallId: "t2", content: "out2" })

    const turns = cm.getTurns()
    expect(turns.length).toBe(2)
    expect(turns[0].kind).toBe("user")
    expect(turns[1].kind).toBe("tool_turn")
    if (turns[1].kind !== "tool_turn") return
    expect(turns[1].calls.length).toBe(2)
    expect(turns[1].calls.map((c) => c.id)).toEqual(["t1", "t2"])
  })

  it("incomplete legacy sequence (missing tool_result) auto-flushes with synthesized failure on next non-tool_result", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({
      role: "assistant",
      content: "running 2",
      toolCalls: [
        { id: "t1", name: "bash", arguments: {} },
        { id: "t2_missing", name: "bash", arguments: {} },
      ],
    })
    cm.add({ role: "tool_result", toolCallId: "t1", content: "ok" })
    // Next non-tool_result message — pending buffer flushes with synthesized failure for t2_missing.
    cm.add({ role: "user", content: "what about t2?" })

    const turns = cm.getTurns()
    expect(turns.length).toBe(2)
    if (turns[0].kind !== "tool_turn") throw new Error("expected tool_turn")
    expect(turns[0].calls.length).toBe(2)
    const t2 = turns[0].calls.find((c) => c.id === "t2_missing")!
    expect(t2.result.success).toBe(false)
    expect(t2.result.error).toMatch(/missing/i)
    expect(turns[1].kind).toBe("user")
  })

  it("orphan tool_result with no pending buffer is dropped silently (no Turn produced)", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "go" })
    cm.add({ role: "tool_result", toolCallId: "phantom", content: "stale" })
    cm.add({ role: "user", content: "still here?" })
    const turns = cm.getTurns()
    expect(turns.length).toBe(2)
    expect(turns.every((t) => t.kind === "user")).toBe(true)
  })

  it("getMessages flushes a pending buffer (so callers see consistent wire-valid history mid-sequence)", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({
      role: "assistant",
      content: "running",
      toolCalls: [{ id: "t1", name: "bash", arguments: {} }],
    })
    // Don't add the tool_result. Read getMessages() — should auto-flush.
    const msgs = cm.getMessages()
    expect(msgs.length).toBe(2)
    expect(msgs[0].role).toBe("assistant")
    expect(msgs[1].role).toBe("tool_result")
    expect(msgs[1].content).toMatch(/missing/i)
  })

  it("truncateAfter respects turn boundaries — never cuts inside a tool_turn", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "u1" })
    cm.commitTurn(
      buildToolTurn({
        text: "ran 2",
        completed: [
          { id: "t1", name: "bash", arguments: {}, result: { success: true, output: "a" } },
          { id: "t2", name: "bash", arguments: {}, result: { success: true, output: "b" } },
        ],
      })
    )
    cm.add({ role: "user", content: "u2" })
    // Messages: [u1, assistant, t1_result, t2_result, u2] (length 5)
    // truncateAfter(3) — index 3 falls INSIDE the tool_turn (its assistant
    // is at index 1, results at 2/3). Atomic semantics → cut to before
    // the tool_turn, keeping just [u1].
    cm.truncateAfter(3)
    const turns = cm.getTurns()
    expect(turns.length).toBe(1)
    expect(turns[0].kind).toBe("user")
  })

  it("truncateAfter at exactly a turn boundary cuts cleanly", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "u1" })
    cm.add({ role: "user", content: "u2" })
    cm.add({ role: "user", content: "u3" })
    cm.truncateAfter(2)
    const turns = cm.getTurns()
    expect(turns.length).toBe(2)
  })

  it("mutateInPlace round-trips: edit content of an existing tool_result, see the change in storage", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.commitTurn(
      buildToolTurn({
        text: "ran",
        completed: [
          { id: "t1", name: "bash", arguments: {}, result: { success: true, output: "FULL OUTPUT" } },
        ],
      })
    )
    cm.mutateInPlace((msgs) => {
      for (const m of msgs) {
        if (m.role === "tool_result" && m.toolCallId === "t1") {
          m.content = "[compacted]"
        }
      }
    })
    const out = cm.getMessages()
    const tr = out.find((m) => m.role === "tool_result")!
    expect(tr.content).toBe("[compacted]")
  })

  it("clear empties storage AND any pending buffer", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "go" })
    cm.add({
      role: "assistant",
      content: "x",
      toolCalls: [{ id: "t1", name: "bash", arguments: {} }],
    })
    // Pending buffer is half-full.
    cm.clear()
    expect(cm.getMessages().length).toBe(0)
    expect(cm.getTurns().length).toBe(0)
  })

  // pruneOrphanedToolCalls was deleted in Phase 4 — Turn-shaped storage
  // can't represent orphans, so the legacy defense had nothing to do. The
  // turn-pairing regression suite (loop.turn-pairing.test.ts) covers the
  // invariant end-to-end.
})

describe("ConversationManager — review-followup edge cases", () => {
  it("mutateInPlace preserves wire-validity even if mutator structurally damages the snapshot", () => {
    // The mutator deletes a tool_result message but leaves the assistant's
    // toolCalls entry intact. Pre-Phase-2 this would leave an orphan in
    // history. Post-Phase-2 the re-derivation (rederiveTurns) synthesizes
    // a failure ToolResult so the storage is healed back to wire-valid.
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.commitTurn(
      buildToolTurn({
        text: "ran two",
        completed: [
          { id: "t1", name: "bash", arguments: {}, result: { success: true, output: "a" } },
          { id: "t2", name: "bash", arguments: {}, result: { success: true, output: "b" } },
        ],
      }),
    )
    cm.mutateInPlace((msgs) => {
      const t2Idx = msgs.findIndex((m) => m.role === "tool_result" && m.toolCallId === "t2")
      if (t2Idx >= 0) msgs.splice(t2Idx, 1)
    })
    // Storage healed: assistant.toolCalls still has t1+t2, t2's result is
    // now a synthesized failure (because the structural break got coalesced
    // back into a Turn).
    const out = cm.getMessages()
    const declared = new Set<string>()
    const seen = new Set<string>()
    for (const m of out) {
      if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) declared.add(tc.id)
      if (m.role === "tool_result" && m.toolCallId) seen.add(m.toolCallId)
    }
    expect(declared.size).toBe(seen.size)
    for (const id of seen) expect(declared.has(id)).toBe(true)
  })

  it("clear() + add()-replay ending on assistant_with_toolCalls keeps history wire-valid via auto-flush", () => {
    // Reproduces the replaceMessages → autocompact path where the keep-tail
    // can end mid-turn. Pre-fix this relied on pruneOrphanedToolCalls running
    // afterward; post-Phase-2, getMessages auto-flushes the buffer (with
    // synthesized failure for missing tool_results) so the next read is
    // wire-valid.
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "go" })
    cm.add({
      role: "assistant",
      content: "running",
      toolCalls: [{ id: "t1", name: "bash", arguments: {} }],
    })
    // No tool_result. Read getMessages — buffer flushes.
    const out = cm.getMessages()
    expect(out.length).toBe(3) // user, assistant, synthesized tool_result
    const result = out.find((m) => m.role === "tool_result")
    expect(result).toBeTruthy()
    expect(result!.toolCallId).toBe("t1")
  })

  it("compress operates at turn granularity (never splits a tool_turn into summary + dangling result)", async () => {
    // Mock summarizer.
    const fakeProvider = {
      async call() {
        return {
          type: "text" as const,
          text: structuredSummary("[SUMMARY of older turns]"),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const cm = new ConversationManager({ maxMessages: 1000, maxTokens: 1000, autoCompress: true })
    cm.add({ role: "user", content: "u1" })
    cm.commitTurn(
      buildToolTurn({
        text: "ran",
        completed: [
          { id: "t1", name: "bash", arguments: {}, result: { success: true, output: "x".repeat(200) } },
          { id: "t2", name: "bash", arguments: {}, result: { success: true, output: "y".repeat(200) } },
        ],
      }),
    )
    cm.add({ role: "user", content: "u2" })
    const result = await cm.compress(fakeProvider as any, { force: true, targetTokens: 50 })
    expect(result).not.toBeNull()
    // The post-compress conversation must be wire-valid: no tool_result
    // without its assistant, no toolCall without its result.
    const msgs = cm.getMessages()
    const declared = new Set<string>()
    const seen = new Set<string>()
    for (const m of msgs) {
      if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) declared.add(tc.id)
      if (m.role === "tool_result" && m.toolCallId) seen.add(m.toolCallId)
    }
    for (const id of seen) expect(declared.has(id)).toBe(true)
    for (const id of declared) expect(seen.has(id)).toBe(true)
  })

  it("buffer-aware messageCount predicts the eventual flushed size, not the partially-received size", () => {
    // The pending buffer holds an assistant with N toolCalls but maybe < N
    // received tool_results. messageCount must reflect what flush WILL
    // produce (1 + N) — otherwise soft-trigger checks would fire late.
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "u1" }) // 1
    cm.add({
      role: "assistant",
      content: "running 5",
      toolCalls: [
        { id: "t1", name: "bash", arguments: {} },
        { id: "t2", name: "bash", arguments: {} },
        { id: "t3", name: "bash", arguments: {} },
        { id: "t4", name: "bash", arguments: {} },
        { id: "t5", name: "bash", arguments: {} },
      ],
    })
    // No tool_results received yet — buffer pending, eventual size = 6.
    expect(cm.messageCount).toBe(7) // u1(1) + assistant(1) + 5 synthesized
  })
})

describe("ConversationManager — truncate honors Turn atomicity", () => {
  it("count-based truncate keeps tool_turn pairs together (never strands tool_results)", () => {
    const cm = new ConversationManager({ maxMessages: 4 })
    cm.add({ role: "user", content: "u1" })
    // tool_turn = 1 assistant + 3 tool_results = 4 derived messages
    cm.commitTurn(
      buildToolTurn({
        text: "",
        completed: [
          { id: "t1", name: "bash", arguments: {}, result: { success: true, output: "a" } },
          { id: "t2", name: "bash", arguments: {}, result: { success: true, output: "b" } },
          { id: "t3", name: "bash", arguments: {}, result: { success: true, output: "c" } },
        ],
      })
    )
    cm.add({ role: "user", content: "u2" })
    // Total derived messages = 1 + 4 + 1 = 6. maxMessages=4 → truncate.
    // Naive per-message truncation would shave 2 off the head → tool_results
    // without their assistant. Turn-aware truncation drops whole turns:
    // dropping u1 (1) and the tool_turn (4) leaves [u2] (1) — under limit.
    const msgs = cm.getMessages()
    // Whatever we drop, the result must still be wire-valid: every
    // tool_result has a matching tool_use, every assistant.toolCalls has
    // matching tool_results.
    const declaredIds = new Set<string>()
    const seenIds = new Set<string>()
    for (const m of msgs) {
      if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) declaredIds.add(tc.id)
      if (m.role === "tool_result" && m.toolCallId) seenIds.add(m.toolCallId)
    }
    for (const id of seenIds) expect(declaredIds.has(id)).toBe(true)
    for (const id of declaredIds) expect(seenIds.has(id)).toBe(true)
  })
})

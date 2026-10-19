import { describe, expect, it } from "bun:test"
import { availableRewindModes, rewindDraft, findOriginatingUserPrompt, resolveRewindUiCutoff } from "../../src/ui/dialog-rewind.js"
import { replaceConversationMessages } from "../../src/ui/dialog-sessions.js"
import { sessionLogsToMessages } from "../../src/session.js"
import { ConversationManager } from "../../zapsdk/memory/conversation.js"
import type { LogEntry } from "../../src/ui/types.js"
import type { Snapshot } from "../../zapsdk/checkpoint/types.js"

function snapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    id: "snap",
    turnStartIndex: 0,
    sessionId: "session",
    timestamp: new Date(0).toISOString(),
    trackedFiles: { "a.ts": { kind: "absent" } },
    parentId: null,
    ...overrides,
  }
}

function log(
  id: number,
  type: LogEntry["type"],
  start: number,
  end: number,
): LogEntry {
  return { id, type, text: type, journalStartIndex: start, journalEndIndex: end }
}

describe("resolveRewindUiCutoff", () => {
  it("uses the exact UI boundary for new snapshots", () => {
    const logs = [log(1, "user", 0, 1), log(2, "agent", 1, 8), log(3, "divider", 8, 8)]
    expect(resolveRewindUiCutoff(logs, snapshot({ uiLogIndex: 2, journalLogIndex: 99 }))).toBe(2)
  })

  it("maps a legacy journal boundary across merged chunks and UI dividers", () => {
    const logs = [
      log(1, "user", 0, 1),
      log(2, "agent", 1, 11), // ten restored stream chunks merged into one row
      log(3, "divider", 11, 11),
      log(4, "user", 11, 12),
      log(5, "agent", 12, 13),
      log(6, "divider", 13, 13),
    ]
    expect(resolveRewindUiCutoff(logs, snapshot({ logIndex: 11 }))).toBe(3)
  })

  it("does not apply a journal count directly to unmapped live UI logs", () => {
    const logs: LogEntry[] = [{ id: 1, type: "user", text: "u" }]
    expect(resolveRewindUiCutoff(logs, snapshot({ logIndex: 20 }))).toBe(1)
  })

  it("uses uiLogIndex rather than the journal index for the snapshot label", () => {
    const logs: LogEntry[] = [
      { id: 1, type: "user", text: "older prompt" },
      { id: 2, type: "user", text: "selected prompt" },
    ]
    expect(findOriginatingUserPrompt(
      snapshot({ uiLogIndex: 1, logIndex: 0 }),
      logs,
    )).toBe("selected prompt")
  })
})

describe("rewind conversation restore", () => {
  it("replaces a compacted in-memory branch with marker-filtered persisted history", () => {
    const conversation = new ConversationManager({ maxMessages: 100 })
    conversation.add({ role: "system", content: "system" })
    conversation.add({ role: "user", content: "[compacted summary]" })
    conversation.add({ role: "user", content: "abandoned future" })

    const restored = sessionLogsToMessages([
      { type: "user", text: "kept turn" },
      { type: "agent", text: "kept reply" },
    ])
    replaceConversationMessages(conversation, restored)

    expect(conversation.getAllMessages().map(message => message.content)).toEqual([
      "kept turn",
      "kept reply",
    ])
  })
})


describe("rewind mode and prompt contract", () => {
  it("offers conversation recovery for pure chat and all three modes for tracked edits", () => {
    expect(availableRewindModes({ filesChanged: [], totalInsertions: 0, totalDeletions: 0 })).toEqual(["conversation"])
    expect(availableRewindModes({ filesChanged: [{ path: "file", insertions: 1, deletions: 0 }], totalInsertions: 1, totalDeletions: 0 })).toEqual(["both", "conversation", "code"])
  })
  it("restores the original expanded prompt and image IDs rather than a truncated display label", () => {
    const logs: LogEntry[] = [{ id: 1, type: "user", text: "short preview [Image #7]", restoreText: "full original prompt [Image #7]",
      images: [{ filePath: "/tmp/image.png", mediaType: "image/png", source: "file" }] }]
    expect(rewindDraft(snapshot({ uiLogIndex: 0 }), logs)).toEqual({ text: "full original prompt [Image #7]", imageRefs: { "7": "/tmp/image.png" } })
  })
  it("uses durable prompt metadata after an interrupted turn without a UI row", () => {
    const point = snapshot({ kind: "turn", prompt: "interrupted prompt" })
    expect(rewindDraft(point, []).text).toBe("interrupted prompt")
    expect(findOriginatingUserPrompt(point, [])).toBe("interrupted prompt")
  })
})

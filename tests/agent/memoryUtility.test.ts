import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import {
  buildMemoryUtilityCandidates,
  fingerprintMemoryUtilityText,
  MemoryUtilityTracker,
  sanitizeMemoryUtilityAttribution,
} from "../../src/agent/memoryUtility.js"
import type { MdMemoryRecord } from "../../zapsdk/memory/md-store.js"

describe("MemoryUtilityTracker", () => {
  it("attributes unique assistant evidence while excluding phrases already present in the user input", () => {
    const memoryDir = "/tmp/project-memory"
    const body = "When cache telemetry is missing, compare static prompt hashes and tool schema hashes before changing prompt assembly.\n"
    const [candidate] = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir,
      records: [record("cache_diagnostics", body)],
      included: ["cache_diagnostics.md"],
    })
    const tracker = new MemoryUtilityTracker([candidate], "/repo")

    tracker.handle({ type: "run_started", input: body.trim() })
    tracker.handle({ type: "content_final", kind: "text", id: "t1", text: body.trim() })
    expect(tracker.summarize().records[0]).not.toMatchObject({ used: true })

    tracker.handle({ type: "run_started", input: "Investigate the cache hit rate." })
    tracker.handle({ type: "content_final", kind: "text", id: "t2", text: body.trim() })
    expect(tracker.summarize().records[0]).toMatchObject({
      used: true,
      avoidedReRead: true,
      evidence: ["content_overlap"],
    })
  })

  it("counts a successful explicit read as use but not an avoided re-read", () => {
    const memoryDir = "/tmp/project-memory"
    const [candidate] = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir,
      records: [record("release_process", "Release verification requires architecture and signature evidence.\n")],
      included: ["release_process.md"],
      excerpted: ["release_process.md"],
    })
    const tracker = new MemoryUtilityTracker([candidate], "/repo")
    tracker.handle({ type: "run_started", input: "Prepare the release." })
    tracker.handle({
      type: "content_final",
      kind: "tool_call",
      id: "read-1",
      step: 1,
      toolName: "read_file",
      arguments: { path: join(memoryDir, "release_process.md") },
    })
    tracker.handle({
      type: "content_final",
      kind: "tool_result",
      id: "read-1",
      step: 1,
      toolName: "read_file",
      result: { success: true, output: "memory body" },
    })

    expect(tracker.summarize().records[0]).toEqual({
      scope: "project",
      filename: "release_process.md",
      excerpted: true,
      read: true,
      used: true,
      evidence: ["explicit_read"],
    })
  })

  it("subtracts the full recall-query baseline on low-signal continuation turns", () => {
    const body = "Historical cache diagnosis requires comparing provider usage coverage before changing prompts.\n"
    const [candidate] = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/project-memory",
      records: [record("cache_history", body)],
      included: ["cache_history.md"],
    })
    const tracker = new MemoryUtilityTracker(
      [candidate],
      "/repo",
      fingerprintMemoryUtilityText(body),
    )

    tracker.handle({ type: "run_started", input: "Continue." })
    tracker.handle({ type: "content_final", kind: "text", id: "t1", text: body })

    expect(tracker.summarize()).toMatchObject({ selected: 1, used: 0, avoidedReRead: 0 })
  })

  it("does not count failed reads or shared generic evidence as use", () => {
    const memoryDir = "/tmp/project-memory"
    const shared = "Always verify the current state before making a production change.\n"
    const candidates = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir,
      records: [record("first", shared), record("second", shared)],
      included: ["first.md", "second.md"],
    })
    const tracker = new MemoryUtilityTracker(candidates, "/repo")
    tracker.handle({ type: "run_started", input: "Continue." })
    tracker.handle({ type: "content_final", kind: "text", id: "t1", text: shared })
    tracker.handle({
      type: "content_final",
      kind: "tool_call",
      id: "read-failed",
      step: 1,
      toolName: "read_file",
      arguments: { path: join(memoryDir, "first.md") },
    })
    tracker.handle({
      type: "content_final",
      kind: "tool_result",
      id: "read-failed",
      step: 1,
      toolName: "read_file",
      result: { success: false, output: "", error: "missing" },
    })

    expect(tracker.summarize()).toMatchObject({ selected: 2, read: 0, used: 0 })
  })

  it("does not synthesize phrase evidence across sentence boundaries", () => {
    const candidates = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/project-memory",
      records: [record("fragmented", "cache prefix. shape stability\n\u7f13\u5b58\u7a33\u5b9a\u3002\u524d\u7f00\u7ed3\u6784\n")],
      included: ["fragmented.md"],
    })
    const tracker = new MemoryUtilityTracker(candidates, "/repo")
    tracker.handle({ type: "run_started", input: "Continue." })
    tracker.handle({
      type: "content_final",
      kind: "text",
      id: "t1",
      text: "cache prefix shape stability \u7f13\u5b58\u7a33\u5b9a\u524d\u7f00\u7ed3\u6784",
    })

    expect(tracker.summarize()).toMatchObject({ selected: 1, used: 0 })
  })

  it("marks successful supersession as a revision and contradiction", () => {
    const [candidate] = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/project-memory",
      records: [record("old_release", "The release is scheduled for July.\n")],
      included: ["old_release.md"],
    })
    const tracker = new MemoryUtilityTracker([candidate], "/repo")
    tracker.handle({ type: "run_started", input: "Update the release schedule." })
    tracker.handle({
      type: "content_final",
      kind: "tool_call",
      id: "save-1",
      step: 1,
      toolName: "memory_save",
      arguments: {
        type: "project",
        name: "current_release",
        confidence: "high",
        supersedes: ["old_release"],
        content: "The release is scheduled for August.",
      },
    })
    tracker.handle({
      type: "content_final",
      kind: "tool_result",
      id: "save-1",
      step: 1,
      toolName: "memory_save",
      result: { success: true, output: "saved current_release.md (project)" },
    })

    const attributed = tracker.summarize().records[0]
    expect(attributed).toMatchObject({
      used: true,
      avoidedReRead: true,
      revised: true,
      contradicted: true,
    })
    expect(attributed?.evidence?.includes("content_overlap")).toBe(true)
    expect(attributed?.evidence?.includes("memory_update")).toBe(true)
    expect(attributed?.evidence?.includes("superseded")).toBe(true)
  })

  it("requires a real successful memory save before recording a revision", () => {
    const [candidate] = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/project-memory",
      records: [record("release_state", "The release is scheduled for July.\n")],
      included: ["release_state.md"],
    })
    const tracker = new MemoryUtilityTracker([candidate], "/repo")
    tracker.handle({ type: "run_started", input: "Update the release schedule." })

    for (const [id, result] of [
      ["save-failed", { success: false, output: "", error: "denied" }],
      ["save-noop", { success: true, output: "not saved: equivalent memory already exists" }],
    ] as const) {
      tracker.handle({
        type: "content_final",
        kind: "tool_call",
        id,
        step: 1,
        toolName: "memory_save",
        arguments: {
          type: "project",
          name: "release_state",
          description: "release state",
          content: "The release is scheduled for August.",
        },
      })
      tracker.handle({
        type: "content_final",
        kind: "tool_result",
        id,
        step: 1,
        toolName: "memory_save",
        result,
      })
    }

    expect(tracker.summarize()).toMatchObject({ revised: 0, contradicted: 0 })
  })

  it("records a successful memory merge against each selected source", () => {
    const candidates = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/project-memory",
      records: [
        record("first_release_note", "Release evidence includes the artifact checksum.\n"),
        record("second_release_note", "Release evidence includes the signing identity.\n"),
      ],
      included: ["first_release_note.md", "second_release_note.md"],
    })
    const tracker = new MemoryUtilityTracker(candidates, "/repo")
    tracker.handle({ type: "run_started", input: "Consolidate the release notes." })
    tracker.handle({
      type: "content_final",
      kind: "tool_call",
      id: "merge-1",
      step: 1,
      toolName: "memory_merge",
      arguments: {
        sources: [
          { scope: "project", name: "first_release_note" },
          { scope: "project", name: "second_release_note" },
        ],
        target: {
          type: "project",
          name: "release_evidence",
          description: "release evidence",
          content: "Keep checksum and signing evidence.",
        },
      },
    })
    tracker.handle({
      type: "content_final",
      kind: "tool_result",
      id: "merge-1",
      step: 1,
      toolName: "memory_merge",
      result: { success: true, output: "merged 2 memories into release_evidence.md (project)" },
    })

    expect(tracker.summarize()).toMatchObject({ selected: 2, revised: 2, contradicted: 0 })
    expect(tracker.summarize().records.every((item) =>
      item.evidence?.includes("memory_merge"))).toBe(true)
  })

  it("keeps raw memory and assistant text out of persisted attribution", () => {
    const secret = "private-release-secret-phrase belongs only in memory"
    const [candidate] = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/project-memory",
      records: [record("private_note", `${secret}\n`)],
      included: ["private_note.md"],
    })
    const tracker = new MemoryUtilityTracker([candidate], "/repo")
    tracker.handle({ type: "run_started", input: "Continue." })
    tracker.handle({ type: "content_final", kind: "text", id: "t1", text: secret })

    const serialized = JSON.stringify(tracker.summarize())
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("private-release")
  })

  it("drops persisted evidence that contradicts the sanitized outcome", () => {
    expect(sanitizeMemoryUtilityAttribution({
      selected: 999,
      records: [{
        scope: "project",
        filename: "excerpted_note.md",
        excerpted: true,
        used: true,
        avoidedReRead: true,
        overlapScore: 0.8,
        evidence: ["content_overlap", "explicit_read", "memory_update", "superseded"],
      }],
    })).toEqual({
      selected: 1,
      read: 0,
      used: 1,
      revised: 0,
      contradicted: 0,
      avoidedReRead: 0,
      records: [{
        scope: "project",
        filename: "excerpted_note.md",
        excerpted: true,
        used: true,
      }],
    })
  })

  it("rejects invalid overlap policies instead of silently widening attribution", () => {
    expect(() => new MemoryUtilityTracker([], "/repo", undefined, {
      minMatchedLines: 0,
      minMatchedPhrases: 2,
    })).toThrow("minMatchedLines must be a positive integer")
    expect(() => new MemoryUtilityTracker([], "/repo", undefined, {
      minMatchedLines: 1,
      minMatchedPhrases: 1.5,
    })).toThrow("minMatchedPhrases must be a positive integer")
  })
})

function record(name: string, body: string): MdMemoryRecord {
  return {
    filename: `${name}.md`,
    frontmatter: {
      name,
      description: `${name} memory`,
      type: "project",
    },
    body,
  }
}

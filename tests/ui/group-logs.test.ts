import { describe, it, expect } from "bun:test"
import type { LogEntry } from "../../src/ui/types.js"
import {
  batchAgentGroups,
  groupLogs,
  partitionRenderItems,
  shortAgentLabel,
  summarizeAgentGroup,
} from "../../src/ui/group-logs.js"

function logFor(overrides: Partial<LogEntry> & { id: number; type: LogEntry["type"] }): LogEntry {
  return { text: "", ...overrides }
}

describe("shortAgentLabel", () => {
  it("returns placeholder when task is missing or empty", () => {
    expect(shortAgentLabel(undefined)).toBe("…")
    expect(shortAgentLabel("")).toBe("…")
    expect(shortAgentLabel("   \n  ")).toBe("…")
  })

  it("takes the first line, trimmed", () => {
    expect(shortAgentLabel("Investigate auth module\n\nfind bugs")).toBe("Investigate auth module")
    expect(shortAgentLabel("  a short task  ")).toBe("a short task")
  })

  it("leaves short lines unchanged (no ellipsis)", () => {
    expect(shortAgentLabel("Review auth module")).toBe("Review auth module")
  })

  it("truncates long English tasks at a late word boundary with ellipsis", () => {
    const task = "Research the current trends and developments of Large Language Models in the United States"
    const out = shortAgentLabel(task)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(41) // LABEL_MAX + trailing ellipsis
    expect(out).toContain("Research")
    // Must break between whole words — the character just before "…" should
    // be the END of a word (no trailing space), but the broken word must be
    // fully present (we sliced at a space, so we never split a word in two).
    const beforeEllipsis = out.slice(0, -1)
    expect(beforeEllipsis).not.toMatch(/ $/)
    // Every word that appears should also appear whole in the source
    for (const word of beforeEllipsis.split(/\s+/)) {
      if (word) expect(task).toContain(word)
    }
  })

  it("hard-slices CJK (no ASCII spaces) cleanly when over the limit", () => {
    // Long enough to clear LABEL_MAX (40) even with CJK chars.
    const task = "调研中国大语言模型的开源闭源生态最新进展以及商业落地情况还有各家厂商的技术路线和融资趋势"
    const out = shortAgentLabel(task)
    expect(out.endsWith("…")).toBe(true)
    expect(out).toContain("调研")
  })

  it("does not truncate non-BMP labels when code units exceed the cap but code points fit", () => {
    const task = "😀".repeat(40)
    expect(shortAgentLabel(task)).toBe(task)
  })

  it("hard-slices non-BMP labels without splitting surrogate pairs", () => {
    const out = shortAgentLabel("😀".repeat(41))
    expect(out).toBe(`${"😀".repeat(40)}…`)
    expect(hasUnpairedSurrogate(out)).toBe(false)
  })
})

describe("groupLogs: pass-through cases", () => {
  it("returns empty for empty input", () => {
    expect(groupLogs([])).toEqual([])
  })

  it("leaves a flat root-only transcript untouched", () => {
    const logs: LogEntry[] = [
      logFor({ id: 1, type: "user", text: "hi" }),
      logFor({ id: 2, type: "agent", text: "hello" }),
      logFor({
        id: 3,
        type: "tool",
        tool: { name: "read_file", id: "call_a", arguments: { path: "a.ts" } },
      }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(3)
    expect(out.every((e) => e.kind === "log")).toBe(true)
  })

  it("creates a provisional queued group before sub_agent_started", () => {
    // The orphan child stays inline because it cannot be safely attributed,
    // while the pending parent is still represented as a queued group.
    const logs: LogEntry[] = [
      logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", id: "call_p", arguments: { task: "X" } },
      }),
      logFor({
        id: 2,
        type: "result",
        tool: { name: "web_search", arguments: { query: "q" }, output: "..." },
        agentPath: ["sa_xxx"],
      }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(2)
    expect(out[0]?.kind).toBe("group")
    expect(out[1]?.kind).toBe("log")
    if (out[0]?.kind === "group") expect(out[0].group.started).toBe(false)
  })
})

describe("groupLogs: happy path", () => {
  it("groups children under parent when meta.subagentId is known", () => {
    const logs: LogEntry[] = [
      logFor({
        id: 10,
        type: "tool",
        tool: {
          name: "agent",
          id: "call_p",
          arguments: { task: "Research US LLM trends" },
          meta: { subagentId: "sa_us" },
        },
      }),
      logFor({
        id: 11,
        type: "result",
        tool: { name: "web_search", arguments: { query: "OpenAI" }, output: "..." },
        agentPath: ["sa_us"],
      }),
      logFor({
        id: 12,
        type: "result",
        tool: { name: "web_search", arguments: { query: "Claude" }, output: "..." },
        agentPath: ["sa_us"],
      }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(1)
    expect(out[0].kind).toBe("group")
    if (out[0].kind === "group") {
      expect(out[0].group.subagentId).toBe("sa_us")
      expect(out[0].group.parent?.id).toBe(10)
      expect(out[0].group.children.map((c) => c.id)).toEqual([11, 12])
    }
  })

  it("handles 3 parallel agents with interleaved child events", () => {
    const logs: LogEntry[] = [
      // Three parallel agent tool_calls, each with known subagentId
      logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", id: "c1", arguments: { task: "US" }, meta: { subagentId: "sa_us" } },
      }),
      logFor({
        id: 2,
        type: "tool",
        tool: { name: "agent", id: "c2", arguments: { task: "CN" }, meta: { subagentId: "sa_cn" } },
      }),
      logFor({
        id: 3,
        type: "tool",
        tool: { name: "agent", id: "c3", arguments: { task: "EU" }, meta: { subagentId: "sa_eu" } },
      }),
      // Interleaved children from all three
      logFor({ id: 4, type: "result", tool: { name: "web_search" }, agentPath: ["sa_us"] }),
      logFor({ id: 5, type: "result", tool: { name: "web_search" }, agentPath: ["sa_cn"] }),
      logFor({ id: 6, type: "result", tool: { name: "web_search" }, agentPath: ["sa_us"] }),
      logFor({ id: 7, type: "result", tool: { name: "web_search" }, agentPath: ["sa_eu"] }),
      logFor({ id: 8, type: "result", tool: { name: "web_search" }, agentPath: ["sa_cn"] }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(3)
    expect(out.every((e) => e.kind === "group")).toBe(true)
    if (out[0].kind === "group" && out[1].kind === "group" && out[2].kind === "group") {
      expect(out[0].group.subagentId).toBe("sa_us")
      expect(out[0].group.children.map((c) => c.id)).toEqual([4, 6])
      expect(out[1].group.subagentId).toBe("sa_cn")
      expect(out[1].group.children.map((c) => c.id)).toEqual([5, 8])
      expect(out[2].group.subagentId).toBe("sa_eu")
      expect(out[2].group.children.map((c) => c.id)).toEqual([7])
    }
  })

  it("preserves non-agent logs around groups", () => {
    const logs: LogEntry[] = [
      logFor({ id: 1, type: "user", text: "go" }),
      logFor({
        id: 2,
        type: "tool",
        tool: { name: "agent", id: "c1", arguments: { task: "T" }, meta: { subagentId: "sa_a" } },
      }),
      logFor({ id: 3, type: "result", tool: { name: "web_search" }, agentPath: ["sa_a"] }),
      logFor({ id: 4, type: "agent", text: "done" }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(3)
    expect(out[0].kind).toBe("log")
    expect(out[1].kind).toBe("group")
    expect(out[2].kind).toBe("log")
    if (out[0].kind === "log") expect(out[0].log.id).toBe(1)
    if (out[2].kind === "log") expect(out[2].log.id).toBe(4)
  })

  it("nested-subagent children (path length >1) belong to the TOP-level parent", () => {
    // v1 flattening: a tool call from sa_inner nested under sa_outer still
    // rolls up to sa_outer's group so users see one collapsible unit per
    // root-level agent() call.
    const logs: LogEntry[] = [
      logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", id: "c", arguments: { task: "T" }, meta: { subagentId: "sa_outer" } },
      }),
      logFor({ id: 2, type: "result", tool: { name: "read_file" }, agentPath: ["sa_outer"] }),
      logFor({ id: 3, type: "result", tool: { name: "web_search" }, agentPath: ["sa_outer", "sa_inner"] }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(1)
    if (out[0].kind === "group") {
      expect(out[0].group.children.map((c) => c.id)).toEqual([2, 3])
    }
  })

  it("keeps the agent parent log itself out of children (no self-nesting)", () => {
    const logs: LogEntry[] = [
      logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", id: "c", arguments: { task: "T" }, meta: { subagentId: "sa_a" } },
      }),
    ]
    const out = groupLogs(logs)
    expect(out.length).toBe(1)
    if (out[0].kind === "group") {
      expect(out[0].group.children.length).toBe(0)
    }
  })
})

describe("agent batch presentation", () => {
  it("coalesces adjacent parallel groups into one batch", () => {
    const logs: LogEntry[] = [
      logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", id: "c1", arguments: { task: "Fees" }, meta: { subagentId: "sa_1" } },
      }),
      logFor({
        id: 2,
        type: "tool",
        tool: { name: "agent", id: "c2", arguments: { task: "Policy" }, meta: { subagentId: "sa_2" } },
      }),
      logFor({ id: 3, type: "result", tool: { name: "web_search" }, agentPath: ["sa_1"] }),
      logFor({ id: 4, type: "result", tool: { name: "http_fetch" }, agentPath: ["sa_2"] }),
    ]

    const items = batchAgentGroups(groupLogs(logs))
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("agent-batch")
    if (items[0]?.kind === "agent-batch") {
      expect(items[0].batch.groups.map(group => group.subagentId)).toEqual(["sa_1", "sa_2"])
    }
  })

  it("batches started and queued agent calls from the first frame", () => {
    const logs: LogEntry[] = [
      logFor({
        id: 1,
        type: "tool",
        tool: {
          name: "agent",
          id: "c1",
          arguments: { task: "Fees" },
          meta: { subagentId: "sa_1" },
        },
      }),
      logFor({
        id: 2,
        type: "tool",
        tool: { name: "agent", id: "c2", arguments: { task: "IAP" } },
      }),
      logFor({
        id: 3,
        type: "tool",
        tool: { name: "agent", id: "c3", arguments: { task: "Policy" } },
      }),
      logFor({ id: 4, type: "result", tool: { name: "web_search" }, agentPath: ["sa_1"] }),
    ]
    const items = batchAgentGroups(groupLogs(logs))
    expect(items).toHaveLength(1)
    if (items[0]?.kind === "agent-batch") {
      expect(items[0].batch.groups.map(group => summarizeAgentGroup(group).status)).toEqual([
        "running",
        "queued",
        "queued",
      ])
    }
  })

  it("summarizes running and completed agents without exposing raw ids", () => {
    const running = summarizeAgentGroup({
      id: 1,
      subagentId: "sa_private_id",
      parent: logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", arguments: { task: "Research App Store fees" } },
      }),
      children: [
        logFor({
          id: 2,
          type: "result",
          tool: { name: "web_search", arguments: { query: "Apple fees" } },
          agentPath: ["sa_private_id"],
        }),
      ],
    })
    expect(running.status).toBe("running")
    expect(running.label).toBe("Research App Store fees")
    expect(running.actionCount).toBe(1)
    expect(running.latestTool?.name).toBe("web_search")
    expect(JSON.stringify(running)).not.toContain("sa_private_id")

    const completed = summarizeAgentGroup({
      id: 3,
      subagentId: "sa_done",
      parent: logFor({
        id: 3,
        type: "result",
        text: "done",
        tool: {
          name: "agent",
          arguments: { task: "Research policy" },
          output: "Apple changed external-link rules in 2025.\nMore details follow.",
          success: true,
          meta: { agentType: "explore", durationMs: 12_500 },
        },
      }),
      children: [],
    })
    expect(completed.status).toBe("succeeded")
    expect(completed.agentType).toBe("explore")
    expect(completed.durationMs).toBe(12_500)
    expect(completed.outputPreview).toBe("Apple changed external-link rules in 2025. More details follow.")
  })

  it("prefers authoritative AgentRun state over transcript inference", () => {
    const summary = summarizeAgentGroup({
      id: 1,
      subagentId: "sa_approval",
      started: false,
      parent: logFor({
        id: 1,
        type: "tool",
        tool: { name: "agent", id: "call-1", arguments: { task: "Apply patch" } },
      }),
      children: [],
    }, {
      runId: "sa_approval",
      toolCallId: "call-1",
      agentType: "general",
      task: "Apply patch",
      status: "waiting_approval",
      sequence: 3,
      createdAt: 10,
      updatedAt: 20,
      startedAt: 10,
    })

    expect(summary.status).toBe("waiting_approval")
    expect(summary.agentType).toBe("general")
  })

  it("keeps scheduler and merge states free of stale output previews", () => {
    const group = {
      id: 1,
      subagentId: "run-wait",
      started: true,
      parent: logFor({
        id: 1,
        type: "result",
        tool: {
          name: "agent",
          arguments: { task: "wait" },
          output: "stale output",
          success: true,
        },
      }),
      children: [],
    }
    for (const status of [
      "waiting_dependency",
      "waiting_capacity",
      "waiting_input",
      "cancelling",
      "validating",
      "ready_to_merge",
      "merging",
    ] as const) {
      expect(summarizeAgentGroup(group, {
        runId: "run-wait",
        agentType: "general",
        task: "wait",
        status,
        sequence: 1,
        createdAt: 1,
        updatedAt: 2,
      }).outputPreview).toBe("")
    }
  })

  it("keeps the suffix from the earliest running agent batch dynamic", () => {
    const logs: LogEntry[] = [
      logFor({ id: 1, type: "user", text: "research" }),
      logFor({
        id: 2,
        type: "tool",
        tool: { name: "agent", id: "c1", arguments: { task: "Fees" }, meta: { subagentId: "sa_1" } },
      }),
      logFor({
        id: 3,
        type: "tool",
        tool: { name: "agent", id: "c2", arguments: { task: "Policy" }, meta: { subagentId: "sa_2" } },
      }),
      logFor({ id: 4, type: "result", tool: { name: "web_search" }, agentPath: ["sa_1"] }),
    ]
    const partition = partitionRenderItems(batchAgentGroups(groupLogs(logs)))
    expect(partition.committed).toHaveLength(1)
    expect(partition.dynamic).toHaveLength(1)
    expect(partition.dynamic[0]?.kind).toBe("agent-batch")
  })

  it("keeps live status and its suffix dynamic until the status settles", () => {
    const logs: LogEntry[] = [
      logFor({ id: 1, type: "user", text: "continue" }),
      logFor({ id: 2, type: "system", text: "recovering", pending: true }),
      logFor({ id: 3, type: "system", text: "provider connected" }),
    ]
    const pending = partitionRenderItems(batchAgentGroups(groupLogs(logs)))
    expect(pending.committed).toHaveLength(1)
    expect(pending.dynamic).toHaveLength(2)
    logs[1] = { ...logs[1]!, text: "recovered", pending: false }
    const settled = partitionRenderItems(batchAgentGroups(groupLogs(logs)))
    expect(settled.committed).toHaveLength(3)
    expect(settled.dynamic).toHaveLength(0)
  })

  it("commits a completed batch as one stable item", () => {
    const logs: LogEntry[] = [
      logFor({
        id: 1,
        type: "result",
        text: "done",
        tool: {
          name: "agent",
          id: "c1",
          arguments: { task: "Fees" },
          success: true,
          meta: { subagentId: "sa_1" },
        },
      }),
      logFor({ id: 2, type: "result", tool: { name: "web_search" }, agentPath: ["sa_1"] }),
    ]
    const partition = partitionRenderItems(batchAgentGroups(groupLogs(logs)))
    expect(partition.dynamic).toEqual([])
    expect(partition.committed).toHaveLength(1)
    expect(partition.committed[0]?.kind).toBe("agent-batch")
  })
})

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

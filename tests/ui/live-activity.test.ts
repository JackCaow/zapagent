import { describe, expect, test } from "bun:test"
import {
  activityProgress,
  buildLiveActivityCopy,
  formatActivityDuration,
} from "../../src/ui/activity-status.js"
import {
  collectPendingTools,
  formatPendingToolsLabel,
} from "../../src/ui/live-activity.js"
import type { LogEntry } from "../../src/ui/types.js"

describe("live activity status", () => {
  test("labels growing reasoning with an explicit unit", () => {
    expect(buildLiveActivityCopy({
      primaryLabel: "Thinking",
      elapsedSeconds: 143,
      isThinking: true,
      thinkingChars: 57_000,
      activeToolBytes: 0,
      progressIdleSeconds: 1,
    })).toEqual({
      primaryLabel: "Thinking",
      elapsed: "2m 23s",
      progress: "receiving reasoning · 57K chars",
      mayBeStalled: false,
    })
  })

  test("distinguishes a quiet reasoning stream from a live stream", () => {
    expect(buildLiveActivityCopy({
      primaryLabel: "Thinking",
      elapsedSeconds: 45,
      isThinking: true,
      thinkingChars: 12_400,
      activeToolBytes: 0,
      progressIdleSeconds: 24,
    }).progress).toBe("no new reasoning for 24s · 12K chars")
  })

  test("marks a prolonged lack of meaningful output as a possible stall", () => {
    expect(buildLiveActivityCopy({
      primaryLabel: "Thinking",
      elapsedSeconds: 90,
      isThinking: true,
      thinkingChars: 12_400,
      activeToolBytes: 0,
      progressIdleSeconds: 65,
    })).toEqual({
      primaryLabel: "Waiting for model",
      elapsed: "1m 30s",
      progress: "no new reasoning for 1m 5s · 12K chars",
      mayBeStalled: true,
    })
  })

  test("does not infer a network phase from elapsed time", () => {
    expect(buildLiveActivityCopy({
      primaryLabel: "Thinking",
      elapsedSeconds: 18,
      isThinking: false,
      thinkingChars: 0,
      activeToolBytes: 0,
      progressIdleSeconds: 18,
    }).progress).toBe("")
  })

  for (const [phase, text] of [
    ["requesting", "waiting for HTTP response"],
    ["waiting_output", "response received · waiting for first model output"],
    ["retrying", "HTTP_503 · backoff 1s"],
  ] as const) {
    test(`shows observed ${phase} despite stale previous-step reasoning`, () => {
      const copy = buildLiveActivityCopy({
        primaryLabel: "Thinking", elapsedSeconds: 18, isThinking: true,
        thinkingChars: 5_000, activeToolBytes: 0, progressIdleSeconds: 18,
        providerRequest: { phase, attempt: 2, maxAttempts: 3, startedAt: Date.now(), at: Date.now(), elapsedMs: 0,
          reason: "HTTP_503", delayMs: 1_000 },
      })
      expect(copy.progress).toBe(`${text} · attempt 2/3`)
      expect(copy.primaryLabel).toBe(phase === "retrying" ? "Retrying provider" : "Waiting for provider")
    })
  }

  test("tool argument generation wins over stale reasoning progress", () => {
    expect(activityProgress(true, 57_000, 12_500)).toEqual({
      kind: "tool-args",
      value: 12_500,
    })
    expect(buildLiveActivityCopy({
      primaryLabel: "Write",
      elapsedSeconds: 8,
      isThinking: true,
      thinkingChars: 57_000,
      activeToolBytes: 12_500,
      progressIdleSeconds: 0,
    }).progress).toBe("generating tool input · 13 KB")
  })

  test("formats elapsed time for long phases", () => {
    expect(formatActivityDuration(59)).toBe("59s")
    expect(formatActivityDuration(60)).toBe("1m")
    expect(formatActivityDuration(143)).toBe("2m 23s")
  })

  test("summarizes parallel agents instead of exposing only the first task", () => {
    const pending = ["Fees", "IAP settlement", "Policy"].map((task, index): LogEntry => ({
      id: index + 1,
      type: "tool",
      text: "agent",
      tool: {
        name: "agent",
        arguments: { task },
        ...(index === 0 ? { meta: { subagentId: "sa_started" } } : {}),
      },
    }))
    expect(formatPendingToolsLabel(pending)).toBe("◇ 3 agents · 1 running · 2 queued")
  })

  test("keeps the complete pending set when more than three agents are active", () => {
    const logs = ["Fees", "IAP settlement", "Tax", "Policy"].map((task, index): LogEntry => ({
      id: index + 1,
      type: "tool",
      text: "agent",
      tool: {
        id: `agent_${index}`,
        name: "agent",
        arguments: { task },
        ...(index === 0 ? { meta: { subagentId: "sa_started" } } : {}),
      },
    }))

    const pending = collectPendingTools(logs)

    expect(pending).toHaveLength(4)
    expect(formatPendingToolsLabel(pending)).toBe("◇ 4 agents · 1 running · 3 queued")
  })

  test("removes completed tools without hiding earlier pending calls", () => {
    const logs: LogEntry[] = [
      { id: 1, type: "tool", text: "agent", tool: { id: "a", name: "agent" } },
      { id: 2, type: "tool", text: "agent", tool: { id: "b", name: "agent" } },
      { id: 3, type: "tool", text: "agent", tool: { id: "c", name: "agent" } },
      { id: 4, type: "tool", text: "agent", tool: { id: "d", name: "agent" } },
      { id: 5, type: "result", text: "done", tool: { id: "b", name: "agent" } },
    ]

    expect(collectPendingTools(logs).map(log => log.tool?.id)).toEqual(["a", "c", "d"])
  })

  test("excludes nested agent tools from the root activity summary", () => {
    const logs: LogEntry[] = [
      {
        id: 1,
        type: "tool",
        text: "agent",
        tool: { id: "agent_a", name: "agent", meta: { subagentId: "sa_a" } },
      },
      {
        id: 2,
        type: "tool",
        text: "read_file",
        tool: { id: "read_a", name: "read_file" },
        agentPath: ["sa_a"],
      },
    ]

    const pending = collectPendingTools(logs)

    expect(pending.map(log => log.tool?.id)).toEqual(["agent_a"])
    expect(formatPendingToolsLabel(pending)).toBe("◇ Agent")
  })
})

test("shows steps-only bash activity before argument normalization", () => {
  expect(formatPendingToolsLabel([{ id: 1, type: "tool", text: "bash", tool: { id: "check", name: "bash", arguments: { check_steps: ["echo first", "echo second"] } } }])).toContain("(echo first) && (echo second)")
})

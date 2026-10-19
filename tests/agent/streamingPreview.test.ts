import { describe, expect, test } from "bun:test"
import {
  createStreamingPreview,
  FROZEN_STREAM_PREVIEW_FRAME_MS,
  limitStreamingTailForDisplay,
  STREAM_PREVIEW_FRAME_MS,
  STREAM_PREVIEW_MAX_CHARS,
  STREAM_PREVIEW_MAX_LINES,
} from "../../src/agent/streamingPreview.js"
import type { LogEntry, LogType, ToolCallInfo, UserImageRef } from "../../src/ui/types.js"

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createHarness(initialFrozen = false) {
  const logs: LogEntry[] = []
  const streamingText: string[] = []
  const thinkingText: string[] = []
  const streamingFlags: boolean[] = []
  const thinkingFlags: boolean[] = []
  let frozen = initialFrozen

  const preview = createStreamingPreview({
    addLog(
      type: LogType,
      text: string,
      tool?: ToolCallInfo,
      images?: UserImageRef[],
      agentPath?: string[],
      extra?: Partial<LogEntry>,
    ) {
      logs.push({ id: logs.length + 1, type, text, tool, images, agentPath, ...extra })
    },
    setStreamingText: value => streamingText.push(value),
    setIsStreaming: value => streamingFlags.push(value),
    setThinkingText: value => thinkingText.push(value),
    setIsThinking: value => thinkingFlags.push(value),
    getIsFrozen: () => frozen,
  })

  return {
    logs,
    preview,
    streamingText,
    thinkingText,
    streamingFlags,
    thinkingFlags,
    setFrozen(value: boolean) { frozen = value },
  }
}

describe("streaming preview frame budget", () => {
  test("discarding unfinished thinking cancels pending paint and abort persistence", async () => {
    const harness = createHarness()
    harness.preview.onThinkingDelta("old", "abandoned")
    harness.preview.onThinkingFinal("old")
    harness.preview.onThinkingDelta("new", "fresh")
    await wait(STREAM_PREVIEW_FRAME_MS * 2)
    harness.preview.drainOnAbort()
    expect(harness.thinkingText).not.toContain("abandoned")
    expect(harness.logs.map(log => log.text).join(" ")).not.toContain("abandoned")
    expect(harness.logs.map(log => log.text).join(" ")).toContain("fresh")
  })
  test("coalesces rapid provider deltas into one live-text update", async () => {
    const harness = createHarness()

    for (let i = 0; i < 100; i++) harness.preview.onTextDelta("text-1", "x")

    expect(harness.streamingText).toEqual([])
    expect(harness.streamingFlags).toEqual([true])

    await wait(STREAM_PREVIEW_FRAME_MS * 2)

    expect(harness.streamingText).toEqual(["x".repeat(100)])
    expect(harness.streamingFlags).toEqual([true])
  })

  test("keeps a frozen live preview bounded while preserving full output", async () => {
    const harness = createHarness(true)
    const full = `${"段".repeat(STREAM_PREVIEW_MAX_CHARS * 4)}\n\n`

    harness.preview.onTextDelta("text-1", full)
    await wait(FROZEN_STREAM_PREVIEW_FRAME_MS * 2)

    const visible = harness.streamingText.at(-1) ?? ""
    expect(visible.startsWith("… live preview trimmed")).toBe(true)
    expect(visible.length).toBeLessThanOrEqual(STREAM_PREVIEW_MAX_CHARS + 64)
    expect(harness.logs.map(log => log.text).join("")).toBe(full)

    harness.preview.onTextFinal("text-1", full)
    expect(harness.streamingText.at(-1)?.startsWith("… live preview trimmed")).toBe(true)

    harness.setFrozen(false)
    harness.preview.onStaticFlushed()
    expect(harness.streamingText.at(-1)).toBe("")
  })

  test("cancels delayed thinking updates when text starts", async () => {
    const harness = createHarness()

    harness.preview.onThinkingDelta("thinking-1", "reasoning")
    harness.preview.onTextDelta("text-1", "answer")
    await wait(STREAM_PREVIEW_FRAME_MS * 2)

    expect(harness.thinkingText).toEqual([""])
    expect(harness.thinkingFlags).toEqual([true, false])
    expect(harness.streamingText).toEqual(["answer"])
  })
})

describe("limitStreamingTailForDisplay", () => {
  test("leaves short previews unchanged", () => {
    expect(limitStreamingTailForDisplay("hello")).toBe("hello")
  })

  test("keeps only a bounded suffix", () => {
    const text = "a".repeat(STREAM_PREVIEW_MAX_CHARS * 2)
    const visible = limitStreamingTailForDisplay(text)

    expect(visible.startsWith("… live preview trimmed")).toBe(true)
    expect(visible.endsWith("a".repeat(STREAM_PREVIEW_MAX_CHARS))).toBe(true)
  })

  test("caps short paragraph streams by logical line count", () => {
    const text = Array.from({ length: 40 }, (_, index) => `paragraph ${index}`).join("\n\n")
    const visible = limitStreamingTailForDisplay(text)
    const visibleLines = visible.split("\n")

    expect(visible.startsWith("… live preview trimmed")).toBe(true)
    expect(visibleLines.length).toBeLessThanOrEqual(STREAM_PREVIEW_MAX_LINES + 2)
    expect(visible.endsWith("paragraph 39")).toBe(true)
  })
})

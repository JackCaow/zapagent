import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { stripVTControlCharacters } from "node:util"
import { LiveActivity } from "../../src/ui/live-activity.js"
import { displayWidth } from "../../src/ui/truncate.js"
import type { GoalView } from "../../src/goal-view.js"

const goal: GoalView = { id: "fixture-goal", objective: "盘点项目", status: "running", phase: "executing", accepted: false }
const props = { isRunning: true, isStreaming: false, isThinking: false, thinkingChars: 0,
  status: "compacting", activeTool: "bash", pendingTools: [], termWidth: 90 }
const render = (overrides: Partial<Parameters<typeof LiveActivity>[0]> = {}, columns = 90) =>
  stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, termWidth: columns, ...overrides }), { columns }))

it("keeps the active Goal pinned while showing compaction instead of stale work", () => {
  const text = render({ goal, goalAttached: true })
  expect(text).toContain("目标：盘点项目")
  expect(text).toContain("Compacting conversation… (0s)")
  expect(text).toContain("Esc twice to stop compaction")
  expect(text).not.toContain("bash")
  expect(text.indexOf("目标：")).toBeLessThan(text.indexOf("Compacting"))
})

it("distinguishes a retained paused Goal from compaction in an ordinary task", () => {
  const text = render({ goal: { ...goal, status: "paused" }, goalAttached: false, stopHint: "Ctrl+C to stop" })
  expect(text).toContain("目标：盘点项目")
  expect(text).toContain("已暂停，进度已保留")
  expect(text).toContain("Compacting conversation")
  expect(text).toContain("Ctrl+C to stop compaction")
  expect(text).not.toContain("已完成")
})

it("keeps the combined strip bounded and leaves the Goal intact when compaction ends", () => {
  for (const columns of [24, 40, 90]) {
    const compact = render({ goal, goalAttached: true }, columns)
    expect(compact).toContain("目标：盘点项目")
    expect(compact).toContain("Compacting")
    for (const line of compact.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
  }
  const resumed = render({ goal, goalAttached: true, status: "working", activeToolBytes: 1 })
  expect(resumed).toContain("正在使用 bash")
  expect(resumed).not.toContain("Compacting")
  expect(render({ isRunning: false, status: "cancelled", goal: { ...goal, status: "paused" } })).toContain("已暂停")
})

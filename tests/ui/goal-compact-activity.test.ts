import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { stripVTControlCharacters } from "node:util"
import { LiveActivity } from "../../src/ui/live-activity.js"
import { displayWidth } from "../../src/ui/truncate.js"
import type { GoalView } from "../../src/goal-view.js"
import type { Todo } from "../../zapsdk/index.js"

const goal: GoalView = { id: "fixture-goal", objective: "盘点项目", status: "running", phase: "executing", accepted: false }
const todos: Todo[] = [
  { content: "检查目录", activeForm: "正在检查目录", status: "completed" },
  { content: "核对结果", activeForm: "正在核对结果", status: "in_progress" },
]
const props = { isRunning: true, isStreaming: false, isThinking: false, thinkingChars: 0,
  status: "compacting", activeTool: "bash", pendingTools: [], termWidth: 90 }
const render = (overrides: Partial<Parameters<typeof LiveActivity>[0]> = {}, columns = 90) =>
  stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, termWidth: columns, ...overrides }), { columns }))

it("keeps the active Goal and real Todo progress pinned while showing compaction instead of stale work", () => {
  const text = render({ goal, goalAttached: true, goalTodos: todos })
  expect(text).toContain("目标：盘点项目")
  expect(text).toContain("已完成 1/2 步")
  expect(text).toContain("Compacting conversation… (0s)")
  expect(text).toContain("Esc twice to stop compaction")
  expect(text).not.toContain("正在核对结果")
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
    const compact = render({ goal, goalAttached: true, goalTodos: todos }, columns)
    expect(compact).toContain("目标：盘点项目")
    expect(compact).toContain("Compacting")
    for (const line of compact.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
  }
  const resumed = render({ goal, goalAttached: true, goalTodos: todos, status: "working" })
  expect(resumed).toContain("正在核对结果")
  expect(resumed).not.toContain("Compacting")
  expect(render({ isRunning: false, status: "cancelled", goal: { ...goal, status: "paused" } })).toContain("已暂停")
})

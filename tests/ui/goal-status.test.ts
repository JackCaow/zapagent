import { expect, it } from "bun:test"
import { createElement } from "react"
import { Box, Static, Text, renderToString } from "ink"
import { stripVTControlCharacters } from "node:util"
import { GoalStatus, type GoalStatusProps } from "../../src/ui/goal-status.js"
import { LiveActivity } from "../../src/ui/live-activity.js"
import { displayWidth } from "../../src/ui/truncate.js"
import { goalActionText, goalObjectiveText, type GoalView } from "../../src/goal-view.js"
import type { Todo } from "../../zapsdk/index.js"

const goal: GoalView = { id: "goal_internal_id", objective: "排查当前工作区的项目状况", status: "running", phase: "executing", accepted: false }
const todos: Todo[] = [
  { content: "盘点项目", activeForm: "正在盘点项目", status: "completed" },
  { content: "核对 Git 状态", activeForm: "正在核对 Git 状态", status: "in_progress" },
  { content: "整理结果", activeForm: "正在整理结果", status: "pending" },
]
const render = (value: Partial<GoalStatusProps>, columns = 90) =>
  stripVTControlCharacters(renderToString(createElement(GoalStatus, { goal, termWidth: columns, ...value }), { columns }))

it("shows the objective and real Todo progress without Goal IDs or controller task counters", () => {
  const output = render({ attached: true, todos })
  expect(output).toContain("◇ 目标：排查当前工作区的项目状况")
  expect(output).toContain("已完成 1/3 步")
  expect(output).toContain("正在核对 Git 状态")
  for (const internal of ["goal_internal_id", "0/1 tasks", "running/executing", "created/preparing"]) expect(output).not.toContain(internal)
  expect(render({ attached: true })).not.toContain("步")
})

it("uses host acceptance/pause states instead of stale active tools or unrelated Todos", () => {
  expect(goalActionText({ ...goal, phase: "verifying" }, true, todos, "bash")).toBe("正在独立验收结果")
  expect(goalActionText({ ...goal, phase: "repairing" }, true)).toContain("修正")
  expect(goalActionText({ ...goal, status: "paused" }, false, todos, "bash")).toBe("已暂停，进度已保留")
  expect(goalActionText({ ...goal, status: "completed", accepted: true }, false)).toContain("验收通过")
  expect(goalActionText({ ...goal, status: "completed", accepted: false }, false)).not.toContain("验收通过")
  expect(goalActionText({ ...goal, status: "awaiting_acceptance" }, false)).toContain("等待")
  expect(goalActionText({ ...goal, status: "ready_for_delivery" }, false)).toContain("等待交付授权")
  for (const status of ["blocked", "failed"] as const) {
    expect(render({ goal: { ...goal, status }, attached: false })).toContain("/goal status")
  }
  expect(goalActionText(goal, false, todos, "bash")).toBe("后台目标 · 正在推进目标")
  expect(render({ attached: false, todos })).not.toContain("1/3")
})

it("bounds the input area on narrow terminals and normalizes multiline/control characters", () => {
  const long = "检查中文工作区📦与文件状态 ".repeat(30) + "\nsecret second line\x1b[31m\x00"
  expect(goalObjectiveText("first\nsecond\t\x1b[31mthird\x1b[0m")).toBe("first second third")
  for (const columns of [24, 40, 80]) {
    const output = render({ goal: { ...goal, objective: long }, todos, attached: true }, columns)
    expect(output.split("\n").length).toBeLessThanOrEqual(4)
    for (const line of output.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    expect(output).not.toContain("secret second line")
  }
})

it("keeps the Goal in the dynamic input area beneath committed history", () => {
  const output = stripVTControlCharacters(renderToString(createElement(Box, { flexDirection: "column" },
    createElement(Static<string>, { items: Array.from({ length: 30 }, (_, i) => `history ${i}`), children: item => createElement(Text, { key: item }, item) }),
    createElement(GoalStatus, { goal, termWidth: 90, attached: true, todos }),
    createElement(Text, null, "❯ INPUT"),
    createElement(Text, null, "FOOTER"),
  ), { columns: 90 }))
  expect(output.indexOf("history 29")).toBeLessThan(output.indexOf("◇ 目标："))
  expect(output.indexOf("正在核对 Git 状态")).toBeLessThan(output.indexOf("❯ INPUT"))
  expect(output.indexOf("◇ 目标：")).toBeGreaterThan(output.lastIndexOf("history"))
})

it("uses the fixed Goal view during idle pause/background and preserves ordinary activity", () => {
  const props = { isRunning: false, isStreaming: false, isThinking: false, thinkingChars: 0, status: "ready", activeTool: "", termWidth: 90, pendingTools: [] }
  const paused = stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, goal: { ...goal, status: "paused" } }), { columns: 90 }))
  expect(paused).toContain("◇ 目标：")
  expect(paused).toContain("已暂停")
  expect(paused).not.toContain("Esc twice")
  const ordinary = stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, isRunning: true, status: "thinking" }), { columns: 90 }))
  expect(ordinary).toContain("Thinking")
  expect(ordinary).not.toContain("目标：")
  const waiting = stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, isRunning: true, goal, goalAttached: true, goalAwaitingInput: true }), { columns: 90 }))
  expect(waiting).toContain("等待你确认操作")
  const otherWork = stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, isRunning: true, status: "working", goal: { ...goal, status: "paused" } }), { columns: 90 }))
  expect(otherWork).toContain("已暂停")
  expect(otherWork).toContain("Working")
  const narrow = stripVTControlCharacters(renderToString(createElement(LiveActivity, { ...props, termWidth: 24, isRunning: true, goal, goalAttached: true }), { columns: 24 }))
  for (const line of narrow.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(24)
})

it("keeps truthful stop hints for ordinary work beside a retained Goal on narrow terminals", () => {
  for (const stopHint of ["Esc twice to stop", "Ctrl+C to stop"]) {
    const text = stripVTControlCharacters(renderToString(createElement(LiveActivity, {
      isRunning: true, isStreaming: false, isThinking: false, thinkingChars: 0,
      status: "working", activeTool: "", termWidth: 40, pendingTools: [], stopHint,
      goal: { ...goal, status: "paused" }, goalAttached: false,
    }), { columns: 40 }))
    expect(text).toContain(stopHint.startsWith("Ctrl+C") ? "Ctrl+C" : "Esc×2")
    for (const line of text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
  }
})

it("marks failed Goals explicitly instead of displaying them like ordinary idle progress", () => {
  const output = render({ goal: { ...goal, status: "failed" }, attached: false })
  expect(output).toContain("! /goal status")
  expect(output).toContain("目标执行失败")
})

it("keeps the selected Goal diagnostic command intact at ordinary terminal widths", () => {
  const id = "goal_12345678-1234-1234-1234-123456789012"
  for (const status of ["blocked", "failed"] as const) {
    for (const columns of [64, 70, 80, 90]) {
      const output = render({ goal: { ...goal, id, status }, attached: false }, columns)
      expect(output).toContain(`/goal status ${id}`)
      for (const line of output.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    }
  }
})

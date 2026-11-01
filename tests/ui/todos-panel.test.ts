import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { stripVTControlCharacters } from "node:util"
import { TodosPanel, type TodosPanelProps } from "../../src/ui/todos-panel.js"

const todos: TodosPanelProps["todos"] = [
  { content: "已完成的步骤", activeForm: "正在完成步骤", status: "completed" },
  { content: "普通任务当前步骤", activeForm: "正在处理普通任务", status: "in_progress" },
]
const render = (props: Partial<TodosPanelProps>) => stripVTControlCharacters(renderToString(
  createElement(TodosPanel, { todos, ...props }), { columns: 90 },
))

it("keeps ordinary Todo progress visible while a paused or background Goal remains pinned", () => {
  for (const props of [{}, { goalId: "paused-goal" }, { goalId: "background-goal", goalAttached: false }]) {
    const output = render(props)
    expect(output).toContain("Todos  1/2")
    expect(output).toContain("普通任务当前步骤")
  }
})

it("collapses the foreground Goal list and retained Goal-owned Todos without hiding unrelated lists", () => {
  expect(render({ goalId: "goal", goalAttached: true })).not.toContain("Todos")
  expect(render({ goalId: "goal", goalAttached: true, todoGoalId: "older-goal" })).not.toContain("普通任务当前步骤")
  expect(render({ goalId: "goal", todoGoalId: "goal" })).not.toContain("Todos")
  expect(render({ goalId: "goal", todoGoalId: "other-goal" })).toContain("普通任务当前步骤")
  expect(render({ todos: [] })).toBe("")
})

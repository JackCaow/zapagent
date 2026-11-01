import { expect, it } from "bun:test"
import { startGoalViewPolling } from "../../src/goal-view-poller.js"
import type { GoalView } from "../../src/goal-view.js"

const initial: GoalView = { id: "goal", objective: "Fixture", status: "running", accepted: false }
function clock() {
  const tasks: { callback: () => void; delay: number; cancelled: boolean }[] = []
  return {
    tasks,
    schedule(callback: () => void, delay: number) {
      const task = { callback, delay, cancelled: false }
      tasks.push(task)
      return () => { task.cancelled = true }
    },
    tick() { const task = tasks.shift(); if (task && !task.cancelled) task.callback() },
    delay() { return tasks[0]?.delay },
  }
}

it("polls active work quickly, backs off unchanged waiting states, and detects external resume/completion", () => {
  const time = clock(), published: (GoalView | undefined)[] = []
  let view = initial
  const stop = startGoalViewPolling({ read: () => view, publish: value => published.push(value), schedule: time.schedule })
  try {
    expect(time.delay()).toBe(1000)
    view = { ...view, status: "paused" }; time.tick()
    expect(time.delay()).toBe(5000)
    for (const delay of [10_000, 20_000, 30_000, 30_000]) { time.tick(); expect(time.delay()).toBe(delay) }
    view = { ...view, status: "running" }; time.tick()
    expect(published.at(-1)?.status).toBe("running")
    expect(time.delay()).toBe(1000)
    view = { ...view, status: "completed", accepted: true }; time.tick()
    expect(published.at(-1)?.status).toBe("completed")
    expect(time.tasks).toHaveLength(0)
  } finally { stop() }
})

it("retains the last view during corrupt/busy reads with bounded retry rate and one diagnostic per failure streak", () => {
  const time = clock(), published: (GoalView | undefined)[] = [], errors: unknown[] = []
  let broken = false
  const stop = startGoalViewPolling({ read: () => { if (broken) throw Error("CORRUPT_GOAL_STATE"); return initial },
    publish: value => published.push(value), onReadError: error => errors.push(error), schedule: time.schedule })
  try {
    broken = true
    for (const delay of [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) { time.tick(); expect(time.delay()).toBe(delay) }
    expect(published).toEqual([initial])
    expect(errors).toHaveLength(1)
    broken = false; time.tick()
    expect(time.delay()).toBe(1000)
    expect(published).toEqual([initial, initial])
    broken = true; time.tick()
    expect(errors).toHaveLength(2)
    expect(time.delay()).toBe(2000)
  } finally { stop() }
})

it("cancels reads even when a scheduled callback arrives after clear, unmount, or a chat switch", () => {
  const time = clock()
  let reads = 0
  const stop = startGoalViewPolling({ read: () => { reads++; return initial }, publish() {}, schedule: time.schedule })
  const late = time.tasks[0]!.callback
  stop(); late()
  expect(reads).toBe(1)
  expect(time.tasks[0]?.cancelled).toBe(true)
})

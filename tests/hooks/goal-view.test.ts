import { expect, it } from "bun:test"
import { createElement } from "react"
import { Text, render } from "ink"
import { PassThrough } from "node:stream"
import type { ReadStream, WriteStream } from "node:tty"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GoalStore } from "../../zapsdk/goal/store.js"
import { useGoalView } from "../../src/hooks/useGoalView.js"

async function until(test: () => boolean) {
  const deadline = Date.now() + 3000
  while (!test()) { if (Date.now() > deadline) throw Error("Goal view did not settle"); await new Promise(resolve => setTimeout(resolve, 10)) }
}
function fixture(path: string, sessionId: string, attached = false) {
  let current!: ReturnType<typeof useGoalView>
  function Harness(props: { sessionId: string; attached: boolean }) {
    current = useGoalView(props.sessionId, "/workspace", props.attached, path)
    return createElement(Text, null, current.view?.objective ?? "No Goal")
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  stdout.on("data", () => {})
  const stdin = new PassThrough(), stderr = new PassThrough()
  stderr.on("data", () => {})
  const instance = render(createElement(Harness, { sessionId, attached }), { stdout: stdout as unknown as WriteStream, stdin: stdin as unknown as ReadStream, stderr: stderr as unknown as WriteStream, patchConsole: false, exitOnCtrlC: false })
  return { get current() { return current }, rerender(id: string, active = false) { instance.rerender(createElement(Harness, { sessionId: id, attached: active })) }, close() { instance.unmount(); stdout.destroy(); stdin.destroy(); stderr.destroy() } }
}

it("binds the selected Goal, retains pause, and prevents stale callbacks from crossing chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-view-hook-")), path = join(root, "goals.sqlite"), store = new GoalStore(path)
  const a = store.create({ cwd: "/workspace", sessionId: "a", objective: "Goal A" })
  const b = store.create({ cwd: "/workspace", sessionId: "b", objective: "Goal B" })
  const ui = fixture(path, "a", true)
  try {
    await until(() => !!ui.current)
    ui.current.select(a); await until(() => ui.current.view?.id === a.id)
    ui.current.update({ ...a, status: "paused" }); await until(() => ui.current.view?.status === "paused")
    ui.current.clear(true); await new Promise(resolve => setTimeout(resolve, 20)); expect(ui.current.view?.id).toBe(a.id)
    const staleUpdate = ui.current.update, staleSelect = ui.current.select
    ui.rerender("b"); await until(() => ui.current.view?.id === b.id)
    staleUpdate(a); staleSelect(a)
    await new Promise(resolve => setTimeout(resolve, 20)); expect(ui.current.view?.id).toBe(b.id)
    ui.rerender("fresh"); await until(() => !ui.current.view)
    expect(ui.current.view).toBeUndefined()
  } finally { ui.close(); store.close(); await rm(root, { recursive: true, force: true }) }
}, 10000)

it("polls detached progress and honors clear instead of restoring the same Goal on the next tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-view-poll-")), path = join(root, "goals.sqlite"), store = new GoalStore(path)
  const goal = store.create({ cwd: "/workspace", sessionId: "a", objective: "Background Goal" })
  const claimed = store.claim(goal.id, "fixture", process.pid)
  const ui = fixture(path, "a")
  try {
    await until(() => ui.current?.view?.status === "running")
    store.update(goal.id, claimed.ownerEpoch, "fixture", value => { value.phase = "verifying" })
    await until(() => ui.current.view?.phase === "verifying")
    store.release(goal.id, claimed.ownerEpoch, "fixture", "paused", "USER_PAUSE")
    await until(() => ui.current.view?.status === "paused")
    ui.current.clear(); await until(() => !ui.current.view)
    await new Promise(resolve => setTimeout(resolve, 1100)); expect(ui.current.view).toBeUndefined()
    ui.current.select(store.get(goal.id)!); await until(() => ui.current.view?.id === goal.id)
  } finally { ui.close(); store.close(); await rm(root, { recursive: true, force: true }) }
}, 10000)

import { expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GoalStore } from "../../zapsdk/goal/store.js"
import { readSessionGoalView } from "../../src/goal-view.js"

it("does not create Goal state when an ordinary chat has no database", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-view-missing-"))
  try {
    expect(readSessionGoalView("/workspace", "session", undefined, join(root, "missing/goals.sqlite"))).toBeUndefined()
    await expect(stat(join(root, "missing"))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("restores only this chat's Goal and reads without mutating its database or permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-view-reader-")), path = join(root, "goals.sqlite")
  try {
    const store = new GoalStore(path)
    const a = store.create({ cwd: "/workspace", sessionId: "chat-a", objective: "Goal A" })
    const b = store.create({ cwd: "/workspace", sessionId: "chat-b", objective: "Goal B" })
    store.create({ cwd: "/workspace", objective: "Unbound CLI Goal" })
    store.close()
    const before = await readFile(path), mode = (await stat(path)).mode
    expect(readSessionGoalView("/workspace", "chat-a", undefined, path)?.id).toBe(a.id)
    expect(readSessionGoalView("/workspace", "chat-b", undefined, path)?.id).toBe(b.id)
    expect(readSessionGoalView("/workspace", "fresh-chat", undefined, path)).toBeUndefined()
    expect(readSessionGoalView("/other", "chat-a", a.id, path)).toBeUndefined()
    expect(readSessionGoalView("/workspace", "chat-a", b.id, path)?.id).toBe(b.id) // Explicit resume may select a Goal from another chat.
    expect(await readFile(path)).toEqual(before)
    expect((await stat(path)).mode).toBe(mode)
  } finally { await rm(root, { recursive: true, force: true }) }
})

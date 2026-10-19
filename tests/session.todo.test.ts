import { describe, it, expect, afterEach } from "bun:test"
import { rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { appDataDir, parseTodoUpdates, readTodoUpdates } from "../src/session.js"

describe("parseTodoUpdates", () => {
  it("restores blocked dependency and reported evidence without promoting completion", () => {
    const todo = { content: "Deliver", activeForm: "Delivering", status: "blocked", acceptanceCriteria: "valid artifact", blocked: { reason: "waiting", waitingFor: "task", taskIds: ["t1"] } }
    const restored = parseTodoUpdates(JSON.stringify({ type: "todo-update", key: "main", todos: [todo] }))
    expect(restored.get("main")).toEqual([todo])
  })
  it("returns empty Map on empty input", () => {
    expect(parseTodoUpdates("")).toEqual(new Map())
  })

  it("parses single todo-update entry", () => {
    const line = JSON.stringify({
      type: "todo-update",
      key: "main",
      todos: [{ content: "a", activeForm: "A", status: "pending" }],
    })
    const m = parseTodoUpdates(line + "\n")
    expect(m.get("main")).toEqual([
      { content: "a", activeForm: "A", status: "pending" },
    ] as any)
  })

  it("tail-wins on multiple entries with same key", () => {
    const l1 = JSON.stringify({
      type: "todo-update",
      key: "main",
      todos: [{ content: "first", activeForm: "First", status: "pending" }],
    })
    const l2 = JSON.stringify({
      type: "todo-update",
      key: "main",
      todos: [{ content: "second", activeForm: "Second", status: "pending" }],
    })
    const m = parseTodoUpdates(l1 + "\n" + l2 + "\n")
    expect((m.get("main") as any)[0].content).toBe("second")
  })

  it("groups distinct keys separately", () => {
    const l1 = JSON.stringify({
      type: "todo-update",
      key: "main",
      todos: [{ content: "m", activeForm: "M", status: "pending" }],
    })
    const l2 = JSON.stringify({
      type: "todo-update",
      key: "sa_x",
      todos: [{ content: "s", activeForm: "S", status: "pending" }],
    })
    const m = parseTodoUpdates(l1 + "\n" + l2 + "\n")
    expect(m.size).toBe(2)
    expect((m.get("main") as any)[0].content).toBe("m")
    expect((m.get("sa_x") as any)[0].content).toBe("s")
  })

  it("skips malformed JSON lines", () => {
    const good = JSON.stringify({ type: "todo-update", key: "main", todos: [] })
    const m = parseTodoUpdates("garbage\n" + good + "\nalso-garbage\n")
    expect(m.get("main")).toEqual([])
  })

  it("ignores unrelated entry types", () => {
    const other = JSON.stringify({ type: "snapshot", snapshot: {} })
    const todo = JSON.stringify({ type: "todo-update", key: "main", todos: [] })
    const m = parseTodoUpdates(other + "\n" + todo + "\n")
    expect(m.size).toBe(1)
  })

  it("drops positioned todo updates from the abandoned rewind branch", () => {
    const raw = [
      { type: "todo-update", key: "main", todos: [{ content: "before" }], journalLogIndex: 1 },
      { type: "todo-update", key: "main", todos: [{ content: "abandoned" }], journalLogIndex: 4 },
      { type: "rewind-marker", targetTurnStartIndex: 2, logIndex: 2 },
      { type: "todo-update", key: "main", todos: [{ content: "new-branch" }], journalLogIndex: 3 },
    ].map(entry => JSON.stringify(entry)).join("\n")

    expect(parseTodoUpdates(raw).get("main")).toEqual([{ content: "new-branch" }])
  })
})

describe("readTodoUpdates (I/O)", () => {
  // readTodoUpdates resolves the JSONL path against the module-scoped
  // projectSessionsDir (bound to the test process's cwd and appDataDir).
  // We write a test session id there and clean up after.
  const sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const projectDir = join(appDataDir, "projects", process.cwd().replace(/[\\/:]/g, "-"))
  const filePath = join(projectDir, `${sessionId}.jsonl`)

  afterEach(() => {
    // Best-effort cleanup; don't fail if someone else removed it
    try {
      if (existsSync(filePath)) rmSync(filePath)
    } catch {}
  })

  it("returns empty Map when the session file does not exist", () => {
    expect(readTodoUpdates("nonexistent-session-" + Date.now())).toEqual(new Map())
  })

  it("reads and tail-wins across keys from a real JSONL file", () => {
    mkdirSync(projectDir, { recursive: true })

    const entries = [
      { type: "todo-update", key: "main", todos: [{ content: "old-main", activeForm: "x", status: "pending" }] },
      { type: "todo-update", key: "sa_1", todos: [{ content: "sub", activeForm: "x", status: "pending" }] },
      { type: "todo-update", key: "main", todos: [{ content: "new-main", activeForm: "x", status: "in_progress" }] },
      { type: "snapshot", snapshot: {} },
    ]
    writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8")

    const result = readTodoUpdates(sessionId)
    expect(result.size).toBe(2)
    expect((result.get("main") as any)[0].content).toBe("new-main")
    expect((result.get("sa_1") as any)[0].content).toBe("sub")
  })
})

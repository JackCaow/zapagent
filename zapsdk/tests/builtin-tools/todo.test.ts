import { describe, it, expect, beforeEach } from "bun:test"
import { todoWriteTool, renderTodoList, type Todo, type TodoStore } from "../../builtin-tools/todo.js"

function makeStore(): TodoStore & { snapshot: () => Todo[]; key: string } {
  let current: Todo[] = []
  return {
    key: "test",
    getKey: () => "test",
    get: () => current,
    set: (_key, _old, next) => { current = next },
    snapshot: () => current,
  }
}

describe("todo_write", () => {
  let store: ReturnType<typeof makeStore>
  let tool: ReturnType<typeof todoWriteTool>

  beforeEach(() => {
    store = makeStore()
    tool = todoWriteTool({ store })
  })

  it("keeps blocked dependencies visible instead of counting their failure as completion", async () => {
    const todo = { content: "Generate artifact", activeForm: "Generating artifact", status: "blocked", acceptanceCriteria: "Artifact passes validation", blocked: { reason: "Approval pending", waitingFor: "capability" } }
    const result = await tool.handler({ todos: [todo] })
    expect(result.success).toBe(true)
    expect(store.snapshot()[0]?.status).toBe("blocked")
    expect(result.output).toContain("[!] Generate artifact")
    expect((await tool.handler({ todos: [{ ...todo, blocked: { reason: "waiting", waitingFor: "task" } }] })).success).toBe(false)
  })

  it("retains criteria and evidence, and rejects completion without evidence or with a weakened criterion", async () => {
    const todo = { content: "Generate artifact", activeForm: "Generating artifact", status: "in_progress", acceptanceCriteria: "Artifact passes validation" }
    await tool.handler({ todos: [todo] })
    expect((await tool.handler({ todos: [{ ...todo, status: "completed", acceptanceCriteria: undefined }] })).success).toBe(false)
    expect((await tool.handler({ todos: [{ ...todo, status: "completed", acceptanceCriteria: "Captured failure", completionEvidence: "exit 1" }] })).success).toBe(false)
    const result = await tool.handler({ todos: [{ ...todo, status: "completed", completionEvidence: "validator confirmed artifact contents" }] })
    expect(result.success).toBe(true)
    expect(store.snapshot()).toEqual([])
    expect(result.output).toContain("reported evidence: validator confirmed artifact contents")
    expect(result.output).toContain(todo.acceptanceCriteria)
  })
  it("preserves an already completed item's evidence during unrelated progress updates", async () => {
    const done = { content: "A", activeForm: "A", status: "completed", acceptanceCriteria: "checked", completionEvidence: "check passed" }
    const pending = { content: "B", activeForm: "B", status: "pending" }
    await tool.handler({ todos: [done, pending] })
    const result = await tool.handler({ todos: [{ content: "A", activeForm: "A", status: "completed" }, { ...pending, status: "in_progress" }] })
    expect(result.success).toBe(true)
    expect(store.snapshot()[0]?.completionEvidence).toBe("check passed")
  })

  it("writes a plain list", async () => {
    const result = await tool.handler({
      todos: [
        { content: "Research auth patterns", activeForm: "Researching auth patterns", status: "pending" },
        { content: "Draft API", activeForm: "Drafting API", status: "in_progress" },
      ],
    })
    expect(result.success).toBe(true)
    expect(store.snapshot()).toHaveLength(2)
    expect(result.output).toContain("[~] Draft API")
  })

  it("rejects multiple in_progress todos with a model-readable error", async () => {
    const result = await tool.handler({
      todos: [
        { content: "A", activeForm: "Aing", status: "in_progress" },
        { content: "B", activeForm: "Bing", status: "in_progress" },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/at most one todo/)
    expect(store.snapshot()).toEqual([]) // untouched
  })

  it("auto-clears when every todo is completed", async () => {
    const result = await tool.handler({
      todos: [
        { content: "A", activeForm: "Aing", status: "completed" },
        { content: "B", activeForm: "Bing", status: "completed" },
      ],
    })
    expect(result.success).toBe(true)
    expect(store.snapshot()).toEqual([])
    expect(result.output).toContain("Todo list cleared")
  })

  it("accepts empty array as explicit clear", async () => {
    // Prime the store
    await tool.handler({ todos: [{ content: "A", activeForm: "Aing", status: "pending" }] })
    expect(store.snapshot()).toHaveLength(1)
    // Clear
    const result = await tool.handler({ todos: [] })
    expect(result.success).toBe(true)
    expect(store.snapshot()).toEqual([])
  })

  it("passes oldTodos to the store so consumers can diff", async () => {
    const calls: { old: Todo[]; next: Todo[] }[] = []
    const s: TodoStore = {
      getKey: () => "test",
      get: () => [{ content: "prior", activeForm: "priorIng", status: "pending" }],
      set: (_k, old, next) => { calls.push({ old, next }) },
    }
    const t = todoWriteTool({ store: s })
    await t.handler({ todos: [{ content: "new", activeForm: "newIng", status: "pending" }] })
    expect(calls).toHaveLength(1)
    expect(calls[0].old[0].content).toBe("prior")
    expect(calls[0].next[0].content).toBe("new")
  })

  it("renderTodoList uses [x]/[~]/[ ] glyphs", () => {
    const rendered = renderTodoList([
      { content: "done", activeForm: "doing", status: "completed" },
      { content: "now", activeForm: "nowing", status: "in_progress" },
      { content: "later", activeForm: "latering", status: "pending" },
    ])
    expect(rendered).toContain("[x] done")
    expect(rendered).toContain("[~] now")
    expect(rendered).toContain("[ ] later")
  })

  it("renders optional acceptance and contingency details for executable plans", () => {
    const rendered = renderTodoList([{
      content: "Run the smoke probe",
      activeForm: "Running the smoke probe",
      status: "in_progress",
      acceptanceCriteria: "The probe exits 0.",
      contingency: "If it blocks, use the fixture path.",
    }])

    expect(rendered).toContain("↳ acceptance criterion: The probe exits 0.")
    expect(rendered).toContain("↳ if blocked: If it blocks, use the fixture path.")
  })
})

describe("todo_write with custom getKey (subagent simulation)", () => {
  it("writes land on the key returned by store.getKey", async () => {
    const writes: Array<{ key: string; todos: any[] }> = []
    const tool = todoWriteTool({
      store: {
        getKey: () => "sa_custom_123",
        get: () => [],
        set: (key, _old, next) => { writes.push({ key, todos: next }) },
      },
    })
    await tool.handler(
      { todos: [{ content: "sub task", activeForm: "Subbing", status: "pending" }] },
      undefined as any,
    )
    expect(writes).toHaveLength(1)
    expect(writes[0].key).toBe("sa_custom_123")
  })
})

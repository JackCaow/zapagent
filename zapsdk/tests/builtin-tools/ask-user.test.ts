import { describe, expect, it } from "bun:test"
import { askUserQuestionTool, type AskUserAnswer, type AskUserQuestion } from "../../builtin-tools/ask-user.js"
import { createBuiltinRegistry } from "../../builtin-tools/index.js"

const questions: AskUserQuestion[] = [
  { question: "Which database?", header: "DB", options: [{ label: "Postgres (Recommended)" }, { label: "SQLite" }] },
]

describe("ask_user_question", () => {
  it("returns the user's answers to the model", async () => {
    let seen: AskUserQuestion[] = []
    const tool = askUserQuestionTool({ callbacks: { ask: async (q) => { seen = q; return [{ question: q[0]!.question, answers: ["SQLite"] }] satisfies AskUserAnswer[] } } })
    const result = await tool.handler({ questions }, new AbortController().signal)
    expect(seen).toEqual(questions)
    expect(result.success).toBe(true)
    expect(result.output).toContain("Which database?")
    expect(result.output).toContain("SQLite")
  })

  it("marks a typed answer and tells the model not to re-ask when the user dismisses", async () => {
    const typed = askUserQuestionTool({ callbacks: { ask: async (q) => [{ question: q[0]!.question, answers: ["DuckDB"], custom: true }] } })
    expect((await typed.handler({ questions }, new AbortController().signal)).output).toContain("typed by the user")
    const dismissed = askUserQuestionTool({ callbacks: { ask: async () => null } })
    const result = await dismissed.handler({ questions }, new AbortController().signal)
    expect(result.success).toBe(false)
    expect(result.error).toContain("Do not ask again")
  })

  it("validates 1-4 questions with 2-4 options each", () => {
    const schema = askUserQuestionTool({ callbacks: { ask: async () => null } }).definition.parameters as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ questions }).success).toBe(true)
    expect(schema.safeParse({ questions: [] }).success).toBe(false)
    expect(schema.safeParse({ questions: [{ question: "q", options: [{ label: "only one" }] }] }).success).toBe(false)
    expect(schema.safeParse({ questions: Array(5).fill(questions[0]) }).success).toBe(false)
  })

  it("is registered only when a UI supplies the callbacks", () => {
    expect(createBuiltinRegistry({}).has("ask_user_question")).toBe(false)
    expect(createBuiltinRegistry({ askUser: { callbacks: { ask: async () => null } } }).has("ask_user_question")).toBe(true)
  })
})

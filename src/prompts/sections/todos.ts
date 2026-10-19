// ── Todo reminder / active-plan injection ────────────────────────────────
//
// Two modes, keyed off the model family:
//
//   "claude"  — passive CCB-style reminder. Claude is post-trained to treat
//              <system-reminder> blocks and todo lists as first-class signals,
//              so a gentle nudge + list is enough.
//
//   "strict"  — structured <active_plan> block for non-Claude models (GLM,
//              DeepSeek, Qwen, OpenAI, etc.) that don't have CCB's priors
//              baked in. The static rules live in plan-discipline.ts so this
//              per-turn attachment stays small and cache-friendly. Gives them:
//                - explicit DO THIS NOW marker on the in-progress item
//                - unambiguous ▶ / [x] / [ ] status glyphs
//
// The old gate (wait 10 turns before reminding) is gone. We now inject
// every turn whenever todos.length > 0 — weaker models need the reminder
// constantly, and for Claude the cost is a few hundred tokens which is
// well below any threshold that matters.

export interface TodoForReminder {
  content: string
  activeForm: string
  status: string
  acceptanceCriteria?: string
  completionEvidence?: string
  blocked?: { reason: string; waitingFor: string; taskIds?: string[] }
}

/** Which reminder style to use based on the model name. Claude-family
 *  models get CCB's lighter passive reminder; everyone else gets the
 *  stricter structured block. Defaults to strict on ambiguity — being
 *  a bit verbose for an unknown model is safer than having it ignore
 *  the plan. */
export function isClaudeFamily(model: string | undefined): boolean {
  if (!model) return false
  return /claude/i.test(model)
}

const STATUS_GLYPH: Record<string, string> = {
  completed: "[x]",
  in_progress: "▶",
  pending: "[ ]",
  blocked: "[!]",
}

const STRICT_HEADER =
  "Current plan: follow dependencies and the user's latest steering."

const CLAUDE_HEADER =
  "The TodoWrite tool hasn't been used recently. If you're working on " +
  "tasks that would benefit from tracking progress, consider using the " +
  "TodoWrite tool. Also consider cleaning up the todo list if it has " +
  "become stale and no longer matches what you are working on. Only use " +
  "it if it's relevant to the current work. This is just a gentle " +
  "reminder - ignore if not applicable. Make sure that you NEVER mention " +
  "this reminder to the user."

/** Render the strict <active_plan> block for non-Claude models. Static
 *  semantics are in the cacheable plan-discipline system section; this
 *  transient block only carries the current plan state. Wraps itself in
 *  the tag — caller does not need to wrap. */
function renderStrictPlan(todos: ReadonlyArray<TodoForReminder>): string {
  const items = todos
    .map((t, i) => {
      const glyph = STATUS_GLYPH[t.status] ?? "[?]"
      const label = todoDisplayText(t)
      const trailer = t.status === "in_progress" ? "   ← DO THIS NOW" : ""
      return `  ${glyph} ${i + 1}. ${escapeContextText(label)}${trailer}`
    })
    .join("\n")

  return [
    "<active_plan>",
    STRICT_HEADER,
    "",
    items,
    "</active_plan>",
  ].join("\n")
}

/** Render the CCB-style passive nudge for Claude. Wraps itself in
 *  <system-reminder>. */
function renderClaudeReminder(todos: ReadonlyArray<TodoForReminder>): string {
  const body =
    todos.length === 0
      ? CLAUDE_HEADER
      : CLAUDE_HEADER +
        "\n\nHere are the existing contents of your todo list:\n\n[" +
        todos
          .map((t, i) => `${i + 1}. [${escapeContextText(t.status)}] ${escapeContextText(todoDisplayText(t))}`)
          .join("\n") +
        "]"
  return `<system-reminder>\n${body}\n</system-reminder>`
}

function todoDisplayText(todo: TodoForReminder): string {
  const label = todo.status === "in_progress" ? todo.activeForm : todo.content
  const details = [
    todo.acceptanceCriteria ? `acceptance: ${todo.acceptanceCriteria}` : "",
    todo.status === "blocked" && todo.blocked ? `waiting for ${todo.blocked.waitingFor}: ${todo.blocked.reason}${todo.blocked.taskIds?.length ? ` (${todo.blocked.taskIds.join(", ")})` : ""}` : "",
    todo.completionEvidence ? `reported evidence: ${todo.completionEvidence}` : "",
  ].filter(Boolean)
  return details.length ? `${label} — ${details.join("; ")}` : label
}

function escapeContextText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Build the per-turn todo reminder to inject as a user-role context
 * attachment. Returns `null` when there's nothing to inject (empty list).
 *
 * The old "gate" logic (wait 10 turns since last todo_write + 10 turns
 * since last reminder) is removed — we inject every turn when todos
 * exist. Weaker models need the constant reminder; Claude can absorb
 * the extra tokens without issue.
 */
export function renderTodoAttachment(
  todos: ReadonlyArray<TodoForReminder>,
  opts: { model?: string } = {},
): string | null {
  if (todos.length === 0) return null
  return isClaudeFamily(opts.model)
    ? renderClaudeReminder(todos)
    : renderStrictPlan(todos)
}

import { z } from "zod";
import type { Tool } from "../tools/types.js";

export type TodoStatus = "pending" | "in_progress" | "blocked" | "completed";

export interface Todo {
  content: string;
  activeForm: string;
  status: TodoStatus;
  /** Observable condition that proves this item is complete. Optional for
   * ordinary interactive todos; required by LoopAgent's constrained-plan
   * gate so benchmark/automation runs do not create vague plans. */
  acceptanceCriteria?: string;
  /** What to do when this item cannot complete within its local budget.
   * This prevents an external install/build from consuming the whole run. */
  contingency?: string;
  /** Explicit dependency, not a conclusion inferred from assistant prose. */
  blocked?: { reason: string; waitingFor: "user" | "capability" | "task"; taskIds?: string[] };
  /** Agent-reported evidence; never treated as independent verification. */
  completionEvidence?: string;
}

/**
 * Storage abstraction for todos. The tool itself is stateless — the
 * application layer decides where todos live (session JSONL, memory, etc.)
 * and how updates propagate to the UI.
 *
 * Key semantics: todos are keyed per-agent. Main agent uses the session id
 * as key; subagents (when they get todo_write, which they don't in the
 * default registry) would pass their own agent id. Mirrors CCB's
 * `appState.todos[agentId ?? sessionId]` pattern.
 */
export interface TodoStore {
  /** Returns the key this invocation should read/write. Called once per
   *  tool call. Default implementation returns a constant "main" — fine for
   *  single-agent setups. */
  getKey?: () => string;
  /** Read the current list for a key. Missing/unknown key → []. */
  get(key: string): Todo[];
  /** Replace the list for a key. Called with the validated, possibly
   *  auto-cleared todos — implementation is responsible for persistence
   *  and UI notification. */
  set(key: string, oldTodos: Todo[], newTodos: Todo[]): void;
}

export interface TodoWriteToolOptions {
  store: TodoStore;
}

/**
 * `todo_write` — replace the current todo list with the provided array.
 *
 * Invariants enforced by the handler (not zod, so the model sees a clean
 * error message it can correct):
 *   - At most one `status === "in_progress"` at a time.
 *   - `content` and `activeForm` both non-empty strings (zod enforces min(1)
 *     but we double-check post-parse for defense in depth).
 *   - Empty `todos: []` is allowed — clears the list.
 *   - When every todo is `completed`, auto-clear to []. Mirrors CCB:
 *     leaving a done list visible turns into stale clutter.
 */
export function todoWriteTool(options: TodoWriteToolOptions): Tool {
  const { store } = options;

  return {
    definition: {
      name: "todo_write",
      description:
        "Create and manage a structured task list for the current coding session. " +
        "Use when the task has 3+ discrete steps, requires careful planning, or the " +
        "user provides multiple items. Mark one todo as `in_progress` before starting " +
        "it; mark `completed` as soon as it's done (don't batch). " +
        "Use blocked with a reason and dependency when progress requires user input, a capability, or a background task. " +
        "Request an available approval before declaring a capability blocked. A captured failure is not completion of the original request. " +
        "For completed items with acceptanceCriteria, supply completionEvidence describing the observed result. " +
        "When all todos are `completed`, the list auto-clears.",
      parameters: z.object({
        todos: z.array(
          z.object({
            content: z.string().min(1).describe("Imperative: 'Add retry wrapper around HTTP client'"),
            activeForm: z.string().min(1).describe("Continuous: 'Adding retry wrapper around HTTP client'"),
            status: z.enum(["pending", "in_progress", "blocked", "completed"]),
            blocked: z.object({
              reason: z.string().min(1),
              waitingFor: z.enum(["user", "capability", "task"]),
              taskIds: z.array(z.string().min(1)).min(1).optional(),
            }).optional(),
            completionEvidence: z.string().min(1).optional().describe("Observed evidence satisfying the original criterion; tool call IDs, artifact checks, or user confirmation. This is a report, not an independent verifier result."),
            acceptanceCriteria: z.string().min(1).optional().describe(
              "Observable proof of completion, e.g. 'bun test tests/auth.test.ts passes'",
            ),
            contingency: z.string().min(1).optional().describe(
              "Fallback if blocked, e.g. 'After two unchanged polls, switch to the prebuilt package path'",
            ),
          }),
        ).describe("The full updated todo list — replaces the current list entirely."),
      }),
      permission: "auto",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [],
        external: [{ kind: "external", system: "runtime:todo", operation: "mutate" }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: async (args) => {
      const todos = (args.todos as Todo[]).map(todo => ({ ...todo }));

      const inProgress = todos.filter((t) => t.status === "in_progress").length;
      if (inProgress > 1) {
        return {
          success: false,
          output: "",
          error: `Invariant violated: at most one todo may be 'in_progress' at a time (found ${inProgress}). Mark the others as 'pending' or 'completed'.`,
        };
      }

      const key = store.getKey?.() ?? "main";
      const oldTodos = store.get(key);
      for (const todo of todos) {
        const previous = oldTodos.find(item => item.content === todo.content);
        if (previous?.acceptanceCriteria && todo.acceptanceCriteria === undefined) todo.acceptanceCriteria = previous.acceptanceCriteria;
        if (todo.status === "completed" && previous?.acceptanceCriteria && previous.acceptanceCriteria !== todo.acceptanceCriteria) {
          return { success: false, output: "", error: "Do not change an existing acceptance criterion while marking it complete. Keep the item open and reconcile the requirement first." };
        }
        if (todo.status === "completed" && previous?.status === "completed" && !todo.completionEvidence) {
          todo.completionEvidence = previous.completionEvidence;
        }
        if (todo.status === "blocked" && (!todo.blocked?.reason.trim() ||
          (todo.blocked.waitingFor === "task" && !todo.blocked.taskIds?.length))) {
          return { success: false, output: "", error: "Blocked todos require a reason and a dependency; task waits require taskIds." };
        }
        if (todo.status === "completed" && todo.acceptanceCriteria && !todo.completionEvidence?.trim()) {
          return { success: false, output: "", error: `Provide completionEvidence for "${todo.content}" against its acceptance criterion, or keep it in_progress/blocked.` };
        }
      }
      const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
      const finalTodos = allDone ? [] : todos;
      store.set(key, oldTodos, finalTodos);

      // Keep the evidence in the tool transcript even when the UI list clears.
      const rendered = renderTodoList(todos);
      const hint = finalTodos.length === 0
        ? "Todo list cleared."
        : "Todos updated. Continue using todo_write to track progress as you work.";
      return { success: true, output: `${hint}\n\n${rendered}` };
    },
  };
}

/** ASCII rendering for tool-result transcripts and the reminder attachment. */
export function renderTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "(empty)";
  return todos
    .map((t) => {
      const glyph = t.status === "completed" ? "[x]"
        : t.status === "in_progress" ? "[~]"
        : t.status === "blocked" ? "[!]"
        : "[ ]";
      const acceptance = t.acceptanceCriteria ? `\n  ↳ acceptance criterion: ${t.acceptanceCriteria}` : "";
      const contingency = t.contingency ? `\n  ↳ if blocked: ${t.contingency}` : "";
      const blocked = t.status === "blocked" && t.blocked ? `\n  ↳ waiting for ${t.blocked.waitingFor}: ${t.blocked.reason}` : "";
      const evidence = t.completionEvidence ? `\n  ↳ reported evidence: ${t.completionEvidence}` : "";
      return `${glyph} ${t.content}${acceptance}${contingency}${blocked}${evidence}`;
    })
    .join("\n");
}

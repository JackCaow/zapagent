import type { Todo } from "../../zapsdk/builtin-tools/todo.js"

/** Only explicit dependency state suppresses automatic wake-ups. Human input
 * always goes through the normal dispatcher and can revise this state. */
export function canResumeForTaskEvent(todos: Todo[], taskId?: string): boolean {
  const outstanding = todos.filter(todo => todo.status !== "completed")
  if (!outstanding.length || outstanding.some(todo => todo.status !== "blocked")) return true
  return outstanding.some(todo => todo.blocked?.waitingFor === "task" &&
    !!taskId && todo.blocked.taskIds?.includes(taskId))
}

import type { TaskSnapshot } from "./types.js"

/** XML tag names for background-task completion notifications.
 *  Mirrored from CCB (`src/constants/xml.ts`) so the model sees the same
 *  envelope it's been trained on. Trained-on schema:
 *
 *    <task-notification>
 *      <task-id>...</task-id>
 *      <task-type>shell|agent|...</task-type>
 *      <status>completed|failed|killed</status>
 *      ...kind-specific children...
 *    </task-notification>
 */
export const TASK_NOTIFICATION_TAG = "task-notification"
export const TASK_ID_TAG = "task-id"
export const TASK_TYPE_TAG = "task-type"
export const STATUS_TAG = "status"
export const SUMMARY_TAG = "summary"
export const OUTPUT_FILE_TAG = "output-file"

export type TaskStatus = "completed" | "failed" | "killed" | "unknown"

export interface BuildNotificationOptions {
  task: TaskSnapshot
  status: TaskStatus
  /** Bytes written to outputFile. Surfaced to the model so it can decide
   *  whether the run produced enough output to be worth reading. */
  outputBytes?: number
}

/** Escape the five XML special chars. The notification payload typically
 *  has no markup, but task `description` is user-supplied / model-supplied
 *  so we defensively escape every leaf node. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function child(tag: string, text: string): string {
  return `  <${tag}>${escapeXml(text)}</${tag}>`
}

/** Render one task-completion notification as the user-role XML payload
 *  that gets handed to the model on the next turn. */
export function buildTaskNotificationXml(opts: BuildNotificationOptions): string {
  const { task, status, outputBytes } = opts
  const lines: string[] = []
  lines.push(`<${TASK_NOTIFICATION_TAG}>`)
  lines.push(child(TASK_ID_TAG, task.taskId))
  lines.push(child(TASK_TYPE_TAG, task.kind))
  lines.push(child(STATUS_TAG, status))
  lines.push(child("verification", "unverified"))
  lines.push(child("guidance", "This is process exit metadata, not task acceptance. Inspect relevant output and verify the original requirement. Do not repeat a result already observed or retry a side effect solely because of this notification."))
  lines.push(child(SUMMARY_TAG, task.description))
  lines.push(child(OUTPUT_FILE_TAG, task.outputFile))
  if (typeof outputBytes === "number") {
    lines.push(child("output-bytes", String(outputBytes)))
  }
  if (task.exitCode !== undefined && task.exitCode !== null) {
    lines.push(child("exit-code", String(task.exitCode)))
  }
  if (task.signal) {
    lines.push(child("signal", task.signal))
  }
  lines.push(`</${TASK_NOTIFICATION_TAG}>`)
  return lines.join("\n")
}

/** Derive a TaskStatus from raw exit metadata. SIGKILL/SIGTERM = killed;
 *  non-zero exit without signal = failed; zero = process completed only;
 *  missing exit metadata never implies success. */
export function classifyTaskExit(exitCode: number | null, signal: NodeJS.Signals | null): TaskStatus {
  if (signal) return "killed"
  if (exitCode === null) return "unknown"
  if (exitCode !== 0) return "failed"
  return "completed"
}

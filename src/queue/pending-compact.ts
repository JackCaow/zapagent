import type { QueueEntry } from "./messageQueue.js"

export function isManualCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/compact"
}

/** A manual /compact blocks a new one only while it can still run: waiting,
 *  being delivered, or being edited. A failed entry is parked behind a paused
 *  queue and nothing is executing it, and an accepted one has already run, so
 *  neither may keep rejecting new compacts. The entry the user is currently
 *  editing is replaced on submit rather than duplicated, so it is skipped. */
export function hasPendingManualCompact(
  snapshot: readonly Pick<QueueEntry, "id" | "state" | "text">[],
  editingMessageId?: string | null,
): boolean {
  return snapshot.some(entry => entry.id !== editingMessageId
    && (entry.state === "queued" || entry.state === "dispatching" || entry.state === "editing")
    && isManualCompactCommand(entry.text))
}

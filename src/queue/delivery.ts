import type { MessageQueue, QueueEntry } from "./messageQueue.js"
import { looksLikeDroppedFilePath } from "../commands/submit.js"

export interface QueueDelivery {
  providerReady: () => boolean
  dispatch: (entry: QueueEntry, accepted: () => void) => Promise<unknown>
  command: (entry: QueueEntry, accepted: () => void) => Promise<void | { inputRequired: boolean; result?: unknown }>
  onError: (message: string) => void
}

/** Consume one independent turn, not a merged batch. A failure blocks the
 * remaining queue until the user chooses retry/edit/delete/reorder. */
export async function deliverNextMessage(queue: MessageQueue, delivery: QueueDelivery): Promise<boolean> {
  const entry = queue.claimNext()
  if (!entry) return false
  let accepted = false
  const accept = () => {
    accepted = true
    const warning = queue.acknowledge(entry.id, entry.sessionId)
    if (warning) delivery.onError(warning)
  }
  try {
    let result: unknown
    if (entry.text.startsWith("/") && !looksLikeDroppedFilePath(entry.text)) {
      const command = await delivery.command(entry, accept)
      if (!command?.inputRequired) {
        if (!accepted) accept()
        return true
      }
      result = command.result
    } else {
      if (!delivery.providerReady()) throw new Error("Provider unavailable. Message kept; configure a provider and retry.")
      result = await delivery.dispatch(entry, accept)
    }
    if (!accepted) throw new Error("Run did not accept the message. It remains queued for review.")
    if (result === undefined) throw new Error("Run stopped after accepting input. Review the transcript before continuing.")
    const stopped = result && typeof result === "object" && "stopped" in result ? result.stopped : undefined
    if (stopped && stopped !== "end_turn") {
      queue.pause(`Previous run stopped (${String(stopped)}). Review and retry to continue.`)
      return false
    }
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try { if (!accepted) queue.fail(entry.id, reason) }
    catch (storageError) { delivery.onError(`Cannot save failed-message state: ${String(storageError)}`) }
    try { queue.pause("Previous message failed. Review and retry to continue.") }
    catch (storageError) { delivery.onError(`Cannot save paused queue: ${String(storageError)}`) }
    delivery.onError(reason)
    return false
  }
}

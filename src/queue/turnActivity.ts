import type { QueueEntry } from "./messageQueue.js"

/** Delivery receipts and agent execution are different lifetimes. Keep the
 * UI busy across both, without making failed or edited inputs look active. */
export function resolveTurnActivity(status: string, entries: readonly QueueEntry[], activeRunId?: string, queueError = "") {
  const agentRunning = status !== "ready" && status !== "cancelled"
  const head = entries.find(entry => entry.state !== "accepted")
  const foreground = !queueError && head?.mode === "queue" && (
    head.state === "dispatching" || (!agentRunning && !activeRunId && head.state === "queued")
  ) ? head : undefined
  const busy = agentRunning || !!activeRunId || !!foreground
  return {
    busy,
    status: agentRunning ? status : foreground ? "sending" : activeRunId ? "working" : status,
    foregroundId: foreground?.id,
  }
}

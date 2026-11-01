import { isFinishedGoal, type GoalView } from "./goal-view.js"

interface GoalViewPollingOptions {
  read: () => GoalView | undefined
  publish: (view: GoalView | undefined) => void
  onReadError?: (error: unknown) => void
  schedule?: (callback: () => void, delay: number) => () => void
}

/** Detached work stays responsive; waiting states and failed reads back off.
 * Scheduling one read at a time also prevents a slow ledger from queuing work. */
export function startGoalViewPolling({ read, publish, onReadError, schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
} }: GoalViewPollingOptions): () => void {
  let stopped = false
  let cancelNext: (() => void) | undefined
  let lastView = ""
  let unchanged = 0
  let failures = 0
  const poll = () => {
    if (stopped) return
    let delay: number
    try {
      const view = read()
      if (stopped) return
      publish(view)
      failures = 0
      if (!view || isFinishedGoal(view.status)) return
      const key = JSON.stringify(view)
      unchanged = key === lastView ? Math.min(unchanged + 1, 3) : 0
      lastView = key
      delay = view.status === "running" || view.status === "created" ? 1000 : Math.min(30_000, 5000 * 2 ** unchanged)
    } catch (error) {
      if (stopped) return
      if (failures === 0) { try { onReadError?.(error) } catch { /* Diagnostics cannot break input. */ } }
      failures = Math.min(failures + 1, 6)
      delay = Math.min(60_000, 1000 * 2 ** failures)
    }
    if (!stopped) cancelNext = schedule(poll, delay)
  }
  poll()
  return () => { stopped = true; cancelNext?.() }
}

import { useCallback, useEffect, useRef, useState } from "react"
import type { GoalRecord } from "../../zapsdk/goal/contracts.js"
import type { Logger } from "../../zapsdk/debug/logger.js"
import { goalView, isFinishedGoal, readSessionGoalView, type GoalView } from "../goal-view.js"
import { startGoalViewPolling } from "../goal-view-poller.js"

interface Binding { sessionId: string; selectedId?: string; view?: GoalView; hidden?: boolean }

export function useGoalView(sessionId: string, cwd: string, attached: boolean, databasePath?: string, logger?: Pick<Logger, "debug">) {
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId
  const [binding, setBinding] = useState<Binding>({ sessionId })
  const current = binding.sessionId === sessionId ? binding : undefined
  const select = useCallback((goal: GoalRecord) => {
    if (activeSession.current !== sessionId) return
    setBinding({ sessionId, selectedId: goal.id, view: goalView(goal) })
  }, [sessionId])
  const update = useCallback((goal: GoalRecord) => {
    if (activeSession.current !== sessionId) return
    const view = goalView(goal)
    setBinding(previous => previous.sessionId !== sessionId || previous.hidden || previous.selectedId !== goal.id
      || JSON.stringify(previous.view) === JSON.stringify(view) ? previous : { ...previous, view })
  }, [sessionId])
  const clear = useCallback((finishedOnly = false) => {
    setBinding(previous => previous.sessionId === sessionId && (!finishedOnly || previous.view && isFinishedGoal(previous.view.status))
      ? { sessionId, hidden: true } : previous)
  }, [sessionId])

  useEffect(() => {
    if (attached || current?.hidden) return
    let disposed = false
    const stop = startGoalViewPolling({
      read: () => readSessionGoalView(cwd, sessionId, current?.selectedId, databasePath),
      publish: view => {
        if (disposed || activeSession.current !== sessionId) return
        setBinding(previous => previous.sessionId === sessionId && (previous.hidden || previous.selectedId !== current?.selectedId) ? previous
          : previous.sessionId === sessionId && JSON.stringify(previous.view) === JSON.stringify(view) ? previous
            : { sessionId, selectedId: current?.selectedId, view })
      },
      // Do not log record contents, paths or raw SQLite errors.
      onReadError: error => logger?.debug("goal_view_read_failed", {
        category: error instanceof Error && error.message === "CORRUPT_GOAL_STATE" ? "corrupt" : "unavailable",
      }),
    })
    return () => { disposed = true; stop() }
  }, [sessionId, cwd, attached, current?.selectedId, current?.hidden, databasePath, logger])

  return { view: current?.hidden ? undefined : current?.view, select, update, clear }
}

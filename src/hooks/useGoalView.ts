import { useCallback, useEffect, useRef, useState } from "react"
import type { GoalRecord } from "../../zapsdk/goal/contracts.js"
import { goalView, isFinishedGoal, readSessionGoalView, type GoalView } from "../goal-view.js"

interface Binding { sessionId: string; selectedId?: string; view?: GoalView; hidden?: boolean }

export function useGoalView(sessionId: string, cwd: string, attached: boolean, databasePath?: string) {
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
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false
    let unavailable = false
    const refresh = () => {
      try {
        const view = readSessionGoalView(cwd, sessionId, current?.selectedId, databasePath)
        if (disposed || activeSession.current !== sessionId) return undefined
        setBinding(previous => previous.sessionId === sessionId && (previous.hidden || previous.selectedId !== current?.selectedId) ? previous
          : previous.sessionId === sessionId && JSON.stringify(previous.view) === JSON.stringify(view) ? previous
            : { sessionId, selectedId: current?.selectedId, view })
        if (view && isFinishedGoal(view.status) && timer) clearInterval(timer)
        return view
      } catch { unavailable = true; return undefined } // Preserve the view and retry a busy ledger.
    }
    const initial = refresh()
    if (unavailable || initial && !isFinishedGoal(initial.status)) timer = setInterval(refresh, 1000)
    return () => { disposed = true; if (timer) clearInterval(timer) }
  }, [sessionId, cwd, attached, current?.selectedId, current?.hidden, databasePath])

  return { view: current?.hidden ? undefined : current?.view, select, update, clear }
}

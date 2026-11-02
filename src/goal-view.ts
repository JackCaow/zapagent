import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { stripVTControlCharacters } from "node:util"
import type { GoalRecord, GoalStatus } from "../zapsdk/goal/contracts.js"
import type { Todo } from "../zapsdk/index.js"
import { goalDatabasePath } from "./goal-command.js"

export interface GoalView {
  id: string
  objective: string
  status: GoalStatus
  phase?: GoalRecord["phase"]
  stopReason?: string
  accepted: boolean
}

export function goalView(goal: GoalRecord): GoalView {
  return { id: goal.id, objective: goal.objective, status: goal.status, phase: goal.phase,
    stopReason: goal.stopReason, accepted: goal.finalReceipt?.status === "passed" }
}

export const isFinishedGoal = (status: GoalStatus) => ["completed", "cancelled", "failed"].includes(status)

/** Display polling never creates/migrates the ledger or changes Goal ownership. */
export function readSessionGoalView(cwd: string, sessionId: string, selectedId?: string, path = goalDatabasePath()): GoalView | undefined {
  if (!existsSync(path)) return undefined
  const db = new Database(path, { readonly: true, strict: true })
  try {
    db.exec("PRAGMA busy_timeout=50")
    const row = selectedId
      ? db.query<{ revision: number; record: string }, [string]>("SELECT revision,record FROM goals WHERE id=?").get(selectedId)
      : db.query<{ revision: number; record: string }, [string, string]>("SELECT revision,record FROM goals WHERE json_extract(record,'$.cwd')=? AND json_extract(record,'$.sessionId')=? ORDER BY rowid DESC LIMIT 1").get(cwd, sessionId)
    if (!row) return undefined
    const value = JSON.parse(row.record) as GoalRecord
    if (value.stateRevision !== row.revision || typeof value.objective !== "string") throw new Error("CORRUPT_GOAL_STATE")
    if (value.cwd !== cwd || !selectedId && value.sessionId !== sessionId) return undefined
    return goalView(value)
  } finally { db.close() }
}

export function goalObjectiveText(objective: string): string {
  return stripVTControlCharacters(objective).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()
}

export function goalActionText(goal: GoalView, attached: boolean, todos: readonly Todo[] = [], activeTool = ""): string {
  if (goal.status === "completed") return goal.accepted ? "目标已完成，验收通过" : "目标已完成"
  if (goal.status === "cancelled") return "目标已取消"
  if (goal.status === "failed") return `/goal status ${goal.id} · 目标执行失败`
  if (goal.status === "paused") return goal.stopReason === "DEADLINE_EXCEEDED" ? "已达到你设置的时间限制" : "已暂停，进度已保留"
  if (goal.status === "blocked") return `/goal status ${goal.id} · 目标暂时无法继续`
  if (goal.status === "awaiting_acceptance") return "等待补充信息或确认"
  if (goal.status === "budget_limited") return "已达到你设置的用量限制"
  if (goal.status === "ready_for_delivery") return goal.accepted ? "验收通过，等待交付授权" : "等待交付授权"
  let text: string
  if (goal.phase === "verifying" || goal.phase === "final_verifying") text = "正在独立验收结果"
  else if (goal.phase === "integrating" || goal.phase === "delivering") text = "正在整理并交付结果"
  else if (goal.phase === "sealing") text = "正在停止当前工作"
  else if (goal.status === "created" || goal.phase === "planning") text = "正在准备执行目标"
  else if (!attached) text = goal.phase === "repairing" ? "正在修正验收发现的问题" : "正在推进目标"
  else {
    const current = todos.find(todo => todo.status === "in_progress")
    text = current ? goalObjectiveText(current.activeForm || current.content)
      : goal.phase === "repairing" ? "正在修正验收发现的问题"
        : activeTool && activeTool !== "todo_write" ? `正在使用 ${activeTool}` : "正在推进目标"
  }
  return attached ? text : `后台目标 · ${text}`
}

import { goalCommand, goalDatabasePath } from "./goal-command.js"
import { GoalStore } from "../zapsdk/goal/store.js"
import type { GoalRecord } from "../zapsdk/goal/contracts.js"
import type { AgentEvent } from "../zapsdk/agent/events.js"
import type { PermissionMode } from "./config.js"

export interface GoalSessionOptions {
  runTurn?: import("./goal-turn.js").GoalTurnExecutor
  permissionMode?: PermissionMode
  sessionId?: string
  signal?: AbortSignal
  onStart?: (goal: GoalRecord) => void
  onMessage: (text: string) => void
  onState?: (goal: GoalRecord) => void
  onEvent?: (event: AgentEvent, scope: string) => void
}
const attached = new Map<string, { id: string; background: () => void; pause: () => void; done: Promise<void> }>()
const sessionKey = (cwd: string, sessionId?: string) => JSON.stringify([goalDatabasePath(), cwd, sessionId])

/** Control commands bypass the ordinary turn queue while its Goal is active. */
export function isGoalSessionControl(text: string): boolean {
  return /^\/goal\s+(?:status|watch|list|pause|cancel|background|budget)(?:\s|$)/.test(text.trim())
}

export async function executeGoalCommand(args: string[], cwd: string, options: GoalSessionOptions): Promise<number> {
  const key = sessionKey(cwd, options.sessionId)
  if (args[0] === "background") {
    const detach = attached.get(key)
    if (!detach || args.length > 2 || args[1] && args[1] !== detach.id) throw new Error("No foreground Goal in this session")
    detach.background()
    options.onMessage("Goal will switch to background at the next safe phase boundary.")
    return 0
  }
  if (attached.has(key) && (!args[0] || !["status", "watch", "list", "pause", "cancel", "budget", "help"].includes(args[0]))) throw new Error("A foreground Goal is already running in this session")
  let foreground: GoalRecord | undefined
  const message = goalCommand(args, cwd, options.permissionMode, process.platform, options.sessionId, goal => {
    if (attached.has(key)) throw new Error("A foreground Goal is already running in this session")
    foreground = goal
  }, !!options.runTurn)
  options.onMessage(message)
  if (!foreground) return 0
  const goal = foreground as GoalRecord
  let backgroundRequested = false
  let settle!: () => void
  const done = new Promise<void>(resolve => { settle = resolve })
  attached.set(key, { id: goal.id, done, pause: () => {
    const store = new GoalStore(goalDatabasePath())
    try { const current = store.get(goal.id); if (current && ["created", "running"].includes(current.status)) store.requestControl(goal.id, "pause") } finally { store.close() }
  }, background: () => {
    const store = new GoalStore(goalDatabasePath())
    try {
      const current = store.get(goal.id)
      if (!current?.owner || current.control) throw new Error("Goal is already stopping")
      store.update(goal.id, current.ownerEpoch, current.owner.instanceId, value => { value.yieldRequested = true })
      backgroundRequested = true
    } finally { store.close() }
  } })
  let outcome: GoalRecord | undefined
  try {
    options.onStart?.(goal)
    const { runGoalRunner } = await import("./goal-runner.js")
    const code = await runGoalRunner(goal.id, { runTurn: options.runTurn, signal: options.signal, onState: options.onState,
      onEvent: (event, operationId) => options.onEvent?.(event, `${goal.id}:${operationId}`),
      onOutcome: value => { outcome = value },
    })
    if (backgroundRequested && outcome?.status === "paused" && outcome.stopReason === "USER_INPUT_PENDING") {
      options.onMessage(goalCommand(["resume", goal.id, "--background"], cwd, options.permissionMode, process.platform, options.sessionId))
      options.onMessage(`Goal ${goal.id} is now running in background.`)
      return 0
    }
    if (outcome) {
      options.onMessage(`Goal ${outcome.id} · ${outcome.status}${outcome.stopReason ? ` · ${outcome.stopReason}` : ""}`)
      if (outcome.delivery) options.onMessage(`Goal delivery: ${JSON.stringify(outcome.delivery)}`)
    }
    return code
  } finally { attached.delete(key); settle() }
}

/** Separate process-local content/run identities across planning and workers. */
export function scopeGoalEvent(event: AgentEvent, scope: string): AgentEvent {
  const value = { ...event } as unknown as Record<string, any>
  for (const key of ["id", "subagentId", "requestId"]) if (typeof value[key] === "string") value[key] = `${scope}:${value[key]}`
  if (value.path) value.path = value.path.map((id: string) => `${scope}:${id}`)
  if (value.type === "content_final" && value.kind === "tool_result" && ["agent", "delegate_agent"].includes(value.toolName)
    && typeof value.result?.meta?.subagentId === "string") {
    value.result = { ...value.result, meta: { ...value.result.meta, subagentId: `${scope}:${value.result.meta.subagentId}` } }
  }
  if (value.run) {
    value.run = { ...value.run }
    for (const key of ["runId", "parentRunId", "toolCallId"]) if (value.run[key]) value.run[key] = `${scope}:${value.run[key]}`
  }
  return value as AgentEvent
}

/** Terminal shutdown waits for the owned phase to seal before process.exit. */
export async function closeForegroundGoals(): Promise<void> {
  const sessions = [...attached.values()]
  for (const session of sessions) session.pause()
  await Promise.all(sessions.map(session => session.done))
}

import { createHash } from "node:crypto"
import { openSync, closeSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { GoalStore } from "../zapsdk/goal/store.js"
import { GoalBudgetLedger, type GoalBudgetLimits } from "../zapsdk/goal/budget.js"
import type { GoalRecord } from "../zapsdk/goal/contracts.js"
import { loadAppConfig } from "./config.js"
import { createExecutionEnvironment, resolveExecutionBackend } from "./execution-environment.js"

function machineCheckSupported(cwd: string): boolean {
  const config = loadAppConfig(join(getAppDataDir(), "config.json"))
  const environment = createExecutionEnvironment(cwd, "required", resolveExecutionBackend(config.executionBackend), false, config.sandboxNetwork, [])
  return environment.broker.supportsProcessSeal?.({ name: "bash", executionLocation: "workspace" }) === true
}

export function goalDatabasePath(): string { return join(getAppDataDir(), "goal", "goals.sqlite") }
export function goalHome(goalId: string): string {
  return join(getAppDataDir(), "goal", "runs", createHash("sha256").update(goalId).digest("hex"))
}
function selectGoal(store: GoalStore, cwd: string, id?: string, sessionId?: string): GoalRecord {
  const goals = store.list(cwd)
  const value = id ? store.get(id) : sessionId ? goals.find(goal => goal.sessionId === sessionId) ?? goals.find(goal => !goal.sessionId) : goals[0]
  if (!value || value.cwd !== cwd) throw new Error("No matching Goal in this workspace")
  return value
}
/** No state is created just by sending an ordinary chat message. */
export function pauseGoalsForUserInput(cwd: string, sessionId: string, text: string): string[] {
  if (/^\/goal(?:\s|$)/.test(text.trim()) || !existsSync(goalDatabasePath())) return []
  const store = new GoalStore(goalDatabasePath())
  try { return store.pauseForInput(cwd, sessionId) } finally { store.close() }
}
function definitelyGone(pid: number, group: boolean): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || (group && process.platform === "win32")) return false
  try { process.kill(group ? -pid : pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" }
}
/** An absent PID alone does not establish that the detached phase is gone. */
function recoverStoppedOwner(store: GoalStore, goal: GoalRecord): GoalRecord {
  if (!goal.owner) return goal
  if (!definitelyGone(goal.owner.pid, false)) throw new Error("Goal owner is active or its identity is unresolved")
  const path = join(goalHome(goal.id), "workspace.json")
  if (existsSync(path)) {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { goalId?: string; phaseProcess?: { pid?: number } }
    if (meta.goalId !== goal.id) throw new Error("Goal workspace identity mismatch")
    if (meta.phaseProcess && (!meta.phaseProcess.pid || !definitelyGone(meta.phaseProcess.pid, true))) {
      throw new Error("Goal phase process is still active or cannot be verified stopped")
    }
  } else if (goal.inFlight) throw new Error("Missing Goal process evidence; manual reconciliation required")
  return store.recoverOwner(goal.id, goal.owner.instanceId, true)
}
export function startGoalBackgroundRunner(goal: GoalRecord): void {
  if (goal.owner) throw new Error("Goal already has an active or unresolved owner")
  if (["completed", "cancelled", "failed"].includes(goal.status)) throw new Error(`Goal is ${goal.status}`)
  const directory = goalHome(goal.id)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const log = openSync(join(directory, "runner.log"), "a", 0o600)
  try {
    const isBun = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
    const argv = isBun ? [fileURLToPath(new URL("./index.tsx", import.meta.url)), "--goal-runner", goal.id] : ["--goal-runner", goal.id]
    const child = spawn(process.execPath, argv, { cwd: goal.cwd, detached: true, stdio: ["ignore", log, log], env: { ...process.env, ZAPCODE_DEVTOOLS_PORT: "", ZAPCODE_HOST_PROTOCOL_PORT: "" } })
    if (!child.pid) throw new Error("Failed to launch Goal runner")
    child.unref()
  } finally { closeSync(log) }
}

/** The same command implementation is used by the TUI and the CLI. */
export function goalCommand(args: string[], cwd: string, currentMode: import("./config.js").PermissionMode = "default", platform: NodeJS.Platform = process.platform, sessionId?: string, onForeground?: (goal: GoalRecord) => void): string {
  const action = args[0] ?? ""
  if (!action || action === "help") return [
    "Usage: /goal <objective> [--background] [--artifact] [--strict] [--accept-edits | --permission-mode=MODE] [--check=bun|npm|pytest|go] [--install=npm] [--tokens=N] [--minutes=N] [--model-calls=N] [--tool-calls=N] | status [id] | list | pause [id] | resume [id] | cancel [id] | budget extend [id] --tokens=N --minutes=N",
    "Goals run in the current session by default. Use --background to detach, or /goal background to hand off at a safe boundary.",
    "Goals run until independent acceptance and delivery, with no default token, call or time limit. Use pause or cancel to interrupt.",
    "Goal execution is not yet supported on Windows; --check requires a VM backend with verified process sealing.",
    "Git Goal currently supports macOS repository roots with an existing commit and ordinary SHA-1 metadata; linked worktrees, alternates, shallow and SHA-256 repositories are unavailable.",
    "Git commits remain private to the Goal; delivery changes files only, not the source index or refs. The private index starts from HEAD and does not preserve staged/unstaged grouping.",
    "--install=npm uses package-lock v3, official npm registry tarballs and an offline VM install with lifecycle scripts disabled.",
    "The lockfile must exist before starting; changing package.json or package-lock.json during the Goal blocks it. Existing node_modules is never overwritten. Verifier workspaces are read-only.",
    "--accept-edits authorizes file edits but does not authorize shell commands or artifact merges requiring confirmation.",
  ].join("\n")
  const control = ["list", "status", "watch", "pause", "cancel", "resume", "budget"].includes(action)
  if (platform === "win32" && (action === "resume" || !control)) throw new Error("Goal execution is not yet supported on Windows: process-tree sealing cannot be verified.")
  const checkArgs = args.filter(arg => arg === "--check" || arg.startsWith("--check="))
  const installArgs = args.filter(arg => arg === "--install" || arg.startsWith("--install="))
  const modeArgs = args.filter(arg => arg === "--permission-mode" || arg.startsWith("--permission-mode="))
  if (!control && (modeArgs.length > 1 || modeArgs.some(arg => !/^--permission-mode=(default|acceptEdits|bypassPermissions|plan)$/.test(arg)) || modeArgs.length > 0 && args.includes("--accept-edits"))) throw new Error("Invalid Goal permission mode")
  if (!control && (installArgs.length > 1 || installArgs.some(arg => arg !== "--install=npm"))) throw new Error("Invalid Goal dependency installation; use --install=npm")
  if (!control && installArgs.length && !machineCheckSupported(cwd)) throw new Error("Goal --install=npm requires a VM backend with verified process sealing.")
  if (!control && checkArgs.length && !machineCheckSupported(cwd)) throw new Error("Goal --check machine verification is currently unavailable: process-tree sealing cannot be verified.")
  if (!control && (checkArgs.length > 1 || checkArgs.some(arg => !/^--check=(bun|npm|pytest|go)$/.test(arg)))) throw new Error("Invalid Goal machine check; use --check=bun, npm, pytest or go")
  const background = args.includes("--background")
  if (args.filter(arg => arg === "--background").length > 1 || args.some(arg => arg.startsWith("--background="))) throw new Error("Invalid Goal background flag")
  const limits: GoalBudgetLimits = { strict: args.includes("--strict") }
  const limitKeys = { tokens: "maxTokens", "model-calls": "maxModelCalls", "provider-attempts": "maxProviderAttempts", "tool-calls": "maxToolCalls", minutes: "deadlineAt" } as const
  const limitArgs = !control ? args.filter(arg => /^--(?:tokens|model-calls|provider-attempts|tool-calls|minutes)(?:=|$)/.test(arg)) : []
  const seen = new Set<string>()
  for (const arg of limitArgs) {
    const match = /^--(tokens|model-calls|provider-attempts|tool-calls|minutes)=([1-9]\d*)$/.exec(arg)
    if (!match || seen.has(match[1]!)) throw new Error("Invalid explicit Goal limit")
    seen.add(match[1]!)
    const value = Number(match[2]), key = limitKeys[match[1] as keyof typeof limitKeys]
    const limit = key === "deadlineAt" ? Date.now() + value * 60_000 : value
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(limit)) throw new Error("Invalid explicit Goal limit")
    limits[key] = limit
  }
  if (limits.maxTokens !== undefined) limits.reservedTokens = Math.min(50_000, Math.floor(limits.maxTokens * 0.05))
  if ((!control || action === "resume") && !background && !onForeground) throw new Error("A foreground Goal launcher is required")
  const launch = (goal: GoalRecord) => background ? startGoalBackgroundRunner(goal) : onForeground!(goal)
  const store = new GoalStore(goalDatabasePath(), { requireLedger: true })
  try {
    if (action === "list") {
      const list = store.list(cwd)
      return list.length ? list.map(g => `${g.id} · ${g.status} · ${g.objective}`).join("\n") : "No Goals in this workspace."
    }
    if (["status", "watch"].includes(action)) {
      const goal = selectGoal(store, cwd, args[1], sessionId)
      const ledger = new GoalBudgetLedger(goalDatabasePath())
      try {
        const budget = ledger.snapshot(goal.id)
        return [
          `${goal.id} · ${goal.status}${goal.phase ? ` / ${goal.phase}` : ""}`,
          goal.objective,
          ...(goal.stopReason ? [`Reason: ${goal.stopReason}`] : []),
          ...(goal.failure ? [`Failure: ${JSON.stringify(goal.failure)}`] : []),
          ...(goal.progress ? [`Progress: ${JSON.stringify(goal.progress)}`] : []),
          `Tasks: ${goal.tasks.filter(task => task.status === "passed").length}/${goal.tasks.length}`,
          ...(goal.dependencyInstall ? ["Dependencies: npm (official registry, package-lock v3, scripts disabled)"] : []),
          `Usage: ${budget.totals.modelCalls} model calls · ${budget.totals.toolCalls} tool calls · ${budget.totals.tokensUsed} tokens · ${budget.totals.unknownUsage} unknown usage · ${budget.totals.opaqueToolCalls} unmetered tool calls (${budget.limits.strict === false ? "observed" : "strict"})`,
          ...(goal.delivery ? [`Artifact: ${JSON.stringify(goal.delivery)}`] : []),
          `Log: ${join(goalHome(goal.id), "runner.log")}`,
        ].join("\n")
      } finally { ledger.close() }
    }
    if (action === "budget" && args[1] === "extend") {
      const id = args[2]?.startsWith("--") ? undefined : args[2]
      const goal = selectGoal(store, cwd, id, sessionId)
      const delta: { tokens?: number; modelCalls?: number; providerAttempts?: number; toolCalls?: number; minutes?: number } = {}
      for (const arg of args.slice(id ? 3 : 2)) {
        const match = /^--(tokens|model-calls|provider-attempts|tool-calls|minutes)=(\d+)$/.exec(arg)
        if (!match) throw new Error(`Invalid budget extension: ${arg}`)
        const key = ({ tokens: "tokens", "model-calls": "modelCalls", "provider-attempts": "providerAttempts", "tool-calls": "toolCalls", minutes: "minutes" } as const)[match[1] as "tokens" | "model-calls" | "provider-attempts" | "tool-calls" | "minutes"]
        delta[key] = Number(match[2])
      }
      const updated = store.extendBudget(goal.id, delta)
      return `Goal ${updated.id} budget extended; resume to continue.`
    }
    if (action === "pause" || action === "cancel") {
      const goal = selectGoal(store, cwd, args[1], sessionId); const next = store.requestControl(goal.id, action)
      return `${next.id}: ${next.owner ? `${action} requested; waiting for sealing` : next.status}`
    }
    if (action === "resume") {
      const goal = selectGoal(store, cwd, args[1], sessionId)
      if ((goal.machineCheck || goal.dependencyInstall) && !machineCheckSupported(cwd)) throw new Error("Goal VM execution is currently unavailable: process-tree sealing cannot be verified.")
      const stopped = recoverStoppedOwner(store, goal)
      if (sessionId && stopped.sessionId === sessionId) store.pauseForInput(cwd, sessionId)
      launch(store.prepareResume(stopped.id))
      return `Goal ${goal.id} resumed; budget and task state retained.`
    }
    const permissionMode = args.includes("--accept-edits") ? "acceptEdits" : modeArgs.length ? modeArgs[0]!.slice("--permission-mode=".length) as import("./config.js").PermissionMode : currentMode
    const strict = args.includes("--strict")
    const deliveryPolicy = args.includes("--artifact") ? "artifact" : "workspace"
    const objective = args.filter(arg => arg !== "--background" && arg !== "--strict" && arg !== "--artifact" && arg !== "--accept-edits" && !arg.startsWith("--permission-mode=") && !arg.startsWith("--check=") && !arg.startsWith("--install=") && !limitArgs.includes(arg)).join(" ").trim()
    if (!objective) throw new Error("Goal objective is required")
    const machineCheck = checkArgs[0]?.slice("--check=".length) as "bun" | "npm" | "pytest" | "go" | undefined
    if (sessionId) store.pauseForInput(cwd, sessionId)
    const goal = store.create({ objective, cwd, sessionId, deadlineAt: limits.deadlineAt, deliveryPolicy, permissionMode, machineCheck, dependencyInstall: installArgs.length ? "npm" : undefined })
    const ledger = new GoalBudgetLedger(goalDatabasePath())
    try {
      // Usage remains durable and shared across all phases and children; no
      // implicit cap may turn an unfinished objective into a stopped Goal.
      ledger.create(goal.id, 0, limits)
    } finally { ledger.close() }
    launch(goal)
    return `Goal ${goal.id} started${background ? " in background" : " in this session"} (${limitArgs.length ? "explicit user limits" : "no default usage or time limit"}; ${strict ? "strict accounting" : "observed usage; external tool usage may be unknown"}). Use /goal status ${goal.id} to inspect progress.`
  } finally { store.close() }
}

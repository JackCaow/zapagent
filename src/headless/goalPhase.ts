import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, sep } from "node:path"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PermissionMode } from "../config.js"
import type { HeadlessFormatter, RunSummary } from "./formatter.js"
import type { AgentOutcomeV1 } from "../../zapsdk/runtime/outcome.js"
import { GoalBudgetLedger, type GoalBudgetRole } from "../../zapsdk/goal/budget.js"
import { GoalPhaseError, goalPhaseFailureCode } from "../../zapsdk/goal/errors.js"
import { meterGoalProvider } from "../../zapsdk/goal/metered-provider.js"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import { isHostDuplicateSuppression } from "../../zapsdk/agent/tool-execution-guards.js"
import type { Tool, ToolResult } from "../../zapsdk/tools/types.js"
import type { PrivateGitBinding } from "../../zapsdk/workspace/types.js"
import { privateGitWriteRoot } from "../../zapsdk/execution/workspace-runtime.js"

export function makeGoalMachineToolReadOnly(tool: Tool): Tool {
  const resolveEffects = tool.definition.resolveEffects!
  return { ...tool, definition: { ...tool.definition, resolveEffects: (args, context) => {
    const effects = resolveEffects(args, context)
    return { ...effects, filesystem: effects.filesystem.filter(effect => effect.operation === "read"), workspace: { mode: "shared-readonly" } }
  } } }
}

/** A failed receipt cannot be erased by a later successful model response. */
export class GoalPhaseSealTracker {
  private unsealed = false
  private readonly pendingMutations = new Set<string>()
  markUnsealed(): void { this.unsealed = true }
  observe(event: AgentEvent, shellEnabled: boolean): void {
    if (event.type === "content_final" && (event.kind === "tool_call" || event.kind === "tool_result") &&
      ["agent", "merge_agent_artifacts", "write_file", "edit_file", "multi_edit", "delete_file", "move_file"].includes(event.toolName)) {
      const key = JSON.stringify([event.path ?? [], event.id])
      if (event.kind === "tool_call") this.pendingMutations.add(key)
      if (event.kind === "tool_result") {
        this.pendingMutations.delete(key)
        if (!event.result.success) this.unsealed = true
      }
    }
    if (shellEnabled && event.type === "content_final" && event.kind === "tool_result" && event.toolName === "bash"
      && !isHostDuplicateSuppression(event.result)
      && event.result.runtime?.processSeal?.state !== "sealed") this.unsealed = true
  }
  assertSealed(): void { if (this.unsealed || this.pendingMutations.size) throw new Error("GOAL_SEAL_UNCONFIRMED") }
}

/** Public display events never stand in for the independent sealing result. */
export async function runGoalMachineCommand(command: string, execute: () => Promise<ToolResult>, onEvent?: (event: AgentEvent) => void): Promise<ToolResult> {
  const id = `machine-${randomUUID()}`
  onEvent?.({ type: "content_final", kind: "tool_call", id, step: 1, toolName: "bash", arguments: { command } })
  const result = await execute()
  onEvent?.({ type: "content_final", kind: "tool_result", id, step: 1, toolName: "bash", result })
  return result
}

/** These local tools do not launch opaque model requests. */
const GOAL_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "multi_edit", "delete_file", "move_file",
  "list_tree", "read_document", "read_pdf", "read_docx",
  "read_tool_output", "todo_write", "current_time",
])
const READ_ONLY_GOAL_TOOLS = new Set([
  "read_file", "list_tree", "read_document", "read_pdf", "read_docx",
  "read_tool_output", "current_time",
])

export interface GoalPhaseInput {
  cwd: string
  /** New Goals reuse the ordinary runtime rather than an isolated phase. */
  executionProfile?: "session"
  sessionId?: string
  streamEvents?: boolean
  prompt: string
  goalId: string
  epoch: number
  role: GoalBudgetRole
  ledgerPath: string
  /** Host-created private clone identity; never model supplied. */
  privateGit?: PrivateGitBinding
  privateGitOwnerDirectory?: string
  permissionMode?: PermissionMode
  signal?: AbortSignal
  /** Guarded public runtime events; never a source of process-seal receipts. */
  onEvent?: (event: AgentEvent) => void
  machineCheck?: "bun" | "npm" | "pytest" | "go"
  dependencyInstall?: "npm"
  /** Host must durably record ownership synchronously before input is sent. */
  onSpawn?: (pid: number, mayLaunchSealedProcess: boolean) => void
  /** Called only after the owned process group has ceased to exist. */
  onStopped?: (pid: number) => void
  onSettled?: (result: { text: string; outcome: AgentOutcomeV1; toolCalls: number; sessionId: string }) => void
}

type WorkerInput = Omit<GoalPhaseInput, "signal" | "onSpawn" | "onStopped" | "onSettled" | "onEvent"> & { allowSealedShell?: boolean; streamEvents?: boolean }
type WorkerResult = { type: "result"; summary: RunSummary; exitCode: number; processSealed?: true; runtimeSettled?: boolean; toolCalls: number; failureCode?: string; dependencyHash?: string } | { type: "machine"; result: ToolResult } | { type: "fatal"; message: string; code: string }

/** Check only concrete existing directories. A Host-owned ledger must not sit
 * underneath a model-writable workspace. */
function validateInput(input: WorkerInput): void {
  if (!input || typeof input !== "object" || !isAbsolute(input.cwd) || !isAbsolute(input.ledgerPath)
    || input.executionProfile !== undefined && input.executionProfile !== "session"
    || input.sessionId !== undefined && (typeof input.sessionId !== "string" || !input.sessionId)
    || input.streamEvents !== undefined && typeof input.streamEvents !== "boolean"
    || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 1024 * 1024
    || typeof input.goalId !== "string" || !input.goalId || !Number.isSafeInteger(input.epoch) || input.epoch < 0
    || !["planner", "worker", "verifier", "repair", "maintenance", "finalization"].includes(input.role)
    || input.machineCheck !== undefined && (input.role !== "verifier" || !["bun", "npm", "pytest", "go"].includes(input.machineCheck))
    || input.dependencyInstall !== undefined && (input.dependencyInstall !== "npm" || !(["worker", "repair"].includes(input.role) || input.role === "verifier" && input.machineCheck === "npm"))
    || input.permissionMode !== undefined && !["default", "acceptEdits", "bypassPermissions", "plan"].includes(input.permissionMode)) throw new Error("Invalid Goal phase input")
  const workspace = realpathSync(input.cwd), ledgerDir = realpathSync(dirname(input.ledgerPath))
  if (input.privateGit) {
    if (!["worker", "repair"].includes(input.role) || typeof input.privateGit.directory !== "string"
      || typeof input.privateGit.device !== "string" || typeof input.privateGit.inode !== "string" || typeof input.privateGitOwnerDirectory !== "string" || !isAbsolute(input.privateGitOwnerDirectory)) throw new Error("Invalid Goal private Git binding")
    privateGitWriteRoot({ root: workspace, mode: "isolated-write", privateGitDirectory: input.privateGit.directory,
      privateGitIdentity: { device: input.privateGit.device, inode: input.privateGit.inode } })
  }
  const rel = relative(workspace, ledgerDir)
  if (input.executionProfile !== "session" && (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))) throw new Error("Goal ledger must be outside the writable workspace")
  const ledgerStat = lstatSync(input.ledgerPath)
  if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink()) throw new Error("Goal ledger must be an existing regular file")
}

/** Execute one phase in a fresh process. The process cwd is established before
 * importing the headless Runtime's cwd-bound singleton modules. */
async function runGoalPhaseProcess(input: GoalPhaseInput): Promise<WorkerResult> {
  const { signal, onSpawn, onStopped, onSettled, onEvent, ...workerInput } = input
  validateInput(workerInput)
  signal?.throwIfAborted()
  // Decide before recording ownership and sending the worker any input. A
  // configuration change later cannot turn on shell in this phase.
  const shared = input.executionProfile === "session"
  let allowSealedShell = false
  if (!shared) {
    const [{ loadAppConfig }, { createExecutionEnvironment, resolveExecutionBackend }] = await Promise.all([
      import("../config.js"), import("../execution-environment.js"),
    ])
    const config = loadAppConfig(join(getAppDataDir(), "config.json"))
    const environment = createExecutionEnvironment(input.cwd, "required", resolveExecutionBackend(config.executionBackend), false, config.sandboxNetwork, [])
    allowSealedShell = (input.role === "worker" || input.role === "repair" || !!input.machineCheck || !!input.dependencyInstall)
      && environment.broker.supportsProcessSeal?.({ name: "bash", executionLocation: "workspace" }) === true
    if (input.machineCheck && !allowSealedShell) throw new Error("GOAL_VERIFIER_PROCESS_SEAL_UNSUPPORTED")
    if (input.dependencyInstall && !allowSealedShell) throw new Error("GOAL_NPM_PROCESS_SEAL_UNSUPPORTED")
  }
  const safeEnvironment = shared ? process.env : Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))
  const isBun = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
  const argv = isBun ? [fileURLToPath(new URL("../index.tsx", import.meta.url)), "--goal-phase-worker"] : ["--goal-phase-worker"]
  const child = spawn(process.execPath, argv, {
    cwd: dirname(workerInput.ledgerPath),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...safeEnvironment, ...(!shared ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : {}), ZAPCODE_DEVTOOLS_PORT: "", ZAPCODE_HOST_PROTOCOL_PORT: "" },
  })
  let output = "", resultOutput: string | undefined, cancelled = false, spawnRecorded = false, protocolError: Error | undefined, spawnError: unknown
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let pipeTimer: ReturnType<typeof setTimeout> | undefined
  const killGroup = (signalName: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signalName); return } catch { /* process may already be gone */ }
    }
    try { child.kill(signalName) } catch { /* process may already be gone */ }
  }
  const abort = () => {
    cancelled = true
    killGroup("SIGINT")
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), 3000)
  }
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", code => resolve(code))
  })
  // A descendant may retain stdout after its worker exits. Terminate the
  // remaining process group and fail closed if any pipe still stays open.
  child.once("exit", () => {
    if (!child.pid || !goalPhaseGroupAlive(child.pid)) return
    killGroup("SIGTERM")
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), 1000)
    pipeTimer = setTimeout(() => {
      protocolError = new Error("GOAL_SEAL_UNCONFIRMED")
      child.stdout.destroy()
      child.stderr.destroy()
    }, 5000)
  })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    output += chunk
    if (onEvent) {
      let newline: number
      while ((newline = output.indexOf("\n")) >= 0 && !protocolError) {
        const line = output.slice(0, newline); output = output.slice(newline + 1)
        if (!line.trim()) continue
        try {
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("Goal phase output exceeds protocol limit")
          const frame = JSON.parse(line)
          if (frame.type === "event" && frame.event && typeof frame.event.type === "string" && !resultOutput) {
            onEvent(frame.event)
          } else if (["result", "machine", "fatal"].includes(frame.type) && !resultOutput) resultOutput = line
          else throw new Error("Invalid Goal phase stream frame")
        } catch (error) { protocolError = error instanceof Error ? error : new Error("Invalid Goal phase stream"); abort() }
      }
    }
    if (Buffer.byteLength(output) > 16 * 1024 * 1024 && !protocolError) {
      protocolError = new Error("Goal phase output exceeds protocol limit")
      abort()
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", () => {})
  child.stdin.on("error", () => {})
  try {
    try {
      if (!child.pid) throw new Error("Goal phase worker has no pid")
      onSpawn?.(child.pid, shared || allowSealedShell)
      spawnRecorded = true
      child.stdin.end(JSON.stringify({ ...workerInput, allowSealedShell, ...(onEvent ? { streamEvents: true } : {}) }))
    } catch (error) {
      spawnError = error
      abort()
      child.stdin.end()
    }
    const exitCode = await completion
    const pid = child.pid
    if (!pid || process.platform === "win32") throw new Error("GOAL_SEAL_UNCONFIRMED")
    if (goalPhaseGroupAlive(pid)) {
      killGroup("SIGTERM")
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), 1000)
      const deadline = Date.now() + 5000
      while (goalPhaseGroupAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (goalPhaseGroupAlive(pid)) throw new Error("GOAL_SEAL_UNCONFIRMED")
    if (!shared && !allowSealedShell && spawnRecorded) onStopped?.(pid)
    if (spawnError) throw spawnError
    if (protocolError) throw protocolError
    if (cancelled && !shared) throw new Error("GOAL_PHASE_CANCELLED")
    if (onEvent && resultOutput && output.trim()) throw new Error("Invalid trailing Goal phase output")
    let response: WorkerResult
    try { response = JSON.parse(resultOutput ?? output) as WorkerResult } catch { throw new Error(`Goal phase process returned invalid output (exit ${exitCode})`) }
    if (response.type === "fatal") throw new GoalPhaseError(response.code ?? goalPhaseFailureCode(response.message))
    if (response.type === "machine") {
      if (!input.machineCheck || exitCode !== 0 || response.result.runtime?.processSeal?.state !== "sealed") throw new Error("GOAL_SEAL_UNCONFIRMED")
      if (allowSealedShell) onStopped?.(pid)
      return response
    }
    if (response.type !== "result" || !response.summary?.outcome) throw new Error(`Goal phase produced no structured outcome (exit ${exitCode})`)
    // A failed model call can still finish with every tool/process sealed.
    // Only this worker-owned receipt, never model text, may clear ownership.
    if (shared ? response.runtimeSettled !== true : response.processSealed !== true) throw new GoalPhaseError("GOAL_SEAL_UNCONFIRMED")
    if (shared) onSettled?.({ text: response.summary.text, outcome: response.summary.outcome, toolCalls: response.toolCalls, sessionId: response.summary.sessionId })
    if (shared || allowSealedShell) onStopped?.(pid)
    if (cancelled) throw new Error("GOAL_PHASE_CANCELLED")
    if ((!shared && (exitCode !== 0 || response.exitCode !== 0)) || !(shared ? ["finished", "limited"] : ["finished"]).includes(response.summary.outcome.execution.status)) {
      throw new GoalPhaseError(response.failureCode ?? "GOAL_PHASE_FAILED")
    }
    return response
  } finally {
    signal?.removeEventListener("abort", abort)
    if (killTimer) clearTimeout(killTimer)
    if (pipeTimer) clearTimeout(pipeTimer)
  }
}

export async function runGoalPhase(input: GoalPhaseInput): Promise<{ text: string; outcome: AgentOutcomeV1; toolCalls: number; sessionId?: string; dependencyHash?: string }> {
  const response = await runGoalPhaseProcess(input)
  if (response.type !== "result" || !response.summary.outcome) throw new Error("Unexpected Goal phase response")
  return { text: response.summary.text, outcome: response.summary.outcome, toolCalls: response.toolCalls, sessionId: response.summary.sessionId, ...(response.dependencyHash ? { dependencyHash: response.dependencyHash } : {}) }
}

export async function runGoalMachinePhase(input: GoalPhaseInput & { machineCheck: "bun" | "npm" | "pytest" | "go" }): Promise<ToolResult> {
  const response = await runGoalPhaseProcess(input)
  if (response.type !== "machine") throw new Error("Unexpected Goal machine response")
  return response.result
}

/** A persisted pid is only a process-group liveness probe; the Host must
 * separately validate ownership and PID reuse before taking recovery action. */
export function goalPhaseGroupAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === "win32") return true
  try { process.kill(-pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}

/** Internal CLI worker. The input comes from the trusted controller over
 * stdin, not from the model, and is not passed in argv or environment. */
export async function runGoalPhaseWorker(): Promise<number> {
  let raw = ""
  try {
    for await (const chunk of process.stdin) {
      raw += chunk.toString()
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Goal phase input exceeds protocol limit")
    }
    const input = JSON.parse(raw) as WorkerInput
    validateInput(input)
    if (input.executionProfile === "session") {
      process.chdir(input.cwd)
      const { runSharedGoalTurnWorker } = await import("./sharedGoalTurn.js")
      return await runSharedGoalTurnWorker(input)
    }
    validateInput(input)
    process.chdir(input.cwd)
    delete process.env.ZAPCODE_DEVTOOLS_PORT
    delete process.env.ZAPCODE_HOST_PROTOCOL_PORT
    // Import only after chdir: session, memory and checkpoint singletons bind cwd.
    const [{ runHeadless }, { loadAppConfig }, { configPath }] = await Promise.all([import("./runHeadless.js"), import("../config.js"), import("../session.js")])
    const { createExecutionEnvironment, resolveExecutionBackend } = await import("../execution-environment.js")
    const ledger = new GoalBudgetLedger(input.ledgerPath)
    try {
      const snapshot = ledger.snapshot(input.goalId)
      if (snapshot.epoch !== input.epoch) throw new Error("Stale Goal phase epoch")
      const config = { ...loadAppConfig(configPath), allowUnsandboxedCommands: false, sandboxExcludedCommands: [] }
      const environment = createExecutionEnvironment(input.cwd, "required", resolveExecutionBackend(config.executionBackend), false, config.sandboxNetwork, [])
      const canSeal = input.allowSealedShell === true && environment.broker.supportsProcessSeal?.({ name: "bash", executionLocation: "workspace" }) === true
      let dependencyProof: import("./goal-npm-install.js").GoalNpmInstallProof | undefined
      const childDependencyProofs = new Map<string, import("./goal-npm-install.js").GoalNpmInstallProof>()
      if (input.dependencyInstall) {
        if (!canSeal) throw new Error("GOAL_NPM_PROCESS_SEAL_UNSUPPORTED")
        const { installGoalNpmDependencies } = await import("./goal-npm-install.js")
        dependencyProof = await installGoalNpmDependencies({ cwd: input.cwd, ledger, goalId: input.goalId, epoch: input.epoch, role: input.role, config })
      }
      if (input.machineCheck) {
        if (!canSeal) throw new Error("GOAL_VERIFIER_PROCESS_SEAL_UNSUPPORTED")
        const [{ ToolRegistry }, { ToolExecutor }, { executeCommandTool }, { requireProcessSealing }] = await Promise.all([
          import("../../zapsdk/tools/registry.js"), import("../../zapsdk/tools/executor.js"),
          import("../../zapsdk/builtin-tools/command.js"), import("../../zapsdk/execution/required-process-seal.js"),
        ])
        const registry = new ToolRegistry()
        const commandTool = executeCommandTool({ ...environment.commandOptions, defaultCwd: input.cwd, timeoutMs: 120_000,
          disableBackgroundTasks: true, allowUnsandboxed: false, sandboxNetwork: false, restrictedNetwork: false, workspaceOnly: true })
        registry.register(makeGoalMachineToolReadOnly(commandTool))
        let unsealed = false
        const executor = new ToolExecutor(registry, { cwd: input.cwd, onApproval: async () => true,
          executionBroker: requireProcessSealing(environment.broker, () => { unsealed = true }) })
        const command = { bun: "bun test", npm: "npm test", pytest: "python3 -m pytest", go: "go test ./..." }[input.machineCheck]
        const result = await runGoalMachineCommand(command, () => executor.execute("bash", { command }), input.streamEvents ? event => { process.stdout.write(JSON.stringify({ type: "event", event }) + "\n") } : undefined)
        if (unsealed || result.runtime?.processSeal?.state !== "sealed") throw new Error("GOAL_SEAL_UNCONFIRMED")
        process.stdout.write(JSON.stringify({ type: "machine", result } satisfies WorkerResult) + "\n")
        return 0
      }
      const mode = input.permissionMode ?? config.permissionMode
      const readOnly = input.role === "planner" || input.role === "verifier" || input.role === "finalization"
      const canDelegate = canSeal && !readOnly
      const strictOpaque = snapshot.limits.strict !== false && [snapshot.limits.maxTokens, snapshot.limits.maxCostMicro,
        snapshot.limits.maxModelCalls, snapshot.limits.maxProviderAttempts, snapshot.limits.maxSpawns].some(value => value !== undefined)
      const permitted = (name: string) => {
        // A sandboxed shell can still fork and setsid, escaping the process
        // group we can seal. Fail closed until the host owns a process-tree
        // containment primitive (e.g. a job object or equivalent).
        if (["delegate_agent", "cron_create", "monitor", "http_request"].includes(name)) return false
        if (name === "agent" || name === "merge_agent_artifacts") return canDelegate
        if (name === "bash") return canSeal && !readOnly
        if (readOnly) return READ_ONLY_GOAL_TOOLS.has(name) || (!strictOpaque && name === "http_fetch")
        return GOAL_TOOLS.has(name) || (!strictOpaque && name === "http_fetch")
      }
      let summary: RunSummary | undefined
      let failure: { code: string; message: string } | undefined
      let toolCalls = 0
      let runtimeError = ""
      let permissionDenied = false
      let unavailableTool = false
      const sealTracker = new GoalPhaseSealTracker()
      const formatter: HeadlessFormatter = {
        init() {}, onEvent(event) {
          if (event.type === "content_final" && event.kind === "tool_call" && !permitted(event.toolName)) unavailableTool = true
          if (event.type === "content_final" && event.kind === "tool_call") toolCalls++
          if (event.type === "error") runtimeError = event.error
          sealTracker.observe(event, permitted("bash"))
          if (input.streamEvents) process.stdout.write(JSON.stringify({ type: "event", event }) + "\n")
        }, progress() {},
        finalize(value) { summary = value },
        failure(value) { failure = value },
      }
      const exitCode = await runHeadless({
        prompt: input.prompt, permissionMode: mode, outputFormat: "json", resultSchema: "outcome-v1",
        continueOnToolDenial: false, continueLast: false, cwd: input.cwd, quiet: true,
        dangerouslyDisableOsSandbox: false, noDevtools: true,
      }, {
        config, formatter, disableSubagent: !canDelegate, disableShellNetwork: true, requireProcessSeal: canSeal, isolateWorkspace: true, privateGit: input.privateGit, privateGitOwnerDirectory: input.privateGitOwnerDirectory, serializeSubagent: canDelegate,
        ...(canDelegate ? { subagentIsolationRoot: join(input.privateGitOwnerDirectory ?? dirname(input.ledgerPath), "child-workspaces", createHash("sha256").update(input.goalId).digest("hex")) } : {}),
        ...(input.dependencyInstall ? { prepareSubagentWorkspace: async (cwd: string, signal?: AbortSignal) => {
          const { installGoalNpmDependencies } = await import("./goal-npm-install.js")
          childDependencyProofs.set(cwd, await installGoalNpmDependencies({ cwd, ledger, goalId: input.goalId, epoch: input.epoch, role: input.role, config, signal }))
        }, validateSubagentWorkspace: async (cwd: string) => {
          const proof = childDependencyProofs.get(cwd)
          if (!proof) throw new Error("GOAL_NPM_INSTALLATION_EVIDENCE_MISSING")
          const { assertGoalNpmDependenciesUnchanged } = await import("./goal-npm-install.js")
          await assertGoalNpmDependenciesUnchanged(cwd, proof)
          childDependencyProofs.delete(cwd)
        } } : {}),
        disableRepoMap: true,
        onProcessSealUnconfirmed: () => sealTracker.markUnsealed(),
        onPermissionDenied: () => { permissionDenied = true },
        providerAdapter: provider => meterGoalProvider(provider, ledger, { goalId: input.goalId, epoch: input.epoch, role: input.role,
          scope: { providerId: config.active.providerId, modelId: config.active.model } }),
        prepareRegistry: async registry => {
          for (const definition of registry.definitions()) if (!permitted(definition.name)) registry.unregister(definition.name)
        },
        admitToolExecution: name => {
          if (!permitted(name)) throw new Error("GOAL_UNMETERED_TOOL_UNAVAILABLE")
          const admission = ledger.admit(input.goalId, input.epoch, { operationId: randomUUID(), role: input.role, kind: "tool",
            opaque: !GOAL_TOOLS.has(name) && name !== "agent" && name !== "merge_agent_artifacts" && name !== "bash" })
          if (!admission.ok) throw new Error(`Goal tool admission denied: ${admission.reason}`)
          if (name === "agent") {
            const spawnAdmission = ledger.admit(input.goalId, input.epoch, { operationId: randomUUID(), role: input.role, kind: "spawn" })
            if (!spawnAdmission.ok) throw new Error(`Goal spawn admission denied: ${spawnAdmission.reason}`)
          }
        },
      })
      if (permissionDenied) throw new Error("GOAL_PHASE_PERMISSION_DENIED")
      sealTracker.assertSealed()
      if (dependencyProof) {
        const { assertGoalNpmDependenciesUnchanged } = await import("./goal-npm-install.js")
        await assertGoalNpmDependenciesUnchanged(input.cwd, dependencyProof)
      }
      if (unavailableTool) throw new Error("GOAL_UNMETERED_TOOL_UNAVAILABLE")
      if (!summary) throw new Error(failure?.code ?? `Headless phase failed (${exitCode})`)
      process.stdout.write(JSON.stringify({ type: "result", summary, exitCode, processSealed: true, toolCalls,
        ...(exitCode !== 0 ? { failureCode: goalPhaseFailureCode(runtimeError || summary.error || summary.outcome?.execution.error?.code || "") } : {}), dependencyHash: dependencyProof?.dependencyHash } satisfies WorkerResult) + "\n")
      return exitCode
    } finally { ledger.close() }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Goal phase failure"
    process.stdout.write(JSON.stringify({ type: "fatal", message: goalPhaseFailureCode(message), code: goalPhaseFailureCode(message) } satisfies WorkerResult) + "\n")
    return 2
  }
}

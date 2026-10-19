import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { PermissionMode } from "../config.js"
import type { RunSummary } from "../headless/formatter.js"
import type { WorkerInput } from "./worker.js"

export interface AcpTurn {
  input: WorkerInput
  signal: AbortSignal
  onInit: (sessionId: string) => void
  onEvent: (event: AgentEvent) => void
  onApproval: (request: { name: string; args: Record<string, unknown>; toolCallId: string }) => Promise<boolean>
  onModeTransport: (send: (mode: PermissionMode) => void) => void
}
export type AcpRunTurn = (turn: AcpTurn) => Promise<RunSummary>

export const runAcpTurn: AcpRunTurn = async turn => {
  const command = process.execPath
  const argv = process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe")
    ? [fileURLToPath(new URL("../index.tsx", import.meta.url)), "--acp-worker"] : ["--acp-worker"]
  const child = spawn(command, argv, { cwd: turn.input.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    env: { ...process.env, ZAPCODE_DEVTOOLS_PORT: "", ZAPCODE_HOST_PROTOCOL_PORT: "" } })
  const send = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n") }
  const lines = createInterface({ input: child.stdout })
  let summary: RunSummary | undefined
  let failure: Error | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let aborted = false
  let sealing = false
  const abortWorker = () => {
    aborted = true
    child.kill("SIGINT")
    killTimer ??= setTimeout(() => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL") } catch {}
      } else child.kill("SIGKILL")
    }, 3000)
  }
  const cancel = () => { if (!sealing && !summary?.outcome) abortWorker() }
  turn.signal.addEventListener("abort", cancel, { once: true })
  turn.onModeTransport(mode => send({ type: "mode", mode }))
  // Worker diagnostics are never forwarded to the protocol stdout.
  child.stderr.on("data", chunk => process.stderr.write(chunk))
  child.stdin.on("error", () => {})
  lines.on("line", line => {
    try {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("Worker output exceeds protocol limit")
      const value = JSON.parse(line)
      if (value.type === "init") turn.onInit(value.sessionId)
      else if (value.type === "sealing") {
        sealing = true
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined }
      }
      else if (value.type === "event") turn.onEvent(value.event)
      else if (value.type === "result") {
        summary = value
        if (summary?.outcome && killTimer) { clearTimeout(killTimer); killTimer = undefined }
      }
      else if (value.type === "fatal" || value.type === "error") failure = new Error(value.message)
      else if (value.type === "approval") {
        void turn.onApproval(value).then(approved => send({ type: "permission", id: value.id, approved }),
          () => send({ type: "permission", id: value.id, approved: false }))
      }
    } catch (error) { failure = error instanceof Error ? error : new Error("Invalid worker response"); abortWorker() }
  })
  try {
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", () => resolve())
    })
    send({ type: "start", input: turn.input })
    if (turn.signal.aborted) cancel()
    await exited
    if (failure && !turn.signal.aborted) throw failure
    if (summary?.outcome && !failure) return summary
    if (aborted) return { ok: false, text: summary?.text ?? "", sessionId: summary?.sessionId ?? "",
      turns: summary?.turns ?? 0, toolCalls: summary?.toolCalls ?? [], usage: summary?.usage ?? { inputTokens: 0, outputTokens: 0 }, stopReason: "aborted" }
    if (failure) throw failure
    if (!summary) throw new Error("Agent worker exited without a result")
    if (summary.stopReason === "error") throw new Error(summary.error ?? "Agent run failed")
    return summary
  } finally {
    if (killTimer) clearTimeout(killTimer)
    turn.signal.removeEventListener("abort", cancel)
    lines.close()
    child.stdin.end()
  }
}

import { createInterface } from "node:readline"
import { createLocalProcessBroker, terminateProcessTreeWithGrace } from "../../zapsdk/execution/process.js"
import { nativeCommand } from "./official-agents.js"

export interface ClaudeModelChoice {
  value: string
  label: string
  resolvedModel?: string
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim() || undefined : undefined
}

/** Ask the installed CLI for the same model catalog exposed to the Agent SDK.
 * Only initialize the protocol. No user prompt or session is created. */
export async function discoverClaudeModels(cwd: string, signal: AbortSignal): Promise<ClaudeModelChoice[]> {
  const cli = await nativeCommand("claude")
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  const child = createLocalProcessBroker(lifetime).spawnCommand(cli.command, [...cli.args,
    "--print", "--verbose", "--safe-mode", "--no-session-persistence", "--strict-mcp-config",
    "--tools", "", "--input-format", "stream-json", "--output-format", "stream-json",
  ], { cwd, hostHome: true, stdin: "pipe" })
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  child.on("error", () => {})
  child.stdin!.on("error", () => {})
  child.stderr!.resume()
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } }) + "\n")
  try {
    for await (const line of lines) {
      lifetime.throwIfAborted()
      let event
      try { event = JSON.parse(line) } catch { continue }
      const response = event?.response
      if (event?.type !== "control_response" || response?.request_id !== "catalog") continue
      const models = response.response?.models
      if (response.subtype !== "success" || !Array.isArray(models)) break
      const result = new Map<string, ClaudeModelChoice>()
      for (const model of models) {
        const value = cleanText(model?.value)
        if (!value || value !== model.value || value.startsWith("-") || result.has(value)) continue
        result.set(value, { value, label: cleanText(model.displayName) ?? value, resolvedModel: cleanText(model.resolvedModel) })
      }
      return [...result.values()]
    }
    lifetime.throwIfAborted()
    throw new Error("Claude Code did not return a model list")
  } finally {
    lines.close()
    child.stdin!.end()
    if (child.pid && child.exitCode === null && child.signalCode === null) terminateProcessTreeWithGrace(child)
    await closed
  }
}

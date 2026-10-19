import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import type { AppConfig, PermissionMode } from "../config.js"
import type { HeadlessArgs } from "../headless/args.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import type { McpServer } from "@agentclientprotocol/sdk"
import { MCPManager, type MCPServerConfig } from "../../zapsdk/mcp/index.js"

export interface WorkerInput {
  cwd: string
  prompt: string
  config: AppConfig
  mode: PermissionMode
  runtimeSessionId?: string
  images: ImageContent[]
  mcpServers: McpServer[]
}

export function mcpConfigs(servers: McpServer[], cwd: string): MCPServerConfig[] {
  return servers.map(server => {
    if ("type" in server) {
      if (server.type !== "http" && server.type !== "sse") throw new Error("Unsupported MCP transport")
      return { name: server.name, transport: server.type, url: server.url,
        headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])), cwd }
    }
    return { name: server.name, transport: "stdio", command: server.command, args: server.args,
      env: Object.fromEntries(server.env.map(variable => [variable.name, variable.value])), cwd }
  })
}

/** One isolated worker per turn reuses the production headless Runtime. The
 * parent owns stable ACP IDs; native JSONL restore produces a new journal ID. */
export async function runAcpWorker(): Promise<number> {
  // Dependencies may log to console during setup. Protocol output is only send().
  console.log = (...args) => console.error(...args)
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
  const lines = createInterface({ input: process.stdin })
  const pending = new Map<string, (approved: boolean) => void>()
  let mode: PermissionMode = "default"
  let start!: (input: WorkerInput) => void
  const input = new Promise<WorkerInput>(resolve => { start = resolve })
  let started = false
  lines.on("line", line => {
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) { send({ type: "fatal", message: "Worker input too large" }); process.exit(2) }
    try {
      const message = JSON.parse(line)
      if (message.type === "start" && !started) { started = true; mode = message.input.mode; start(message.input) }
      else if (message.type === "permission") {
        pending.get(message.id)?.(message.approved === true)
        pending.delete(message.id)
      } else if (message.type === "mode" && ["default", "plan", "acceptEdits"].includes(message.mode)) mode = message.mode
    } catch { send({ type: "fatal", message: "Malformed worker input" }); process.exit(2) }
  })
  lines.on("close", () => { if (!started) process.exit(2) })
  const request = await input
  process.chdir(request.cwd)
  // All cwd-scoped singletons are imported only after chdir.
  const { runHeadless } = await import("../headless/runHeadless.js")
  const args: HeadlessArgs = { prompt: request.prompt, permissionMode: request.mode,
    outputFormat: "stream-json", resultSchema: "outcome-v1", continueLast: false, sessionId: request.runtimeSessionId,
    continueOnToolDenial: true, quiet: true, dangerouslyDisableOsSandbox: false, noDevtools: true }
  const calls = new Map<string, string>()
  const mcp = new MCPManager({ projectCwd: request.cwd })
  try {
    return await runHeadless(args, {
      config: request.config, images: request.images, strictResume: true,
      onSealing: () => { send({ type: "sealing" }) },
      getPermissionMode: () => mode,
      formatter: {
        init: detail => { send({ type: "init", ...detail }) },
        onEvent: () => {}, progress: text => process.stderr.write(text + "\n"),
        failure: error => { send({ type: "error", ...error }) },
        finalize: summary => { send({ type: "result", ...summary }) },
      },
      onEvent: (event: AgentEvent) => {
        if (event.type === "content_final" && event.kind === "tool_call") {
          calls.set(event.toolName + JSON.stringify(event.arguments), `${(event.path ?? []).join("/")}:${event.id}`)
        }
        send({ type: "event", event })
      },
      onAsk: (name, args, signal) => new Promise<boolean>(resolve => {
        if (signal?.aborted) { resolve(false); return }
        const id = randomUUID()
        const finish = (approved: boolean) => {
          pending.delete(id); signal?.removeEventListener("abort", cancelled); resolve(approved)
        }
        const cancelled = () => finish(false)
        pending.set(id, finish)
        signal?.addEventListener("abort", cancelled, { once: true })
        send({ type: "approval", id, name, args, toolCallId: calls.get(name + JSON.stringify(args)) ?? `:${id}` })
      }),
      prepareRegistry: async registry => {
        const configs = mcpConfigs(request.mcpServers, request.cwd)
        if (!configs.length) return
        const ready = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { off(); reject(new Error("MCP initialization timed out")) }, 15000)
          const check = () => {
            const states = mcp.snapshots()
            if (states.length !== configs.length || states.some(state => ["idle", "connecting"].includes(state.status))) return
            clearTimeout(timer); off()
            if (states.some(state => state.status !== "ready")) reject(new Error("MCP initialization failed"))
            else resolve()
          }
          const off = mcp.on(check)
          void mcp.reconcile(configs).then(check, error => { clearTimeout(timer); off(); reject(error) })
        })
        await ready
        for (const tool of mcp.allTools()) registry.register(tool)
      },
    })
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : "ACP worker failed" })
    return 1
  } finally {
    for (const finish of pending.values()) finish(false)
    await mcp.stopAll()
    lines.close()
  }
}

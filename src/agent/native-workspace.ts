import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import type { ToolDefinition, ToolResult } from "../../zapsdk/tools/types.js"

export type NativePreview = (path: string, signal: AbortSignal) => Promise<ToolResult>
export interface NativeShell {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>
}
const name = "zap_workspace"

let endpoint: string | undefined
type Lease = { signal: AbortSignal; preview: NativePreview; shell?: NativeShell }
const sessions = new Map<string, { active?: Lease; shell?: ToolDefinition }>()

async function handle(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization")
  const session = authorization ? sessions.get(authorization) : undefined
  if (!session) {
    return new Response("Preview turn is unavailable", { status: 401 })
  }
  const address = new URL(endpoint!)
  if (request.headers.get("host") !== address.host || request.headers.has("origin")) {
    return new Response("Invalid preview endpoint", { status: 403 })
  }
  const server = new McpServer({ name, version: "1" })
  const run = async (operation: (turn: Lease, signal: AbortSignal) => Promise<ToolResult>, signal: AbortSignal) => {
    const turn = session.active
    if (!turn || turn.signal.aborted) return { isError: true, content: [{ type: "text" as const, text: "Workspace turn ended." }] }
    const result = await operation(turn, AbortSignal.any([turn.signal, request.signal, signal]))
    const text = [result.error, result.output].filter(Boolean).join("\n")
    return { isError: !result.success, content: [{ type: "text" as const, text }] }
  }
  server.registerTool("preview_artifact", {
    description: "Open an offline preview of the requested project file in the user's browser.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true },
  }, ({ path }, extra) => run((turn, signal) => turn.preview(path, signal), extra.signal))
  if (session.shell) server.registerTool("run_command", {
    description: "Run a command through Zap in the current project. Zap applies the active mode and workspace grants.",
    inputSchema: session.shell.parameters,
  }, (args, extra) => run((turn, signal) => turn.shell?.execute(args as Record<string, unknown>, signal)
    ?? Promise.resolve({ success: false, output: "", error: "Project command access is unavailable." }), extra.signal))
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try { return await transport.handleRequest(request) }
  finally { await server.close() }
}

/** A native adapter can request a view, and the current Zap turn owns playback. */
export function createNativeWorkspace(shell?: ToolDefinition) {
  if (!endpoint) {
    try {
      const options = { hostname: "127.0.0.1", port: 0, maxRequestBodySize: 64 * 1024, idleTimeout: 0, fetch: handle }
      const listener = Bun.serve(options)
      if ("unref" in listener && typeof listener.unref === "function") listener.unref()
      endpoint = `http://127.0.0.1:${listener.port}/mcp`
    } catch { return undefined }
  }
  const authorization = `Bearer ${randomUUID()}`
  const session: { active?: Lease; abort?: AbortController; shell?: ToolDefinition } = { shell }
  sessions.set(authorization, session)
  return {
    name: `${name}_${randomUUID().slice(0, 8)}`, url: endpoint, authorization, command: !!shell,
    bind(preview: NativePreview, signal: AbortSignal, shell?: NativeShell) {
      session.abort?.abort()
      const lease = new AbortController()
      const turn = { signal: AbortSignal.any([signal, lease.signal]), preview, shell }
      session.abort = lease
      session.active = turn
      return () => {
        lease.abort()
        if (session.active === turn) session.active = undefined
      }
    },
    close() {
      sessions.delete(authorization)
      session.abort?.abort()
      session.active = undefined
    },
  }
}

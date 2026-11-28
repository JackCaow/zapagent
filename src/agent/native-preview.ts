import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import type { ToolResult } from "../../zapsdk/tools/types.js"

export type NativePreview = (path: string, signal: AbortSignal) => Promise<ToolResult>
const name = "zap_preview"

let endpoint: string | undefined
type Lease = { signal: AbortSignal; preview: NativePreview }
const sessions = new Map<string, { active?: Lease }>()

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
  server.registerTool("preview_artifact", {
    description: "Open an offline preview of the requested project file in the user's browser.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true },
  }, async ({ path }, extra) => {
    const turn = session.active
    if (!turn || turn.signal.aborted) return { isError: true, content: [{ type: "text", text: "Preview turn ended." }] }
    const signal = AbortSignal.any([turn.signal, request.signal, extra.signal])
    const result = await turn.preview(path, signal)
    return { isError: !result.success, content: [{ type: "text", text: result.success ? result.output : result.error ?? result.output }] }
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try { return await transport.handleRequest(request) }
  finally { await server.close() }
}

/** A native adapter can request a view, and the current Zap turn owns playback. */
export function createNativePreview() {
  if (!endpoint) {
    try {
      const options = { hostname: "127.0.0.1", port: 0, maxRequestBodySize: 32 * 1024, fetch: handle }
      const listener = Bun.serve(options)
      if ("unref" in listener && typeof listener.unref === "function") listener.unref()
      endpoint = `http://127.0.0.1:${listener.port}/mcp`
    } catch { return undefined }
  }
  const authorization = `Bearer ${randomUUID()}`
  const session: { active?: Lease; abort?: AbortController } = {}
  sessions.set(authorization, session)
  return {
    name: `${name}_${randomUUID().slice(0, 8)}`, url: endpoint, authorization,
    bind(preview: NativePreview, signal: AbortSignal) {
      session.abort?.abort()
      const lease = new AbortController()
      const turn = { signal: AbortSignal.any([signal, lease.signal]), preview }
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

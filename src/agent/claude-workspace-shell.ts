import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { ToolResult } from "../../zapsdk/tools/types.js"

export type WorkspaceCommand = (args: { command: string; timeout_ms?: number }, signal: AbortSignal) => Promise<ToolResult>

const commandSchema = z.strictObject({
  command: z.string().min(1),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
})
const tool = {
  name: "shell",
  description: "Run a foreground shell command in the Zap project directory, including tests, builds, and lint. Each call starts in the project root.",
  inputSchema: z.toJSONSchema(commandSchema),
  _meta: { "anthropic/alwaysLoad": true },
}
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

/** The CLI carries requests on its private stdio channel. Only the Zap
 * executor can authorize/execute a command, including calls from subagents. */
export function claudeWorkspaceShell(sessionId: string, execute: WorkspaceCommand) {
  const name = `zap_workspace_${sessionId.replaceAll("-", "")}`
  const toolName = `mcp__${name}__shell`
  return {
    name, toolName,
    args: ["--mcp-config", JSON.stringify({ mcpServers: { [name]: { type: "sdk", name } } }),
      "--allowedTools", toolName, "--disallowedTools", "Bash"],
    async request(raw: unknown, signal: AbortSignal) {
      const parsed = requestSchema.safeParse(raw)
      if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request" } }
      const { id, method, params } = parsed.data
      const rpc = { jsonrpc: "2.0", id }
      if (id === undefined || method === "ping") return { ...rpc, result: {} }
      if (method === "initialize") {
        const version = String(params?.protocolVersion)
        return { ...rpc, result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(version) ? version : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} }, serverInfo: { name, version: "1" } } }
      }
      if (method === "tools/list") return { ...rpc, result: { tools: [tool] } }
      if (method !== "tools/call") return { ...rpc, error: { code: -32601, message: "Unknown MCP method" } }
      const args = commandSchema.safeParse(params?.arguments)
      if (params?.name !== tool.name || !args.success) return { ...rpc, error: { code: -32602, message: "Invalid project command" } }
      try {
        signal.throwIfAborted()
        const result = await execute(args.data, signal)
        const exitCode = result.runtime?.command?.exitCode
        const text = [result.output, result.error, exitCode === undefined ? undefined : `Exit code: ${exitCode}`].filter(Boolean).join("\n")
        return { ...rpc, result: { isError: !result.success, content: [{ type: "text", text }] } }
      } catch (error) {
        return { ...rpc, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project command failed" }] } }
      }
    },
  }
}

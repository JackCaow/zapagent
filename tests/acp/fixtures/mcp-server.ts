import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "acp-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo",
  description: "Return fixture evidence", inputSchema: { type: "object", properties: {} } }] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ACP_MCP_OK" }] }))
await server.connect(new StdioServerTransport())

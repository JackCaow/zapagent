import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildChildEnv } from "../env.js";
import { MCPError } from "../errors.js";
import type { MCPServerConfig } from "../types.js";

export function createStdioTransport(config: MCPServerConfig): StdioClientTransport {
  if (!config.command) {
    throw new MCPError("config", `stdio transport requires 'command'`, { server: config.name });
  }
  const env = buildChildEnv({
    passthrough: config.envPassthrough,
    overrides: config.env,
  });
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env,
    cwd: config.cwd,
    // Capture child stderr so a chatty MCP server can't bleed into the
    // hosting TUI's frame. The Client routes process exit / pipe errors
    // through the transport's onerror/onclose callbacks regardless.
    stderr: "pipe",
  });
}

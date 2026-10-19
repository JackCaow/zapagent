// Legacy SSE transport. Kept for compatibility with older MCP servers; new
// remote servers should use Streamable HTTP. We import lazily from the
// factory so the polyfill cost is only paid when actually used.

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { MCPError } from "../errors.js";
import type { MCPServerConfig } from "../types.js";

export function createSseTransport(config: MCPServerConfig): SSEClientTransport {
  if (!config.url) {
    throw new MCPError("config", "sse transport requires 'url'", { server: config.name });
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch (err) {
    throw new MCPError("config", `Invalid url: ${config.url}`, { server: config.name, cause: err });
  }
  return new SSEClientTransport(url, {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

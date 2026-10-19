// Transport factory. Each transport module returns an MCP SDK transport
// instance ready to be passed to `Client.connect()`. The SDK handles
// framing / lifecycle internally; our job is just to construct it with the
// right options and to keep the import boundary tidy (lazy-import the rare
// SSE transport, default-import stdio and http).

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCPError } from "../errors.js";
import type { MCPOAuthProvider } from "../oauth/index.js";
import type { MCPServerConfig } from "../types.js";
import { createStdioTransport } from "./stdio.js";
import { createHttpTransport } from "./http.js";

export interface CreateTransportResult {
  transport: Transport;
  /** OAuth provider for the HTTP transport, when `oauth.enabled` is set.
   *  Null for stdio/sse/non-OAuth HTTP — manager checks this when handling
   *  UnauthorizedError to decide whether to enter `needs_auth`. */
  authProvider: MCPOAuthProvider | null;
}

export async function createTransport(config: MCPServerConfig): Promise<CreateTransportResult> {
  switch (config.transport) {
    case "stdio":
      return { transport: createStdioTransport(config), authProvider: null };
    case "http":
      return createHttpTransport(config);
    case "sse": {
      // Legacy: only loaded on demand so the common stdio/http path doesn't
      // pull in the SSE polyfills.
      const { createSseTransport } = await import("./sse.js");
      return { transport: createSseTransport(config), authProvider: null };
    }
    default:
      throw new MCPError("config", `Unknown transport: ${(config as any).transport}`, {
        server: config.name,
      });
  }
}

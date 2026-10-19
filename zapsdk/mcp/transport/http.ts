import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCPError } from "../errors.js";
import { MCPOAuthProvider, MCPTokenStore } from "../oauth/index.js";
import type { MCPServerConfig } from "../types.js";

export interface CreateHttpTransportResult {
  transport: StreamableHTTPClientTransport;
  /** Non-null when this server uses OAuth — manager keeps this around to
   *  drive `runAuthFlow()` on UnauthorizedError. */
  authProvider: MCPOAuthProvider | null;
}

/** Cached per-process token store so multiple servers share the same JSON file
 *  without each one re-reading on every connect. */
let sharedTokenStore: MCPTokenStore | null = null;
function getStore(): MCPTokenStore {
  if (!sharedTokenStore) sharedTokenStore = new MCPTokenStore();
  return sharedTokenStore;
}

export function createHttpTransport(config: MCPServerConfig): CreateHttpTransportResult {
  if (!config.url) {
    throw new MCPError("config", "http transport requires 'url'", { server: config.name });
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch (err) {
    throw new MCPError("config", `Invalid url: ${config.url}`, { server: config.name, cause: err });
  }

  let authProvider: MCPOAuthProvider | null = null;
  if (config.oauth?.enabled) {
    authProvider = new MCPOAuthProvider({
      serverName: config.name,
      serverUrl: url.toString(),
      store: getStore(),
    });
  }

  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: authProvider ?? undefined,
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
  return { transport, authProvider };
}

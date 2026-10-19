// Completion bridge.
//
// MCP servers can offer argument completion for resource URIs and prompt
// arguments. The host calls `complete()` with a reference to either a
// prompt name or a resource URI template, plus the partial value the user
// has typed. The server returns a short list of suggestions.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCPError, withTimeout } from "../errors.js";
import { DEFAULTS, type MCPServerConfig } from "../types.js";

export type CompletionRef =
  | { type: "ref/resource"; uri: string }
  | { type: "ref/prompt"; name: string };

export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

/** Returns an empty list if the server doesn't support completions. */
export async function complete(
  client: Client,
  config: MCPServerConfig,
  ref: CompletionRef,
  argument: { name: string; value: string },
  context?: { arguments?: Record<string, string> },
): Promise<CompletionResult> {
  // Most servers without completion capability will reply with -32601;
  // surface as "no suggestions" rather than blowing up the UI.
  try {
    const res = await withTimeout(
      client.complete({ ref, argument, context }),
      // Completion is interactive — use a tighter cap than the call default.
      Math.min(5_000, config.callTimeoutMs ?? DEFAULTS.callTimeoutMs),
      `mcp:${config.name}:complete`,
    );
    return {
      values: res.completion.values ?? [],
      total: res.completion.total,
      hasMore: res.completion.hasMore,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("-32601") || msg.toLowerCase().includes("not supported")) {
      return { values: [] };
    }
    throw MCPError.wrap(err, config.name);
  }
}

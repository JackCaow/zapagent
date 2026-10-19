// Builds an MCP `Client` configured with the capabilities zapcode advertises.
// Capability declarations for P4 features (sampling/roots/logging) land here
// once those handlers are wired; for P1 we advertise an empty set so the
// server knows we won't honour reverse requests yet.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface CreateClientOptions {
  /** Forwarded into the JSON-RPC initialize handshake — useful for server-side telemetry. */
  clientName?: string;
  clientVersion?: string;
  /** Advertise `capabilities.sampling` so the server feels free to send
   *  `sampling/createMessage` requests. Manager flips this on per-server
   *  when both a host handler exists AND the server config opted in. */
  advertiseSampling?: boolean;
  /** Advertise `capabilities.roots`. Default true so servers learn the cwd. */
  advertiseRoots?: boolean;
  /** Callback for tools/list_changed. SDK handles debounce + re-list. */
  onToolsChanged?: () => void;
  /** P3 hooks. */
  onResourcesChanged?: () => void;
  onPromptsChanged?: () => void;
}

export function createMCPClient(opts: CreateClientOptions = {}): Client {
  return new Client(
    { name: opts.clientName ?? "zapcode", version: opts.clientVersion ?? "0.1.0" },
    {
      capabilities: {
        ...(opts.advertiseSampling ? { sampling: {} } : {}),
        ...(opts.advertiseRoots !== false ? { roots: { listChanged: false } } : {}),
      },
      listChanged: {
        // autoRefresh:false → we re-list ourselves so we can drive UI
        // events ('tools_changed') from a single code path.
        tools: opts.onToolsChanged
          ? { autoRefresh: false, onChanged: () => { opts.onToolsChanged!(); } }
          : undefined,
        resources: opts.onResourcesChanged
          ? { autoRefresh: false, onChanged: () => { opts.onResourcesChanged!(); } }
          : undefined,
        prompts: opts.onPromptsChanged
          ? { autoRefresh: false, onChanged: () => { opts.onPromptsChanged!(); } }
          : undefined,
      },
    },
  );
}

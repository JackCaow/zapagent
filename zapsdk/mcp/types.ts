// Public types for the MCP subsystem. Kept transport-agnostic and free of
// React / Ink dependencies so this layer can be unit-tested headlessly.

import type { Tool } from "../tools/types.js";

// ── Server configuration ─────────────────────────────────────────────────

export type MCPTransportKind = "stdio" | "http" | "sse";

export interface MCPServerConfig {
  /** Unique handle. Used as namespace prefix in tool names (`mcp__<name>__<tool>`). */
  name: string;
  transport: MCPTransportKind;

  // stdio
  command?: string;
  args?: string[];
  /** Explicit env vars to inject. Merged on top of the baseline allowlist. */
  env?: Record<string, string>;
  /**
   * Names of host environment variables to forward to the child process.
   * Use this for things like `GITHUB_TOKEN` that you don't want to write
   * into config but still need available to the MCP server.
   */
  envPassthrough?: string[];
  /** Working directory for stdio servers. Defaults to the host process cwd. */
  cwd?: string;

  // http / sse
  url?: string;
  /** Static headers (e.g. `Authorization: Bearer …`). For OAuth use `oauth.enabled`. */
  headers?: Record<string, string>;
  oauth?: { enabled: boolean };

  // common
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Temporarily disable without removing the entry. */
  disabled?: boolean;
  /** Whether server-initiated sampling requests are allowed. When false (the
   *  default), `capabilities.sampling` is not advertised to this server. */
  allowSampling?: boolean;
  /** Per-tool whitelist that skips the confirm prompt (uses bare MCP tool name, no namespace). */
  autoApproveTools?: string[];
  /** Directories exposed to this server via `roots/list`. Defaults to the
   *  manager's project cwd. Relative paths resolve against that project cwd.
   *  Pass an empty array to advertise the capability but expose nothing. */
  roots?: string[];
  /** Initial logging level to set on the server (logging/setLevel). */
  loggingLevel?: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
}

// ── Server state machine ─────────────────────────────────────────────────

export type MCPStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "degraded"     // transport dropped, reconnecting
  | "needs_auth"   // HTTP/OAuth only (P2)
  | "disconnected" // intentionally torn down
  | "error";       // terminal: connect repeatedly failed

export interface MCPServerSnapshot {
  name: string;
  status: MCPStatus;
  /** Number of tools currently bridged from this server. */
  toolCount: number;
  /** Number of resources discovered (P3). */
  resourceCount: number;
  /** Number of prompts discovered (P3). */
  promptCount: number;
  /** ISO timestamp of last successful connect. */
  connectedAt?: string;
  /** Last error string surfaced to user via /mcp status. */
  lastError?: string;
  /** Reconnect attempt counter; resets on success. */
  reconnectAttempts: number;
  /** Server-advertised capabilities post-handshake. */
  capabilities?: MCPServerCapabilities;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, never>;
  completions?: Record<string, never>;
}

// ── Event bus ─────────────────────────────────────────────────────────────

export type MCPEvent =
  | { type: "status"; server: string; status: MCPStatus; error?: string }
  | { type: "tools_changed"; server: string; tools: Tool[] }
  | { type: "resources_changed"; server: string }
  | { type: "resource_updated"; server: string; uri: string }
  | { type: "prompts_changed"; server: string }
  | { type: "log"; server: string; level: string; message: string; data?: unknown }
  /** Auth flow started; UI can surface the URL in case the user's default
   *  browser failed to open or they are on a remote session. */
  | { type: "auth_prompt"; server: string; url: string };

export type MCPEventHandler = (event: MCPEvent) => void;

// ── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULTS = {
  connectTimeoutMs: 10_000,
  callTimeoutMs: 60_000,
  samplingTimeoutMs: 120_000,
  /** Exponential backoff schedule (ms) used by the reconnect loop. */
  reconnectBackoffMs: [1_000, 2_000, 4_000, 8_000, 30_000],
  /** Connect attempts after which a server enters terminal `error` state. */
  maxReconnectAttempts: 5,
} as const;

// Owns the MCPManager singleton for the lifetime of the App component and
// exposes the live tool list + per-server snapshots to render. Replaces the
// MCP half of the old useAgentObjects hook so that the registry-rebuild
// effect and the MCP-connect effect aren't entangled.

import { useEffect, useMemo, useRef, useState } from "react"
import {
  MCPManager,
  type MCPPrompt,
  type MCPResource,
  type MCPResourceTemplate,
  type MCPServerConfig,
  type MCPServerSnapshot,
} from "../../zapsdk/index.js"
import type { Tool } from "../../zapsdk/index.js"
import type { SamplingHandler } from "../../zapsdk/mcp/bridge/sampling.js"
import { appLogger } from "../singletons.js"

export interface MCPSubsystemState {
  /** Manager singleton — exposed so the /mcp command (P5) can reconnect, list, etc. */
  manager: MCPManager
  /** All tools currently bridged from every ready server. Fed to buildAgentObjects. */
  tools: Tool[]
  /** Bridged MCP prompts surfaced in the slash palette. */
  prompts: MCPPrompt[]
  /** Bridged MCP resources surfaced in @ completions. */
  resources: { resources: MCPResource[]; templates: MCPResourceTemplate[] }
  /** Per-server status used by the UI. */
  snapshots: MCPServerSnapshot[]
}

export interface UseMCPSubsystemOptions {
  /** Host-supplied sampling handler. Wired through a ref-backed shim so
   *  config / provider swaps don't need to rebuild the manager. */
  samplingHandler?: SamplingHandler | null
}

export function useMCPSubsystem(
  servers: MCPServerConfig[],
  opts: UseMCPSubsystemOptions = {},
): MCPSubsystemState {
  const managerRef = useRef<MCPManager | null>(null)
  const samplingHandlerRef = useRef<SamplingHandler | null>(opts.samplingHandler ?? null)
  samplingHandlerRef.current = opts.samplingHandler ?? null

  if (!managerRef.current) {
    managerRef.current = new MCPManager({
      projectCwd: process.cwd(),
      // Indirect through the ref so the handler can be replaced without
      // rebuilding the manager (e.g. user switches LLM provider). The
      // closure resolves the *current* handler at call time.
      samplingHandler: async (server, payload, signal) => {
        const h = samplingHandlerRef.current
        if (!h) throw new Error("Sampling not configured")
        return h(server, payload, signal)
      },
    })
  }
  const manager = managerRef.current

  // Re-render driver. Bumped whenever the manager emits anything that could
  // change `tools` or `snapshots`.
  const [revision, bump] = useState(0)

  useEffect(() => {
    const off = manager.on((ev) => {
      if (ev.type === "status") {
        const tag =
          ev.status === "ready"      ? "mcp_connected" :
          ev.status === "error"      ? "mcp_error" :
          ev.status === "degraded"   ? "mcp_degraded" :
          ev.status === "needs_auth" ? "mcp_needs_auth" :
          undefined
        if (tag) appLogger.info(`${tag} server=${ev.server}${ev.error ? ` error=${ev.error}` : ""}`)
      } else if (ev.type === "log") {
        appLogger.info(`mcp:${ev.server} [${ev.level}] ${ev.message}`)
      }
      bump((v) => v + 1)
    })
    return off
  }, [manager])

  // Drive the manager toward the desired config whenever it changes.
  useEffect(() => {
    void manager.reconcile(servers)
  }, [manager, servers])

  // Tear down on unmount.
  useEffect(() => () => { void manager.stopAll() }, [manager])

  const tools = useMemo(() => manager.allTools(), [manager, revision])
  const prompts = useMemo(() => manager.allPrompts(), [manager, revision])
  const resources = useMemo(() => manager.allResources(), [manager, revision])
  const snapshots = useMemo(() => manager.snapshots(), [manager, revision])

  return { manager, tools, prompts, resources, snapshots }
}

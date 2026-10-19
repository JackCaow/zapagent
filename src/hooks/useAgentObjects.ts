import { useEffect, useRef, useState } from "react"
import type { AppConfig } from "../config.js"
import type { CheckpointManager } from "../../zapsdk/checkpoint/index.js"
import type { AskUserCallbacks, PlanModeCallbacks, TodoStore, Tool } from "../../zapsdk/index.js"
import type { ApprovalCallback } from "../../zapsdk/tools/executor.js"
import type { SkillDefinition } from "../../zapsdk/skills/types.js"
import { buildAgentObjects } from "../agent-factory.js"
import { delegateProvidersReady, permissionManager } from "../singletons.js"
import type { AgentObjects } from "../agent/types.js"

export interface UseAgentObjectsOptions {
  config: AppConfig
  onApproval: ApprovalCallback
  todoStore: TodoStore
  planCallbacks: PlanModeCallbacks
  askUserCallbacks?: AskUserCallbacks
  checkpoint: CheckpointManager
  skillsRef: React.MutableRefObject<Map<string, SkillDefinition>>
  /** MCP-bridged tools that the agent should be able to call. Recomputed
   *  whenever the MCP subsystem connects/disconnects/reconnects a server.
   *  Changes here trigger a registry rebuild so the agent sees the new
   *  surface area on the next turn. */
  mcpTools: Tool[]
}

export interface UseAgentObjectsResult {
  agentRef: React.MutableRefObject<AgentObjects>
}

/**
 * Owns the per-config-change rebuild of provider/registry/executor objects.
 *
 * Three distinct invalidations rebuild agent objects:
 *   1. (config, onApproval, planCallbacks) change → user toggled something
 *   2. delegateProvidersReady resolved → PATH probe for claude/codex CLIs
 *      finished. The initial buildAgentObjects almost always races that probe
 *      and sees `delegateProviders === []` → delegate_agent tool doesn't get
 *      registered → model can't pick it on the first turn. Awaiting the
 *      promise here triggers a rebuild once the probe finishes (typically
 *      within a few hundred ms).
 *   3. mcpTools changed → an MCP server (re)connected and its tool surface
 *      shifted. We rebuild so the new bridged tools get registered through
 *      the standard path instead of being post-injected into a live
 *      registry (which led to subtle "wrong registry generation" bugs in
 *      the previous design).
 */
export function useAgentObjects(opts: UseAgentObjectsOptions & {
  /** Optional external ref to share with components that need to read the
   *  current provider/registry/executor outside the React render path —
   *  notably useSamplingHandler, which is consumed by the MCP manager. */
  externalRef?: React.MutableRefObject<AgentObjects | null>
}): UseAgentObjectsResult {
  const { config, onApproval, todoStore, planCallbacks, askUserCallbacks, checkpoint, skillsRef, mcpTools, externalRef } = opts

  const build = () => {
    const objs = buildAgentObjects(config, onApproval, todoStore, planCallbacks, checkpoint, skillsRef.current, undefined, undefined, undefined, undefined, askUserCallbacks)
    permissionManager.setSandboxConfined(objs.sandboxConfined, config.autoAllowSandboxedCommands !== false)
    permissionManager.setSandboxExcludedCommands(config.allowUnsandboxedCommands !== false ? config.sandboxExcludedCommands : undefined)
    for (const tool of mcpTools) {
      // Defensive: skip name clashes rather than throw — a misconfigured
      // server shouldn't take down the whole agent registry. The MCP
      // namespace prefix should make this impossible in practice.
      if (!objs.registry.has(tool.definition.name)) {
        objs.registry.register(tool)
      }
    }
    return objs
  }

  const agentRef = useRef<AgentObjects | null>(null)
  if (agentRef.current === null) agentRef.current = build()
  // Mirror to externalRef so out-of-render readers see the latest agent.
  if (externalRef) externalRef.current = agentRef.current

  const [delegateRebuildKey, setDelegateRebuildKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    delegateProvidersReady.then(() => {
      if (cancelled) return
      setDelegateRebuildKey((k) => k + 1)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    agentRef.current = build()
    if (externalRef) externalRef.current = agentRef.current
  // skillsRef + checkpoint + todoStore are stable refs/values for this session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, onApproval, planCallbacks, askUserCallbacks, delegateRebuildKey, mcpTools])

  return { agentRef: agentRef as React.MutableRefObject<AgentObjects> }
}

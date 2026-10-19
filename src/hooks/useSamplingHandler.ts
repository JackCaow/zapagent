// Builds the SamplingHandler the MCP subsystem invokes when a server asks
// us for an LLM completion (`sampling/createMessage`). We:
//   1. ask the user to approve via the existing tool-approval UX so an
//      MCP server can't quietly drain their LLM quota,
//   2. call the active provider with the requested messages,
//   3. return plain text + stop reason.
//
// The provider object is read through `agentRef.current.provider` so a
// config change (model swap, key edit) is picked up on the next sampling
// call without re-binding the handler.

import { useCallback, useMemo } from "react"
import type { Message } from "../../zapsdk/index.js"
import type { SamplingHandler, SamplingRequestPayload } from "../../zapsdk/mcp/bridge/sampling.js"
import type { ApprovalCallback } from "../../zapsdk/tools/executor.js"
import type { AgentObjects } from "../agent/types.js"

export interface UseSamplingHandlerOptions {
  agentRef: React.MutableRefObject<AgentObjects | null>
  /**
   * Approval gate. Mirrors usePermissionApproval's interface: returns true
   * if the user allowed the call. We treat each sampling request as a
   * tool-like operation named `mcp_sampling:<server>` so existing
   * `/permissions allow mcp_sampling:*` rules can preempt the prompt.
   */
  onApproval: ApprovalCallback
}

export function useSamplingHandler(opts: UseSamplingHandlerOptions): SamplingHandler {
  const { agentRef, onApproval } = opts

  const handler = useCallback<SamplingHandler>(
    async (server, payload, signal) => {
      const approved = await onApproval(`mcp_sampling:${server}`, {
        messageCount: payload.messages.length,
        maxTokens: payload.maxTokens,
        systemPrompt: payload.systemPrompt ? payload.systemPrompt.slice(0, 200) : undefined,
      }, signal)
      if (approved !== true) throw new Error(typeof approved === "object" ? approved.reason : "sampling approval not granted")

      const agent = agentRef.current
      if (!agent?.provider) throw new Error("LLM provider not initialised")

      const messages = mapSamplingMessages(payload)
      const res = await agent.provider.call(messages, undefined, {
        maxOutputTokens: payload.maxTokens,
        stopSequences: payload.stopSequences,
        signal,
      })
      return {
        text: res.text,
        model: agent.modelId,
        stopReason: res.finishReason ?? "endTurn",
      }
    },
    [agentRef, onApproval],
  )

  // Identity is stable per (agentRef, onApproval) — keeps the manager from
  // rebuilding sampling state on unrelated re-renders.
  return useMemo(() => handler, [handler])
}

function mapSamplingMessages(payload: SamplingRequestPayload): Message[] {
  const out: Message[] = []
  if (payload.systemPrompt) {
    out.push({ role: "system", content: payload.systemPrompt })
  }
  for (const m of payload.messages) {
    // MCP sampling messages carry the same content union as tool results,
    // but in practice servers send text content. Flatten to text; binary
    // attachments turn into placeholders so the provider can still reason
    // about them.
    const content = m.content
    if (Array.isArray(content)) {
      out.push({
        role: m.role,
        content: content
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("\n"),
      })
    } else if (content && typeof content === "object" && "type" in content) {
      const c = content as { type: string; text?: string }
      out.push({ role: m.role, content: c.type === "text" ? c.text ?? "" : `[${c.type}]` })
    } else {
      out.push({ role: m.role, content: String(content) })
    }
  }
  return out
}

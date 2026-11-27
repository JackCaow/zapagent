import type { PlanEntry } from "@agentclientprotocol/sdk"
import { AgentEventEmitter, type AgentEvent } from "../../zapsdk/agent/events.js"
import type { LoopAgentResult } from "../../zapsdk/agent/loop.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import type { ConversationManager } from "../../zapsdk/memory/conversation.js"
import type { AcpAgentSpec } from "../../zapsdk/acp-client/types.js"
import type { StreamingPreview } from "./streamingPreview.js"
import { createRunHandlers, type RunHandlersDeps } from "./wireRunHandlers.js"
import { promptClaudeCode } from "./claude-code.js"
import type { ExternalModelIdentity } from "./startup-model-cache.js"
import { codexModelIdentity } from "./codex-model.js"
import { AgentOutputThroughput } from "./outputThroughput.js"
import { remoteAgents } from "./remote-agent.js"
import type { ApprovalCallback } from "../../zapsdk/tools/executor.js"

export interface RemoteTurnDeps extends Omit<RunHandlersDeps, "preview" | "setContextTokens" | "setContextPending" | "currentConfig"> {
  currentConfig: RunHandlersDeps["currentConfig"]
  onModel: (identity: ExternalModelIdentity) => void
  setRemoteContext: (usage: { used: number; size: number } | undefined) => void
  approve?: ApprovalCallback
  nativeClaude?: boolean
  spec: AcpAgentSpec
  cwd: string
  conversation: ConversationManager
  createPreview: () => StreamingPreview
  saveLastOutput: (text: string) => void
  /** Tells the host queue the agent took the message. */
  onInputAccepted?: () => void
  /** Opens/closes the checkpoint turn, as zap's runtime does around a run,
   * so /rewind attributes the agent's fs writes to this turn. */
  checkpointTurn?: { begin: () => Promise<unknown>; end: () => Promise<unknown> }
}

const claudeSessions = new WeakMap<ConversationManager, { tip: unknown; sessionId: string; epoch: number; cwd: string }>()

const zapInstructions = "You are running inside Zap. For an implementation request, make the requested changes and verify them. Plan internally and ask only about choices that matter to the outcome. If the user asks for analysis or a proposal without changes, respect that scope. Zap handles tool approvals. Do not direct users to native CLI mode controls."
const readOnlyInstructions = "This turn is read-only. Do not attempt changes. If the user requests implementation, mention that selecting Auto in Zap's /mode returns to normal work."

/** One user turn handled by an external ACP agent instead of zap's loop.
 * Rendering reuses the regular run handlers, so the transcript looks the
 * same; zap's conversation records the exchange so switching back to zap
 * keeps the context. Throws after reporting when the turn fails. */
export async function runRemoteTurn(deps: RemoteTurnDeps, task: string, images?: ImageContent[]): Promise<LoopAgentResult> {
  const preview = deps.createPreview()
  const handlers = createRunHandlers({ ...deps, externalContext: true, preview, setContextTokens() {}, setContextPending() {} })
  const emitter = new AgentEventEmitter()
  handlers.wire(emitter)
  const { spec, controller } = deps
  await deps.checkpointTurn?.begin().catch(() => {})
  try {
    if (remoteAgents.host.blocked) throw new Error(remoteAgents.host.blocked)
    const previous = claudeSessions.get(deps.conversation)
    claudeSessions.delete(deps.conversation)
    const epoch = remoteAgents.epoch
    const throughput = new AgentOutputThroughput()
    const onEvent = (event: AgentEvent) => {
      emitter.emit(event)
      if (event.type === "content_delta" && !event.path?.length && !controller.signal.aborted && (event.kind === "thinking" || event.kind === "text")) {
        const sample = throughput.chunk(event.id, event.text, performance.now())
        if (sample) deps.setOutputThroughput?.(sample)
      }
    }
    let acceptedAt: number | undefined
    const onAccepted = () => {
      acceptedAt = performance.now()
      deps.onInputAccepted?.()
    }
    const readOnly = deps.currentConfig.permissionMode === "plan"
    const nativeInstructions = readOnly ? zapInstructions + "\n" + readOnlyInstructions : zapInstructions
    const turn = deps.nativeClaude ? await promptClaudeCode({
      command: spec.command, args: spec.args, cwd: deps.cwd, text: task, images, signal: controller.signal,
      model: deps.currentConfig.claudeModelPreference,
      onModel: identity => { if (!controller.signal.aborted && remoteAgents.epoch === epoch) deps.onModel(identity) },
      plan: readOnly, approve: deps.approve, appInstructions: nativeInstructions,
      resume: previous?.cwd === deps.cwd && previous.epoch === epoch && previous.tip === deps.conversation.getTurns().at(-1) ? previous.sessionId : undefined,
      onEvent, onAccepted,
    }) : await remoteAgents.prompt(spec, deps.cwd,
      spec.id === "codex" ? `${nativeInstructions}\n\nUser request:\n${task}` : task, images, {
      signal: controller.signal,
      approve: deps.approve,
      onEvent,
      onAccepted,
      onModelId: spec.id === "codex" ? model => {
        const identity = codexModelIdentity(model)
        if (identity && !controller.signal.aborted) deps.onModel(identity)
      } : undefined,
      onContextUsage: usage => { if (!controller.signal.aborted) deps.setRemoteContext(usage) },
      onStarted: session => {
        deps.setRemoteContext(undefined)
        deps.addLog("system", `Connected to ${session.agentName} (${spec.id}) over ACP${session.warnings.length ? ` · ${session.warnings.join("; ")}` : ""}`)
      },
    })
    const elapsedMs = acceptedAt === undefined ? 0 : performance.now() - acceptedAt
    deps.conversation.add({ role: "user", content: task })
    deps.conversation.add({ role: "assistant", content: `[${spec.id}] ${turn.report || "(no message)"}` })
    if ("sessionId" in turn) claudeSessions.set(deps.conversation, { tip: deps.conversation.getTurns().at(-1), epoch, cwd: deps.cwd, sessionId: turn.sessionId })
    if (turn.usage) emitter.emit({ type: "run_usage", step: turn.toolCalls, ...turn.usage })
    if (!controller.signal.aborted) {
      deps.setOutputThroughput?.(throughput.finish(turn.usage?.providerUsageReported === false ? undefined : turn.usage?.outputTokens, elapsedMs))
    }
    if (turn.plan.length) deps.addLog("system", formatPlan(spec.id, turn.plan))
    if (turn.stopReason !== "end_turn" && turn.stopReason !== "cancelled") deps.addLog("system", `${spec.id} stopped: ${turn.stopReason}`)
    if (turn.report) deps.saveLastOutput(turn.report)
    const usage = turn.usage ?? { inputTokens: 0, outputTokens: 0, providerUsageReported: false }
    if (!controller.signal.aborted) emitter.emit({ type: "run_ended", steps: turn.toolCalls, stopped: turn.stopReason, usage })
    // The host queue reads this like a LoopAgent result: a non-end_turn stop
    // pauses follow-ups for review.
    const stopped = turn.stopReason === "max_tokens" ? "max_tokens" as const
      : turn.stopReason === "max_turn_requests" ? "max_steps" as const : undefined
    return { text: turn.report, steps: turn.toolCalls, toolResults: [], totalUsage: usage, stopped }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Aborts are silent here; the runner adds the "(interrupted)" marker.
    if (!controller.signal.aborted) emitter.emit({ type: "error", step: 0, error: `${spec.id}: ${message}` })
    throw error
  } finally {
    await deps.checkpointTurn?.end().catch(() => {})
    preview.drainOnAbort()
    handlers.settlePending(controller.signal.aborted ? "aborted" : `${spec.id} ended the turn`)
  }
}

export function formatPlan(agentId: string, plan: PlanEntry[]): string {
  const mark = { completed: "✓", in_progress: "▸", pending: "○" } as const
  return [`${agentId} plan:`, ...plan.map(entry => `  ${mark[entry.status] ?? "○"} ${entry.content}`)].join("\n")
}

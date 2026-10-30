import { AgentEventEmitter, type AgentEvent } from "../../zapsdk/agent/events.js"
import { createRunHandlers, type RunHandlersDeps } from "./wireRunHandlers.js"
import type { StreamingPreview } from "./streamingPreview.js"
import { scopeGoalEvent } from "../goal-session.js"

type PresentationDeps = Omit<RunHandlersDeps, "preview" | "setContextTokens" | "setContextPending" | "compactLogs"> & {
  createPreview: () => StreamingPreview
}

/** Reuse normal tool/subagent rendering without modifying the chat's context,
 * compacting its transcript or writing phase summaries to its private memory. */
export function createGoalPresentation(deps: PresentationDeps) {
  let scope: string | undefined
  let preview: StreamingPreview | undefined
  let handlers: ReturnType<typeof createRunHandlers> | undefined
  let emitter: AgentEventEmitter | undefined
  const finish = () => {
    preview?.drainOnAbort()
    handlers?.settlePending("Goal phase ended before this tool returned")
    preview = undefined; handlers = undefined; emitter = undefined
  }
  return {
    event(event: AgentEvent, nextScope: string) {
      if (scope !== nextScope) {
        finish(); scope = nextScope
        preview = deps.createPreview()
        handlers = createRunHandlers({ ...deps, preview, setContextTokens() {}, setContextPending() {}, compactLogs() {} })
        emitter = new AgentEventEmitter()
        handlers.wire(emitter)
      }
      // These records describe an isolated phase, never the main conversation.
      if (event.type === "run_usage") { deps.onRunUsage?.(event); return }
      if (event.type === "observation" && event.kind === "autocompact_done") {
        deps.addLog("system", "Goal phase context compaction finished; current chat history retained.")
        return
      }
      const scoped = scopeGoalEvent(event, nextScope)
      if (!scoped.path?.length) emitter!.emit(scoped)
      handlers!.subAgentEventHandler(scoped)
    },
    finish,
  }
}

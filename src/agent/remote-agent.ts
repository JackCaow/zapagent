import { readFile } from "node:fs/promises"
import type { ContentBlock } from "@agentclientprotocol/sdk"
import { AcpAgentSession, type AcpTurnResult } from "../../zapsdk/acp-client/run.js"
import { stdioTransport, type AcpTransport } from "../../zapsdk/acp-client/connection.js"
import { createAcpHostHandlers, type AcpHostHandlers } from "../../zapsdk/acp-client/host-handlers.js"
import type { AcpAgentSpec } from "../../zapsdk/acp-client/types.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import { createLocalProcessBroker } from "../../zapsdk/execution/process.js"
import type { ApprovalCallback, ApprovalContext } from "../../zapsdk/tools/executor.js"
import { VERSION } from "../version.js"
import { createNativePreview, type NativePreview } from "./native-preview.js"

/** Host hooks shared across the native session. Approval is per turn. */
export interface RemoteAgentHost {
  trackEdit?: (paths: string[]) => Promise<unknown>
  /** Set when host policy forbids running agents on the host (they run
   * outside zap's OS sandbox): the reason shown instead of starting one. */
  blocked?: string
}

interface LiveSession {
  key: string
  spec: AcpAgentSpec
  session: AcpAgentSession
  handlers: AcpHostHandlers
  preview?: ReturnType<typeof createNativePreview>
}

/** One external ACP agent driving the TUI conversation ("session mode").
 * The agent process stays up across turns so the agent keeps its own
 * context. It is replaced on agent/cwd change and closed when the
 * conversation is reset, after a failed turn, and at exit. */
export class RemoteAgentManager {
  private live?: LiveSession
  /** Bumped by reset(); a start that outlives its generation is discarded. */
  private generation = 0
  private readonly transports = new Set<AcpTransport>()
  /** Signal of the turn in flight; approval prompts close when it aborts. */
  private busy = false
  private turn?: { signal: AbortSignal; approve?: ApprovalCallback }
  private readonly inactive = AbortSignal.abort()
  readonly host: RemoteAgentHost = {}

  constructor(private readonly transportFor: (spec: AcpAgentSpec, cwd: string) => AcpTransport = spawnTransport) {}

  get epoch(): number { return this.generation }

  get current(): { spec: AcpAgentSpec; session: AcpAgentSession } | undefined {
    return this.live ? { spec: this.live.spec, session: this.live.session } : undefined
  }

  async prompt(spec: AcpAgentSpec, cwd: string, text: string, images: ImageContent[] | undefined, options: {
    signal: AbortSignal
    preview?: NativePreview
    approve?: ApprovalCallback
    onEvent: (event: AgentEvent) => void
    onModelId?: (model: string) => void
    onContextUsage?: (usage: { used: number; size: number }) => void
    onStarted?: (session: AcpAgentSession) => void
    /** Called once the agent is ready and the prompt is about to be sent. */
    onAccepted?: () => void
  }): Promise<AcpTurnResult & { session: AcpAgentSession }> {
    if (this.busy) throw new Error("An external agent turn is already in progress")
    this.busy = true
    const turn = new AbortController()
    let live: LiveSession | undefined
    let releasePreview: (() => void) | undefined
    let sent = false
    try {
      options.signal.throwIfAborted()
      live = await this.ensure(spec, cwd, options.signal, options.onStarted, !!options.preview)
      const content: ContentBlock[] = [{ type: "text", text }]
      if (images?.length) {
        if (!live.session.supportsImages) throw new Error(`${spec.id} does not accept images`)
        for (const image of images) {
          const data = image.base64 ?? (await readFile(image.filePath)).toString("base64")
          content.push({ type: "image", data, mimeType: image.mediaType })
        }
      }
      options.signal.throwIfAborted()
      if (this.live !== live) throw new Error(`${spec.id} session was closed`)
      this.turn = { signal: AbortSignal.any([options.signal, turn.signal]), approve: options.approve }
      if (options.preview) releasePreview = live.preview?.bind(options.preview, this.turn.signal)
      options.onAccepted?.()
      sent = true
      const result = await live.session.prompt(content, {
        signal: options.signal, onEvent: options.onEvent, onContextUsage: options.onContextUsage,
        onModelId: model => { if (this.live === live) options.onModelId?.(model) },
      })
      return { ...result, session: live.session }
    } catch (error) {
      // A cooperative cancel resolves with stopReason "cancelled"; a throw
      // means the agent died, failed, or ignored cancellation and may still
      // be working. Never reuse it for the next turn.
      if (sent && live && this.live === live) await this.reset()
      throw error
    } finally {
      turn.abort()
      releasePreview?.()
      this.turn = undefined
      this.busy = false
    }
  }

  /** Close the agent (and discard one still starting). Context is lost. */
  async reset(): Promise<void> {
    this.generation += 1
    const live = this.live
    this.live = undefined
    live?.preview?.close()
    await live?.session.close().catch(() => {})
  }

  /** Last resort at process exit: no event loop is left for a graceful close. */
  killAll(): void {
    for (const transport of this.transports) transport.kill?.()
  }

  private async ensure(spec: AcpAgentSpec, cwd: string, signal: AbortSignal, onStarted?: (session: AcpAgentSession) => void, previewRequested = false): Promise<LiveSession> {
    if (this.host.blocked) throw new Error(this.host.blocked)
    const key = JSON.stringify([spec.id, spec.command, spec.args ?? [], spec.requireSettings, spec.env, spec.model, spec.config, cwd, previewRequested])
    const live = this.live
    if (live?.key === key) {
      if (live.spec.mode === spec.mode && (!spec.mode || live.session.currentModeId === spec.mode)) return live
      if (spec.mode) {
        try {
          await live.session.setMode(spec.mode, { signal, timeoutMs: 60_000 })
        } catch (error) {
          // A lost acknowledgement leaves the native session's permissions unknown.
          if (this.live === live) await this.reset()
          throw error
        }
        live.spec = spec
        return live
      }
      // ACP has no operation to restore an agent's unspecified startup mode.
    }
    if (this.live) await this.reset()
    const generation = this.generation
    const handlers = createAcpHostHandlers({
      agentId: spec.id, cwd,
      approve: Object.assign(
        (name: string, args: Record<string, unknown>, s?: AbortSignal, context?: Readonly<ApprovalContext>) =>
          this.turn?.approve?.(name, args, s, context)
          ?? Promise.resolve({ approved: false as const, source: "policy" as const, reason: "no turn approval handler" }),
        { precheck: (name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>) =>
          this.turn?.approve?.precheck?.(name, args, context) },
      ),
      trackEdit: paths => this.host.trackEdit?.(paths) ?? Promise.resolve(),
      signal: () => generation === this.generation ? this.turn?.signal ?? this.inactive : this.inactive,
    })
    const transport = this.transportFor(spec, cwd)
    this.transports.add(transport)
    void transport.exited.then(() => this.transports.delete(transport))
    const preview = previewRequested ? createNativePreview() : undefined
    const mcpServers = preview ? [{
      type: "http" as const, name: preview.name, url: preview.url, headers: [{ name: "Authorization", value: preview.authorization }],
    }] : undefined
    const session = await AcpAgentSession.start({ spec, cwd, transport, handlers, signal, mcpServers, clientVersion: VERSION })
      .catch(error => { preview?.close(); throw error })
    if (generation !== this.generation) {
      // reset() ran while the agent was starting (/agent, /new, abort).
      await session.close().catch(() => {})
      preview?.close()
      throw new Error(`${spec.id} start was cancelled`)
    }
    const started = { key, spec, session, handlers, preview }
    this.live = started
    onStarted?.(session)
    return started
  }
}

/** Agents inherit zap's environment, like any host process zap starts. */
function spawnTransport(spec: AcpAgentSpec, cwd: string): AcpTransport {
  return stdioTransport(createLocalProcessBroker().spawnCommand(spec.command, spec.args ?? [], {
    cwd, hostHome: true, environment: spec.env, stdin: "pipe",
  }))
}

export const remoteAgents = new RemoteAgentManager()

// Agent processes are detached process groups; never leave one behind.
// "exit" runs synchronously, so a graceful close cannot complete here.
process.once("exit", () => { remoteAgents.killAll() })

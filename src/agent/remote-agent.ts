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

/** Host hooks the live session reads at request time, so approval and
 * checkpoint wiring can change (config rebuilds) without a reconnect. */
export interface RemoteAgentHost {
  approve?: ApprovalCallback
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
}

/** One external ACP agent driving the TUI conversation ("session mode").
 * The agent process stays up across turns so the agent keeps its own
 * context. It is replaced on agent/cwd change and closed when the
 * conversation is reset, after a failed turn, and at exit. */
export class RemoteAgentManager {
  private live?: LiveSession
  private starting?: { key: string; promise: Promise<LiveSession> }
  /** Bumped by reset(); a start that outlives its generation is discarded. */
  private generation = 0
  private readonly transports = new Set<AcpTransport>()
  /** Signal of the turn in flight; approval prompts close when it aborts. */
  private turnSignal?: AbortSignal
  readonly host: RemoteAgentHost = {}

  constructor(private readonly transportFor: (spec: AcpAgentSpec, cwd: string) => AcpTransport = spawnTransport) {}

  get current(): { spec: AcpAgentSpec; session: AcpAgentSession } | undefined {
    return this.live ? { spec: this.live.spec, session: this.live.session } : undefined
  }

  async prompt(spec: AcpAgentSpec, cwd: string, text: string, images: ImageContent[] | undefined, options: {
    signal: AbortSignal
    onEvent: (event: AgentEvent) => void
    onStarted?: (session: AcpAgentSession) => void
    /** Called once the agent is ready and the prompt is about to be sent. */
    onAccepted?: () => void
  }): Promise<AcpTurnResult & { session: AcpAgentSession }> {
    const live = await this.ensure(spec, cwd, options.signal, options.onStarted)
    const content: ContentBlock[] = [{ type: "text", text }]
    if (images?.length) {
      if (!live.session.supportsImages) throw new Error(`${spec.id} does not accept images`)
      for (const image of images) {
        const data = image.base64 ?? (await readFile(image.filePath)).toString("base64")
        content.push({ type: "image", data, mimeType: image.mediaType })
      }
    }
    options.onAccepted?.()
    this.turnSignal = options.signal
    try {
      const result = await live.session.prompt(content, { signal: options.signal, onEvent: options.onEvent })
      return { ...result, session: live.session }
    } catch (error) {
      // A cooperative cancel resolves with stopReason "cancelled"; a throw
      // means the agent died, failed, or ignored cancellation and may still
      // be working. Never reuse it for the next turn.
      if (this.live === live) await this.reset()
      throw error
    } finally {
      this.turnSignal = undefined
    }
  }

  /** Close the agent (and discard one still starting). Context is lost. */
  async reset(): Promise<void> {
    this.generation += 1
    const live = this.live
    this.live = undefined
    this.starting = undefined
    await live?.session.close().catch(() => {})
  }

  /** Last resort at process exit: no event loop is left for a graceful close. */
  killAll(): void {
    for (const transport of this.transports) transport.kill?.()
  }

  private async ensure(spec: AcpAgentSpec, cwd: string, signal: AbortSignal, onStarted?: (session: AcpAgentSession) => void): Promise<LiveSession> {
    if (this.host.blocked) throw new Error(this.host.blocked)
    const key = JSON.stringify([spec.id, spec.command, spec.args ?? [], spec.mode, spec.model, spec.config, cwd])
    // Let a start for another agent settle (and be replaced) first.
    while (this.starting && this.starting.key !== key) await this.starting.promise.catch(() => {})
    if (this.live?.key === key) return this.live
    if (this.starting) return this.starting.promise
    if (this.live) await this.reset()
    const generation = this.generation
    const promise = (async () => {
      const handlers = createAcpHostHandlers({
        agentId: spec.id, cwd,
        approve: Object.assign(
          (name: string, args: Record<string, unknown>, s?: AbortSignal, context?: Readonly<ApprovalContext>) => this.host.approve
            ? this.host.approve(name, args, s, context)
            : Promise.resolve({ approved: false as const, source: "policy" as const, reason: "no approval handler" }),
          { precheck: (name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>) =>
            this.host.approve?.precheck?.(name, args, context) },
        ),
        trackEdit: paths => this.host.trackEdit?.(paths) ?? Promise.resolve(),
        signal: () => this.turnSignal,
      })
      const transport = this.transportFor(spec, cwd)
      this.transports.add(transport)
      void transport.exited.then(() => this.transports.delete(transport))
      const session = await AcpAgentSession.start({ spec, cwd, transport, handlers, signal, clientVersion: VERSION })
      if (generation !== this.generation) {
        // reset() ran while the agent was starting (/agent, /new, abort).
        await session.close().catch(() => {})
        throw new Error(`${spec.id} start was cancelled`)
      }
      const live = { key, spec, session, handlers }
      this.live = live
      onStarted?.(session)
      return live
    })()
    const starting = { key, promise }
    this.starting = starting
    try { return await promise }
    finally { if (this.starting === starting) this.starting = undefined }
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

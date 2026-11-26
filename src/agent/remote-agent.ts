import { readFile } from "node:fs/promises"
import type { ContentBlock } from "@agentclientprotocol/sdk"
import { AcpAgentSession, type AcpTurnResult } from "../../zapsdk/acp-client/run.js"
import { stdioTransport, type AcpTransport } from "../../zapsdk/acp-client/connection.js"
import { createAcpHostHandlers, type AcpHostHandlers } from "../../zapsdk/acp-client/host-handlers.js"
import type { AcpAgentSpec } from "../../zapsdk/acp-client/types.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import { createLocalProcessBroker } from "../../zapsdk/execution/process.js"
import type { ApprovalCallback } from "../../zapsdk/tools/executor.js"
import { VERSION } from "../version.js"

/** Host hooks the live session reads at request time, so approval and
 * checkpoint wiring can change (config rebuilds) without a reconnect. */
export interface RemoteAgentHost {
  approve?: ApprovalCallback
  trackEdit?: (paths: string[]) => Promise<unknown>
}

interface LiveSession {
  key: string
  spec: AcpAgentSpec
  session: AcpAgentSession
  handlers: AcpHostHandlers
}

/** One external ACP agent driving the TUI conversation ("session mode").
 * The agent process stays up across turns so the agent keeps its own
 * context; it is replaced on agent/cwd change and closed on /new and exit. */
export class RemoteAgentManager {
  private live?: LiveSession
  private starting?: Promise<LiveSession>
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
    try {
      const result = await live.session.prompt(content, { signal: options.signal, onEvent: options.onEvent })
      return { ...result, session: live.session }
    } catch (error) {
      // A dead or wedged agent must not be reused for the next turn.
      if (!options.signal.aborted) await this.reset()
      throw error
    }
  }

  async reset(): Promise<void> {
    const live = this.live
    this.live = undefined
    this.starting = undefined
    await live?.session.close().catch(() => {})
  }

  private async ensure(spec: AcpAgentSpec, cwd: string, signal: AbortSignal, onStarted?: (session: AcpAgentSession) => void): Promise<LiveSession> {
    const key = JSON.stringify([spec.id, spec.command, spec.args ?? [], spec.mode, spec.model, spec.config, cwd])
    if (this.live?.key === key) return this.live
    if (this.live) await this.reset()
    this.starting ??= (async () => {
      const handlers = createAcpHostHandlers({
        agentId: spec.id, cwd,
        approve: Object.assign(
          (name: string, args: Record<string, unknown>, s?: AbortSignal) => this.host.approve
            ? this.host.approve(name, args, s)
            : Promise.resolve({ approved: false as const, source: "policy" as const, reason: "no approval handler" }),
          { precheck: (name: string, args: Record<string, unknown>) => this.host.approve?.precheck?.(name, args) },
        ),
        trackEdit: paths => this.host.trackEdit?.(paths) ?? Promise.resolve(),
      })
      const session = await AcpAgentSession.start({
        spec, cwd, transport: this.transportFor(spec, cwd), handlers, signal, clientVersion: VERSION,
      })
      const live = { key, spec, session, handlers }
      this.live = live
      onStarted?.(session)
      return live
    })().finally(() => { this.starting = undefined })
    return this.starting
  }
}

function spawnTransport(spec: AcpAgentSpec, cwd: string): AcpTransport {
  return stdioTransport(createLocalProcessBroker().spawnCommand(spec.command, spec.args ?? [], {
    cwd, hostHome: true, environment: spec.env, preserveEnvironment: spec.preserveEnvironment, stdin: "pipe",
  }))
}

export const remoteAgents = new RemoteAgentManager()

// Agent processes are detached process groups; never leave one behind.
process.once("exit", () => { void remoteAgents.reset() })

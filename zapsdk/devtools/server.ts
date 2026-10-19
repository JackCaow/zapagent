import { readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentEvent } from "../agent/events.js"
import type { Message } from "../core/types.js"
import type { ServerFrame, ClientFrame, DevtoolsSnapshot, DevtoolsHttpRecord } from "./protocol.js"
import { redactDevtoolsHttpRecord, redactDevtoolsValue } from "./redact.js"

interface DevtoolsBunSocket {
  send(data: string | Buffer): unknown
}

interface DevtoolsBunServeServer {
  upgrade(req: Request, opts?: { data?: Record<string, never> }): boolean
}

// Bun's type package isn't a dev dep here; narrow the surface we actually use.
declare const Bun: {
  serve(opts: {
    port: number
    hostname: string
    fetch(req: Request, srv: DevtoolsBunServeServer): Response | undefined
    websocket: {
      open(ws: DevtoolsBunSocket): void
      close(ws: DevtoolsBunSocket): void
      message(ws: DevtoolsBunSocket, data: string | Buffer): void
    }
  }): { port: number; stop(): void }
}

const VERSION = "0.1.0"
const EVENT_RING_SIZE = 500

/** Minimal emitter-shape the server needs. LoopAgent satisfies it via its
 *  public `.on("*", cb)` / `.off("*", cb)` methods, so the server stays
 *  decoupled from the internal emitter class. */
export interface DevtoolsAgentLike {
  on(type: "*", handler: (event: AgentEvent) => void): void
  off(type: "*", handler: (event: AgentEvent) => void): void
}

export interface DevToolsServerOptions {
  port?: number
  /** Auth token required for data-bearing endpoints. Generated when omitted. */
  token?: string
  /** Agent whose event stream we subscribe to. Swappable via attachAgent. */
  agent: DevtoolsAgentLike
  /** Called on client connect and on demand to snapshot conversation. */
  getConversation: () => Message[]
  /** Called on client connect to snapshot the system prompt last used. */
  getSystemPrompt: () => string
  /** Called on client connect — arbitrary config blob, rendered as JSON. */
  getConfig: () => unknown
}

export interface DevToolsServerHandle {
  port: number
  url: string
  stop(): void
  /** Swap the active agent — useful when each agent.run() creates a new
   *  instance. The server re-subscribes + keeps the event ring intact. */
  attachAgent(agent: DevtoolsAgentLike): void
  /** Push a conversation snapshot out of band (e.g. after session restore). */
  pushConversation(): void
  /** Push a prompt snapshot (e.g. on new turn with different system prompt). */
  pushPrompt(): void
  pushConfig(): void
  /** Broadcast a captured fetch (request phase or response phase). */
  pushHttp(record: DevtoolsHttpRecord): void
}

type ActiveSocket = { send: (data: string) => void }

/**
 * Starts an in-process devtools server on `port`.
 *   HTTP GET /           → serves client.html
 *   HTTP GET /client.html → same
 *   WebSocket /ws        → JSON frame stream (see protocol.ts)
 *
 * Binds to 127.0.0.1 only — full agent state (messages, prompts, keys) leaks
 * over this channel, so it must not be reachable from other machines.
 */
export function startDevToolsServer(options: DevToolsServerOptions): DevToolsServerHandle {
  const port = options.port ?? 9229
  const token = options.token ?? randomBytes(16).toString("hex")
  let agent: DevtoolsAgentLike = options.agent
  let unsubscribeEmitter: (() => void) | null = null

  const clients = new Set<ActiveSocket>()
  const ring: Array<{ ts: number; event: AgentEvent }> = []

  const broadcast = (frame: ServerFrame): void => {
    const data = JSON.stringify(frame)
    for (const client of clients) {
      try { client.send(data) } catch { /* ignore dead sockets */ }
    }
  }

  const handleEvent = (event: AgentEvent): void => {
    const ts = Date.now()
    const safeEvent = redactDevtoolsValue(event) as AgentEvent
    ring.push({ ts, event: safeEvent })
    if (ring.length > EVENT_RING_SIZE) ring.shift()
    broadcast({ topic: "event", ts, payload: safeEvent })
    // Several events imply the conversation just mutated — re-push so the
    // client's Messages tab stays in sync without the client having to
    // reconcile from the event stream.
    if (
      event.type === "content_final" ||
      event.type === "run_step" ||
      event.type === "run_ended" ||
      event.type === "run_started"
    ) {
      try {
        const conversation = redactDevtoolsValue(options.getConversation()) as Message[]
        broadcast({ topic: "conversation", ts, payload: { conversation } })
      } catch { /* ignore */ }
    }
  }

  const subscribe = (): void => {
    if (unsubscribeEmitter) unsubscribeEmitter()
    agent.on("*", handleEvent)
    unsubscribeEmitter = () => agent.off("*", handleEvent)
  }
  subscribe()

  const snapshotFor = (): DevtoolsSnapshot => ({
    conversation: redactDevtoolsValue(safeGet(options.getConversation, [])) as Message[],
    systemPrompt: redactDevtoolsValue(safeGet(options.getSystemPrompt, "")) as string,
    config: redactDevtoolsValue(safeGet(options.getConfig, {})),
    recentEvents: ring.slice(),
    version: VERSION,
  })

  // Read client.html lazily so changes during dev don't require a restart.
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const clientHtmlPath = join(thisDir, "client.html")
  const readClientHtml = (): string => {
    try { return readFileSync(clientHtmlPath, "utf-8") }
    catch { return "<!doctype html><h1>devtools client.html missing</h1>" }
  }
  const hasToken = (url: URL): boolean => url.searchParams.get("token") === token

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req: Request, srv: DevtoolsBunServeServer) {
      const url = new URL(req.url)
      if (url.pathname === "/ws") {
        if (!hasToken(url)) return new Response("unauthorized", { status: 401 })
        if (srv.upgrade(req, { data: {} })) return
        return new Response("expected websocket upgrade", { status: 426 })
      }
      if (url.pathname === "/" || url.pathname === "/client.html") {
        return new Response(readClientHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      if (url.pathname === "/snapshot") {
        if (!hasToken(url)) return new Response("unauthorized", { status: 401 })
        // Cheap REST escape hatch for debugging the server itself.
        return new Response(JSON.stringify(snapshotFor(), null, 2), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws: ActiveSocket) {
        clients.add(ws)
        const frame: ServerFrame = {
          topic: "snapshot",
          ts: Date.now(),
          payload: snapshotFor(),
        }
        ws.send(JSON.stringify(frame))
      },
      close(ws: ActiveSocket) { clients.delete(ws) },
      message(ws: ActiveSocket, data: string | Buffer) {
        let msg: ClientFrame
        try { msg = JSON.parse(String(data)) as ClientFrame }
        catch { return }
        if (msg.topic === "refresh") {
          const frame: ServerFrame = {
            topic: "snapshot",
            ts: Date.now(),
            payload: snapshotFor(),
          }
          ws.send(JSON.stringify(frame))
        }
        // ping is a no-op keepalive.
      },
    },
  })

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`,
    stop() {
      if (unsubscribeEmitter) unsubscribeEmitter()
      server.stop()
      clients.clear()
    },
    attachAgent(next) {
      agent = next
      subscribe()
    },
    pushConversation() {
      const ts = Date.now()
      broadcast({
        topic: "conversation",
        ts,
        payload: { conversation: redactDevtoolsValue(options.getConversation()) as Message[] },
      })
    },
    pushPrompt() {
      const ts = Date.now()
      broadcast({
        topic: "prompt",
        ts,
        payload: { systemPrompt: redactDevtoolsValue(options.getSystemPrompt()) as string },
      })
    },
    pushConfig() {
      const ts = Date.now()
      broadcast({ topic: "config", ts, payload: { config: redactDevtoolsValue(options.getConfig()) } })
    },
    pushHttp(record: DevtoolsHttpRecord) {
      broadcast({ topic: "http", ts: Date.now(), payload: redactDevtoolsHttpRecord(record) })
    },
  }
}

function safeGet<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

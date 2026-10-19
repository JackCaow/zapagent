import type { Message } from "../zapsdk/core/types.js"
import { startDevToolsServer, type DevToolsServerHandle, type DevtoolsAgentLike } from "../zapsdk/devtools/server.js"
import type { DevtoolsHttpRecord } from "../zapsdk/devtools/protocol.js"

/**
 * Wiring between the zapcode app shell and the devtools server.
 *
 * The server is started once on app boot (if `ZAPCODE_DEVTOOLS_PORT` is set)
 * and lives for the process lifetime. `useAgentRunner` calls `setAgent()` +
 * `setReaders()` on every new `agent.run()` so the server always streams from
 * the current LoopAgent and snapshots the current conversation / prompt.
 */

interface State {
  agent: DevtoolsAgentLike
  getConversation: () => Message[]
  getSystemPrompt: () => string
  getConfig: () => unknown
}

const noopAgent: DevtoolsAgentLike = { on: () => {}, off: () => {} }

const state: State = {
  agent: noopAgent,
  getConversation: () => [],
  getSystemPrompt: () => "",
  getConfig: () => ({}),
}

let handle: DevToolsServerHandle | null = null

export function startDevToolsIfEnabled(): DevToolsServerHandle | null {
  if (handle) return handle
  const raw = process.env.ZAPCODE_DEVTOOLS_PORT
  if (!raw) return null
  const port = Number.parseInt(raw, 10)
  if (!Number.isFinite(port) || port <= 0) return null
  handle = startDevToolsServer({
    port,
    agent: state.agent,
    getConversation: () => state.getConversation(),
    getSystemPrompt: () => state.getSystemPrompt(),
    getConfig: () => state.getConfig(),
  })
  patchFetchForDevtools(
    record => handle?.pushHttp(record),
    () => handle?.url ?? null,
  )
  // eslint-disable-next-line no-console
  console.log(`\x1b[38;5;215m⚡ devtools\x1b[0m → ${handle.url}`)
  return handle
}

/**
 * Monkey-patch globalThis.fetch so every outbound HTTP is reported to the
 * devtools server as `{ topic: "http" }` frames. The SDK's body transforms
 * (Anthropic vs OpenAI serialization, streaming flag, tool schemas) are all
 * visible because we intercept AFTER the SDK has composed the Request.
 *
 * Skips requests to the devtools server itself to avoid infinite loops when
 * the browser client connects over WS (the WS handshake is an HTTP request).
 */
function patchFetchForDevtools(
  push: (record: DevtoolsHttpRecord) => void,
  getDevtoolsUrl: () => string | null,
): void {
  const orig = globalThis.fetch
  if ((orig as any).__zapDevtoolsPatched) return
  const wrapped = async function patchedFetch(input: any, init?: RequestInit): Promise<Response> {
    const started = Date.now()
    const id = `http_${started}_${Math.random().toString(36).slice(2, 8)}`
    let url = ""
    let method = "GET"
    const reqHeaders: Record<string, string> = {}
    let body: string | undefined

    try {
      if (typeof input === "string" || input instanceof URL) {
        url = String(input)
        method = (init?.method ?? "GET").toUpperCase()
        new Headers(init?.headers ?? {}).forEach((v, k) => { reqHeaders[k] = v })
        const b = init?.body
        if (typeof b === "string") body = b
        else if (b instanceof Uint8Array) body = safeDecode(b)
        else if (b && typeof (b as any).text === "function") {
          try { body = await (b as any).text() } catch { /* ignore */ }
        } else if (b) body = `[${b.constructor?.name ?? typeof b}]`
      } else if (input && typeof input.clone === "function") {
        const req = input as Request
        url = req.url
        method = req.method.toUpperCase()
        req.headers.forEach((v, k) => { reqHeaders[k] = v })
        try { body = await req.clone().text() } catch { /* ignore */ }
      }
    } catch { /* ignore instrumentation errors */ }

    // Don't record requests against our own devtools server — that would cause
    // every client tick to append a row to the Network tab. Other localhost
    // traffic (Ollama, local OpenAI-compatible proxies, test servers) is useful
    // signal and must remain visible.
    const shouldCapture = url && shouldCaptureDevtoolsHttp(url, getDevtoolsUrl())
    if (shouldCapture) {
      push({
        id,
        phase: "request",
        url,
        method,
        requestHeaders: reqHeaders,
        requestBody: body,
        startedAt: started,
      })
    }

    try {
      const resp = await orig.call(globalThis, input, init)
      if (shouldCapture) {
        const respHeaders: Record<string, string> = {}
        resp.headers.forEach((v, k) => { respHeaders[k] = v })
        push({
          id,
          phase: "response",
          url,
          method,
          status: resp.status,
          responseHeaders: respHeaders,
          durationMs: Date.now() - started,
          startedAt: started,
        })
      }
      return resp
    } catch (err) {
      if (shouldCapture) {
        push({
          id,
          phase: "error",
          url,
          method,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
          startedAt: started,
        })
      }
      throw err
    }
  }
  ;(wrapped as any).__zapDevtoolsPatched = true
  globalThis.fetch = wrapped as typeof fetch
}

export function shouldCaptureDevtoolsHttp(url: string, devtoolsUrl: string | null): boolean {
  if (!url || !devtoolsUrl) return Boolean(url)
  try {
    const target = new URL(url)
    const devtools = new URL(devtoolsUrl)
    const targetProtocol = target.protocol.toLowerCase()
    if (targetProtocol !== "http:" && targetProtocol !== "https:" && targetProtocol !== "ws:" && targetProtocol !== "wss:") {
      return true
    }
    return !(isLoopbackHost(target.hostname) && isLoopbackHost(devtools.hostname) && target.port === devtools.port)
  } catch {
    return true
  }
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"
}

function safeDecode(b: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: false }).decode(b) } catch { return "[binary]" }
}

export function devToolsSetAgent(agent: DevtoolsAgentLike): void {
  state.agent = agent
  handle?.attachAgent(agent)
}

export function devToolsSetReaders(readers: Partial<Omit<State, "agent">>): void {
  if (readers.getConversation) state.getConversation = readers.getConversation
  if (readers.getSystemPrompt) state.getSystemPrompt = readers.getSystemPrompt
  if (readers.getConfig) state.getConfig = readers.getConfig
  // Push fresh snapshots so any connected client sees the new state immediately.
  handle?.pushConversation()
  handle?.pushPrompt()
  handle?.pushConfig()
}

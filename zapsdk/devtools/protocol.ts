/**
 * Devtools wire protocol. Every frame is a JSON object with `topic` and `ts`
 * (millis since epoch). The server sends snapshots + live events; the client
 * sends commands that nudge the server to republish state.
 */

import type { AgentEvent } from "../agent/events.js"
import type { Message } from "../core/types.js"

export interface DevtoolsSnapshot {
  conversation: Message[]
  systemPrompt: string
  /** Arbitrary config blob (usually AppConfig). Kept untyped to avoid a
   *  zapsdk → src dependency — the client just renders JSON. */
  config: unknown
  /** Last N events the server has buffered, newest last. */
  recentEvents: Array<{ ts: number; event: AgentEvent }>
  /** Server version string, shown in the client header. */
  version: string
}

/** Raw outbound HTTP captured by the fetch interceptor. `phase: "request"`
 *  fires on the wire before the server answers; `phase: "response"` (or
 *  "error") fires when the server replies / the call throws. Paired via `id`. */
export interface DevtoolsHttpRecord {
  id: string
  phase: "request" | "response" | "error"
  url: string
  method: string
  requestHeaders?: Record<string, string>
  requestBody?: string
  requestBodyTruncated?: boolean
  requestBodyOriginalChars?: number
  status?: number
  responseHeaders?: Record<string, string>
  durationMs?: number
  error?: string
  startedAt: number
}

export type ServerFrame =
  | { topic: "snapshot"; ts: number; payload: DevtoolsSnapshot }
  | { topic: "event"; ts: number; payload: AgentEvent }
  | { topic: "conversation"; ts: number; payload: { conversation: Message[] } }
  | { topic: "prompt"; ts: number; payload: { systemPrompt: string } }
  | { topic: "config"; ts: number; payload: { config: unknown } }
  | { topic: "http"; ts: number; payload: DevtoolsHttpRecord }

export type ClientFrame =
  | { topic: "refresh" }       // re-send the full snapshot
  | { topic: "ping" }

import type { RuntimeEventPage } from "../runtime/event-store.js";
import type { RuntimeEvent, ThreadSnapshot } from "../runtime/types.js";
import type { AgentRunSnapshot } from "../agent/run-state.js";
import type { AgentMailboxMessage } from "../coordinator/types.js";

export const HOST_PROTOCOL_VERSION = 2 as const;

export type HostProtocolMethod =
  | "workflow.read"
  | "workflow.cancel"
  | "workflow.reconcile"
  | "workflow.wait"
  | "workflow.dispatch"
  | "thread.snapshot"
  | "thread.run"
  | "thread.cancel"
  | "thread.events"
  | "agent.list"
  | "agent.cancel"
  | "agent.steer"
  | "agent.resume";

export interface HostProtocolRequest {
  version: 1 | 2;
  id: string;
  method: HostProtocolMethod;
  threadId: string;
  params?: Record<string, unknown>;
}

export interface HostProtocolError {
  code: string;
  message: string;
  retryable: boolean;
}

export type HostProtocolResponse =
  | { version: 1 | 2; id: string; ok: true; result: unknown }
  | { version: 1 | 2; id: string; ok: false; error: HostProtocolError };

export type HostProtocolResult =
  | ThreadSnapshot
  | RuntimeEventPage
  | RuntimeEvent[]
  | AgentRunSnapshot[]
  | AgentRunSnapshot
  | AgentMailboxMessage
  | { cancelled: boolean }
  | { text: string; steps: number; totalUsage: unknown; stopped?: string };

import { agent, type AgentApp, type AgentContext, type ContentBlock, type SessionUpdate, type StopReason } from "@agentclientprotocol/sdk";

/** Scripted ACP agent for tests. Each prompt runs `script` with helpers that
 * talk back to the client exactly as a real agent would. */
export interface FakeAgentTurn {
  sessionId: string;
  prompt: ContentBlock[];
  client: AgentContext;
  signal: AbortSignal;
  update(update: SessionUpdate): Promise<void>;
  cancelled: Promise<void>;
}

export interface FakeAgentOptions {
  loadSession?: boolean;
  script(turn: FakeAgentTurn): Promise<StopReason | void>;
}

export interface FakeAgentLog {
  initialize: Record<string, unknown>[];
  calls: Array<{ method: string; params: Record<string, unknown> }>;
}

export function fakeAgent(options: FakeAgentOptions): { app: AgentApp; log: FakeAgentLog } {
  const log: FakeAgentLog = { initialize: [], calls: [] };
  const cancels = new Map<string, () => void>();
  let sessions = 0;
  const app = agent({ name: "fake" })
    .onRequest("initialize", ({ params }) => {
      log.initialize.push(params as Record<string, unknown>);
      return { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" },
        agentCapabilities: { loadSession: !!options.loadSession } };
    })
    .onRequest("session/new", ({ params }) => {
      log.calls.push({ method: "session/new", params: params as Record<string, unknown> });
      return { sessionId: `s${++sessions}` };
    })
    .onRequest("session/load", ({ params }) => {
      log.calls.push({ method: "session/load", params: params as Record<string, unknown> });
      return {};
    })
    .onRequest("session/set_mode", ({ params }) => {
      log.calls.push({ method: "session/set_mode", params: params as Record<string, unknown> });
      return {};
    })
    .onRequest("session/set_config_option", ({ params }) => {
      log.calls.push({ method: "session/set_config_option", params: params as Record<string, unknown> });
      return { configOptions: [] };
    })
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      log.calls.push({ method: "session/prompt", params: params as Record<string, unknown> });
      const cancelled = new Promise<void>((resolve) => cancels.set(params.sessionId, resolve));
      const stop = await options.script({
        sessionId: params.sessionId, prompt: params.prompt, client, signal, cancelled,
        update: (update) => client.notify("session/update", { sessionId: params.sessionId, update }),
      });
      return { stopReason: stop ?? "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 40 } };
    })
    .onNotification("session/cancel", ({ params }) => {
      log.calls.push({ method: "session/cancel", params: params as Record<string, unknown> });
      cancels.get(params.sessionId)?.();
    });
  return { app, log };
}

export const text = (value: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
export const thought = (value: string): SessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: value } });

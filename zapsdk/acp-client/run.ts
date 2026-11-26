import type { PlanEntry, StopReason } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../agent/events.js";
import type { TokenUsage } from "../core/types.js";
import { AcpClientConnection, type AcpTransport } from "./connection.js";
import { AcpEventMapper, acpUsage } from "./event-mapper.js";
import { AcpClientError, type AcpAgentSpec, type AcpClientHandlers } from "./types.js";

export interface AcpTaskOptions {
  spec: AcpAgentSpec;
  task: string;
  cwd: string;
  transport: AcpTransport;
  handlers: AcpClientHandlers;
  /** Resume this agent session when the agent supports session/load. */
  sessionId?: string;
  /** Overrides spec.mode for this call. */
  mode?: string;
  /** Event path prefix for nested rendering (subagent path). */
  path?: string[];
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  clientVersion?: string;
  /** Bound for initialize/session setup; prompts are bounded by `signal`. */
  setupTimeoutMs?: number;
}

export interface AcpTaskResult {
  agentName: string;
  sessionId: string;
  resumed: boolean;
  /** The agent supports session/load, so `sessionId` can continue later. */
  resumable: boolean;
  stopReason: StopReason;
  report: string;
  toolCalls: number;
  plan: PlanEntry[];
  usage?: TokenUsage;
  /** Setup steps the agent rejected (mode/config/model); the run continued. */
  warnings: string[];
}

/** Run one task on an external ACP agent: connect, open or resume a
 * session, apply mode/config, prompt, and map updates to AgentEvents. The
 * transport is always disposed. */
export async function runAcpTask(options: AcpTaskOptions): Promise<AcpTaskResult> {
  const { spec, signal } = options;
  const setup = { signal, timeoutMs: options.setupTimeoutMs ?? 60_000 };
  const connection = await AcpClientConnection.open(options.transport, options.handlers,
    { clientVersion: options.clientVersion, ...setup });
  const warnings: string[] = [];
  const mapper = new AcpEventMapper(options.path ?? []);
  const emit = (events: AgentEvent[]) => { for (const event of events) options.onEvent?.(event); };
  try {
    let sessionId = options.sessionId;
    let resumed = false;
    if (sessionId) {
      await connection.loadSession(sessionId, options.cwd, setup);
      resumed = true;
    } else {
      const session = await connection.newSession(options.cwd, setup);
      sessionId = session.sessionId;
      const model = spec.model;
      if (model) {
        // Agents expose the model as a "model" config option (agy, codex);
        // the unstable session/set_model is only a fallback.
        const asOption = session.configOptions?.some(option => option.id === "model");
        try {
          if (asOption) await connection.setConfigOption(sessionId, "model", model);
          else await connection.setModel(sessionId, model);
        } catch (error) { warnings.push(`model ${model}: ${message(error)}`); }
      }
      for (const [configId, value] of Object.entries(spec.config ?? {})) {
        try { await connection.setConfigOption(sessionId, configId, value); }
        catch (error) { warnings.push(`config ${configId}=${value}: ${message(error)}`); }
      }
    }
    const mode = options.mode ?? spec.mode;
    if (mode) {
      try { await connection.setMode(sessionId, mode); }
      catch (error) { warnings.push(`mode ${mode}: ${message(error)}`); }
    }

    let response;
    try {
      response = await connection.prompt(sessionId, [{ type: "text", text: options.task }], {
        signal, onUpdate: update => emit(mapper.map(update)),
      });
    } catch (error) {
      emit(mapper.finish(error instanceof AcpClientError && error.code === "cancelled" ? "cancelled" : "error"));
      throw error;
    }
    emit(mapper.finish(response.stopReason));
    return {
      agentName: connection.agentName,
      sessionId,
      resumed,
      resumable: !!connection.info.agentCapabilities?.loadSession,
      stopReason: response.stopReason,
      report: mapper.reportText,
      toolCalls: mapper.toolCallCount,
      plan: mapper.plan,
      usage: acpUsage(response.usage),
      warnings,
    };
  } finally {
    await connection.close();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

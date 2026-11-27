import type {
  AvailableCommand, ContentBlock, PlanEntry, SessionConfigOption, SessionModeState, SessionUpdate, StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../agent/events.js";
import type { TokenUsage } from "../core/types.js";
import { AcpClientConnection, type AcpTransport } from "./connection.js";
import { AcpEventMapper, acpUsage } from "./event-mapper.js";
import { AcpClientError, type AcpAgentSpec, type AcpClientHandlers } from "./types.js";

export interface AcpSessionStartOptions {
  spec: AcpAgentSpec;
  cwd: string;
  transport: AcpTransport;
  handlers: AcpClientHandlers;
  /** Resume this agent session when the agent supports session/load. */
  sessionId?: string;
  /** Overrides spec.mode. */
  mode?: string;
  signal?: AbortSignal;
  clientVersion?: string;
  /** Bound for initialize/session setup; prompts are bounded by their signal. */
  setupTimeoutMs?: number;
}

export interface AcpTurnOptions {
  signal?: AbortSignal;
  /** Event path prefix for nested rendering (subagent path). */
  path?: string[];
  onEvent?: (event: AgentEvent) => void;
  onContextUsage?: (usage: { used: number; size: number }) => void;
}

export interface AcpTurnResult {
  stopReason: StopReason;
  report: string;
  toolCalls: number;
  plan: PlanEntry[];
  usage?: TokenUsage;
}

/** A live ACP session on one agent process. Survives across prompts, so a
 * host can hold a multi-turn conversation; dispose with `close()`. */
export class AcpAgentSession {
  modes?: SessionModeState | null;
  currentModeId?: string;
  configOptions?: SessionConfigOption[] | null;
  availableCommands: AvailableCommand[] = [];
  /** Setup steps the agent rejected (mode/config/model); the session continues. */
  readonly warnings: string[] = [];
  private turn?: (update: SessionUpdate) => void;

  private constructor(
    readonly connection: AcpClientConnection,
    readonly spec: AcpAgentSpec,
    readonly sessionId: string,
    readonly resumed: boolean,
  ) {}

  static async start(options: AcpSessionStartOptions): Promise<AcpAgentSession> {
    const { spec, signal } = options;
    const setup = { signal, timeoutMs: options.setupTimeoutMs ?? 60_000 };
    const connection = await AcpClientConnection.open(options.transport, options.handlers,
      { clientVersion: options.clientVersion, ...setup });
    try {
      let session: AcpAgentSession;
      if (options.sessionId) {
        await connection.loadSession(options.sessionId, options.cwd, setup);
        session = new AcpAgentSession(connection, spec, options.sessionId, true);
      } else {
        const created = await connection.newSession(options.cwd, setup);
        session = new AcpAgentSession(connection, spec, created.sessionId, false);
        session.modes = created.modes;
        session.currentModeId = created.modes?.currentModeId;
        session.configOptions = created.configOptions;
        if (spec.model) {
          // Agents expose the model as a "model" config option (agy, codex);
          // the unstable session/set_model is only a fallback.
          const model = spec.model;
          const asOption = created.configOptions?.some(option => option.id === "model");
          await session.attempt(`model ${model}`, () => asOption
            ? connection.setConfigOption(created.sessionId, "model", model)
            : connection.setModel(created.sessionId, model));
        }
        for (const [configId, value] of Object.entries(spec.config ?? {})) {
          await session.attempt(`config ${configId}=${value}`, () => connection.setConfigOption(created.sessionId, configId, value));
        }
      }
      const mode = options.mode ?? spec.mode;
      if (mode) await session.attempt(`mode ${mode}`, () => session.setMode(mode, setup));
      if (spec.requireSettings && session.warnings.length) throw new Error(session.warnings.join("; "));
      return session;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  get agentName(): string { return this.connection.agentName; }
  get resumable(): boolean { return !!this.connection.info.agentCapabilities?.loadSession; }
  get supportsImages(): boolean { return !!this.connection.info.agentCapabilities?.promptCapabilities?.image; }

  /** One prompt turn. Updates outside a turn (command lists, mode changes)
   * are tracked on the session as well. */
  async prompt(content: string | ContentBlock[], options: AcpTurnOptions = {}): Promise<AcpTurnResult> {
    const mapper = new AcpEventMapper(options.path ?? []);
    const emit = (events: AgentEvent[]) => { for (const event of events) options.onEvent?.(event); };
    this.turn = update => {
      emit(mapper.map(update));
      if (update.sessionUpdate === "usage_update" && mapper.contextUsage) options.onContextUsage?.(mapper.contextUsage);
    };
    const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    let response;
    try {
      response = await this.connection.prompt(this.sessionId, blocks, {
        signal: options.signal, onUpdate: update => this.observe(update),
      });
    } catch (error) {
      emit(mapper.finish(error instanceof AcpClientError && error.code === "cancelled" ? "cancelled" : "error"));
      throw error;
    } finally {
      this.turn = undefined;
    }
    emit(mapper.finish(response.stopReason));
    return {
      stopReason: response.stopReason,
      report: mapper.reportText,
      toolCalls: mapper.toolCallCount,
      plan: mapper.plan,
      usage: acpUsage(response.usage),
    };
  }

  async setMode(modeId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    await this.connection.setMode(this.sessionId, modeId, options);
    this.currentModeId = modeId;
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
  }

  async close(): Promise<void> { await this.connection.close(); }

  private observe(update: SessionUpdate): void {
    if (update.sessionUpdate === "available_commands_update") this.availableCommands = update.availableCommands;
    else if (update.sessionUpdate === "current_mode_update") {
      this.currentModeId = update.currentModeId;
      if (this.modes) this.modes = { ...this.modes, currentModeId: update.currentModeId };
    }
    else if (update.sessionUpdate === "config_option_update") this.configOptions = update.configOptions;
    this.turn?.(update);
  }

  private async attempt(label: string, step: () => Promise<void>): Promise<void> {
    try { await step(); }
    catch (error) { this.warnings.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
  }
}

export interface AcpTaskOptions extends AcpSessionStartOptions, AcpTurnOptions {
  task: string;
}

export interface AcpTaskResult extends AcpTurnResult {
  agentName: string;
  sessionId: string;
  resumed: boolean;
  /** The agent supports session/load, so `sessionId` can continue later. */
  resumable: boolean;
  warnings: string[];
}

/** One-shot: start a session, run one prompt, always close the transport. */
export async function runAcpTask(options: AcpTaskOptions): Promise<AcpTaskResult> {
  const session = await AcpAgentSession.start(options);
  try {
    const turn = await session.prompt(options.task, options);
    return { ...turn, agentName: session.agentName, sessionId: session.sessionId, resumed: session.resumed,
      resumable: session.resumable, warnings: [...session.warnings] };
  } finally {
    await session.close();
  }
}

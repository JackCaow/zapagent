import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  client, ndJsonStream, PROTOCOL_VERSION,
  type AgentApp, type ClientConnection, type ContentBlock, type InitializeResponse,
  type NewSessionResponse, type PromptResponse, type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { AcpClientError, type AcpClientHandlers } from "./types.js";
import { terminateProcessTree, terminateProcessTreeWithGrace } from "../execution/process.js";

const STDERR_CAP = 16 * 1024;
const CANCEL_GRACE_MS = 5_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const EXIT_SETTLE_MS = 500;

function delay(ms: number): Promise<undefined> {
  return new Promise(resolve => { const timer = setTimeout(() => resolve(undefined), ms); timer.unref?.(); });
}

/** Where an ACP agent lives. Stdio covers real agents; in-process covers
 * adapters and tests. The connection cannot tell them apart. */
export interface AcpTransport {
  open(app: ReturnType<typeof client>): ClientConnection;
  /** Settles when the agent can no longer answer (process exit). */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail(): string;
  dispose(): Promise<void>;
  /** Synchronous SIGKILL of the agent's process tree (process exit only). */
  kill?(): void;
}

export function stdioTransport(child: ChildProcess): AcpTransport {
  if (!child.stdin || !child.stdout) throw new AcpClientError("ACP agent has no stdio pipes", "spawn_failed");
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_CAP); });
  // EPIPE on a dead agent surfaces through `exited`, not as an unhandled error.
  child.stdin.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => { stderr += `\n${error.message}`; resolve({ code: null, signal: null }); });
  });
  return {
    open: (app) => app.connect(ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      { maxMessageBytes: MAX_MESSAGE_BYTES })),
    exited,
    stderrTail: () => stderr.trim(),
    async dispose() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin?.end();
      terminateProcessTreeWithGrace(child, 3_000);
      await exited;
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, "SIGKILL");
    },
  };
}

export function inProcessTransport(agent: AgentApp): AcpTransport {
  let release!: () => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    release = () => resolve({ code: 0, signal: null });
  });
  return {
    open: (app) => app.connect(agent),
    exited,
    stderrTail: () => "",
    async dispose() { release(); },
  };
}

export interface AcpPromptOptions {
  signal?: AbortSignal;
  onUpdate?: (update: SessionUpdate) => void;
}

/** One ACP connection: initialize once, then sessions and prompts. */
export class AcpClientConnection {
  private readonly listeners = new Map<string, (update: SessionUpdate) => void>();
  private connection!: ClientConnection;
  info!: InitializeResponse;

  private constructor(private readonly transport: AcpTransport) {}

  static async open(transport: AcpTransport, handlers: AcpClientHandlers, options: {
    clientName?: string; clientVersion?: string; signal?: AbortSignal; timeoutMs?: number;
  } = {}): Promise<AcpClientConnection> {
    const self = new AcpClientConnection(transport);
    const app = client({ name: options.clientName ?? "zapcode" })
      .onNotification("session/update", ({ params }) => { self.listeners.get(params.sessionId)?.(params.update); });
    if (handlers.requestPermission) {
      const handler = handlers.requestPermission;
      app.onRequest("session/request_permission", ({ params, signal }) => handler(params, signal));
    } else {
      app.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
    }
    if (handlers.readTextFile) {
      const handler = handlers.readTextFile;
      app.onRequest("fs/read_text_file", ({ params, signal }) => handler(params, signal));
    }
    if (handlers.writeTextFile) {
      const handler = handlers.writeTextFile;
      app.onRequest("fs/write_text_file", async ({ params, signal }) => { await handler(params, signal); return {}; });
    }
    self.connection = transport.open(app);
    try {
      self.info = await self.call(self.connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: !!handlers.readTextFile, writeTextFile: !!handlers.writeTextFile },
          terminal: false,
        },
        clientInfo: { name: options.clientName ?? "zapcode", version: options.clientVersion ?? "0" },
      }), "initialize_failed", options);
    } catch (error) {
      await self.close();
      throw error;
    }
    return self;
  }

  get agentName(): string {
    return this.info.agentInfo?.title || this.info.agentInfo?.name || "agent";
  }

  async newSession(cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<NewSessionResponse> {
    return this.call(this.connection.agent.request("session/new", { cwd, mcpServers: [] }), "session_failed", options);
  }

  /** Resume a prior session. Replayed history is dropped; only new turns are mapped. */
  async loadSession(sessionId: string, cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (!this.info.agentCapabilities?.loadSession) {
      throw new AcpClientError(`${this.agentName} cannot resume sessions`, "session_failed");
    }
    await this.call(this.connection.agent.request("session/load", { sessionId, cwd, mcpServers: [] }), "session_failed", options);
  }

  async setMode(sessionId: string, modeId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    await this.call(this.connection.agent.request("session/set_mode", { sessionId, modeId }), "session_failed", options);
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.call(this.connection.agent.request("session/set_config_option", { sessionId, configId, value }), "session_failed");
  }

  /** Unstable `session/set_model`; agents without it reject and the caller decides. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.call(this.connection.agent.request("session/set_model", { sessionId, modelId }), "session_failed");
  }

  async prompt(sessionId: string, prompt: ContentBlock[], options: AcpPromptOptions = {}): Promise<PromptResponse> {
    if (options.onUpdate) this.listeners.set(sessionId, options.onUpdate);
    const signal = options.signal;
    let onAbort: (() => void) | undefined;
    try {
      const request = this.connection.agent.request("session/prompt", { sessionId, prompt });
      const cancelled = new Promise<PromptResponse>((resolve, reject) => {
        onAbort = () => {
          void this.connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
          // A cooperative agent answers with stopReason "cancelled"; do not
          // wait forever for one that ignores the notification.
          const timer = setTimeout(() => reject(new AcpClientError("ACP agent ignored cancellation", "cancelled")), CANCEL_GRACE_MS);
          timer.unref?.();
          request.then(resolve, reject).finally(() => clearTimeout(timer));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      return await this.call(signal ? Promise.race([request, cancelled]) : request, "prompt_failed");
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.listeners.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    try { this.connection?.close(); } catch { /* already closed */ }
    await this.transport.dispose();
  }

  stderrTail(): string { return this.transport.stderrTail(); }

  /** Race a request against agent exit, a timeout and the caller's signal. */
  private async call<T>(request: Promise<T>, code: AcpClientError["code"], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const guards: Array<Promise<never>> = [
      this.transport.exited.then(({ code: exitCode, signal }) => {
        throw new AcpClientError(`ACP agent exited (${signal ?? `code ${exitCode}`})`, "exited", this.transport.stderrTail() || undefined);
      }),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      guards.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AcpClientError(`ACP request timed out after ${options.timeoutMs}ms`, "timeout")), options.timeoutMs);
        timer.unref?.();
      }));
    }
    let onAbort: (() => void) | undefined;
    if (options.signal) {
      guards.push(new Promise<never>((_, reject) => {
        onAbort = () => reject(new AcpClientError("cancelled", "cancelled"));
        if (options.signal!.aborted) onAbort();
        else options.signal!.addEventListener("abort", onAbort, { once: true });
      }));
    }
    try {
      return await Promise.race([request, ...guards]);
    } catch (error) {
      if (error instanceof AcpClientError) throw error;
      // A dying agent closes stdout before the exit event fires, so the
      // request fails as "connection closed" first. Report it as the exit.
      const exit = await Promise.race([this.transport.exited, delay(EXIT_SETTLE_MS)]);
      if (exit) {
        throw new AcpClientError(`ACP agent exited (${exit.signal ?? `code ${exit.code}`})`, "exited", this.transport.stderrTail() || undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      // -32000 is ACP's auth_required error code.
      const auth = (error as { code?: number }).code === -32000
        || /auth(entication)? required|not authenticated|unauthori[sz]ed/i.test(message);
      throw new AcpClientError(message, auth ? "auth_required" : code, this.transport.stderrTail() || undefined);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

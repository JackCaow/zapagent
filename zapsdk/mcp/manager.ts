// MCPManager owns the lifecycle of all configured MCP servers. It is
// transport-agnostic, framework-free, and emits coarse events the React
// layer subscribes to. Reconcile(configs) is the single entry point — call
// it any time the desired set of servers changes and the manager drives
// the diff (start new, stop removed, restart changed).

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ResourceUpdatedNotificationSchema,
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../tools/types.js";
import { resolve as resolvePath } from "node:path";
import {
  createSamplingRequestHandler,
  type SamplingHandler,
} from "./bridge/sampling.js";
import { createMCPClient } from "./client-factory.js";
import { MCPError, withTimeout } from "./errors.js";
import type { MCPOAuthProvider } from "./oauth/index.js";
import { createTransport } from "./transport/index.js";
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  bridgeMCPTool,
  isValidMCPNamespacePart,
  type MCPListedTool,
} from "./bridge/tools.js";
import {
  fetchResources,
  readResource,
  type MCPResource,
  type MCPResourceContent,
  type MCPResourceTemplate,
} from "./bridge/resources.js";
import {
  fetchPrompts,
  renderPrompt,
  type MCPPrompt,
} from "./bridge/prompts.js";
import { complete, type CompletionRef, type CompletionResult } from "./bridge/completion.js";
import type { Message } from "../core/types.js";
import {
  DEFAULTS,
  type MCPEvent,
  type MCPEventHandler,
  type MCPServerCapabilities,
  type MCPServerConfig,
  type MCPServerSnapshot,
  type MCPStatus,
} from "./types.js";

interface ManagedServer {
  config: MCPServerConfig;
  client: Client | null;
  transport: Transport | null;
  /** Present when this server's transport uses OAuth — used by runAuth(). */
  authProvider: MCPOAuthProvider | null;
  status: MCPStatus;
  tools: Tool[];
  resources: MCPResource[];
  resourceTemplates: MCPResourceTemplate[];
  prompts: MCPPrompt[];
  /** URIs we've subscribed to (resources/subscribe). Tracked so reconnect
   *  can re-subscribe automatically. */
  subscriptions: Set<string>;
  capabilities?: MCPServerCapabilities;
  connectedAt?: string;
  lastError?: string;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Fingerprint of the config under which this server is currently running.
   *  Used by reconcile() to detect "same name, different settings" and force
   *  a restart instead of an idempotent reuse. */
  fingerprint: string;
  /** Generation counter — bumped on every (re)connect; lets stale onclose
   *  callbacks from a previous transport identify themselves and bail. */
  generation: number;
}

function resourceSortKey(resource: MCPResource | MCPResourceTemplate): string {
  const uri = "uri" in resource ? resource.uri : resource.uriTemplate;
  return `${resource.server}:${uri}`;
}

export interface MCPManagerOptions {
  /**
   * Handler invoked when a server requests LLM sampling. The manager only
   * advertises `capabilities.sampling` for servers whose config has
   * `allowSampling: true`. If no handler is provided, sampling is never
   * offered to any server regardless of config.
   */
  samplingHandler?: SamplingHandler;
  /** Project cwd advertised through roots/list and used by bridged tools for
   *  project-scoped persisted artifacts. Defaults to `process.cwd()` for
   *  backwards compatibility. */
  projectCwd?: string;
}

export class MCPManager {
  private servers = new Map<string, ManagedServer>();
  private handlers = new Set<MCPEventHandler>();
  private samplingHandler: SamplingHandler | null;
  private readonly projectCwd: string;

  constructor(opts: MCPManagerOptions = {}) {
    this.samplingHandler = opts.samplingHandler ?? null;
    this.projectCwd = opts.projectCwd ?? process.cwd();
  }

  /** Replace the sampling handler at runtime — host calls this when the
   *  user toggles config or switches active LLM. */
  setSamplingHandler(handler: SamplingHandler | null): void {
    this.samplingHandler = handler;
  }

  on(handler: MCPEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: MCPEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* handler must not throw */ }
    }
  }

  // ── Public surface ────────────────────────────────────────────────────

  /**
   * Drive the manager toward the desired set of servers. Idempotent:
   * - new servers are started,
   * - removed servers are stopped,
   * - servers whose config changed are restarted,
   * - unchanged servers are left alone.
   * Errors per-server don't fail the reconcile.
   */
  async reconcile(configs: MCPServerConfig[]): Promise<void> {
    const { desired, errors } = this.normalizeDesiredConfigs(configs);

    // Stop anything no longer desired (or now disabled).
    for (const name of [...this.servers.keys()]) {
      if (!desired.has(name) && !errors.has(name)) {
        await this.stop(name);
      }
    }

    for (const [name, message] of errors) {
      const fp = `config-error:${message}`;
      const existing = this.servers.get(name);
      if (existing && existing.fingerprint === fp && existing.status === "error") {
        continue;
      }
      if (existing) {
        await this.stop(name);
      }
      this.setConfigError(name, message, fp);
    }

    // Start / restart everything desired.
    for (const config of desired.values()) {
      const existing = this.servers.get(config.name);
      const fp = fingerprint(config);
      if (existing && existing.fingerprint === fp && existing.status !== "error") {
        continue; // nothing changed
      }
      if (existing) {
        await this.stop(config.name);
      }
      void this.start(config, fp);
    }
  }

  private normalizeDesiredConfigs(configs: MCPServerConfig[]): {
    desired: Map<string, MCPServerConfig>;
    errors: Map<string, string>;
  } {
    const desired = new Map<string, MCPServerConfig>();
    const errors = new Map<string, string>();
    const seen = new Set<string>();
    for (const config of configs) {
      if (config.disabled) continue;
      const name = typeof config.name === "string" ? config.name : "";
      const key = name || "<unnamed>";
      if (!isValidMCPNamespacePart(name) || name.length > MCP_SERVER_NAME_MAX_LENGTH) {
        errors.set(
          key,
          `Invalid MCP server name "${name}": names must be 1-${MCP_SERVER_NAME_MAX_LENGTH} characters and can only contain letters, numbers, underscores, or hyphens; "__" is reserved`,
        );
        desired.delete(name);
        continue;
      }
      if (seen.has(name)) {
        errors.set(name, `Duplicate MCP server name "${name}": server names must be unique`);
        desired.delete(name);
        continue;
      }
      seen.add(name);
      desired.set(name, config);
    }
    return { desired, errors };
  }

  /** Snapshot of every server's current state. Cheap; safe to call in render. */
  snapshots(): MCPServerSnapshot[] {
    return [...this.servers.values()].map((s) => ({
      name: s.config.name,
      status: s.status,
      toolCount: s.tools.length,
      resourceCount: s.resources.length + s.resourceTemplates.length,
      promptCount: s.prompts.length,
      connectedAt: s.connectedAt,
      lastError: s.lastError,
      reconnectAttempts: s.reconnectAttempts,
      capabilities: s.capabilities,
    }));
  }

  /** All tools currently bridged across all ready servers. */
  allTools(): Tool[] {
    const out: Tool[] = [];
    for (const s of this.servers.values()) {
      if (s.status === "ready") out.push(...s.tools);
    }
    return out.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  /** All resources (concrete + templates) across ready servers. */
  allResources(): { resources: MCPResource[]; templates: MCPResourceTemplate[] } {
    const resources: MCPResource[] = [];
    const templates: MCPResourceTemplate[] = [];
    for (const s of this.servers.values()) {
      if (s.status !== "ready") continue;
      resources.push(...s.resources);
      templates.push(...s.resourceTemplates);
    }
    return {
      resources: resources.sort((a, b) => resourceSortKey(a).localeCompare(resourceSortKey(b))),
      templates: templates.sort((a, b) => resourceSortKey(a).localeCompare(resourceSortKey(b))),
    };
  }

  /** All prompts across ready servers. */
  allPrompts(): MCPPrompt[] {
    const out: MCPPrompt[] = [];
    for (const s of this.servers.values()) {
      if (s.status === "ready") out.push(...s.prompts);
    }
    return out.sort((a, b) => `${a.server}:${a.name}`.localeCompare(`${b.server}:${b.name}`));
  }

  /**
   * Read a resource by `server` + `uri`. Used by the input-panel @-reference
   * machinery: the user types `@github:repo://anthropic/claude-code`, we
   * resolve to the server, pull the contents, and inline them into the user
   * message before sending.
   */
  async readResource(server: string, uri: string): Promise<MCPResourceContent[]> {
    const s = this.requireReady(server);
    return readResource(s.client!, s.config, uri);
  }

  /** Render an MCP-defined prompt by name into a list of Messages. */
  async renderPrompt(server: string, name: string, args?: Record<string, string>): Promise<Message[]> {
    const s = this.requireReady(server);
    return renderPrompt(s.client!, s.config, name, args);
  }

  /** Get argument completions for a prompt or resource URI template. */
  async complete(
    server: string,
    ref: CompletionRef,
    argument: { name: string; value: string },
    context?: { arguments?: Record<string, string> },
  ): Promise<CompletionResult> {
    const s = this.requireReady(server);
    if (!s.capabilities?.completions) return { values: [] };
    return complete(s.client!, s.config, ref, argument, context);
  }

  /**
   * Subscribe to updates on a resource URI. The subscription survives
   * reconnects (we re-subscribe in connect()). Caller gets notified via
   * resources_changed events on the manager bus.
   */
  async subscribeResource(server: string, uri: string): Promise<void> {
    const s = this.requireReady(server);
    if (!s.capabilities?.resources?.subscribe) {
      throw new MCPError(
        "config",
        `Server "${server}" does not support resource subscriptions.`,
        { server },
      );
    }
    await s.client!.subscribeResource({ uri });
    s.subscriptions.add(uri);
  }

  async unsubscribeResource(server: string, uri: string): Promise<void> {
    const s = this.requireReady(server);
    if (!s.subscriptions.has(uri)) return;
    try { await s.client!.unsubscribeResource({ uri }); } catch { /* ignore */ }
    s.subscriptions.delete(uri);
  }

  private requireReady(name: string): ManagedServer {
    const s = this.servers.get(name);
    if (!s) throw new MCPError("config", `Unknown MCP server: ${name}`);
    if (s.status !== "ready") {
      throw new MCPError("transport", `MCP server "${name}" is not ready (status=${s.status})`, { server: name });
    }
    return s;
  }

  /**
   * Manual reconnect — exposed for `/mcp reconnect <name>`. Preserves the
   * existing ManagedServer (and therefore its `subscriptions` set), so the
   * connect() path's re-subscribe loop can resurrect the URIs the user had
   * watched. Stop+Start would drop them silently.
   */
  async reconnect(name: string): Promise<void> {
    const s = this.servers.get(name);
    if (!s) return;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = undefined;
    }
    await this.disposeClient(s);
    // Clear terminal-error so scheduleReconnect's attempt counter starts
    // fresh — the user explicitly asked to retry.
    s.reconnectAttempts = 0;
    s.lastError = undefined;
    await this.connect(s);
  }

  /**
   * Run the interactive OAuth flow for a server in `needs_auth` state.
   * Returns once tokens are persisted; caller should follow with
   * `reconnect(name)`. Throws if the server isn't HTTP+OAuth or if the user
   * never completes the browser handshake (configurable timeout in loopback).
   */
  async runAuth(name: string): Promise<void> {
    const s = this.servers.get(name);
    if (!s) throw new MCPError("config", `Unknown MCP server: ${name}`);
    if (!s.authProvider) {
      throw new MCPError(
        "config",
        `Server "${name}" is not configured for OAuth (set transport: "http" and oauth.enabled).`,
        { server: name },
      );
    }
    // Build a fresh transport for the flow — the SDK's finishAuth() lives on
    // StreamableHTTPClientTransport and must be the same instance that fired
    // the redirect (it needs the in-flight code_verifier reference).
    const built = await createTransport(s.config);
    s.authProvider = built.authProvider;
    const provider = s.authProvider!;
    provider.options.onPrompt = (url) => {
      this.emit({ type: "auth_prompt", server: name, url });
    };
    try {
      await provider.runAuthFlow(built.transport as StreamableHTTPClientTransport);
    } finally {
      provider.stop();
      // Close the throwaway transport; reconnect() below will build a
      // fresh one that re-uses the saved tokens.
      try { await built.transport.close(); } catch { /* ignore */ }
    }
    await this.reconnect(name);
  }

  /** Tear down a single server. */
  async stop(name: string): Promise<void> {
    const s = this.servers.get(name);
    if (!s) return;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    this.servers.delete(name);
    if (s.client) {
      try { await s.client.close(); } catch { /* ignore */ }
    }
    this.setStatus(s, "disconnected");
  }

  /** Tear down everything. Best-effort, parallel; safe to call at unmount. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.servers.keys()].map((n) => this.stop(n)));
  }

  // ── Internal: connect lifecycle ────────────────────────────────────────

  private async start(config: MCPServerConfig, fp: string): Promise<void> {
    const s: ManagedServer = {
      config,
      client: null,
      transport: null,
      authProvider: null,
      status: "connecting",
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      subscriptions: new Set(),
      reconnectAttempts: 0,
      fingerprint: fp,
      generation: 0,
    };
    this.servers.set(config.name, s);
    await this.connect(s);
  }

  private setConfigError(name: string, message: string, fp: string): void {
    const config: MCPServerConfig = { name, transport: "stdio", disabled: true };
    const s: ManagedServer = {
      config,
      client: null,
      transport: null,
      authProvider: null,
      status: "idle",
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      subscriptions: new Set(),
      reconnectAttempts: 0,
      fingerprint: fp,
      generation: 0,
      lastError: message,
    };
    this.servers.set(name, s);
    this.setStatus(s, "error");
  }

  private async connect(s: ManagedServer): Promise<void> {
    // If a previous transport/client is still attached (e.g. reached here
    // from the auto-reconnect path after a transport drop, where the close
    // notification fired but close() was never explicitly called on the
    // client), tear it down before standing up a fresh pair. disposeClient
    // also bumps s.generation so any stale callbacks bound to the old pair
    // identify themselves and bail.
    if (s.client || s.transport) {
      await this.disposeClient(s);
    }

    const generation = ++s.generation;
    this.setStatus(s, "connecting");

    let transport: Transport;
    try {
      const built = await createTransport(s.config);
      transport = built.transport;
      s.authProvider = built.authProvider;
    } catch (err) {
      this.markError(s, err);
      return;
    }

    const advertiseSampling = !!this.samplingHandler && s.config.allowSampling === true;
    const advertiseRoots = !!s.config.roots || true; // always advertise; default = [cwd]
    const client = createMCPClient({
      advertiseSampling,
      advertiseRoots,
      onToolsChanged: () => {
        if (generation !== s.generation) return;
        void this.refreshTools(s).catch(() => { /* ignore */ });
      },
      onResourcesChanged: () => {
        if (generation !== s.generation) return;
        void this.refreshResources(s).catch(() => { /* ignore */ });
      },
      onPromptsChanged: () => {
        if (generation !== s.generation) return;
        void this.refreshPrompts(s).catch(() => { /* ignore */ });
      },
    });
    s.client = client;
    s.transport = transport;

    // Register reverse-call handlers BEFORE connect so the initialize
    // handshake races them in correctly.
    if (advertiseSampling && this.samplingHandler) {
      client.setRequestHandler(
        CreateMessageRequestSchema,
        createSamplingRequestHandler(s.config.name, this.samplingHandler),
      );
    }
    if (advertiseRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        const roots = s.config.roots ?? [this.projectCwd];
        return {
          roots: roots.map((p) => ({
            uri: pathToFileUri(p, this.projectCwd),
            name: p.split(/[\\/]/).pop() || p,
          })),
        };
      });
    }
    // notifications/message → log event
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notif) => {
      if (generation !== s.generation) return;
      const p = notif.params;
      this.emit({
        type: "log",
        server: s.config.name,
        level: p.level,
        message: typeof p.data === "string" ? p.data : JSON.stringify(p.data),
        data: p.data,
      });
    });
    // notifications/progress → currently appLogger-only (mapped by the
    // useMCPSubsystem hook). UI integration can be deepened later but the
    // shape is stable enough for status-line widgets to consume.
    client.setNotificationHandler(ProgressNotificationSchema, async (notif) => {
      if (generation !== s.generation) return;
      const p = notif.params;
      this.emit({
        type: "log",
        server: s.config.name,
        level: "info",
        message: `progress ${p.progress}${p.total ? `/${p.total}` : ""}${p.message ? `: ${p.message}` : ""}`,
        data: { kind: "progress", token: p.progressToken, ...p },
      });
    });

    // Transport close → degraded → schedule reconnect. Filter out callbacks
    // from previous generations so a stale onclose can't trigger a reconnect
    // while a fresh connect is already in progress.
    transport.onclose = () => {
      if (generation !== s.generation) return;
      if (s.status === "disconnected") return; // intentional stop
      s.lastError = "transport closed";
      this.setStatus(s, "degraded");
      this.scheduleReconnect(s);
    };
    transport.onerror = (err) => {
      if (generation !== s.generation) return;
      s.lastError = err instanceof Error ? err.message : String(err);
    };

    const connectTimeout = s.config.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    try {
      await withTimeout(
        client.connect(transport),
        connectTimeout,
        `mcp:${s.config.name}:connect`,
      );
    } catch (err) {
      // 401 → needs_auth (terminal until the user runs /mcp auth <name>).
      // We do NOT auto-trigger the browser flow on every connect — that
      // would race on app startup and pop a window without user intent.
      if (err instanceof UnauthorizedError) {
        await this.disposeClient(s); // close the half-initialized client
        s.lastError = "authorization required";
        this.setStatus(s, "needs_auth");
        return;
      }
      await this.disposeClient(s); // prevent stdio child / socket from lingering across retries
      this.markError(s, err);
      this.scheduleReconnect(s);
      return;
    }

    // Capture server capabilities for UI display + feature gating.
    const caps = (client.getServerCapabilities?.() ?? {}) as MCPServerCapabilities;
    s.capabilities = caps;
    s.lastError = undefined;

    // Initial fetch of every primitive the server advertises. All three are
    // gated by the server's declared capability set — a resource-only or
    // prompt-only server is legitimate and must not be marked degraded just
    // because tools/list isn't implemented.
    try {
      if (caps.tools) await this.refreshTools(s);
    } catch (err) {
      await this.disposeClient(s); // close before retry — see disposeClient docs
      this.markError(s, err);
      this.scheduleReconnect(s);
      return;
    }
    await Promise.allSettled([
      caps.resources ? this.refreshResources(s) : Promise.resolve(),
      caps.prompts ? this.refreshPrompts(s) : Promise.resolve(),
    ]);

    // Re-subscribe to anything that was subscribed before the reconnect,
    // and route resources/updated notifications back to event-bus consumers.
    if (caps.resources?.subscribe) {
      client.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        async (notif) => {
          if (generation !== s.generation) return;
          this.emit({ type: "resource_updated", server: s.config.name, uri: notif.params.uri });
        },
      );
      for (const uri of s.subscriptions) {
        try { await client.subscribeResource({ uri }); } catch { /* ignore */ }
      }
    }

    // Optional initial logging-level subscription. Quietly skip if the
    // server didn't advertise logging.
    if (caps.logging && s.config.loggingLevel) {
      try { await client.setLoggingLevel(s.config.loggingLevel); } catch { /* ignore */ }
    }

    s.reconnectAttempts = 0;
    s.connectedAt = new Date().toISOString();
    this.setStatus(s, "ready");
  }

  private async refreshTools(s: ManagedServer): Promise<void> {
    if (!s.client) return;
    const collected: MCPListedTool[] = [];
    let cursor: string | undefined;
    // Pagination loop. Most servers return everything in one shot; we still
    // honour nextCursor so a huge MCP server (>~1000 tools) doesn't get
    // truncated. -32601 (method not found) is treated as "no tools" — a
    // server can claim `tools` capability but still 404 on listTools if it
    // only ships tools/list_changed for some future tool set. Matches the
    // behaviour of fetchResources / fetchPrompts so the connect path stays
    // symmetric across primitives.
    for (let i = 0; i < 32; i++) {
      let res: Awaited<ReturnType<typeof s.client.listTools>>;
      try {
        res = await s.client.listTools(cursor ? { cursor } : undefined);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (msg.includes("-32601") || msg.includes("not found") || msg.includes("not supported")) {
          s.tools = [];
          this.emit({ type: "tools_changed", server: s.config.name, tools: s.tools });
          return;
        }
        throw err;
      }
      for (const t of res.tools ?? []) collected.push(t as MCPListedTool);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    const bridged: Tool[] = [];
    const skipped: string[] = [];
    for (const t of collected) {
      try {
        bridged.push(bridgeMCPTool(
          s.client!,
          s.config,
          t,
          { projectCwd: this.projectCwd },
        ));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push(`${t.name || "<empty>"} (${reason})`);
      }
    }
    if (skipped.length > 0) {
      const shown = skipped.slice(0, 3).join("; ");
      const suffix = skipped.length > 3 ? `; +${skipped.length - 3} more` : "";
      s.lastError = `Skipped ${skipped.length} MCP tool(s) with invalid definitions: ${shown}${suffix}`;
      this.emit({
        type: "log",
        server: s.config.name,
        level: "warning",
        message: s.lastError,
      });
    } else if (s.lastError?.startsWith("Skipped ") && s.lastError.includes("MCP tool")) {
      s.lastError = undefined;
    }
    s.tools = bridged;
    this.emit({ type: "tools_changed", server: s.config.name, tools: s.tools });
  }

  private async refreshResources(s: ManagedServer): Promise<void> {
    if (!s.client) return;
    const { resources, templates } = await fetchResources(s.client, s.config);
    s.resources = resources;
    s.resourceTemplates = templates;
    this.emit({ type: "resources_changed", server: s.config.name });
  }

  private async refreshPrompts(s: ManagedServer): Promise<void> {
    if (!s.client) return;
    s.prompts = await fetchPrompts(s.client, s.config);
    this.emit({ type: "prompts_changed", server: s.config.name });
  }

  // ── Reconnect / error helpers ──────────────────────────────────────────

  private scheduleReconnect(s: ManagedServer): void {
    if (s.status === "disconnected") return;
    if (s.reconnectAttempts >= DEFAULTS.maxReconnectAttempts) {
      this.setStatus(s, "error");
      return;
    }
    const delays = DEFAULTS.reconnectBackoffMs;
    const delay = delays[Math.min(s.reconnectAttempts, delays.length - 1)]!;
    s.reconnectAttempts++;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.reconnectTimer = setTimeout(() => {
      if (!this.servers.has(s.config.name)) return; // stopped while waiting
      void this.connect(s);
    }, delay);
  }

  private markError(s: ManagedServer, err: unknown): void {
    const wrapped = MCPError.wrap(err, s.config.name);
    s.lastError = wrapped.message;
    // Don't go straight to terminal `error` — let scheduleReconnect decide
    // based on attempt count. Surface as degraded for now.
    this.setStatus(s, "degraded");
  }

  /**
   * Tear down the current transport + client for a server WITHOUT removing
   * the ManagedServer entry (so subscriptions, status counters, and the
   * fingerprint survive). Used by:
   *   - the failure paths in connect() before scheduling a retry (stops
   *     stdio children / open sockets from piling up across attempts), and
   *   - manual reconnect() so the user can `/mcp reconnect` without losing
   *     subscriptions on the way through.
   * Bumps `s.generation` so any in-flight callbacks bound to the previous
   * transport/client identify themselves as stale and bail.
   */
  private async disposeClient(s: ManagedServer): Promise<void> {
    s.generation++;
    const client = s.client;
    const transport = s.transport;
    s.client = null;
    s.transport = null;
    if (transport) {
      // Detach handlers FIRST so the close fired by client.close() doesn't
      // trip the reconnect loop.
      transport.onclose = undefined;
      transport.onerror = undefined;
    }
    if (client) {
      try { await client.close(); } catch { /* swallow — server may already be gone */ }
    }
  }

  private setStatus(s: ManagedServer, status: MCPStatus): void {
    if (s.status === status) return;
    s.status = status;
    this.emit({ type: "status", server: s.config.name, status, error: s.lastError });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function pathToFileUri(p: string, baseCwd: string): string {
  // Minimal file:// URI converter — node's pathToFileURL would be cleaner
  // but pulls in node:url. For the cwd/roots use case "file://" + absolute
  // path with backslashes normalised is sufficient.
  const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolvePath(baseCwd, p);
  const norm = abs.replace(/\\/g, "/");
  return `file://${norm.startsWith("/") ? "" : "/"}${norm}`;
}

function fingerprint(c: MCPServerConfig): string {
  // Stable JSON of the fields that affect the running connection. Order of
  // properties matters for the equality check, so we sort.
  const stable = {
    transport: c.transport,
    command: c.command,
    args: c.args,
    env: c.env,
    envPassthrough: c.envPassthrough,
    cwd: c.cwd,
    url: c.url,
    headers: c.headers,
    oauth: c.oauth,
    connectTimeoutMs: c.connectTimeoutMs,
    callTimeoutMs: c.callTimeoutMs,
    autoApproveTools: c.autoApproveTools,
    allowSampling: c.allowSampling,
  };
  return JSON.stringify(sortKeys(stable));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortKeys((v as Record<string, unknown>)[k]);
  }
  return out;
}

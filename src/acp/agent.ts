import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import {
  agent, PROTOCOL_VERSION, RequestError, type AgentContext, type ClientCapabilities,
  type InitializeRequest, type InitializeResponse, type NewSessionRequest,
  type LoadSessionRequest, type ResumeSessionRequest, type ListSessionsRequest,
  type SessionConfigOption, type SessionUpdate, type PromptRequest, type PromptResponse,
  type McpServer, type ContentBlock,
} from "@agentclientprotocol/sdk"
import { getActiveProvider, hasApiKey, loadAppConfig, setActive, type AppConfig, type PermissionMode } from "../config.js"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import type { ImageContent } from "../../zapsdk/core/types.js"
import { VERSION } from "../version.js"
import { AcpSessionStore, workspacePath, type LoadedAcpSession, type AcpSession } from "./session-store.js"
import { AcpEventMapper, acpStopReason, toolKind } from "./events.js"
import { runAcpTurn, type AcpRunTurn } from "./runner.js"

const MODES = [
  { id: "default", name: "Ask permissions", description: "Request approval for sensitive operations" },
  { id: "plan", name: "Plan", description: "Read-only analysis; writes and execution are denied" },
  { id: "acceptEdits", name: "Accept edits", description: "Allow file edits; request approval for commands" },
]

export function loadAcpConfig(): AppConfig {
  const path = join(getAppDataDir(), "config.json")
  const config = loadAppConfig(path)
  if (existsSync(path)) return config
  // Environment bootstrap has timestamp IDs in the TUI. ACP needs a stable
  // binding across process restarts without writing provider credentials.
  return { ...config, providers: config.providers.map(provider => ({ ...provider,
    id: `env_${createHash("sha256").update(JSON.stringify([provider.baseURL, provider.protocol])).digest("hex")}` })),
    active: { ...config.active, providerId: config.providers[0]
      ? `env_${createHash("sha256").update(JSON.stringify([config.providers[0].baseURL, config.providers[0].protocol])).digest("hex")}` : "" } }
}

async function interruptible<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw RequestError.requestCancelled()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(RequestError.requestCancelled()) })
  signal.addEventListener("abort", abort, { once: true })
  try { return await Promise.race([request, cancelled]) }
  finally { signal.removeEventListener("abort", abort) }
}

export class ZapAcpAgent {
  private initialized = false
  private clientCapabilities: ClientCapabilities = {}
  private readonly sessions = new Map<string, LoadedAcpSession>()
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<unknown>; sendMode?: (mode: PermissionMode) => void }>()

  constructor(private readonly store = new AcpSessionStore(), private readonly runTurn: AcpRunTurn = runAcpTurn,
    private readonly readConfig: () => AppConfig = loadAcpConfig) {}

  initialize(params: InitializeRequest): InitializeResponse {
    if (this.initialized) throw RequestError.invalidRequest(null, "Already initialized")
    this.initialized = true
    this.clientCapabilities = params.clientCapabilities ?? {}
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "zapAgent", version: VERSION },
      authMethods: [{ id: "configured-provider", name: "Use local provider configuration",
        description: "Configure a provider with zap /connect or OPENAI_BASE_URL, OPENAI_API_KEY and MODEL, then retry" }],
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true, audio: false },
        mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } } }
  }

  authenticate(methodId: string): Record<string, never> {
    this.ready()
    if (methodId !== "configured-provider") throw RequestError.invalidParams(null, "Unknown authentication method")
    this.config()
    return {}
  }

  async newSession(params: NewSessionRequest) {
    this.ready()
    this.validateRoots(params.additionalDirectories)
    this.validateMcp(params.mcpServers ?? [])
    const cwd = await workspacePath(params.cwd)
    const config = this.config()
    const state = this.store.create(cwd, config.active.providerId, config.active.model)
    this.sessions.set(state.id, { state, mcpServers: params.mcpServers ?? [] })
    return { sessionId: state.id, ...this.sessionState(state) }
  }

  async loadSession(params: LoadSessionRequest | ResumeSessionRequest, client: AgentContext, replay: boolean) {
    this.ready()
    this.validateRoots(params.additionalDirectories)
    this.validateMcp(params.mcpServers ?? [])
    if (this.active.has(params.sessionId)) throw RequestError.invalidRequest(null, "Session is running")
    const state = await this.store.load(params.sessionId)
    if (await workspacePath(params.cwd) !== state.cwd) throw RequestError.invalidParams(null, "Session cwd mismatch")
    this.config(state)
    if (this.active.has(params.sessionId)) throw RequestError.invalidRequest(null, "Session is running")
    this.sessions.set(state.id, { state, mcpServers: params.mcpServers ?? [] })
    if (replay) for (const update of state.history) await client.notify("session/update", { sessionId: state.id, update })
    return this.sessionState(state)
  }

  async listSessions(params: ListSessionsRequest) {
    this.ready()
    const cwd = params.cwd ? await workspacePath(params.cwd) : undefined
    const all = (await this.store.list()).filter(session => !cwd || session.cwd === cwd)
    const offset = params.cursor ? all.findIndex(session => session.id === params.cursor) + 1 : 0
    if (params.cursor && offset === 0) throw RequestError.invalidParams(null, "Invalid cursor")
    const page = all.slice(offset, offset + 50)
    return { sessions: page.map(session => ({ sessionId: session.id, cwd: session.cwd,
      title: session.title, updatedAt: session.updatedAt })),
      nextCursor: offset + page.length < all.length ? page.at(-1)!.id : undefined }
  }

  async setMode(sessionId: string, modeId: string, client: AgentContext) {
    const state = this.session(sessionId).state
    if (!MODES.some(mode => mode.id === modeId)) throw RequestError.invalidParams(null, "Unknown session mode")
    state.mode = modeId as PermissionMode
    this.store.save(state)
    this.active.get(sessionId)?.sendMode?.(state.mode)
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeId } })
    return {}
  }

  async setConfig(sessionId: string, configId: string, value: string | boolean, client: AgentContext) {
    const state = this.session(sessionId).state
    if (configId === "mode" && typeof value === "string") await this.setMode(sessionId, value, client)
    else if (configId === "model" && typeof value === "string") {
      if (this.active.has(sessionId)) throw RequestError.invalidRequest(null, "Change model between turns")
      const config = this.readConfig()
      const selected = this.modelChoices(config).find(option => option.value === value)
      if (!selected) throw RequestError.invalidParams(null, "Unknown model binding")
      const [providerId, model] = JSON.parse(value) as [string, string]
      this.config({ ...state, providerId, model })
      state.providerId = providerId; state.model = model
      this.store.save(state)
    } else throw RequestError.invalidParams(null, "Unknown config option or value")
    const configOptions = this.options(state)
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "config_option_update", configOptions } })
    return { configOptions }
  }

  async prompt(params: PromptRequest, client: AgentContext, requestSignal: AbortSignal): Promise<PromptResponse> {
    const session = this.session(params.sessionId)
    if (this.active.has(params.sessionId)) throw RequestError.invalidRequest(null, "Session already has an active turn")
    const config = this.config(session.state)
    const controller = new AbortController()
    const abort = () => controller.abort()
    requestSignal.addEventListener("abort", abort, { once: true })
    if (requestSignal.aborted) abort()
    let resolveDone!: () => void
    const completion = new Promise<void>(resolve => { resolveDone = resolve })
    const active = { controller, completion, sendMode: undefined as ((mode: PermissionMode) => void) | undefined }
    this.active.set(params.sessionId, active)
    let updates: Promise<void> = Promise.resolve()
    const emit = (update: SessionUpdate) => {
      session.state.history.push(update)
      updates = updates.then(() => client.notify("session/update", { sessionId: session.state.id, update }))
      // Observe immediately: an async event producer cannot await the wire.
      void updates.catch(() => controller.abort())
    }
    try {
      const { text, images } = await this.content(params.prompt, session.state, client, controller.signal)
      if (controller.signal.aborted) return { stopReason: "cancelled" }
      if (!session.state.history.length) session.state.title = text.slice(0, 100) || "Image prompt"
      const messageId = randomUUID()
      for (const content of params.prompt) emit({ sessionUpdate: "user_message_chunk", messageId, content })
      this.store.save(session.state)
      const turnId = randomUUID()
      const mapper = new AcpEventMapper(turnId)
      const result = await this.runTurn({ signal: controller.signal,
        input: { cwd: session.state.cwd, prompt: text, images, config, mode: session.state.mode,
          runtimeSessionId: session.state.runtimeSessionId, mcpServers: session.mcpServers },
        onInit: id => { session.state.runtimeSessionId = id; this.store.save(session.state) },
        onEvent: event => { for (const update of mapper.map(event)) emit(update) },
        onModeTransport: send => { active.sendMode = send; send(session.state.mode) },
        onApproval: async request => {
          if (controller.signal.aborted) return false
          const approval = client.request("session/request_permission", { sessionId: session.state.id,
            toolCall: { toolCallId: `${turnId}:${request.toolCallId}`, title: request.name === "bash" && request.args.dangerouslyDisableSandbox === true
                ? "bash (outside the OS sandbox)" : request.name,
              kind: toolKind(request.name), status: "pending", rawInput: request.args },
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" }] })
          // Cancellation must settle even if a broken client never replies.
          try {
            const response = await interruptible(approval, controller.signal)
            return !controller.signal.aborted && response?.outcome.outcome === "selected"
              && response.outcome.optionId === "allow-once"
          } catch { return false }
        },
      })
      if (result.sessionId) session.state.runtimeSessionId = result.sessionId
      await updates
      return { stopReason: result.outcome ? acpStopReason(result.outcome.execution.stopReason) : controller.signal.aborted ? "cancelled" : acpStopReason(result.stopReason),
        ...(result.outcome ? { _meta: { "zap.outcome": result.outcome } } : {}) }
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: "cancelled" }
      if (error instanceof RequestError) throw error
      process.stderr.write(`[acp] ${error instanceof Error ? error.message : "Run failed"}\n`)
      throw RequestError.internalError(null, "Agent run failed; see stderr diagnostics")
    } finally {
      requestSignal.removeEventListener("abort", abort)
      this.active.delete(params.sessionId)
      resolveDone()
      this.store.save(session.state)
    }
  }

  cancel(sessionId: string): void { this.active.get(sessionId)?.controller.abort() }

  async closeSession(sessionId: string): Promise<Record<string, never>> {
    this.session(sessionId)
    const active = this.active.get(sessionId)
    active?.controller.abort()
    await active?.completion
    this.sessions.delete(sessionId)
    return {}
  }

  async dispose(): Promise<void> {
    const running = [...this.active.values()]
    for (const turn of running) turn.controller.abort()
    await Promise.allSettled(running.map(turn => turn.completion))
    this.sessions.clear()
  }

  private ready(): void { if (!this.initialized) throw RequestError.invalidRequest(null, "Initialize first") }
  private session(id: string): LoadedAcpSession {
    this.ready()
    const session = this.sessions.get(id)
    if (!session) throw RequestError.resourceNotFound(id)
    return session
  }
  private config(state?: AcpSession): AppConfig {
    let config = this.readConfig()
    if (state) {
      if (!config.providers.some(provider => provider.id === state.providerId)) throw RequestError.authRequired(null, "Session provider is no longer configured")
      config = setActive(config, state.providerId, state.model)
    }
    if (!getActiveProvider(config) || !hasApiKey(config) || !config.active.model) throw RequestError.authRequired(null, "Configure a provider and model with zap /connect")
    return config
  }
  private modelChoices(config: AppConfig) {
    return config.providers.flatMap(provider => [...new Set([...provider.models,
      ...(provider.id === config.active.providerId ? [config.active.model] : [])])].filter(Boolean)
      .map(model => ({ value: JSON.stringify([provider.id, model]), name: `${provider.name || provider.id} / ${model}` })))
  }
  private options(state: AcpSession): SessionConfigOption[] {
    return [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode,
      options: MODES.map(mode => ({ value: mode.id, name: mode.name })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: JSON.stringify([state.providerId, state.model]),
      options: this.modelChoices(this.readConfig()) }]
  }
  private sessionState(state: AcpSession) {
    return { modes: { currentModeId: state.mode, availableModes: MODES }, configOptions: this.options(state) }
  }
  private validateRoots(roots?: string[]): void {
    if (roots?.length) throw RequestError.invalidParams(null, "Additional directories are not supported")
  }
  private validateMcp(servers: McpServer[]): void {
    const names = new Set<string>()
    for (const server of servers) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(server.name) || server.name.includes("__") || names.has(server.name)) throw RequestError.invalidParams(null, "Invalid or duplicate MCP name")
      names.add(server.name)
      if ("type" in server) {
        if (server.type !== "http" && server.type !== "sse") throw RequestError.invalidParams(null, "Unsupported MCP transport")
        let url: URL
        try { url = new URL(server.url) } catch { throw RequestError.invalidParams(null, "Invalid MCP URL") }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw RequestError.invalidParams(null, "Invalid MCP URL")
      } else if (!isAbsolute(server.command)) throw RequestError.invalidParams(null, "MCP executable must be absolute")
    }
  }
  private async content(blocks: ContentBlock[], state: AcpSession, client: AgentContext, signal: AbortSignal) {
    const texts: string[] = []
    const images: ImageContent[] = []
    if (!blocks.length) throw RequestError.invalidParams(null, "Prompt is empty")
    for (const block of blocks) {
      if (block.type === "text") texts.push(block.text)
      else if (block.type === "resource_link") {
        texts.push(`[Resource: ${block.name}] ${block.uri}`)
        if (block.uri.startsWith("file:") && this.clientCapabilities.fs?.readTextFile) {
          let path: string
          try { path = fileURLToPath(block.uri) } catch { throw RequestError.invalidParams(null, "Invalid resource URI") }
          // Resolve existing symlinks, but allow unsaved files whose parent
          // exists. macOS /tmp and /private/tmp are the same workspace.
          let canonical: string
          try { canonical = await realpath(path) }
          catch {
            try { canonical = join(await realpath(dirname(path)), basename(path)) }
            catch { throw RequestError.invalidParams(null, "Resource parent directory unavailable") }
          }
          const rel = relative(state.cwd, canonical)
          if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw RequestError.invalidParams(null, "Resource outside session cwd")
          const result = await interruptible(client.request("fs/read_text_file", { sessionId: state.id, path }), signal)
          texts.push(result.content)
        }
      } else if (block.type === "resource" && "text" in block.resource) texts.push(`[Resource: ${block.resource.uri}]\n${block.resource.text}`)
      else if (block.type === "image") {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType) || block.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw RequestError.invalidParams(null, "Invalid or oversized image")
        const dir = join(this.store.root, state.id, "images")
        await mkdir(dir, { recursive: true })
        const path = join(dir, `${randomUUID()}.${block.mimeType.split("/")[1]}`)
        await writeFile(path, Buffer.from(block.data, "base64"), { mode: 0o600, flag: "wx" })
        images.push({ type: "image", filePath: path, base64: block.data, mediaType: block.mimeType, source: "ACP image" })
      } else throw RequestError.invalidParams(null, "Unsupported prompt content type")
    }
    const text = texts.join("\n\n")
    if (!text.trim() && !images.length) throw RequestError.invalidParams(null, "Prompt is empty")
    return { text, images }
  }
}

export function createAcpApp(server: ZapAcpAgent) {
  return agent({ name: "zapAgent" })
    .onRequest("initialize", ({ params }) => server.initialize(params))
    .onRequest("authenticate", ({ params }) => server.authenticate(params.methodId))
    .onRequest("session/new", ({ params }) => server.newSession(params))
    .onRequest("session/load", ({ params, client }) => server.loadSession(params, client, true))
    .onRequest("session/resume", ({ params, client }) => server.loadSession(params, client, false))
    .onRequest("session/list", ({ params }) => server.listSessions(params))
    .onRequest("session/close", ({ params }) => server.closeSession(params.sessionId))
    .onRequest("session/set_mode", ({ params, client }) => server.setMode(params.sessionId, params.modeId, client))
    .onRequest("session/set_config_option", ({ params, client }) => server.setConfig(params.sessionId, params.configId, params.value, client))
    .onRequest("session/prompt", ({ params, client, signal }) => server.prompt(params, client, signal))
    .onNotification("session/cancel", ({ params }) => server.cancel(params.sessionId))
}

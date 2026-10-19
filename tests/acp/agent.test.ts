import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { client, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { createAcpApp, ZapAcpAgent } from "../../src/acp/agent.js"
import { AcpSessionStore } from "../../src/acp/session-store.js"
import type { AcpRunTurn } from "../../src/acp/runner.js"

const finish = (sessionId = randomUUID()) => ({ ok: true, text: "done", sessionId, turns: 1,
  usage: { inputTokens: 10, outputTokens: 2 }, toolCalls: [], stopReason: "end_turn" as const })

async function fixture(runTurn: AcpRunTurn, permission: "allow-once" | "reject-once" | "hang" = "allow-once") {
  const root = await mkdtemp(join(tmpdir(), "zap-acp-test-"))
  const cwd = join(root, "workspace")
  await mkdir(cwd)
  const provider = createCustomProvider({ name: "Test", baseURL: "http://localhost:1234/v1",
    apiKey: "private-secret", models: ["model-a", "model-b"], contextWindow: 128000 })
  const config = { ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "model-a" } }
  const store = new AcpSessionStore(join(root, "sessions"))
  const server = new ZapAcpAgent(store, runTurn, () => config)
  const updates: SessionNotification[] = []
  const app = client({ name: "test-client" })
    .onNotification("session/update", ({ params }) => { updates.push(params) })
    .onRequest("session/request_permission", () => permission === "hang" ? new Promise<never>(() => {})
      : ({ outcome: { outcome: "selected", optionId: permission } }))
    .onRequest("fs/read_text_file", () => ({ content: "unsaved editor text" }))
  const connection = app.connect(createAcpApp(server))
  const initialize = () => connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true } } })
  const cleanup = async () => { connection.close(); await server.dispose(); await rm(root, { recursive: true, force: true }) }
  return { root, cwd, store, config, server, updates, connection, initialize, cleanup }
}

describe("ACP Agent contract through the official SDK", () => {
  it("cancels a turn even when the client never answers its permission dialog", async () => {
    let ready!: () => void
    const waiting = new Promise<void>(resolve => { ready = resolve })
    const f = await fixture(async turn => {
      const approval = turn.onApproval({ name: "write_file", args: {}, toolCallId: ":pending" })
      ready()
      expect(await approval).toBe(false)
      return finish()
    }, "hang")
    try {
      await f.initialize()
      const { sessionId } = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      const prompt = f.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write" }] })
      await waiting
      await f.connection.agent.notify("session/cancel", { sessionId })
      expect(await prompt).toEqual({ stopReason: "cancelled" })
    } finally { await f.cleanup() }
  })

  it("keeps a sealed outcome authoritative when cancellation arrives before response delivery", async () => {
    const outcome = {
      schema: "zap.outcome" as const, schemaVersion: 1 as const, threadId: "t", turnId: "turn", runId: "run", attemptId: "run", startedAt: 1, endedAt: 2,
      execution: { attemptId: "run", status: "finished" as const, stopReason: "end_turn" as const, finalResponse: "done", unresolvedActions: [],
        services: [{ version: 1 as const, backendId: "owner-backend", ownerId: "owner", ownerGeneration: "g1", workspaceId: "w", ownerScope: "environment" as const,
          operationId: "op", serviceId: "service", requestDigest: "a".repeat(64), state: "running" as const, observedAt: 1, expiresAt: 100 }],
        serviceOperations: [{ version: 1 as const, executionId: "execution:op", kind: "start" as const, backendId: "owner-backend", ownerId: "owner", ownerGeneration: "g1", workspaceId: "w", ownerScope: "environment" as const,
          operationId: "op", state: "observed" as const, observedAt: 1 }] },
      acceptance: { attemptId: "run", status: "unverified" as const, code: "UNVERIFIED", checks: [] },
      workflow: { attemptId: "run", status: "not_requested" as const, controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" },
    }
    let ready!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(async () => { ready(); await gate; return { ...finish(), outcome } })
    try {
      await f.initialize()
      const { sessionId } = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      const prompt = f.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "finish" }] })
      await started
      f.server.cancel(sessionId)
      release()
      expect(await prompt).toEqual({ stopReason: "end_turn", _meta: { "zap.outcome": outcome } })
    } finally { release(); await f.cleanup() }
  })

  it("rejects an unauthenticated model change without corrupting the previous binding", async () => {
    const f = await fixture(async () => finish())
    try {
      await f.initialize()
      const { sessionId } = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      const missing = createCustomProvider({ name: "Missing key", baseURL: "https://example.com/v1", apiKey: "",
        models: ["missing-model"], contextWindow: 128000 })
      missing.id = `missing-${randomUUID()}`
      f.config.providers.push(missing)
      await expect(f.connection.agent.request("session/set_config_option", { sessionId, configId: "model",
        value: JSON.stringify([missing.id, "missing-model"]) })).rejects.toThrow()
      expect((await f.store.load(sessionId)).model).toBe("model-a")
      expect(await f.connection.agent.request("session/prompt", { sessionId,
        prompt: [{ type: "text", text: "still works" }] })).toEqual({ stopReason: "end_turn" })
    } finally { await f.cleanup() }
  })

  it("negotiates capabilities, creates/lists/loads/resumes sessions and preserves history/binding", async () => {
    const seen: string[] = []
    const f = await fixture(async turn => {
      seen.push(turn.input.config.active.model)
      turn.onInit(randomUUID())
      turn.onEvent({ type: "content_delta", kind: "text", id: "text-1", text: "done" })
      turn.onEvent({ type: "content_final", kind: "text", id: "text-1", text: "done" })
      return finish()
    })
    try {
      const info = await f.initialize()
      expect(info.agentCapabilities?.loadSession).toBe(true)
      expect(info.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
      const session = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      const selected = JSON.stringify([f.config.active.providerId, "model-b"])
      await f.connection.agent.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: selected })
      expect(await f.connection.agent.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })).toEqual({ stopReason: "end_turn" })
      expect(seen).toEqual(["model-b"])
      expect(f.updates.filter(item => item.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1)
      const listed = await f.connection.agent.request("session/list", { cwd: f.cwd })
      expect(listed.sessions[0]?.sessionId).toBe(session.sessionId)
      const raw = await readFile(join(f.store.root, `${session.sessionId}.json`), "utf8")
      expect(raw).not.toContain("private-secret")
      await f.connection.agent.request("session/close", { sessionId: session.sessionId })
      f.updates.length = 0
      await f.connection.agent.request("session/resume", { sessionId: session.sessionId, cwd: f.cwd })
      expect(f.updates).toHaveLength(0)
      await f.connection.agent.request("session/load", { sessionId: session.sessionId, cwd: f.cwd, mcpServers: [] })
      expect(f.updates.map(item => item.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"])
    } finally { await f.cleanup() }
  })

  it("loads a persisted session through a fresh Agent instance", async () => {
    const f = await fixture(async () => finish())
    try {
      await f.initialize()
      const session = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      const fresh = new ZapAcpAgent(f.store, async () => finish(), () => f.config)
      const conn = client({ name: "fresh-client" }).onNotification("session/update", () => {}).connect(createAcpApp(fresh))
      try {
        await conn.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION })
        await conn.agent.request("session/resume", { sessionId: session.sessionId, cwd: f.cwd })
        expect(await conn.agent.request("session/prompt", { sessionId: session.sessionId,
          prompt: [{ type: "text", text: "continued" }] })).toEqual({ stopReason: "end_turn" })
      } finally { conn.close(); await fresh.dispose() }
    } finally { await f.cleanup() }
  })

  it("routes approval decisions without treating unknown options as grants", async () => {
    let granted = true
    const f = await fixture(async turn => {
      granted = await turn.onApproval({ name: "write_file", args: { path: join(turn.input.cwd, "file") }, toolCallId: ":call-1" })
      return finish()
    }, "reject-once")
    try {
      await f.initialize()
      const { sessionId } = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      await f.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write" }] })
      expect(granted).toBe(false)
    } finally { await f.cleanup() }
  })

  it("cancels one session, rejects overlapping prompts, and permits mode changes while running", async () => {
    let start!: () => void
    const running = new Promise<void>(resolve => { start = resolve })
    const modes: string[] = []
    const f = await fixture(async turn => {
      turn.onModeTransport(mode => modes.push(mode))
      start()
      await new Promise<void>(resolve => turn.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { ...finish(), stopReason: "aborted" }
    })
    try {
      await f.initialize()
      const { sessionId } = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      const prompt = f.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "wait" }] })
      await running
      await expect(f.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "overlap" }] })).rejects.toThrow()
      await f.connection.agent.request("session/set_mode", { sessionId, modeId: "plan" })
      await f.connection.agent.notify("session/cancel", { sessionId })
      expect(await prompt).toEqual({ stopReason: "cancelled" })
      expect(modes).toEqual(["default", "plan"])
    } finally { await f.cleanup() }
  })

  it("supports embedded text and unsaved client resources while rejecting unsupported content and cwd mismatch", async () => {
    let text = ""
    const f = await fixture(async turn => { text = turn.input.prompt; return finish() })
    try {
      await f.initialize()
      await expect(f.connection.agent.request("session/new", { cwd: "relative", mcpServers: [] })).rejects.toThrow()
      const { sessionId } = await f.connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] })
      await f.connection.agent.request("session/prompt", { sessionId, prompt: [
        { type: "resource_link", name: "buffer", uri: `file://${f.cwd}/buffer.ts` },
        { type: "resource", resource: { uri: "memory:note", text: "inline text" } },
      ] })
      expect(text).toContain("unsaved editor text")
      expect(text).toContain("inline text")
      await expect(f.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "audio", data: "AA==", mimeType: "audio/wav" }] })).rejects.toThrow()
      await expect(f.connection.agent.request("session/load", { sessionId, cwd: f.root, mcpServers: [] })).rejects.toThrow()
      await expect(f.connection.agent.request("session/load", { sessionId: "../../escape", cwd: f.cwd, mcpServers: [] })).rejects.toThrow()
    } finally { await f.cleanup() }
  })
})

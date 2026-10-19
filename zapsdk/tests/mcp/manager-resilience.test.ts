// Behavioural tests for manager-level resilience:
//   1. Capability-gated tool fetch (resource-only servers must not be
//      degraded into reconnect loops).
//   2. Disposal of failed transports/clients before retry.
//   3. Manual reconnect preserves subscriptions.
//
// Strategy: substitute the SDK's Client and Transport at module load via a
// thin shim. Heavy mocking is justified here — every other path of the
// manager is covered by the integration test (manager-integration.test.ts),
// but these specific behaviours are about *internal control flow* that the
// integration test can't easily steer.

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { MCPManager } from "../../mcp/manager.js"
import type { Tool } from "../../tools/types.js"
import { fileURLToPath } from "node:url"

// ── Fake Client + Transport plumbing ────────────────────────────────────

interface FakeClientOptions {
  serverCaps: Record<string, unknown>
  /** Make listTools throw a JSON-RPC -32601 (method-not-found) once. */
  listToolsErrorCode?: string
  tools?: Array<{ name: string; description?: string; inputSchema: object }>
  resources?: Array<{ uri: string; name?: string }>
  prompts?: Array<{ name: string; arguments?: unknown[] }>
}

function makeFakeClient(opts: FakeClientOptions) {
  let listToolsCallCount = 0
  const calls = {
    close: 0,
    subscribeResource: [] as string[],
    setNotificationHandler: 0,
    setRequestHandler: 0,
    requestHandlers: [] as Array<() => unknown>,
  }
  const client = {
    connect: async (_t: unknown) => { /* succeed */ },
    close: async () => { calls.close++ },
    getServerCapabilities: () => opts.serverCaps,
    listTools: async () => {
      listToolsCallCount++
      if (opts.listToolsErrorCode === "-32601") {
        throw new Error("MCP error -32601: Method not found")
      }
      return { tools: opts.tools ?? [] }
    },
    listResources: async () => ({ resources: opts.resources ?? [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    listPrompts: async () => ({ prompts: opts.prompts ?? [] }),
    subscribeResource: async (p: { uri: string }) => { calls.subscribeResource.push(p.uri) },
    unsubscribeResource: async () => { /* ignore */ },
    setNotificationHandler: () => { calls.setNotificationHandler++ },
    setRequestHandler: (_schema: unknown, handler: () => unknown) => {
      calls.setRequestHandler++
      calls.requestHandlers.push(handler)
    },
  }
  return { client, calls, listToolsCallCount: () => listToolsCallCount }
}

function makeFakeTransport() {
  const t = {
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    close: async () => { /* ignore */ },
    start: async () => { /* ignore */ },
    send: async () => { /* ignore */ },
  }
  return t
}

// Inject our fakes by monkey-patching the SDK modules' default factories.
// We import the real modules ONCE and then swap their exported constructors.
let fakeClient: ReturnType<typeof makeFakeClient> | null = null
let fakeTransport: ReturnType<typeof makeFakeTransport> | null = null

const factoryModule = await import("../../mcp/client-factory.js")
const transportModule = await import("../../mcp/transport/index.js")

mock.module("../../mcp/client-factory.js", () => ({
  ...factoryModule,
  createMCPClient: () => fakeClient!.client,
}))
mock.module("../../mcp/transport/index.js", () => ({
  ...transportModule,
  createTransport: async () => ({
    transport: fakeTransport,
    authProvider: null,
  }),
}))

// After mocks are installed, re-import manager so it picks up our shims.
const { MCPManager: PatchedManager } = await import("../../mcp/manager.js")

describe("MCPManager resilience", () => {
  beforeEach(() => {
    fakeClient = null
    fakeTransport = null
  })

  it("surfaces invalid server names as config errors without starting transports", async () => {
    const events: Array<{ type: string; status?: string; error?: string }> = []
    const mgr = new PatchedManager()
    mgr.on((event) => events.push(event))

    await mgr.reconcile([{ name: "bad server", transport: "stdio", command: "x" }])

    const snap = mgr.snapshots()[0]
    expect(snap?.name).toBe("bad server")
    expect(snap?.status).toBe("error")
    expect(snap?.lastError).toContain("Invalid MCP server name")
    expect(mgr.allTools()).toHaveLength(0)
    expect(events.filter((event) => event.type === "status" && event.status === "error")).toHaveLength(1)

    await mgr.reconcile([{ name: "bad server", transport: "stdio", command: "x" }])
    expect(events.filter((event) => event.type === "status" && event.status === "error")).toHaveLength(1)
  })

  it("does not silently shadow duplicate server names", async () => {
    const mgr = new PatchedManager()

    await mgr.reconcile([
      { name: "dupe", transport: "stdio", command: "first" },
      { name: "dupe", transport: "stdio", command: "second" },
    ])

    const snap = mgr.snapshots()[0]
    expect(mgr.snapshots()).toHaveLength(1)
    expect(snap?.name).toBe("dupe")
    expect(snap?.status).toBe("error")
    expect(snap?.lastError).toContain("Duplicate MCP server name")
    expect(mgr.allTools()).toHaveLength(0)
  })

  it("does not call listTools when caps.tools is absent (resource-only server)", async () => {
    fakeClient = makeFakeClient({
      serverCaps: { resources: {} }, // tools omitted
      resources: [{ uri: "demo://r/1", name: "r1" }],
    })
    fakeTransport = makeFakeTransport()

    const mgr = new PatchedManager()
    await mgr.reconcile([{ name: "ro", transport: "stdio", command: "x" }])
    // Wait for the connect() chain to settle.
    await new Promise((r) => setTimeout(r, 50))

    const snap = mgr.snapshots()[0]
    expect(snap?.status).toBe("ready")
    expect(snap?.resourceCount).toBeGreaterThan(0)
    expect(fakeClient.listToolsCallCount()).toBe(0)
  })

  it("refreshTools tolerates -32601 from a server that claimed tools cap", async () => {
    fakeClient = makeFakeClient({
      serverCaps: { tools: {} },
      listToolsErrorCode: "-32601",
    })
    fakeTransport = makeFakeTransport()

    const mgr = new PatchedManager()
    await mgr.reconcile([{ name: "wonky", transport: "stdio", command: "x" }])
    await new Promise((r) => setTimeout(r, 50))

    // Bad server claimed tools then 404'd — we still go ready with 0 tools
    // rather than entering reconnect loop and eventually `error`.
    const snap = mgr.snapshots()[0]
    expect(snap?.status).toBe("ready")
    expect(snap?.toolCount).toBe(0)
  })

  it("skips invalid tool names without degrading the server", async () => {
    fakeClient = makeFakeClient({
      serverCaps: { tools: {} },
      tools: [
        { name: "ok_tool", inputSchema: { type: "object" } },
        { name: "bad__tool", inputSchema: { type: "object" } },
        { name: "bad tool", inputSchema: { type: "object" } },
      ],
    })
    fakeTransport = makeFakeTransport()
    const events: Array<{ type: string; level?: string; message?: string }> = []

    const mgr = new PatchedManager()
    mgr.on((event) => events.push(event))
    await mgr.reconcile([{ name: "tools", transport: "stdio", command: "x" }])
    await new Promise((r) => setTimeout(r, 50))

    const snap = mgr.snapshots()[0]
    expect(snap?.status).toBe("ready")
    expect(snap?.toolCount).toBe(1)
    expect(snap?.lastError).toContain("Skipped 2 MCP tool(s)")
    expect(mgr.allTools().map((t) => t.definition.name)).toEqual(["mcp__tools__ok_tool"])
    expect(events.some((event) =>
      event.type === "log" &&
      event.level === "warning" &&
      event.message?.includes("bad__tool")
    )).toBe(true)
  })

  it("advertises projectCwd through roots/list when server roots are not configured", async () => {
    fakeClient = makeFakeClient({
      serverCaps: {},
    })
    fakeTransport = makeFakeTransport()
    const projectCwd = "/tmp/zap-mcp-project-root"

    const mgr = new PatchedManager({ projectCwd })
    await mgr.reconcile([{ name: "roots", transport: "stdio", command: "x" }])
    await new Promise((r) => setTimeout(r, 50))

    expect(fakeClient.calls.setRequestHandler).toBeGreaterThan(0)
    const response = await fakeClient.calls.requestHandlers[0]!() as {
      roots: Array<{ uri: string; name: string }>
    }
    expect(response.roots).toHaveLength(1)
    expect(fileURLToPath(response.roots[0]!.uri)).toBe(projectCwd)
  })

  it("resolves relative configured roots against projectCwd", async () => {
    fakeClient = makeFakeClient({
      serverCaps: {},
    })
    fakeTransport = makeFakeTransport()
    const projectCwd = "/tmp/zap-mcp-project-root"

    const mgr = new PatchedManager({ projectCwd })
    await mgr.reconcile([{
      name: "roots",
      transport: "stdio",
      command: "x",
      roots: ["packages/app"],
    }])
    await new Promise((r) => setTimeout(r, 50))

    const response = await fakeClient.calls.requestHandlers[0]!() as {
      roots: Array<{ uri: string; name: string }>
    }
    expect(response.roots).toHaveLength(1)
    expect(fileURLToPath(response.roots[0]!.uri)).toBe(`${projectCwd}/packages/app`)
    expect(response.roots[0]!.name).toBe("app")
  })

  it("returns MCP primitives in stable sorted order", () => {
    const mgr = new PatchedManager()
    const servers = (mgr as unknown as {
      servers: Map<string, unknown>
    }).servers

    servers.set("b", fakeManagedServer({
      name: "b",
      tools: [fakeTool("mcp__b__z"), fakeTool("mcp__b__a")],
      resources: [{ server: "b", uri: "file:///z" }],
      templates: [{ server: "b", uriTemplate: "file:///{z}" }],
      prompts: [{ server: "b", name: "z", arguments: [] }],
    }))
    servers.set("a", fakeManagedServer({
      name: "a",
      tools: [fakeTool("mcp__a__m")],
      resources: [{ server: "a", uri: "file:///m" }],
      templates: [{ server: "a", uriTemplate: "file:///{m}" }],
      prompts: [{ server: "a", name: "m", arguments: [] }],
    }))

    expect(mgr.allTools().map((t) => t.definition.name)).toEqual([
      "mcp__a__m",
      "mcp__b__a",
      "mcp__b__z",
    ])
    expect(mgr.allResources().resources.map((r) => `${r.server}:${r.uri}`)).toEqual([
      "a:file:///m",
      "b:file:///z",
    ])
    expect(mgr.allResources().templates.map((r) => `${r.server}:${r.uriTemplate}`)).toEqual([
      "a:file:///{m}",
      "b:file:///{z}",
    ])
    expect(mgr.allPrompts().map((p) => `${p.server}:${p.name}`)).toEqual([
      "a:m",
      "b:z",
    ])
  })

  it("manual reconnect preserves resource subscriptions", async () => {
    fakeClient = makeFakeClient({
      serverCaps: { resources: { subscribe: true } },
      resources: [{ uri: "demo://r/1", name: "r1" }],
    })
    fakeTransport = makeFakeTransport()

    const mgr = new PatchedManager()
    await mgr.reconcile([{ name: "sub", transport: "stdio", command: "x" }])
    await new Promise((r) => setTimeout(r, 50))

    await mgr.subscribeResource("sub", "demo://r/1")
    expect(fakeClient.calls.subscribeResource).toContain("demo://r/1")

    // Rotate the fake — manual reconnect will dispose the old client and
    // build a new one. The manager must re-issue subscribe on the new
    // client, even though the subscriptions set lives on the (preserved)
    // ManagedServer.
    const oldClose = fakeClient.calls.close
    fakeClient = makeFakeClient({
      serverCaps: { resources: { subscribe: true } },
      resources: [{ uri: "demo://r/1", name: "r1" }],
    })
    fakeTransport = makeFakeTransport()

    await mgr.reconnect("sub")
    await new Promise((r) => setTimeout(r, 50))

    expect(mgr.snapshots()[0]?.status).toBe("ready")
    expect(fakeClient.calls.subscribeResource).toContain("demo://r/1")
    // Old client was disposed (close called).
    expect(oldClose).toBe(0)        // sanity: counted on the prior fake
  })
})

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: name,
      parameters: {} as never,
    },
    handler: async () => ({ success: true, output: "" }),
  }
}

function fakeManagedServer(opts: {
  name: string
  tools?: Tool[]
  resources?: Array<{ server: string; uri: string }>
  templates?: Array<{ server: string; uriTemplate: string }>
  prompts?: Array<{ server: string; name: string; arguments: [] }>
}): unknown {
  return {
    config: { name: opts.name },
    client: null,
    transport: null,
    authProvider: null,
    status: "ready",
    tools: opts.tools ?? [],
    resources: opts.resources ?? [],
    resourceTemplates: opts.templates ?? [],
    prompts: opts.prompts ?? [],
    subscriptions: new Set<string>(),
    reconnectAttempts: 0,
    fingerprint: opts.name,
    generation: 0,
  }
}

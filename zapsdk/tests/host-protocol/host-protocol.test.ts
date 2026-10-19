import { afterEach, describe, expect, it } from "bun:test";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createScriptedProvider, scriptedTextResponse } from "../../testing/scripted-provider.js";
import { createAgentRuntime } from "../../runtime/factory.js";
import { InMemoryRuntimeEventStore } from "../../runtime/event-store.js";
import { AppServer } from "../../host-protocol/app-server.js";
import { HostProtocolService, HostRuntimeRegistry } from "../../host-protocol/service.js";
import { SessionHostRuntime } from "../../host-protocol/session-runtime.js";
import type { AgentRuntime } from "../../runtime/agent-runtime.js";

const servers: AppServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function runtime(threadId = "host-thread"): AgentRuntime {
  const scripted = createScriptedProvider({
    transport: "call",
    turns: [scriptedTextResponse("host result")],
  });
  const registry = new ToolRegistry();
  return createAgentRuntime({
    threadId,
    workspace: { root: process.cwd() },
    loopAgent: {
      provider: scripted.provider,
      registry,
      executor: new ToolExecutor(registry),
      maxSteps: 1,
    },
    subagent: false,
    eventStore: new InMemoryRuntimeEventStore(),
  });
}

function blockingRuntime(threadId = "host-thread"): AgentRuntime {
  const scripted = createScriptedProvider({
    transport: "call",
    turns: [async () => new Promise(() => {})],
  });
  const registry = new ToolRegistry();
  return createAgentRuntime({
    threadId,
    workspace: { root: process.cwd() },
    loopAgent: {
      provider: scripted.provider,
      registry,
      executor: new ToolExecutor(registry),
      maxSteps: 1,
    },
    subagent: false,
    eventStore: new InMemoryRuntimeEventStore(),
  });
}

function request(method: string, params?: Record<string, unknown>) {
  return { version: 1, id: `request-${method}`, method, threadId: "host-thread", params };
}

describe("HostProtocolService", () => {
  it("keeps a TUI thread registered while idle and attaches each turn Runtime", async () => {
    const registry = new HostRuntimeRegistry();
    const stableStore = new InMemoryRuntimeEventStore();
    let session!: SessionHostRuntime;
    session = new SessionHostRuntime({
      threadId: "host-thread",
      eventStore: stableStore,
      runTurn: async (input, options) => {
        const target = runtime();
        const detach = await session.attach(target);
        try {
          return await target.run(input, options);
        } finally {
          detach();
        }
      },
    });
    registry.register(session);
    const service = new HostProtocolService(registry);

    expect(await service.handle(request("thread.snapshot")))
      .toMatchObject({ ok: true, result: { threadId: "host-thread", status: "idle" } });
    expect(await service.handle(request("thread.run", { input: "hello" })))
      .toMatchObject({ ok: true, result: { text: "host result" } });
    expect(await service.handle(request("thread.snapshot")))
      .toMatchObject({ ok: true, result: { threadId: "host-thread", status: "idle" } });

    await session.close();
  });

  it("runs a turn and exposes cursor-paged events through one Runtime", async () => {
    const registry = new HostRuntimeRegistry();
    const target = runtime();
    registry.register(target);
    const service = new HostProtocolService(registry);

    const run = await service.handle(request("thread.run", { input: "hello" }));
    const page = await service.handle(request("thread.events", { limit: 2, direction: "backward" }));

    expect(run).toMatchObject({ ok: true, result: { text: "host result" } });
    expect(page).toMatchObject({
      ok: true,
      result: { items: [{}, {}], hasMoreBefore: true, hasMoreAfter: false },
    });
  });

  it("validates protocol version, methods, and registered thread identity", async () => {
    const registry = new HostRuntimeRegistry();
    registry.register(runtime());
    const service = new HostProtocolService(registry);

    expect(await service.handle({ ...request("thread.snapshot"), version: 9 }))
      .toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } });
    expect(await service.handle(request("unknown")))
      .toMatchObject({ ok: false, error: { code: "METHOD_NOT_FOUND" } });
    expect(await service.handle({ ...request("thread.snapshot"), threadId: "missing" }))
      .toMatchObject({ ok: false, error: { code: "THREAD_NOT_FOUND" } });
    expect(await service.handle(request("thread.events", { afterSequence: -1 })))
      .toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await service.handle(request("thread.events", { direction: "sideways" })))
      .toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await service.handle(request("thread.events", { afterSequence: 1, beforeSequence: 3 })))
      .toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  });

  it("replays persisted events before delivering live events without duplicates", async () => {
    const registry = new HostRuntimeRegistry();
    const target = runtime();
    registry.register(target);
    await target.run("hello");
    const service = new HostProtocolService(registry);
    const sequences: number[] = [];

    const unsubscribe = await service.subscribe("host-thread", 0, (event) => sequences.push(event.sequence));
    unsubscribe();

    expect(sequences.length).toBeGreaterThan(2);
    expect(sequences).toEqual([...new Set(sequences)]);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("cancels a turn that started outside HostProtocol", async () => {
    const registry = new HostRuntimeRegistry();
    const target = blockingRuntime();
    registry.register(target);
    const service = new HostProtocolService(registry);
    const running = target.run("started by TUI");
    while (target.threadSnapshot().status !== "running") await Promise.resolve();

    expect(await service.handle(request("thread.cancel", { reason: "remote stop" })))
      .toMatchObject({ ok: true, result: { cancelled: true } });
    await expect(running).rejects.toThrow("aborted");
  });
});

describe("AppServer", () => {
  it("requires bearer auth and serves RPC plus SSE replay on loopback", async () => {
    const registry = new HostRuntimeRegistry();
    const target = runtime();
    registry.register(target);
    const service = new HostProtocolService(registry);
    const server = new AppServer({ service });
    servers.push(server);
    const endpoint = await server.start();

    const unauthorized = await fetch(`${endpoint.origin}/v1/rpc`, {
      method: "POST",
      body: JSON.stringify(request("thread.snapshot")),
    });
    expect(unauthorized.status).toBe(401);

    const rpc = await fetch(`${endpoint.origin}/v1/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(request("thread.run", { input: "hello" })),
    });
    expect(await rpc.json()).toMatchObject({ ok: true, result: { text: "host result" } });

    const controller = new AbortController();
    const stream = await fetch(`${endpoint.origin}/v1/threads/host-thread/events?after=0`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: runtime_event");
    expect(text).toContain('"schemaVersion":2');
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("refuses accidental unauthenticated non-loopback exposure", () => {
    const service = new HostProtocolService(new HostRuntimeRegistry());
    expect(() => new AppServer({ service, hostname: "0.0.0.0" })).toThrow("authToken");
  });

  it("closes active SSE clients when the server shuts down", async () => {
    const registry = new HostRuntimeRegistry();
    const target = runtime();
    registry.register(target);
    await target.run("hello");
    const server = new AppServer({ service: new HostProtocolService(registry) });
    const endpoint = await server.start();

    const stream = await fetch(`${endpoint.origin}/v1/threads/host-thread/events?after=0`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    await server.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("rejects oversized RPC bodies without resetting the connection", async () => {
    const server = new AppServer({ service: new HostProtocolService(new HostRuntimeRegistry()) });
    servers.push(server);
    const endpoint = await server.start();

    const response = await fetch(`${endpoint.origin}/v1/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}` },
      body: "x".repeat(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
  });
});

it("returns outcome-v1 for v2 and replays v1/v2 terminal events at the same cursor", async () => {
  const target = runtime();
  const registry = new HostRuntimeRegistry(); registry.register(target);
  const service = new HostProtocolService(registry);
  const response = await service.handle({ ...request("thread.run", { input: "hello" }), version: 2 });
  expect(response).toMatchObject({ version: 2, ok: true, result: { outcome: { execution: { status: "finished" }, acceptance: { status: "not_requested" } } } });
  const modern: any[] = [], legacy: any[] = [];
  const stopModern = await service.subscribe(target.threadId, 0, event => modern.push(event), 2);
  const stopLegacy = await service.subscribe(target.threadId, 0, event => legacy.push(event), 1);
  expect(modern.at(-1).payload.type).toBe("attempt_ended");
  expect(legacy.at(-1).payload.type).toBe("turn_incomplete");
  expect(modern.map(event => [event.eventId, event.sequence])).toEqual(legacy.map(event => [event.eventId, event.sequence]));
  expect(await service.handle({ ...request("thread.snapshot"), version: 2 })).toMatchObject({ result: { status: "idle", lastOutcome: { schema: "zap.outcome" } } });
  expect(await service.handle({ ...request("thread.cancel"), version: 2 })).toMatchObject({ result: { cancelled: false } });
  expect(await service.handle({ ...request("workflow.dispatch"), version: 2 })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CAPABILITY" } });
  stopModern(); stopLegacy();
});

it("locks session invocation before attach and refuses stale outcomes from an unmigrated host", async () => {
  const target = runtime();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  let session!: SessionHostRuntime;
  session = new SessionHostRuntime({ threadId: target.threadId, eventStore: target.eventStore,
    runTurn: async (input, options) => {
      calls++;
      if (calls === 1) {
        await gate;
        const detach = await session.attach(target);
        try { return (await target.runWithOutcome(input, options)).loopResult; }
        finally { detach(); }
      }
      // A legacy host that ignores the requested profile cannot reuse the
      // last stored outcome as proof of this new invocation.
      return { text: "legacy response", steps: 1, toolResults: [], totalUsage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  const first = session.runWithOutcome("first");
  await expect(session.run("concurrent")).rejects.toThrow("active turn");
  await expect(session.runWithOutcome("concurrent")).rejects.toThrow("busy");
  release();
  expect((await first).outcome.execution.status).toBe("finished");
  await expect(session.runWithOutcome("second")).rejects.toMatchObject({ code: "OUTCOME_PERSISTENCE_FAILED" });
  expect(calls).toBe(2);
  await session.close();
});

it("hydrates a fresh host snapshot and reconnect replay without running a provider", async () => {
  const { InMemoryRuntimeStateStore } = await import("../../runtime/state-store.js");
  const stateStore = new InMemoryRuntimeStateStore();
  const eventStore = new InMemoryRuntimeEventStore();
  const scripted = createScriptedProvider({ transport: "call", turns: [scriptedTextResponse("persisted")] });
  const build = () => {
    const registry = new ToolRegistry();
    return createAgentRuntime({ threadId: "host-thread", workspace: { root: process.cwd() }, stateStore, eventStore, subagent: false,
      loopAgent: { provider: scripted.provider, registry, executor: new ToolExecutor(registry), maxSteps: 1 } });
  };
  const { outcome } = await build().runWithOutcome("once");
  const fresh = build();
  const registry = new HostRuntimeRegistry();
  registry.register(fresh);
  const service = new HostProtocolService(registry);
  expect(await service.handle({ ...request("thread.snapshot"), version: 2 })).toMatchObject({ ok: true, result: { lastOutcome: outcome, updatedAt: outcome.endedAt } });
  const events: any[] = [];
  const off = await service.subscribe("host-thread", 0, event => events.push(event), 2);
  off();
  expect(events.filter(event => event.payload.type === "attempt_ended")).toHaveLength(1);
  const coldSession = new SessionHostRuntime({ threadId: "cold", eventStore,
    recover: async () => outcome, runTurn: async () => { throw new Error("must not run on reconnect"); } });
  registry.register(coldSession);
  expect(await service.handle({ ...request("thread.snapshot"), version: 2, threadId: "cold" })).toMatchObject({ ok: true, result: { lastOutcome: outcome } });
});

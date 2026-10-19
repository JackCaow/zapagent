import { formatExecutionObservation, formatToolResultForModel, projectToolObservation } from "../../execution/failure.js";
import { expect, it } from "bun:test";
import { z } from "zod";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { TransparentExecutionBroker } from "../../execution/zapvm.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import type { WorkspaceIdentity } from "../../policy/types.js";
import { serviceEffects, serviceTools } from "../../services/tools.js";
import { ServiceReceiptSchema, type ServiceCapabilities, type ServiceReceipt } from "../../services/contracts.js";
import { ServiceExecutionHost, type AuthorizedServiceBackend, type ServiceExecutionAuthority } from "../../services/execution.js";
import { FileServiceDispatchJournal } from "../../services/file-journal.js";
import { createAgentRuntime } from "../../runtime/factory.js";
import { validateOutcome } from "../../runtime/outcome.js";
import { createScriptedProvider, scriptedTextResponse, scriptedToolCallResponse } from "../../testing/scripted-provider.js";

function fixture() {
  const workspace: WorkspaceIdentity = { id: "service-workspace", root: resolve(process.cwd()), mode: "root" };
  const cap: ServiceCapabilities = { version: 1, backendId: "trusted-test-owner", ownerId: "owner", ownerGeneration: "g1", workspaceId: workspace.id!,
    ownerScope: "host-session", defaultLeaseMs: 30_000, maxLeaseMs: 60_000, ownerExpiresAt: Date.now() + 120_000 };
  let current: ServiceReceipt | undefined;
  const dispatches = new Map<string, string>();
  const seen: ServiceExecutionAuthority[] = [];
  const calls = { lookup: 0, start: 0, status: 0, stop: 0 };
  const backend: AuthorizedServiceBackend = {
    capabilities: cap, workspace: { id: workspace.id!, root: workspace.root },
    journal: { durability: "host-session", async bindIntent(i) { const old = dispatches.get(i.operationId); if (old && old !== i.requestDigest) throw new Error("conflict"); },
      async claimDispatch(i) { if (dispatches.has(i.operationId)) return false; dispatches.set(i.operationId, i.requestDigest); return true; }, async bindReceipt() {} },
    async lookup(_id, authority) { calls.lookup++; seen.push(authority); return current ? { state: "present", receipt: current } : { state: "absent" }; },
    async start(intent, authority) { calls.start++; seen.push(authority); const { command: _, cwd: __, authorizationDigest: ___, createdAt: ____, ...fields } = intent;
      current = ServiceReceiptSchema.parse({ ...fields, serviceId: "service-one", state: "running", observedAt: Date.now() }); return current; },
    async status(_id, authority) { calls.status++; seen.push(authority); return current; },
    async stop(_id, authority) { calls.stop++; seen.push(authority); current = { ...current!, state: "stopped", observedAt: Date.now() }; return current; },
  };
  function setup(options: Partial<ConstructorParameters<typeof ToolExecutor>[1]> = {}) {
    const broker = new DefaultExecutionBroker({ services: backend });
    const registry = new ToolRegistry(); serviceTools(broker, workspace).forEach(t => registry.register(t));
    const executor = new ToolExecutor(registry, { cwd: workspace.root, workspace, executionBroker: broker, onApproval: async () => true, ...options });
    return { broker, registry, executor };
  }
  return { workspace, cap, backend, calls, seen, setup, get receipt() { return current; } };
}

it("registers nothing without an owner and refuses a manually copied service tool without calling its handler", async () => {
  const f = fixture(), broker = new DefaultExecutionBroker();
  expect(serviceTools(broker, f.workspace)).toEqual([]);
  const registry = new ToolRegistry(); const tool = serviceTools(f.setup().broker, f.workspace)[0]!;
  let handled = false; registry.register({ ...tool, handler: async () => { handled = true; return { success: true, output: "forged" }; } });
  const result = await new ToolExecutor(registry, { workspace: f.workspace, executionBroker: broker, onApproval: async () => true }).execute("service_start", { command: "neutral-http" });
  expect(result.failure?.code).toBe("CAPABILITY_UNSUPPORTED"); expect(handled).toBe(false); expect(f.calls.start).toBe(0);
});
it("requires actual approval before any lookup or dispatch", async () => {
  const f = fixture(); const { executor } = f.setup({ onApproval: async () => false });
  const result = await executor.execute("service_start", { command: "neutral-http" });
  expect(result.success).toBe(false); expect(f.calls).toEqual({ lookup: 0, start: 0, status: 0, stop: 0 });
});
it("binds immutable complete authority, preserves normal launchers and returns owner observations only", async () => {
  const f = fixture(), { executor } = f.setup();
  const start = await executor.execute("service_start", { command: "neutral-http", network: true }, undefined, { toolCallId: "begin", deadlineAtMs: Date.now() + 5000 });
  expect(start.success).toBe(true); expect(start.runtime?.service?.state).toBe("running");
  const authority = f.seen.at(-1)!;
  expect(authority).toMatchObject({ executionId: "execution:begin", name: "service_start", args: { command: "neutral-http", network: true },
    workspace: f.workspace, grant: { process: { spawn: true }, network: { destinations: ["*"] } } });
  expect(Object.isFrozen(authority)).toBe(true); expect(Object.isFrozen(authority.grant)).toBe(true); expect(Object.isFrozen(authority.limits)).toBe(true);
  expect(start.output).toContain("does not prove endpoint health"); expect(JSON.stringify(start.runtime)).not.toContain("neutral-http");
  expect(start.runtime?.execution?.receipt.spawnedProcesses).toBe(0);
  const status = await executor.execute("service_status", { operation_id: start.runtime!.service!.operationId }); expect(status.runtime?.service?.serviceId).toBe("service-one");
  const stop = await executor.execute("service_stop", { service_id: "service-one" }); expect(stop.runtime?.service?.state).toBe("stopped");
  expect(f.calls.start).toBe(1); expect(f.calls.stop).toBe(1);
});
for (const dimension of ["process", "filesystem", "network", "external", "workspace", "call"] as const) {
  it(`rejects missing ${dimension} authority before backend lookup`, async () => {
    const f = fixture(); const { executor } = f.setup({ policyEngine: { evaluate(r) {
      const grant = createCapabilityGrant(r.call.id, r.effects, Date.now() + 60_000);
      if (dimension === "call") grant.callId = "another-call";
      else delete (grant as any)[dimension];
      return { decision: "allow", grant, reason: "fixture" };
    } } });
    const result = await executor.execute("service_start", { command: "neutral-http", network: true }, undefined, { toolCallId: "scope" });
    expect(result.failure?.code).toBe("POLICY_DENIED"); expect(f.calls.start).toBe(0); expect(f.calls.lookup).toBe(0);
  });
}
it("rejects forged effects, invalid arguments, cross-workspace identity and absent durable ownership", async () => {
  const f = fixture(), { broker, registry } = f.setup();
  expect(serviceTools(broker, { ...f.workspace, id: "other" })).toEqual([]);
  expect(serviceTools(broker, { ...f.workspace, root: resolve("/other") })).toEqual([]);
  expect(serviceTools(broker, { ...f.workspace, mode: "isolated-write" })).toEqual([]);
  expect(() => new ServiceExecutionHost({ ...f.backend, capabilities: { ...f.cap, ownerScope: "environment" } })).toThrow("durable");
  const tool = registry.get("service_start")!; const args = { command: "neutral-http", network: false };
  const effects = serviceEffects("start", f.cap, f.workspace, args); effects.network = [{ kind: "network", operation: "connect", destinations: ["*"] }];
  const result = await broker.execute({ executionId: "forged", tool, name: "service_start", args, workspace: f.workspace, effects,
    grant: createCapabilityGrant("forged", effects, Date.now() + 1000) });
  expect(result.failure?.code).toBe("POLICY_DENIED"); expect(f.calls.lookup).toBe(0);
});
it("does not route VM service calls to a configured local owner", async () => {
  const f = fixture(), local = f.setup().broker, vm = new DefaultExecutionBroker();
  const transparent = new TransparentExecutionBroker({ local, vm, vmToolNames: new Set(["bash"]) });
  expect(serviceTools(transparent, f.workspace)).toEqual([]);
  const tool = serviceTools(local, f.workspace)[0]!; const args = { command: "neutral-http", network: false }, effects = serviceEffects("start", f.cap, f.workspace, args);
  const result = await transparent.execute({ executionId: "vm", tool, name: "service_start", args, effects, workspace: f.workspace,
    grant: createCapabilityGrant("vm", effects, Date.now() + 1000) });
  expect(result.failure?.code).toBe("CAPABILITY_UNSUPPORTED"); expect(f.calls.start).toBe(0);
  expect(() => new DefaultExecutionBroker({ services: f.backend, processBrokerFactory: () => { throw new Error("must not launch"); } })).toThrow("selected backend");
});
it("retains unknown disposition on lost replies and queries without another start", async () => {
  const f = fixture(); const start = f.backend.start.bind(f.backend);
  f.backend.start = async (...args) => { await start(...args); throw new Error("PRIVATE_BACKEND_DETAIL"); };
  const { executor } = f.setup(); const result = await executor.execute("service_start", { command: "neutral-http" }, undefined, { toolCallId: "lost" });
  expect(result.success).toBe(false); expect(result.runtime?.serviceOperation).toMatchObject({ executionId: "execution:lost", state: "unknown" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BACKEND_DETAIL");
  const status = await executor.execute("service_status", { operation_id: result.runtime!.serviceOperation!.operationId });
  expect(status.runtime?.service?.state).toBe("running"); expect(f.calls.start).toBe(1);
});
it("retains unknown operation facts even when the outer executor deadline wins", async () => {
  const f = fixture(); f.backend.start = async () => { f.calls.start++; return new Promise(() => {}); };
  const { executor } = f.setup({ timeoutMs: 25 });
  const began = Date.now(); const result = await executor.execute("service_start", { command: "neutral-http" }, undefined, { toolCallId: "bounded" });
  expect(Date.now() - began).toBeLessThan(1000); expect(result.success).toBe(false);
  // A wall-clock deadline can expire during pre-dispatch workspace inspection.
  // Unknown operation facts exist only after the service owner was entered.
  if (f.calls.lookup) expect(result.runtime?.serviceOperation).toMatchObject({ executionId: "execution:bounded", state: "unknown" });
  else expect(result.runtime?.serviceOperation).toBeUndefined();
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED"); expect(result.runtime?.service).toBeUndefined();
});
it("retains unknown operation facts on cancellation after backend dispatch", async () => {
  const f = fixture(), controller = new AbortController();
  f.backend.start = async () => { f.calls.start++; controller.abort(); return new Promise(() => {}); };
  const { executor } = f.setup();
  const result = await executor.execute("service_start", { command: "neutral-http" }, controller.signal, { toolCallId: "dispatched" });
  expect(f.calls.start).toBe(1); expect(result.failure?.code).toBe("CANCELLED");
  expect(result.runtime?.serviceOperation).toMatchObject({ executionId: "execution:dispatched", state: "unknown" });
  expect(result.runtime?.service).toBeUndefined();
});
it("does not invent an unknown service operation when the deadline precedes dispatch", async () => {
  const f = fixture(), { executor } = f.setup();
  const result = await executor.execute("service_start", { command: "neutral-http" }, undefined,
    { toolCallId: "not-dispatched", deadlineAtMs: Date.now() - 1 });
  expect(f.calls.lookup).toBe(0); expect(f.calls.start).toBe(0);
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED"); expect(result.runtime?.serviceOperation).toBeUndefined();
});
it("rejects cross-owner and changed operation receipts before dispatching a destructive stop", async () => {
  const f = fixture(), { executor } = f.setup(); await executor.execute("service_start", { command: "neutral-http" });
  f.backend.status = async () => ({ ...f.receipt!, ownerGeneration: "other" });
  const result = await executor.execute("service_stop", { service_id: "service-one" });
  expect(result.success).toBe(false); expect(result.runtime?.service).toBeUndefined(); expect(f.calls.stop).toBe(0);
});
it("preserves broker receipts through replacing or throwing post-processing and strips ordinary-tool forgeries", async () => {
  for (const throwing of [false, true]) {
    const f = fixture(), { executor } = f.setup({ postProcess: () => { if (throwing) throw new Error("format failed"); return { success: true, output: "formatted", runtime: { service: { ...f.receipt!, serviceId: "forged" } } }; } });
    const result = await executor.execute("service_start", { command: "neutral-http" });
    expect(result.runtime?.service?.serviceId).toBe("service-one");
  }
  const f = fixture(), { registry, executor } = f.setup(); await executor.execute("service_start", { command: "neutral-http" });
  registry.register({ definition: { name: "ordinary", description: "fixture", parameters: ServiceStatusArgumentsForTest, readOnly: true }, handler: async () => ({ success: true, output: "ordinary", runtime: { service: f.receipt } }) });
  expect((await executor.execute("ordinary", {})).runtime?.service).toBeUndefined();
});
const ServiceStatusArgumentsForTest = z.object({});
it("projects service observations into outcome/persistence without acceptance or extra turns", async () => {
  const f = fixture(), { registry, executor } = f.setup();
  const scripted = createScriptedProvider({ transport: "call", turns: [
    scriptedToolCallResponse([{ id: "owner", name: "service_start", arguments: { command: "neutral-http" } }]), scriptedTextResponse("Process owner returned a receipt.") ] });
  const runtime = createAgentRuntime({ threadId: "service-outcome", workspace: { root: f.workspace.root }, subagent: false,
    loopAgent: { provider: scripted.provider, registry, executor, maxSteps: 3 } });
  const { outcome } = await runtime.runWithOutcome("Start an authorized neutral service."); scripted.assertConsumed();
  expect(outcome.execution.services?.[0]?.state).toBe("running"); expect(outcome.execution.serviceOperations?.[0]?.state).toBe("observed");
  expect(outcome.acceptance.status).toBe("unverified"); validateOutcome(outcome);
  expect(() => validateOutcome({ ...outcome, execution: { ...outcome.execution, services: [{ ...f.receipt, expiresAt: "bad" }] } })).toThrow();
  const serialized = JSON.parse(JSON.stringify(outcome)); validateOutcome(serialized);
  const terminal = (await runtime.eventStore.list(runtime.threadId)).find(e => e.payload.type === "attempt_ended");
  expect(terminal?.payload.type === "attempt_ended" && terminal.payload.outcome.execution.services?.[0]?.serviceId).toBe("service-one");
  await runtime.close();
});

for (const field of ["backendId", "ownerId", "ownerGeneration", "workspaceId", "ownerScope", "operationId", "requestDigest", "expiresAt"] as const) {
  it(`rejects a start receipt with changed ${field} without publishing service availability`, async () => {
    const f = fixture(), start = f.backend.start.bind(f.backend);
    f.backend.start = async (...args) => ({ ...await start(...args) as ServiceReceipt,
      [field]: field === "expiresAt" ? Date.now() + 100_000 : field === "requestDigest" ? "b".repeat(64) : field === "ownerScope" ? "environment" : "other" });
    const { executor } = f.setup(); const result = await executor.execute("service_start", { command: "neutral-http" });
    expect(result.success).toBe(false); expect(result.runtime?.service).toBeUndefined(); expect(result.runtime?.serviceOperation?.state).toBe("unknown");
  });
}
it("returns scoped absence without starting and refuses a cross-owner lookup before status", async () => {
  const f = fixture(), { executor } = f.setup();
  const absent = await executor.execute("service_status", { operation_id: "missing" });
  expect(absent.runtime?.serviceOperation?.state).toBe("absent"); expect(f.calls.start).toBe(0);
  await executor.execute("service_start", { command: "neutral-http" }, undefined, { toolCallId: "valid" });
  f.backend.lookup = async () => ({ state: "present", receipt: { ...f.receipt!, ownerId: "foreign" } });
  const wrong = await executor.execute("service_status", { operation_id: f.receipt!.operationId });
  expect(wrong.success).toBe(false); expect(f.calls.status).toBe(0);
});
it("retains unknown status in outcome on cancellation without starting a replacement service", async () => {
  const f = fixture(); f.backend.start = async () => { f.calls.start++; return new Promise(() => {}); };
  const { registry, executor } = f.setup({ timeoutMs: 25 });
  const scripted = createScriptedProvider({ transport: "call", turns: [
    scriptedToolCallResponse([{ id: "unknown", name: "service_start", arguments: { command: "neutral-http" } }]), scriptedTextResponse("The service disposition is unknown.") ] });
  const runtime = createAgentRuntime({ threadId: "service-unknown", workspace: { root: f.workspace.root }, subagent: false,
    loopAgent: { provider: scripted.provider, registry, executor, maxSteps: 3 } });
  const { outcome } = await runtime.runWithOutcome("Start a neutral service."); scripted.assertConsumed();
  expect(outcome.execution.services).toBeUndefined(); expect(outcome.execution.serviceOperations?.[0]?.state).toBe("unknown");
  expect(outcome.acceptance.status).toBe("unverified"); expect(f.calls.start).toBe(1); validateOutcome(outcome);
  const operationId = outcome.execution.serviceOperations![0]!.operationId;
  expect(JSON.stringify(scripted.requests().at(-1))).toContain(operationId);
  expect(JSON.stringify(scripted.requests().at(-1))).toContain("Query an unknown operation");
  await runtime.close();
});
it("bounds an uncooperative status call and never guesses stopped", async () => {
  const f = fixture(), { executor } = f.setup({ timeoutMs: 25 });
  await executor.execute("service_start", { command: "neutral-http" }, undefined, { toolCallId: "valid" });
  f.backend.status = async () => new Promise(() => {});
  const started = Date.now(); const result = await executor.execute("service_stop", { service_id: "service-one" });
  expect(Date.now() - started).toBeLessThan(1000); expect(result.success).toBe(false); expect(f.calls.stop).toBe(0);
  expect(result.runtime?.service).toBeUndefined(); expect(result.runtime?.serviceOperation?.state).toBe("unknown");
});

it("mints distinct Host operation identities for repeated model call ids in different sessions", async () => {
  const f = fixture(), { executor } = f.setup();
  const first = await executor.execute("service_start", { command: "neutral-http" }, undefined, { toolCallId: "repeated", sessionId: "session-one" });
  // Simulate a second session without changing the selected owner. Lookup must
  // be keyed by operation, so the previous operation is absent for this start.
  f.backend.lookup = async () => ({ state: "absent" });
  const second = await executor.execute("service_start", { command: "neutral-http" }, undefined, { toolCallId: "repeated", sessionId: "session-two" });
  expect(first.success).toBe(true); expect(second.success).toBe(true);
  expect(first.runtime?.service?.operationId).toMatch(/^service:[a-f0-9]{64}$/);
  expect(first.runtime?.service?.operationId).not.toBe(second.runtime?.service?.operationId); expect(f.calls.start).toBe(2);
});
it("does not launch after the approved grant expires during lookup", async () => {
  const f = fixture(); f.backend.lookup = async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { state: "absent" }; };
  const { executor } = f.setup({ policyEngine: { evaluate(r) { return { decision: "allow", grant: createCapabilityGrant(r.call.id, r.effects, Date.now() + 10), reason: "fixture" }; } } });
  const result = await executor.execute("service_start", { command: "neutral-http" });
  expect(result.success).toBe(false); expect(f.calls.start).toBe(0); expect(result.runtime?.serviceOperation?.state).toBe("unknown");
});

it("replays one authorized start with its stable Host identity instead of dispatching twice", async () => {
  const f = fixture(), { executor } = f.setup();
  const authorization = await executor.authorize("service_start", { command: "neutral-http" }, undefined,
    { toolCallId: "replay", sessionId: "session", deadlineAtMs: Date.now() + 5000 });
  if (!("kind" in authorization) || authorization.kind !== "authorized") throw new Error("fixture authorization denied");
  const first = await executor.executeAuthorized(authorization);
  const second = await executor.executeAuthorized(authorization);
  expect(first.success).toBe(true); expect(second.success).toBe(true);
  expect(first.runtime?.service?.operationId).toBe(second.runtime?.service?.operationId); expect(f.calls.start).toBe(1);
});

for (const context of [{ toolCallId: "replay-without-deadline", sessionId: "session" }, undefined]) {
  it(`never remints a dispatch key on replay ${context ? "without an explicit deadline" : "without a model tool id"}`, async () => {
    const f = fixture(), { executor } = f.setup();
    const authorization = await executor.authorize("service_start", { command: "neutral-http" }, undefined, context);
    if (!("kind" in authorization)) throw new Error("fixture authorization denied");
    const first = await executor.executeAuthorized(authorization);
    expect(first.success).toBe(true);
    // A lost receipt must not make this approval a new launch operation.
    f.backend.lookup = async () => ({ state: "absent" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await executor.executeAuthorized(authorization);
    expect(second.success).toBe(false);
    expect(second.runtime?.serviceOperation?.state).toBe("unknown");
    expect(second.runtime?.serviceOperation?.operationId).toBe(first.runtime?.service?.operationId);
    expect(f.calls.start).toBe(1);
  });
}

(process.platform === "win32" ? it.skip : it)("a cold Host preserves the durable approval key when replay authority changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zap-service-replay-"));
  try {
    const f = fixture();
    f.backend.journal = new FileServiceDispatchJournal(directory);
    const { executor } = f.setup();
    const authorization = await executor.authorize("service_start", { command: "neutral-http" });
    if (!("kind" in authorization)) throw new Error("fixture authorization denied");
    const first = await executor.executeAuthorized(authorization);
    expect(first.success).toBe(true);
    f.backend.lookup = async () => ({ state: "absent" });
    for (const change of ["deadline", "grant", "command"] as const) {
      // Neither the in-memory intent cache nor the original journal object survives.
      f.backend.journal = new FileServiceDispatchJournal(directory);
      const cold = f.setup().executor;
      const replay = { ...authorization,
        ...(change === "deadline" ? { context: { ...authorization.context, deadlineAtMs: Date.now() + 5000 } } : {}),
        ...(change === "grant" ? { grant: { ...authorization.grant, expiresAt: authorization.grant.expiresAt - 1 } } : {}),
        ...(change === "command" ? { args: { ...authorization.args, command: "changed-command" } } : {}),
      };
      const result = await cold.executeAuthorized(replay);
      expect(result.success).toBe(false);
      if (change === "command") expect(result.failure?.code).toBe("POLICY_DENIED");
      else expect(result.runtime?.serviceOperation?.operationId).toBe(first.runtime?.service?.operationId);
      expect(f.calls.start).toBe(1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps bounded service references after body compression and rejects malformed persisted observations", async () => {
  const f = fixture(), { executor } = f.setup();
  const result = await executor.execute("service_start", { command: "PRIVATE_COMMAND_BODY" });
  const projected = projectToolObservation(result)!;
  const persisted = JSON.parse(JSON.stringify(projected));
  const rendered = formatExecutionObservation(persisted)!;
  expect(rendered).toContain(result.runtime!.service!.operationId);
  expect(rendered).not.toContain("PRIVATE_COMMAND_BODY"); expect(rendered).not.toContain("dispatchIdentity");
  expect(rendered).not.toContain("authorizationDigest"); expect(rendered).not.toContain("ownerGeneration");
  expect(formatToolResultForModel(result, "[compressed]")).toContain(result.runtime!.service!.serviceId);
  expect(formatExecutionObservation({ serviceOperation: { ...persisted.serviceOperation, operationId: "x".repeat(257) } })).toBeUndefined();
  expect(formatExecutionObservation({ service: { ...persisted.service, command: "PRIVATE_COMMAND_BODY" } } as any)).toBeUndefined();
});

it("keeps concurrent receipt observations local when sessions reuse the same model call id", async () => {
  const f = fixture(), { executor } = f.setup();
  f.backend.lookup = async () => ({ state: "absent" });
  let entered = 0, release!: () => void;
  const together = new Promise<void>(resolve => { release = resolve; });
  f.backend.start = async intent => {
    entered++; if (entered === 2) release();
    await together;
    const { command: _, cwd: __, authorizationDigest: ___, createdAt: ____, ...fields } = intent;
    return { ...fields, serviceId: `svc-${intent.operationId.slice(-12)}`, state: "running", observedAt: Date.now() };
  };
  const authorizations = [];
  for (const sessionId of ["one", "two"]) {
    const authorization = await executor.authorize("service_start", { command: "neutral-http" }, undefined, { sessionId, toolCallId: "same-model-id" });
    if (!("kind" in authorization) || authorization.kind !== "authorized") throw new Error("fixture approval failed");
    authorizations.push(authorization);
  }
  const results = await Promise.all(authorizations.map(authorization => executor.executeAuthorized(authorization)));
  for (const result of results) {
    expect(result.success).toBe(true);
    const body = JSON.parse(result.output).service;
    expect(result.runtime?.service).toEqual(body);
    expect(result.runtime?.serviceOperation?.operationId).toBe(body.operationId);
  }
  expect(results[0]!.runtime?.service?.operationId).not.toBe(results[1]!.runtime?.service?.operationId);
});

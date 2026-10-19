/** Trusted native fixture. Models select semantic actions, never commands/code.
 * Copy unchanged into both frozen SDK snapshots before a registered comparison.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { startLocalServiceOwner, connectLocalServiceOwner } from "../../zapsdk/services/local-owner.js";
import { FileServiceDispatchJournal } from "../../zapsdk/services/file-journal.js";
import { serviceEffects } from "../../zapsdk/services/tools.js";
import { createServiceOperationId, createServiceStartIntent } from "../../zapsdk/services/contracts.js";
import { executionDigest } from "../../zapsdk/execution/observation.js";
import { createCapabilityGrant } from "../../zapsdk/policy/engine.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS } from "../../zapsdk/tools/effects.js";
import { ToolRegistry } from "../../zapsdk/tools/registry.js";
import { ToolExecutor } from "../../zapsdk/tools/executor.js";
import { OpenAICompatibleProvider } from "../../zapsdk/core/providers/openai-compatible.js";
import { LoopAgent } from "../../zapsdk/agent/loop.js";
import type { AuthorizedServiceBackend, ServiceExecutionAuthority, ServiceOperation } from "../../zapsdk/services/execution.js";
import type { ServiceReceipt } from "../../zapsdk/services/contracts.js";
import type { Tool } from "../../zapsdk/tools/types.js";

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const save = (name: string, value: unknown) => writeFileSync(join(cfg.control, name), JSON.stringify(value) + "\n", { mode: 0o600 });
const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function until(test: () => boolean, milliseconds = 3000) {
  const end = performance.now() + milliseconds;
  while (!test()) { if (performance.now() >= end) throw new Error("Fixture observation deadline"); await delay(10); }
}
function authority(backend: AuthorizedServiceBackend, kind: ServiceOperation, args: Record<string, unknown>): ServiceExecutionAuthority {
  const workspace = { ...backend.workspace, mode: "root" as const };
  const effects = serviceEffects(kind, backend.capabilities, workspace, args), callId = randomUUID();
  return { executionId: "fixture:" + callId, dispatchIdentity: randomUUID(), identity: { sessionId: "registered-service-fixture", toolCallId: callId },
    name: "service_" + kind, args, effects, grant: createCapabilityGrant(callId, effects, Date.now() + 10_000),
    workspace, limits: { ...DEFAULT_TOOL_RESOURCE_LIMITS }, sandboxMode: "required", deadlineAtMs: Date.now() + 10_000 };
}
function publicReceipt(receipt: ServiceReceipt) {
  return { operation_id: receipt.operationId, service_id: receipt.serviceId, state: receipt.state,
    observed_at: receipt.observedAt, expires_at: receipt.expiresAt, acceptance: "unverified" };
}

async function owner() {
  if (process.platform !== "darwin") throw new Error("Fixture requires verified native macOS sandbox");
  const bind = FileServiceDispatchJournal.prototype.bindIntent;
  if (cfg.cancel) FileServiceDispatchJournal.prototype.bindIntent = async function (intent) {
    save("intent-gate.json", { at: Date.now(), operationId: intent.operationId });
    await until(() => existsSync(join(cfg.control, "release-gate")), 170_000);
    return bind.call(this, intent);
  };
  const instance = await startLocalServiceOwner({ controlDirectory: cfg.control, workspace: { id: "preset-workspace", root: cfg.workspace },
    ownerExpiresAt: Date.now() + 600_000, defaultLeaseMs: 180_000, maxLeaseMs: 180_000, maxServices: 1 });
  save("owner-ready.json", { descriptorPath: instance.descriptorPath });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= instance.close().then(() => { save("owner-closed.json", { at: Date.now() }); clearInterval(watch); });
  const watch = setInterval(() => { if (existsSync(join(cfg.control, "close-request"))) void close(); }, 10);
  process.on("SIGTERM", () => { writeFileSync(join(cfg.control, "release-gate"), "cleanup"); void close(); });
  process.on("SIGINT", () => { writeFileSync(join(cfg.control, "release-gate"), "cleanup"); void close(); });
}

async function client() {
  const backend = await connectLocalServiceOwner(join(cfg.control, "owner.json"));
  let receipt: ServiceReceipt | undefined, startUsed = false;
  const calls: Array<{ name: string; at: number; output: unknown }> = [];
  const registry = new ToolRegistry();
  const definition = (name: string, description: string, parameters: Tool["definition"]["parameters"], handler: Tool["handler"]) => {
    registry.register({ definition: { name, description, parameters, executionLocation: "host" }, handler });
  };
  definition("start_preset_service", "Start the explicitly authorized preinstalled neutral HTTP preset. No command or source input is accepted. Process running is not business acceptance.",
    z.object({ preset: z.literal("neutral-http") }).strict(), async () => {
      if (startUsed) return { success: false, output: "This preset has already been requested; query its recorded operation instead." };
      startUsed = true;
      const args = { command: `exec ${shell(process.execPath)} ${shell(join(cfg.workspace, "service.ts"))}`, network: true };
      const a = authority(backend, "start", args), digest = executionDigest(a), cap = backend.capabilities;
      const intent = createServiceStartIntent(cap, { operationId: createServiceOperationId(cap, a.dispatchIdentity),
        command: args.command, cwd: cfg.workspace, authorizationDigest: digest });
      if (!cfg.cancel) {
        receipt = await backend.start(intent, a) as ServiceReceipt;
        save("start-receipt.json", receipt);
        const output = publicReceipt(receipt); calls.push({ name: "start", at: Date.now(), output });
        return { success: true, output: JSON.stringify(output) };
      }
      const abort = new AbortController(), startAt = performance.now();
      let settled = false;
      const pending = backend.start(intent, a, abort.signal).then(() => { settled = true; }, () => { settled = true; });
      await until(() => existsSync(join(cfg.control, "intent-gate.json")));
      const cancelledAt = performance.now(); abort.abort();
      const cancellationSettled = await Promise.race([pending.then(() => true), delay(250).then(() => false)]);
      const cancellationWaitMs = performance.now() - cancelledAt;
      writeFileSync(join(cfg.control, "close-request"), "close");
      const heldAt = performance.now();
      while (performance.now() - heldAt < 300 && !existsSync(join(cfg.control, "owner-closed.json"))) await delay(10);
      const closeReturnedWhileGateHeld = existsSync(join(cfg.control, "owner-closed.json"));
      writeFileSync(join(cfg.control, "release-gate"), "release");
      await until(() => existsSync(join(cfg.control, "owner-closed.json")));
      await Promise.race([pending, delay(250)]);
      const files = readdirSync(join(cfg.control, "records"));
      const records = files.map(name => JSON.parse(readFileSync(join(cfg.control, "records", name), "utf8")));
      save("cancellation-observation.json", { cancellationSettled, cancellationWaitMs, closeReturnedWhileGateHeld,
        pendingEventuallySettled: settled, elapsedMs: performance.now() - startAt,
        records: records.map(record => ({ state: record.receipt.state, hasTaskId: !!record.taskId })),
        lateCommandLaunched: existsSync(join(cfg.workspace, "port")) });
      const output = { operation_id: intent.operationId, state: "unknown", request: "cancelled", acceptance: "unverified",
        observation: "No live acknowledgement was received. Cancellation is not proof that a service stopped." };
      calls.push({ name: "start", at: Date.now(), output });
      return { success: false, output: JSON.stringify(output) };
    });
  definition("service_status", "Query this owner's operation receipt. Historical observations are not business acceptance.",
    z.object({ operation_id: z.string().min(1).max(256) }).strict(), async (args) => {
      const a = authority(backend, "status", args);
      const found = await backend.lookup(args.operation_id as string, a) as { state: string; receipt?: ServiceReceipt };
      if (found.state !== "present" || !found.receipt) return { success: true, output: JSON.stringify({ state: "unknown", operation_id: args.operation_id }) };
      const current = await backend.status(found.receipt.serviceId, a) as ServiceReceipt;
      const output = publicReceipt(current); calls.push({ name: "status", at: Date.now(), output });
      return { success: true, output: JSON.stringify(output) };
    });
  definition("service_stop", "Stop a receipt belonging to this owner when the user requests it.",
    z.object({ service_id: z.string().min(1).max(256) }).strict(), async (args) => {
      const current = await backend.stop(args.service_id as string, authority(backend, "stop", args)) as ServiceReceipt;
      const output = publicReceipt(current); calls.push({ name: "stop", at: Date.now(), output });
      return { success: true, output: JSON.stringify(output) };
    });
  const provider = new OpenAICompatibleProvider({ model: cfg.model, baseURL: cfg.relayURL, apiKey: cfg.relayToken,
    maxTokens: 4096, extraRequestParams: cfg.extraRequestParams });
  const executor = new ToolExecutor(registry, { cwd: cfg.workspace, onApproval: async () => true });
  const agent = new LoopAgent({ provider, registry, executor, promptProfile: "standard", maxSteps: 8,
    systemPrompt: "You operate explicitly authorized preinstalled services using semantic tools. Never invent an operation receipt, process state, readiness or acceptance. Return only JSON for the user's final report. No shell, filesystem or code-generation tool is available." });
  const events: unknown[] = []; agent.on("*", event => events.push(event));
  const start = performance.now();
  try {
    const result = await agent.run(cfg.prompt, { signal: AbortSignal.timeout(175_000), deadlineAtMs: Date.now() + 175_000 });
    save("model-result.json", { text: result.text, steps: result.steps, totalUsage: result.totalUsage,
      elapsedMs: performance.now() - start, toolResults: result.toolResults, calls, events });
  } catch (error) {
    save("model-result.json", { errorType: error instanceof Error ? error.constructor.name : "unknown", elapsedMs: performance.now() - start, calls, events });
    process.exitCode = 1;
  }
}

async function stop() {
  const backend = await connectLocalServiceOwner(join(cfg.control, "owner.json"));
  const receipt = JSON.parse(readFileSync(join(cfg.control, "start-receipt.json"), "utf8"));
  const args = { service_id: receipt.serviceId };
  save("host-stop-receipt.json", await backend.stop(receipt.serviceId, authority(backend, "stop", args)));
}

try {
  if (cfg.mode === "owner") await owner();
  else if (cfg.mode === "client") await client();
  else if (cfg.mode === "stop") await stop();
  else throw new Error("Unknown trusted fixture mode");
} catch (error) {
  save("worker-error-" + cfg.mode + ".json", { errorType: error instanceof Error ? error.constructor.name : "unknown" });
  process.exitCode = 1;
}

import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { constants } from "node:fs";
import { mkdir, open, realpath, readdir, rename, unlink, chmod, lstat } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { DefaultExecutionBroker, validateExecutionGrant } from "../execution/broker.js";
import { NetworkProxy, DEFAULT_ALLOWED_DOMAINS } from "../execution/network-proxy.js";
import { createPlatformSandbox } from "../execution/sandbox.js";
import { executionDigest } from "../execution/observation.js";
import { createCapabilityGrant } from "../policy/engine.js";
import { TaskStore } from "../tasks/store.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS, type ToolResourceLimits } from "../tools/effects.js";
import type { Tool } from "../tools/types.js";
import { FileServiceDispatchJournal } from "./file-journal.js";
import { serviceEffects } from "./tools.js";
import { ServiceStartArguments, ServiceStatusArguments, ServiceStopArguments, type AuthorizedServiceBackend, type ServiceExecutionAuthority, type ServiceOperation } from "./execution.js";
import { ServiceCapabilitiesSchema, ServiceReceiptSchema, ServiceStartIntentSchema, assertServiceBinding, createServiceOperationId,
  type ServiceCapabilities, type ServiceReceipt, type ServiceStartIntent } from "./contracts.js";

const MAX_MESSAGE = 2 * 1024 * 1024;
const DescriptorSchema = z.object({ version: z.literal(1), socket: z.string().min(1), secret: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: ServiceCapabilitiesSchema, workspace: z.object({ id: z.string().min(1), root: z.string().min(1) }).strict() }).strict();
const identifier = z.string().min(1).max(256), pathValue = z.string().min(1).max(32768);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workspaceMode = z.discriminatedUnion("mode", [z.object({ mode: z.literal("none") }).strict(), z.object({ mode: z.literal("shared-readonly") }).strict(), z.object({ mode: z.literal("isolated-write") }).strict(), z.object({ mode: z.literal("root-integration") }).strict()]);
const AuthoritySchema = z.object({
  executionId: identifier, dispatchIdentity: z.string().uuid(), identity: z.object({ sessionId: identifier.optional(), toolCallId: identifier.optional(), step: z.number().int().nonnegative().optional() }).strict(),
  name: z.enum(["service_start", "service_status", "service_stop"]), args: z.record(z.string(), z.unknown()), effects: z.unknown(),
  grant: z.object({ callId: identifier, expiresAt: epoch,
    filesystem: z.object({ read: z.array(pathValue), write: z.array(pathValue) }).strict().optional(),
    network: z.object({ destinations: z.array(identifier), methods: z.array(identifier) }).strict().optional(),
    process: z.object({ spawn: z.boolean() }).strict().optional(),
    external: z.array(z.object({ system: identifier, operations: z.array(identifier), resource: identifier.optional() }).strict()).optional(), workspace: workspaceMode.optional() }).strict(),
  workspace: z.object({ id: identifier.optional(), root: pathValue, mode: z.enum(["root", "shared-readonly", "isolated-write"]).optional(), sandbox: z.enum(["enforced", "none"]).optional() }).strict(),
  limits: z.object(Object.fromEntries(Object.keys(DEFAULT_TOOL_RESOURCE_LIMITS).map(key => [key, epoch]))).strict(),
  sandboxMode: z.enum(["disabled", "best-effort", "required"]), deadlineAtMs: epoch.optional(),
}).strict();
const RecordSchema = z.object({ receipt: ServiceReceiptSchema, taskId: z.string().min(1).optional() }).strict();
type OwnerRecord = z.infer<typeof RecordSchema>;
function within(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== resolve(path)) throw new Error("Owner control directory is not private and canonical");
}
async function privateJson(path: string, maximum = MAX_MESSAGE): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Owner file is not private");
    const data = Buffer.alloc(maximum + 1); const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maximum) throw new Error("Owner file exceeds limit");
    return JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}
async function save(path: string, value: unknown) {
  const pending = join(dirname(path), `.pending-${randomUUID()}`);
  const fd = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  try {
    await rename(pending, path);
    const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(pending).catch(() => {}); }
}
function signature(secret: string, timestamp: string, nonce: string, body: string) { return createHmac("sha256", Buffer.from(secret, "hex")).update(`${timestamp}\n${nonce}\n${body}`).digest("hex"); }
async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { const data = Buffer.from(chunk); total += data.length; if (total > MAX_MESSAGE) throw new Error("Owner request too large"); chunks.push(data); }
  return Buffer.concat(chunks).toString("utf8");
}

const NetworkPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("open") }).strict(),
  z.object({ mode: z.literal("allowlist"), allowedDomains: z.array(z.string().min(1).max(256)).max(10000), deniedDomains: z.array(z.string().min(1).max(256)).max(10000) }).strict(),
]);
export type LocalServiceOwnerNetworkPolicy = z.infer<typeof NetworkPolicySchema>;
function networkPolicy(value: LocalServiceOwnerNetworkPolicy) {
  const parsed = NetworkPolicySchema.parse(value);
  return parsed.mode === "open" ? parsed : { ...parsed, allowedDomains: [...new Set(parsed.allowedDomains.map(x => x.trim().toLowerCase()))].sort(), deniedDomains: [...new Set(parsed.deniedDomains.map(x => x.trim().toLowerCase()))].sort() };
}
export function localServiceOwnerNetworkPolicyDigest(value: LocalServiceOwnerNetworkPolicy): string { return executionDigest(networkPolicy(value)); }

export interface LocalServiceOwnerOptions {
  /** Must be outside the Agent's workspace and all granted read/write roots. */
  controlDirectory: string;
  workspace: { id: string; root: string };
  ownerId?: string;
  ownerExpiresAt: number;
  defaultLeaseMs: number;
  maxLeaseMs: number;
  limits?: Partial<ToolResourceLimits>;
  maxServices?: number;
  networkPolicy?: LocalServiceOwnerNetworkPolicy;
}

/** Lives in a separately hosted process. It never adopts PIDs on restart.
 * A new generation refuses unresolved old records, including expired leases:
 * a timestamp alone does not prove an orphaned process stopped. */
export async function startLocalServiceOwner(options: LocalServiceOwnerOptions): Promise<{
  descriptorPath: string; capabilities: ServiceCapabilities; close(): Promise<void>;
}> {
  if (process.platform === "win32") throw new Error("Local service owner requires a Unix sandbox and directory fsync");
  const root = resolve(options.controlDirectory), workspace = { id: options.workspace.id, root: await realpath(options.workspace.root) };
  if (within(root, workspace.root) || within(workspace.root, root)) throw new Error("Owner controls and workspace must be disjoint");
  await privateDirectory(root); await privateDirectory(join(root, "records"));
  const previous = await readdir(join(root, "records")); const previousBindings = new Set<string>();
  for (const name of previous) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unrecognized owner record");
    const { receipt } = RecordSchema.parse(await privateJson(join(root, "records", name), 8192));
    if (!["stopped", "expired"].includes(receipt.state)) throw new Error("Unreconciled prior owner generation; no PID was adopted");
    previousBindings.add(executionDigest({ backendId: receipt.backendId, ownerId: receipt.ownerId, ownerGeneration: receipt.ownerGeneration, workspaceId: receipt.workspaceId, operationId: receipt.operationId }));
  }
  const dispatchRoot = join(root, "dispatch"); await privateDirectory(dispatchRoot);
  for (const name of await readdir(dispatchRoot)) {
    if (name.endsWith(".dispatch.json") && !previousBindings.has(name.slice(0, -".dispatch.json".length))) throw new Error("Unreconciled dispatch from prior owner generation");
  }
  const network = networkPolicy(options.networkPolicy ?? { mode: "allowlist", allowedDomains: [...DEFAULT_ALLOWED_DOMAINS], deniedDomains: [] });
  if (network.mode === "allowlist" && process.platform !== "darwin") throw new Error("This local owner platform cannot enforce a domain allowlist");
  const cap = Object.freeze(ServiceCapabilitiesSchema.parse({ version: 1, backendId: `local-${process.platform}`, ownerId: options.ownerId ?? randomUUID(), ownerGeneration: randomUUID(),
    workspaceId: workspace.id, ownerScope: "environment", ownerFailure: "unknown-until-host-reconciliation", networkPolicyDigest: localServiceOwnerNetworkPolicyDigest(network), defaultLeaseMs: options.defaultLeaseMs, maxLeaseMs: options.maxLeaseMs, ownerExpiresAt: options.ownerExpiresAt }));
  if (Date.now() >= cap.ownerExpiresAt) throw new Error("Owner lease expired before startup");
  const proxy = network.mode === "allowlist" ? new NetworkProxy(() => network) : undefined;
  const sandbox = createPlatformSandbox({ networkProxy: proxy }); if (!sandbox.status().available) { proxy?.close(); throw new Error("Required OS sandbox unavailable for local owner"); }
  const maxServices = z.number().int().positive().max(4096).parse(options.maxServices ?? 64);
  const limits = { ...DEFAULT_TOOL_RESOURCE_LIMITS, ...options.limits };
  const broker = new DefaultExecutionBroker({ sandbox, sandboxMode: "required", allowUnsandboxed: false, limits });
  const store = new TaskStore({ outputDir: join(root, "logs"), projectCwd: workspace.root });
  const records = new Map<string, OwnerRecord>(), byService = new Map<string, OwnerRecord>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  const starting = new Map<string, Promise<ServiceReceipt>>(); const journal = new FileServiceDispatchJournal(dispatchRoot);
  const leaseStops = new Set<string>(); let closing: Promise<void> | undefined;
  const recordPath = (operation: string) => join(root, "records", `${executionDigest(operation)}.json`);
  let writes = Promise.resolve();
  const persist = (record: OwnerRecord) => {
    const snapshot = JSON.parse(JSON.stringify(record));
    const pending = writes.then(() => save(recordPath(record.receipt.operationId), snapshot));
    writes = pending.catch(() => {}); return pending;
  };
  const observe = async (record: OwnerRecord) => {
    const task = record.taskId ? store.get(record.taskId) : undefined;
    record.receipt = { ...record.receipt, state: task?.exitedAt !== undefined
      ? leaseStops.has(record.receipt.serviceId) ? "expired" : "stopped" : task ? "running" : record.receipt.state,
      observedAt: Date.now() };
    await persist(record); return { ...record.receipt };
  };
  const settle = async (record: OwnerRecord, expired = false) => {
    if (expired && record.taskId && store.get(record.taskId)?.exitedAt === undefined) leaseStops.add(record.receipt.serviceId);
    const timer = timers.get(record.receipt.serviceId); if (timer) clearTimeout(timer); timers.delete(record.receipt.serviceId);
    if (record.taskId) await store.settle([record.taskId]);
    if (!record.taskId || store.get(record.taskId)?.exitedAt === undefined) record.receipt = { ...record.receipt, state: "unknown", observedAt: Date.now() };
    return observe(record);
  };
  const arm = (record: OwnerRecord) => {
    const remaining = record.receipt.expiresAt - Date.now();
    if (remaining <= 0) { void settle(record, true).catch(() => {}); return; }
    timers.set(record.receipt.serviceId, setTimeout(() => arm(record), Math.min(remaining, 2_147_483_647)));
  };
  const validate = (kind: ServiceOperation, authority: ServiceExecutionAuthority) => {
    AuthoritySchema.parse(authority);
    if (closing || authority.sandboxMode !== "required" || authority.name !== `service_${kind}` || !authority.dispatchIdentity
      || authority.workspace?.id !== workspace.id || resolve(authority.workspace?.root ?? "") !== workspace.root
      || authority.workspace.mode !== "root" || authority.grant?.expiresAt <= Date.now()
      || (authority.deadlineAtMs !== undefined && authority.deadlineAtMs <= Date.now())
      || (authority.identity?.toolCallId && authority.grant.callId !== authority.identity.toolCallId)) throw new Error("Owner authority rejected");
    const args = kind === "start" ? ServiceStartArguments.parse(authority.args) : kind === "status" ? ServiceStatusArguments.parse(authority.args) : ServiceStopArguments.parse(authority.args);
    const expected = serviceEffects(kind, cap, workspace, args);
    if (validateExecutionGrant({ grant: authority.grant, effects: expected })) throw new Error("Owner grant does not cover the operation");
    if (executionDigest(expected) !== executionDigest(authority.effects)) throw new Error("Owner effect binding mismatch");
    // The exact sandbox roots are checked before exposing the signing material
    // to any command. Filesystem mode bits alone are not an Agent boundary.
    const context = sandbox.createContext({ executionId: authority.executionId, workspace, effects: expected, grant: authority.grant });
    if ([...context.readablePaths, ...context.writablePaths].some(path => within(root, path) || within(path, root))) throw new Error("Owner controls overlap the service sandbox grants");
    return args;
  };
  const execute = async (kind: ServiceOperation, authority: ServiceExecutionAuthority, handler: Tool["handler"], signal?: AbortSignal, launches = false) => {
    validate(kind, authority);
    const effects = serviceEffects(kind, cap, workspace, authority.args);
    if (!launches) effects.process = [];
    const tool: Tool = { definition: { name: "owner_control", description: "Host service owner dispatch", parameters: z.object({}).passthrough(), sandboxAware: true,
      executionLocation: "host", resolveEffects: () => effects }, handler };
    const result = await broker.execute({ executionId: authority.executionId, name: tool.definition.name, tool, args: authority.args, effects, grant: authority.grant,
      workspace, context: { deadlineAtMs: authority.deadlineAtMs }, limits: authority.limits }, signal);
    if (!result.success) throw new Error("Owner execution rejected or failed");
    return result;
  };
  // Exercise the real launcher once before advertising a usable owner.
  const probeEffects = { filesystem: [{ kind: "filesystem" as const, operation: "read" as const, paths: [workspace.root] }], network: [],
    process: [{ kind: "process" as const, operation: "spawn" as const, commandClass: "shell" }], external: [], workspace: { mode: "shared-readonly" as const }, confidence: "declared" as const };
  const probeTool: Tool = { definition: { name: "owner_probe", description: "Host launcher preflight", parameters: z.object({}), sandboxAware: true }, handler: async (_a, _s, context) => {
    const child = context!.process!.spawnShell("exit 0", { cwd: workspace.root });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { success: code === 0, output: "" };
  } };
  const probe = await broker.execute({ executionId: "owner-preflight", name: "owner_probe", tool: probeTool, args: {}, effects: probeEffects,
    grant: createCapabilityGrant("owner-preflight", probeEffects, Date.now() + 5000), workspace, limits: { timeoutMs: 5000 } });
  if (!probe.success) { proxy?.close(); throw new Error("Required OS sandbox launcher failed owner preflight"); }
  if (Date.now() >= cap.ownerExpiresAt) { proxy?.close(); throw new Error("Owner lease expired during preflight"); }
  const backend = {
    async lookup(operation: string, authority: ServiceExecutionAuthority, signal?: AbortSignal) {
      const expected = authority.name === "service_start" ? createServiceOperationId(cap, authority.dispatchIdentity) : authority.args.operation_id;
      if (operation !== expected) throw new Error("Owner lookup target mismatch");
      let found: ServiceReceipt | undefined;
      await execute(authority.name === "service_start" ? "start" : "status", authority, async () => { const record = records.get(operation); if (record) found = await observe(record); return { success: true, output: "" }; }, signal);
      return found ? { state: "present", receipt: found } : { state: "absent" };
    },
    async start(intentValue: ServiceStartIntent, authority: ServiceExecutionAuthority, signal?: AbortSignal) {
      const intent = ServiceStartIntentSchema.parse(intentValue); assertServiceBinding(intent, cap);
      const args = validate("start", authority) as z.infer<typeof ServiceStartArguments>;
      const digest = executionDigest(authority);
      if (intent.authorizationDigest !== digest || intent.operationId !== createServiceOperationId(cap, authority.dispatchIdentity) || intent.command !== args.command || intent.cwd !== workspace.root
        || intent.expiresAt - intent.createdAt !== (args.lease_ms ?? cap.defaultLeaseMs) || intent.createdAt > Date.now() || intent.expiresAt <= Date.now()
        || intent.expiresAt > cap.ownerExpiresAt || intent.expiresAt - intent.createdAt > cap.maxLeaseMs) throw new Error("Owner start intent mismatch");
      const previous = records.get(intent.operationId);
      if (previous) { if (previous.receipt.requestDigest !== intent.requestDigest) throw new Error("Owner operation conflict"); return observe(previous); }
      const running = starting.get(intent.operationId); if (running) return running;
      const reserved = new Set([...starting.keys(), ...[...records.values()]
        .filter(r => !r.taskId || store.get(r.taskId)?.exitedAt === undefined).map(r => r.receipt.operationId)]);
      if (reserved.size >= maxServices) throw new Error("Owner service capacity exhausted");
      const launch = (async () => {
        await journal.bindIntent(intent); if (!await journal.claimDispatch(intent)) throw new Error("Unknown prior dispatch; start not repeated");
        const receipt = ServiceReceiptSchema.parse({ version: 1, backendId: cap.backendId, ownerId: cap.ownerId, ownerGeneration: cap.ownerGeneration, workspaceId: cap.workspaceId,
          ownerScope: cap.ownerScope, operationId: intent.operationId, serviceId: randomUUID(), requestDigest: intent.requestDigest, state: "starting", observedAt: Date.now(), expiresAt: intent.expiresAt });
        const record: OwnerRecord = { receipt }; records.set(intent.operationId, record); byService.set(receipt.serviceId, record); await persist(record);
        const checkAcknowledgement = () => {
          const now = Date.now();
          if (closing || signal?.aborted || now >= intent.expiresAt || now >= authority.grant.expiresAt
            || (authority.deadlineAtMs !== undefined && now >= authority.deadlineAtMs)) throw new Error("Service cancelled before acknowledgement");
        };
        try {
          await execute("start", authority, async (_args, _signal, context) => {
            const task = store.spawnShell({ command: intent.command, cwd: workspace.root, description: "Host-owned leased service", process: context!.process,
              maxOutputBytes: context!.limits!.maxBackgroundOutputBytes, resources: context!.resources });
            record.taskId = task.taskId; return { success: true, output: "" };
          }, signal, true);
          checkAcknowledgement();
          arm(record); const observed = await observe(record); await journal.bindReceipt(intent, observed);
          // Durable receipt writes can outlive the caller. Until acknowledgement,
          // cancellation still belongs to this start and must stop its process.
          checkAcknowledgement();
          return observed;
        } catch {
          if (record.taskId) await settle(record, Date.now() >= intent.expiresAt);
          else { record.receipt = { ...record.receipt, state: "unknown", observedAt: Date.now() }; await persist(record); }
          throw new Error("Owner start did not commit a live acknowledgement");
        }
      })().finally(() => starting.delete(intent.operationId));
      starting.set(intent.operationId, launch); return launch;
    },
    async status(service: string, authority: ServiceExecutionAuthority, signal?: AbortSignal) {
      const target = byService.get(service);
      if (!target || (authority.name === "service_stop" ? authority.args.service_id !== service : authority.args.operation_id !== target.receipt.operationId)) throw new Error("Owner status target mismatch");
      let receipt: ServiceReceipt | undefined;
      await execute(authority.name === "service_stop" ? "stop" : "status", authority, async () => { const record = byService.get(service); if (!record) throw new Error("Service not owned"); receipt = await observe(record); return { success: true, output: "" }; }, signal); return receipt;
    },
    async stop(service: string, authority: ServiceExecutionAuthority, signal?: AbortSignal) {
      if (authority.args.service_id !== service) throw new Error("Owner stop target mismatch");
      let receipt: ServiceReceipt | undefined;
      await execute("stop", authority, async () => { const record = byService.get(service); if (!record) throw new Error("Service not owned"); receipt = await settle(record); return { success: true, output: "" }; }, signal); return receipt;
    },
  };
  store.on("exited", event => { for (const record of records.values()) if (record.taskId === event.taskId) {
    const timer = timers.get(record.receipt.serviceId); if (timer) clearTimeout(timer); timers.delete(record.receipt.serviceId);
    void observe(record).catch(() => {});
  } });
  const secret = randomBytes(32).toString("hex"), socket = join(root, "owner.sock"), descriptorPath = join(root, "owner.json");
  const seen = new Map<string, number>(), requests = new Set<AbortController>();
  const activeRequests = new Map<string, AbortController>(), cancellations = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController(); requests.add(controller);
    response.once("close", () => requests.delete(controller));
    request.once("aborted", () => controller.abort()); response.once("close", () => { if (!response.writableFinished) controller.abort(); });
    let authenticatedNonce: string | undefined;
    try {
      if (request.method !== "POST" || request.url !== "/v1/owner") throw new Error("Unknown owner route");
      const text = await body(request), timestamp = String(request.headers["x-zap-time"] ?? ""), nonce = String(request.headers["x-zap-nonce"] ?? ""), signed = String(request.headers["x-zap-signature"] ?? "");
      for (const [id, expiry] of seen) if (expiry < Date.now()) seen.delete(id);
      for (const [id, expiry] of cancellations) if (expiry < Date.now()) cancellations.delete(id);
      if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30_000 || !z.string().uuid().safeParse(nonce).success || seen.has(nonce) || seen.size >= 4096 || !/^[a-f0-9]{64}$/.test(signed)
        || !timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(secret, timestamp, nonce, text), "hex"))) throw new Error("Owner authentication rejected");
      seen.set(nonce, Date.now() + 60_000);
      authenticatedNonce = nonce; activeRequests.set(nonce, controller);
      if (cancellations.has(nonce)) controller.abort();
      const value = JSON.parse(text); let result: unknown;
      if (value.kind === "cancel") {
        const target = z.string().uuid().parse(value.requestNonce);
        if (!cancellations.has(target) && cancellations.size >= 4096) throw new Error("Owner cancellation capacity exhausted");
        // A separate authenticated cancellation can overtake its request.
        // Retain a bounded tombstone longer than the signed admission window.
        cancellations.set(target, Date.now() + 60_000); activeRequests.get(target)?.abort();
        result = { cancelled: true };
      }
      else if (value.kind === "capabilities") result = { capabilities: cap, workspace };
      else if (value.kind === "start") result = await backend.start(value.intent, value.authority, controller.signal);
      else if (value.kind === "lookup") result = await backend.lookup(z.string().min(1).max(256).parse(value.operationId), value.authority, controller.signal);
      else if (value.kind === "status") result = await backend.status(z.string().min(1).max(256).parse(value.serviceId), value.authority, controller.signal);
      else if (value.kind === "stop") result = await backend.stop(z.string().min(1).max(256).parse(value.serviceId), value.authority, controller.signal);
      else throw new Error("Unsupported owner operation");
      response.writeHead(200, { "content-type": "application/json", connection: "close" }); response.end(JSON.stringify(result));
    } catch { response.writeHead(403, { "content-type": "application/json", connection: "close" }); response.end('{"error":"OWNER_REQUEST_REJECTED"}'); }
    finally { if (authenticatedNonce) activeRequests.delete(authenticatedNonce); requests.delete(controller); }
  });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.off("error", reject); resolve(); }); }); }
  catch (error) { proxy?.close(); server.close(); throw error; }
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try { await chmod(socket, 0o600); await save(descriptorPath, { version: 1, socket, secret, capabilities: cap, workspace }); }
  catch (error) { proxy?.close(); server.close(); throw error; }
  const socketIdentity = await lstat(socket);
  const close = () => closing ??= (async () => {
    if (ownerTimer) clearTimeout(ownerTimer); for (const request of requests) request.abort();
    for (const timer of timers.values()) clearTimeout(timer); timers.clear();
    // A disconnected caller no longer keeps server.close() waiting. Drain the
    // owned dispatches too, including starts still awaiting durable intent.
    await Promise.allSettled([...starting.values()]);
    const active = [...records.values()].filter(record => record.taskId && store.get(record.taskId)?.exitedAt === undefined);
    if (Date.now() >= cap.ownerExpiresAt) for (const record of active) leaseStops.add(record.receipt.serviceId);
    await store.settle(active.map(record => record.taskId!));
    for (const record of active) await observe(record);
    await writes; proxy?.close();
    await new Promise<void>(resolve => {
      const force = setTimeout(() => server.closeAllConnections?.(), 1000);
      server.close(() => { clearTimeout(force); resolve(); });
    });
    try { const current = await lstat(socket); if (current.isSocket() && current.ino === socketIdentity.ino && current.dev === socketIdentity.dev) await unlink(socket); } catch { /* Already removed by the server. */ }
  })();
  let ownerTimer: ReturnType<typeof setTimeout> | undefined;
  const expireOwner = () => { const remaining = cap.ownerExpiresAt - Date.now();
    if (remaining <= 0) void close(); else ownerTimer = setTimeout(expireOwner, Math.min(remaining, 2_147_483_647)); };
  expireOwner();
  return { descriptorPath, capabilities: { ...cap }, close };
}

/** Load once before Agent execution. Never place this descriptor in workspace
 * grants, child environments, prompts or model tool arguments. */
export async function connectLocalServiceOwner(descriptorPath: string): Promise<AuthorizedServiceBackend> {
  const path = resolve(descriptorPath); const root = await realpath(dirname(path));
  if (root !== dirname(path)) throw new Error("Owner descriptor directory must be canonical");
  await privateDirectory(root);
  const descriptor = DescriptorSchema.parse(await privateJson(path, 16 * 1024));
  if (within(root, descriptor.workspace.root) || within(descriptor.workspace.root, root)) throw new Error("Owner controls overlap workspace");
  if (descriptor.socket !== join(root, "owner.sock")) throw new Error("Owner socket escaped control directory");
  const call = (value: unknown, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Owner request cancelled")); return; }
    const text = JSON.stringify(value); if (Buffer.byteLength(text) > MAX_MESSAGE) { reject(new Error("Owner request exceeds limit")); return; }
    const timestamp = String(Date.now()), nonce = randomUUID();
    const detach = () => signal?.removeEventListener("abort", cancel);
    const fail = (message: string) => { detach(); reject(new Error(message)); };
    const request = httpRequest({ socketPath: descriptor.socket, path: "/v1/owner", method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-zap-time": timestamp, "x-zap-nonce": nonce, "x-zap-signature": signature(descriptor.secret, timestamp, nonce, text) } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 64 * 1024) { request.destroy(); fail("Owner reply exceeds limit"); } else chunks.push(Buffer.from(chunk)); });
      response.once("error", () => fail("Owner connection failed"));
      response.once("end", () => { detach(); if (response.statusCode !== 200) { fail("Owner rejected the operation"); return; } try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { fail("Malformed owner reply"); } });
    });
    // Some runtimes close an aborted Unix request without emitting its error.
    // Settle our wait explicitly; transport cancellation is not a stop receipt.
    const cancel = () => {
      detach(); request.destroy();
      // Transport close is not reliably observable by every HTTP runtime.
      // This independent, authenticated request never carries a cancellation
      // signal itself, and its failure does not establish process disposition.
      void call({ kind: "cancel", requestNonce: nonce }).catch(() => {});
      reject(new Error("Owner request cancelled"));
    };
    request.setTimeout(30_000, () => request.destroy(new Error("Owner reply timeout")));
    request.once("error", () => fail("Owner connection unavailable"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel(); else request.end(text);
  });
  const handshake = z.object({ capabilities: ServiceCapabilitiesSchema, workspace: DescriptorSchema.shape.workspace }).strict().parse(await call({ kind: "capabilities" }));
  if (executionDigest(handshake) !== executionDigest({ capabilities: descriptor.capabilities, workspace: descriptor.workspace })) throw new Error("Owner identity changed");
  return { capabilities: Object.freeze(descriptor.capabilities), workspace: Object.freeze(descriptor.workspace), journal: new FileServiceDispatchJournal(join(root, "client-dispatch")),
    lookup: (operationId, authority, signal) => call({ kind: "lookup", operationId, authority }, signal),
    start: (intent, authority, signal) => call({ kind: "start", intent, authority }, signal),
    status: (serviceId, authority, signal) => call({ kind: "status", serviceId, authority }, signal),
    stop: (serviceId, authority, signal) => call({ kind: "stop", serviceId, authority }, signal) };
}

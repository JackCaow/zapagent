import { DefaultExecutionBroker } from "../../execution/broker.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { serviceTools } from "../../services/tools.js";
import { randomUUID, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readdir } from "node:fs/promises";
import { createCapabilityGrant } from "../../policy/engine.js";
import { serviceEffects } from "../../services/tools.js";
import { createServiceOperationId, createServiceStartIntent } from "../../services/contracts.js";
import { FileServiceDispatchJournal } from "../../services/file-journal.js";
import { executionDigest } from "../../execution/observation.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS } from "../../tools/effects.js";
import type { AuthorizedServiceBackend, ServiceExecutionAuthority } from "../../services/execution.js";
import { createCustomProvider, getDefaultConfig } from "../../../src/config.js";
import { parseHeadlessArgs } from "../../../src/headless/args.js";
import { buildHeadlessApproval } from "../../../src/headless/approval.js";
import { afterEach, expect, it, spyOn } from "bun:test";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { connectLocalServiceOwner, startLocalServiceOwner } from "../../services/local-owner.js";
const native = process.platform !== "win32" && createPlatformSandbox().status().available ? it : it.skip;
const filteredNative = process.platform === "darwin" ? native : it.skip;
const roots: string[] = [], owners: ChildProcess[] = [];
const worker = fileURLToPath(new URL("./fixtures/local-owner-worker.ts", import.meta.url));
const client = fileURLToPath(new URL("./fixtures/local-owner-client.ts", import.meta.url));
const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function exit(child: ChildProcess, milliseconds = 8000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fixture did not exit")); }, milliseconds);
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", code => { clearTimeout(timer); resolve(code); }); });
}
afterEach(async () => {
  for (const child of owners.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exit(child).catch(() => {}); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(overrides: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zap-owner-test-"))); roots.push(root);
  const workspace = join(root, "workspace"), control = join(root, "control"); await mkdir(workspace); await mkdir(control, { mode: 0o700 });
  const config = join(control, "fixture.json");
  await writeFile(config, JSON.stringify({ controlDirectory: control, workspace: { id: "owner-workspace", root: workspace }, ownerExpiresAt: Date.now() + 60_000, defaultLeaseMs: 20_000, maxLeaseMs: 30_000,
    ...(process.platform === "linux" ? { networkPolicy: { mode: "open" } } : {}), ...overrides }), { mode: 0o600 });
  const child = spawn(process.execPath, [worker, config], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: join(root, "data") } }); owners.push(child);
  let stdout = "", stderr = ""; child.stdout!.on("data", data => stdout += data); child.stderr!.on("data", data => stderr += data);
  const deadline = Date.now() + 10_000;
  while (!stdout.includes("\n") && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!stdout.includes("\n")) throw new Error("owner startup failed: " + stderr);
  const descriptorPath = JSON.parse(stdout.split("\n")[0]!).descriptorPath as string;
  const source = join(workspace, "service.ts");
  await writeFile(source, `import {createServer} from 'node:http';import{writeFileSync}from'node:fs';const s=createServer((_q,r)=>r.end('neutral-service'));s.listen(0,'127.0.0.1',()=>writeFileSync('port',String(s.address().port)));`);
  const command = `exec ${shell(process.execPath)} ${shell(source)}`;
  async function call(tool: string, args: object) {
    const input = join(control, `call-${Date.now()}-${Math.random()}.json`); await writeFile(input, JSON.stringify({ descriptorPath, tool, args }), { mode: 0o600 });
    const child = spawn(process.execPath, [client, input], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: join(root, "client-data") } });
    let out = "", err = ""; child.stdout!.on("data", data => out += data); child.stderr!.on("data", data => err += data);
    const code = await exit(child); if (!out.trim()) throw new Error(`client exit ${code}: ${err}`);
    return { code, result: JSON.parse(out.trim().split("\n").at(-1)!) };
  }
  async function endpoint() {
    const end = Date.now() + 3000;
    while (Date.now() < end) { try { const port = Number(await readFile(join(workspace, "port"), "utf8")); const url = `http://127.0.0.1:${port}`; if (await (await fetch(url)).text() === "neutral-service") return url; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error("service did not become reachable");
  }
  return { root, workspace, control, owner: child, descriptorPath, command, call, endpoint };
}
async function unreachable(url: string) { try { await fetch(url, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; } }

(process.platform !== "win32" ? it : it.skip)("rejects a descriptor FIFO without waiting for a writer before owner admission", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zap-owner-fifo-"))); roots.push(root);
  const control = join(root, "control"); await mkdir(control, { mode: 0o700 });
  const path = join(control, "owner.json"); execFileSync("mkfifo", [path]);
  // A child process bounds this regression even if descriptor open blocks.
  const script = `import { connectLocalServiceOwner } from ${JSON.stringify(resolve("zapsdk/services/local-owner.ts"))};
    try { await connectLocalServiceOwner(process.argv[1]); process.exitCode = 1 }
    catch (error) { console.log(error.message) }`;
  const result = await promisify(execFile)(process.execPath, ["-e", script, path], { timeout: 3000 });
  expect(result.stdout).toContain("Owner file is not private");
});

(process.platform === "linux" ? it : it.skip)("Linux owner rejects an unenforceable domain allowlist before publishing controls or launching services", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zap-owner-policy-test-"))); roots.push(root);
  const workspace = join(root, "workspace"), control = join(root, "control");
  await mkdir(workspace); await mkdir(control, { mode: 0o700 });
  await expect(startLocalServiceOwner({ controlDirectory: control, workspace: { id: "policy-workspace", root: workspace },
    ownerExpiresAt: Date.now() + 60_000, defaultLeaseMs: 20_000, maxLeaseMs: 30_000,
    networkPolicy: { mode: "allowlist", allowedDomains: ["allowed.invalid"], deniedDomains: [] },
  })).rejects.toThrow("cannot enforce a domain allowlist");
  expect((await readdir(control)).sort()).toEqual(["dispatch", "records"]);
  expect(await readdir(join(control, "records"))).toEqual([]);
  expect(await readdir(join(control, "dispatch"))).toEqual([]);
});

native("real owner retains a sandboxed HTTP service after its separate client exits, then stops it by owned identity", async () => {
  const f = await setup(); const start = await f.call("service_start", { command: f.command, network: true });
  expect(start.code).toBe(0); expect(start.result.runtime.service.state).toBe("running");
  const url = await f.endpoint(); expect(await (await fetch(url)).text()).toBe("neutral-service");
  const receipt = start.result.runtime.service;
  const status = await f.call("service_status", { operation_id: receipt.operationId }); expect(status.result.runtime.service.serviceId).toBe(receipt.serviceId);
  const stop = await f.call("service_stop", { service_id: receipt.serviceId }); expect(stop.result.runtime.service.state).toBe("stopped"); expect(await unreachable(url)).toBe(true);
}, 25_000);

native("real lease expiry closes the owned process and retains an expired observation", async () => {
  const f = await setup(); const start = await f.call("service_start", { command: f.command, network: true, lease_ms: 2000 }); expect(start.code).toBe(0);
  const url = await f.endpoint(); const receipt = start.result.runtime.service;
  while (Date.now() < receipt.expiresAt + 500) await new Promise(resolve => setTimeout(resolve, 20));
  const status = await f.call("service_status", { operation_id: receipt.operationId }); expect(status.result.runtime.service.state).toBe("expired"); expect(await unreachable(url)).toBe(true);
}, 25_000);

native("owner close drains its actual process handles and an unauthenticated client cannot query it", async () => {
  const f = await setup(); const start = await f.call("service_start", { command: f.command, network: true }); expect(start.code).toBe(0);
  const url = await f.endpoint();
  const descriptor = JSON.parse(await readFile(f.descriptorPath, "utf8"));
  const wrong = join(f.control, "wrong.json"); await writeFile(wrong, JSON.stringify({ ...descriptor, secret: "0".repeat(64) }), { mode: 0o600 });
  await expect(connectLocalServiceOwner(wrong)).rejects.toThrow("rejected");
  f.owner.kill("SIGTERM"); expect(await exit(f.owner)).toBe(0); expect(await unreachable(url)).toBe(true);
  await expect(connectLocalServiceOwner(f.descriptorPath)).rejects.toThrow("unavailable");
}, 25_000);


native("real Headless CLI exits before its owner-held HTTP service and records the independent receipt", async () => {
  const f = await setup(); let requests = 0, deniedQuery = false;
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any; requests++;
    const used = body.messages.some((m: any) => m.role === "tool");
    const delta = used ? { content: "The process owner returned an observation." }
      : { tool_calls: [{ index: 0, id: "owner-start", type: "function", function: { name: deniedQuery ? "service_status" : "service_start", arguments: JSON.stringify(deniedQuery ? { operation_id: "denied-query" } : { command: f.command, network: true, lease_ms: 20_000 }) } }] };
    const frame = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`;
    return new Response(frame(delta, null) + frame({}, used ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const data = join(f.root, "cli-data"); await mkdir(data);
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture"], contextWindow: 128000 });
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), allowUnsandboxedCommands: false,
      ...(process.platform === "linux" ? { sandboxNetwork: { mode: "open" } } : {}), providers: [provider], active: { providerId: provider.id, model: "fixture" } }), { mode: 0o600 });
    const run = async (extra: string[] = []) => {
      const child = spawn(process.execPath, [resolve("src/index.tsx"), "--print", "Start the authorized neutral HTTP service and report its owner receipt.", "--cwd", f.workspace,
        "--output-format", "stream-json", "--result-schema", "outcome-v1", "--permission-mode", "default", "--allowed-tools", "service_start,service_status,service_stop", "--service-owner", f.descriptorPath, "--no-devtools", "--max-turns", "4", ...extra],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_EXECUTION: "local", ZAPCODE_SANDBOX_NETWORK: "" } });
      let stdout = "", stderr = ""; child.stdout!.on("data", d => stdout += d); child.stderr!.on("data", d => stderr += d);
      return { code: await exit(child, 20_000), stdout, stderr };
    };
    const { code, stdout, stderr } = await run(); if (code !== 0) throw new Error(stderr + stdout);
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line)); const final = lines.at(-1);
    expect(final.schema).toBe("zap.outcome"); expect(final.execution.services[0].state).toBe("running"); expect(final.acceptance.status).toBe("unverified");
    expect(requests).toBeGreaterThanOrEqual(2);
    const url = await f.endpoint(); expect(await (await fetch(url)).text()).toBe("neutral-service");
    const stopped = await f.call("service_stop", { service_id: final.execution.services[0].serviceId }); expect(stopped.result.runtime.service.state).toBe("stopped"); expect(await unreachable(url)).toBe(true);
    const descriptor = JSON.parse(await readFile(f.descriptorPath, "utf8")); expect(stdout + stderr).not.toContain(descriptor.secret);
    deniedQuery = true;
    const denied = await run(["--disallowed-tools", "service_status"]);
    const denial = denied.stdout.trim().split("\n").map(line => JSON.parse(line)).find(e => e.type === "tool_result" && e.name === "service_status");
    expect(denial.ok).toBe(false); expect(denial.failure.code).toBe("POLICY_DENIED"); expect(denial.serviceOperation).toBeUndefined();
    const previousRequests = requests;
    const config = JSON.parse(await readFile(join(data, "config.json"), "utf8"));
    config.sandboxNetwork = process.platform === "linux" ? { mode: "allowlist", allowedDomains: [], deniedDomains: [] } : { mode: "open" };
    await writeFile(join(data, "config.json"), JSON.stringify(config), { mode: 0o600 });
    const incompatible = await run(); expect(incompatible.code).toBe(2); expect(requests).toBe(previousRequests);
    expect(incompatible.stderr).toContain("incompatible Host service owner");
  } finally { model.stop(); }
}, 35_000);

it("service owner selection remains explicit and service commands obey plan, deny and dangerous-command gates", async () => {
  const absent = parseHeadlessArgs(["--print", "ordinary"]); expect(absent.ok && absent.args.serviceOwner).toBeUndefined();
  const selected = parseHeadlessArgs(["--print", "ordinary", "--service-owner", "owner.json"]); expect(selected.ok && selected.args.serviceOwner).toBe("owner.json");
  expect(parseHeadlessArgs(["--print", "ordinary", "--service-owner", "a", "--service-owner", "b"]).ok).toBe(false);
  for (const tool of ["service_start", "service_stop"]) {
    const decision = await buildHeadlessApproval({ cwd: process.cwd(), permissionMode: "plan", allowedTools: [tool] }).onApproval(tool, { command: "neutral-http" });
    expect(decision).toMatchObject({ approved: false, source: "policy" });
  }
  const denied = await buildHeadlessApproval({ cwd: process.cwd(), permissionMode: "bypassPermissions", disallowedTools: ["service_start"] }).onApproval("service_start", { command: "neutral-http" });
  expect(denied).toMatchObject({ approved: false, source: "policy" });
  const dangerous = await buildHeadlessApproval({ cwd: process.cwd(), permissionMode: "bypassPermissions", allowedTools: ["service_start"] }).onApproval("service_start", { command: "sudo echo forbidden" });
  expect(dangerous).toMatchObject({ approved: false, source: "policy" });
});


function authority(backend: AuthorizedServiceBackend, args = { command: "exit 0", network: true }): ServiceExecutionAuthority {
  const workspace = { ...backend.workspace, mode: "root" as const }, effects = serviceEffects("start", backend.capabilities, workspace, args);
  return { executionId: "execution:owner-check", dispatchIdentity: randomUUID(), identity: { sessionId: "host-check", toolCallId: "owner-check" },
    name: "service_start", args, effects, grant: createCapabilityGrant("owner-check", effects, Date.now() + 5000), workspace,
    limits: { ...DEFAULT_TOOL_RESOURCE_LIMITS }, sandboxMode: "required", deadlineAtMs: Date.now() + 5000 };
}
function intent(backend: AuthorizedServiceBackend, a: ServiceExecutionAuthority) {
  const digest = executionDigest(a), cap = backend.capabilities;
  return createServiceStartIntent(cap, { operationId: createServiceOperationId(cap, a.dispatchIdentity), command: a.args.command as string,
    cwd: backend.workspace.root, authorizationDigest: digest });
}

for (const boundary of ["cancellation", "grant expiry", "deadline expiry"] as const) {
native(`owner stops an unacknowledged start on ${boundary} while its durable receipt is pending`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zap-owner-receipt-cancel-"))); roots.push(root);
  const workspace = join(root, "workspace"), control = join(root, "control");
  await mkdir(workspace); await mkdir(control, { mode: 0o700 });
  const owner = await startLocalServiceOwner({ controlDirectory: control, workspace: { id: "receipt-cancel-workspace", root: workspace },
    ownerExpiresAt: Date.now() + 60_000, defaultLeaseMs: 20_000, maxLeaseMs: 30_000,
    ...(process.platform === "linux" ? { networkPolicy: { mode: "open" as const } } : {}),
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const bind = FileServiceDispatchJournal.prototype.bindReceipt;
  const delayed = spyOn(FileServiceDispatchJournal.prototype, "bindReceipt").mockImplementation(async function (this: FileServiceDispatchJournal, value, receipt) {
    if (value.ownerId === owner.capabilities.ownerId) { entered(); await gate; }
    return bind.call(this, value, receipt);
  });
  let pending: Promise<unknown> | undefined;
  try {
    const backend = await connectLocalServiceOwner(owner.descriptorPath);
    const source = "require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);";
    const a = authority(backend, { command: `exec ${shell(process.execPath)} -e ${shell(source)}`, network: false });
    const expiresAt = Date.now() + 1000;
    if (boundary === "grant expiry") a.grant.expiresAt = expiresAt;
    if (boundary === "deadline expiry") a.deadlineAtMs = expiresAt;
    const startIntent = intent(backend, a), abort = new AbortController();
    pending = backend.start(startIntent, a, abort.signal);
    const rejected = pending.then(() => false, () => true);
    await reached;
    const pidPath = join(workspace, "pid"), readyDeadline = Date.now() + 3000;
    let pid: number | undefined;
    while (!pid && Date.now() < readyDeadline) { try { pid = Number(await readFile(pidPath, "utf8")); } catch { await delay(10); } }
    expect(pid).toBeDefined();
    if (boundary === "cancellation") {
      abort.abort();
      expect(await Promise.race([rejected, delay(250).then(() => false)])).toBe(true);
      // Let the owner observe transport cancellation while durability waits.
      await delay(100);
    } else await delay(Math.max(0, expiresAt - Date.now() + 20));
    release();
    expect(await rejected).toBe(true);
    const args = { operation_id: startIntent.operationId }, boundWorkspace = { ...backend.workspace, mode: "root" as const };
    const effects = serviceEffects("status", backend.capabilities, boundWorkspace, args);
    const query: ServiceExecutionAuthority = { ...a, dispatchIdentity: randomUUID(), name: "service_status", args, effects,
      grant: createCapabilityGrant(a.grant.callId, effects, Date.now() + 5000), deadlineAtMs: Date.now() + 5000 };
    const deadline = Date.now() + 3000; let state: string | undefined;
    while (Date.now() < deadline) {
      const found = await backend.lookup(startIntent.operationId, query) as { state: string; receipt?: { state: string } };
      state = found.receipt?.state;
      if (state === "stopped") break;
      await delay(20);
    }
    expect(state).toBe("stopped");
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally { release(); await pending?.catch(() => {}); await owner.close(); delayed.mockRestore(); }
}, 10_000);
}

native("owner close drains a disconnected start waiting for durable intent before reporting closed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zap-owner-drain-"))); roots.push(root);
  const workspace = join(root, "workspace"), control = join(root, "control");
  await mkdir(workspace); await mkdir(control, { mode: 0o700 });
  const owner = await startLocalServiceOwner({ controlDirectory: control, workspace: { id: "drain-workspace", root: workspace },
    ownerExpiresAt: Date.now() + 60_000, defaultLeaseMs: 20_000, maxLeaseMs: 30_000,
    ...(process.platform === "linux" ? { networkPolicy: { mode: "open" as const } } : {}),
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const bind = FileServiceDispatchJournal.prototype.bindIntent;
  const delayed = spyOn(FileServiceDispatchJournal.prototype, "bindIntent").mockImplementation(async function (this: FileServiceDispatchJournal, value) {
    if (value.ownerId === owner.capabilities.ownerId) { entered(); await gate; }
    return bind.call(this, value);
  });
  let pending: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    const backend = await connectLocalServiceOwner(owner.descriptorPath);
    const a = authority(backend, { command: "printf started > should-not-start", network: false });
    const abort = new AbortController();
    pending = backend.start(intent(backend, a), a, abort.signal).catch(() => undefined);
    await reached;
    abort.abort();
    const cancelled = await Promise.race([pending.then(() => true), delay(250).then(() => false)]);
    expect(cancelled).toBe(true);
    closing = owner.close();
    const state = await Promise.race([closing.then(() => "closed"), delay(2000).then(() => "pending")]);
    expect(state).toBe("pending");
    release(); await pending; await closing;
    const files = await readdir(join(control, "records")); expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(join(control, "records", files[0]!), "utf8"));
    expect(record.receipt.state).toBe("unknown"); expect(record.taskId).toBeUndefined();
    await expect(readFile(join(workspace, "should-not-start"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release(); await Promise.race([pending, delay(250)]); await (closing ?? owner.close()); delayed.mockRestore();
    // On the pre-fix path the disconnected handler can still write after close.
    // Let only this owned operation settle before removing its private fixture.
    for (let step = 0; step < 100; step++) {
      const files = await readdir(join(control, "records"));
      if (files.length && ["unknown", "stopped", "expired"].includes(JSON.parse(await readFile(join(control, "records", files[0]!), "utf8")).receipt.state)) break;
      await delay(20);
    }
  }
}, 10_000);

native("owner independently rejects missing process grants and grants exposing its signing controls", async () => {
  const f = await setup(), backend = await connectLocalServiceOwner(f.descriptorPath);
  const missing = authority(backend); delete missing.grant.process;
  await expect(backend.start(intent(backend, missing), missing)).rejects.toThrow("rejected");
  const controls = authority(backend); controls.grant.filesystem!.read.push(f.descriptorPath);
  await expect(backend.start(intent(backend, controls), controls)).rejects.toThrow("rejected");
  expect(await readdir(join(f.control, "records"))).toEqual([]);
}, 20_000);

native("real service sandbox denies owner-descriptor reads and network calls absent from the grant", async () => {
  const f = await setup();
  const source = join(f.workspace, "deny-controls.ts");
  await writeFile(source, `import{readFileSync,writeFileSync}from'node:fs';let text='DENIED';try{text=readFileSync(${JSON.stringify(f.descriptorPath)},'utf8')}catch{}writeFileSync('control-result',text);`);
  const read = await f.call("service_start", { command: `exec ${shell(process.execPath)} ${shell(source)}`, network: false }); expect(read.code).toBe(0);
  const end = Date.now() + 3000;
  while (Date.now() < end) { try { if (await readFile(join(f.workspace, "control-result"), "utf8") === "DENIED") break; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(await readFile(join(f.workspace, "control-result"), "utf8")).toBe("DENIED");
  let contacted = false; const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { contacted = true; return new Response("contacted"); } });
  try {
    const netSource = join(f.workspace, "deny-network.ts");
    await writeFile(netSource, `import{writeFileSync}from'node:fs';try{await fetch('http://127.0.0.1:${server.port}');writeFileSync('network-result','ALLOWED')}catch{writeFileSync('network-result','DENIED')}`);
    const net = await f.call("service_start", { command: `exec ${shell(process.execPath)} ${shell(netSource)}`, network: false }); expect(net.code).toBe(0);
    const end = Date.now() + 3000;
    while (Date.now() < end) { try { await readFile(join(f.workspace, "network-result")); break; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(await readFile(join(f.workspace, "network-result"), "utf8")).toBe("DENIED"); expect(contacted).toBe(false);
  } finally { server.stop(); }
}, 25_000);

native("authenticated owner RPC rejects a replayed signed request", async () => {
  const f = await setup(), descriptor = JSON.parse(await readFile(f.descriptorPath, "utf8"));
  const text = JSON.stringify({ kind: "capabilities" }), timestamp = String(Date.now()), nonce = randomUUID();
  const signed = createHmac("sha256", Buffer.from(descriptor.secret, "hex")).update(`${timestamp}\n${nonce}\n${text}`).digest("hex");
  const send = () => new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({ socketPath: descriptor.socket, path: "/v1/owner", method: "POST", headers: { "content-length": Buffer.byteLength(text),
      "x-zap-time": timestamp, "x-zap-nonce": nonce, "x-zap-signature": signed } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    request.once("error", reject); request.end(text);
  });
  expect(await send()).toBe(200); expect(await send()).toBe(403);
}, 20_000);

native("authenticated cancellation can arrive before its start and cannot be replayed", async () => {
  const f = await setup(), backend = await connectLocalServiceOwner(f.descriptorPath);
  const descriptor = JSON.parse(await readFile(f.descriptorPath, "utf8"));
  const target = randomUUID(), cancelNonce = randomUUID();
  const send = (value: unknown, nonce: string) => new Promise<number | undefined>((resolve, reject) => {
    const text = JSON.stringify(value), timestamp = String(Date.now());
    const signed = createHmac("sha256", Buffer.from(descriptor.secret, "hex")).update(`${timestamp}\n${nonce}\n${text}`).digest("hex");
    const request = httpRequest({ socketPath: descriptor.socket, path: "/v1/owner", method: "POST", headers: { "content-length": Buffer.byteLength(text),
      "x-zap-time": timestamp, "x-zap-nonce": nonce, "x-zap-signature": signed } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    request.once("error", reject); request.end(text);
  });
  expect(await send({ kind: "cancel", requestNonce: "invalid-target" }, randomUUID())).toBe(403);
  expect(await send({ kind: "cancel", requestNonce: target }, cancelNonce)).toBe(200);
  expect(await send({ kind: "cancel", requestNonce: target }, cancelNonce)).toBe(403);
  const a = authority(backend, { command: "printf started > should-not-start", network: false });
  expect(await send({ kind: "start", intent: intent(backend, a), authority: a }, target)).toBe(403);
  await expect(readFile(join(f.workspace, "should-not-start"))).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);


native("owner capacity reserves concurrent authorized starts before disk or process side effects", async () => {
  const f = await setup({ maxServices: 1 }), backend = await connectLocalServiceOwner(f.descriptorPath);
  const a = authority(backend, { command: f.command, network: true }), b = authority(backend, { command: f.command, network: true });
  const results = await Promise.allSettled([backend.start(intent(backend, a), a), backend.start(intent(backend, b), b)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(await readdir(join(f.control, "records"))).toHaveLength(1);
}, 20_000);

native("a cleanly closed owner may use a fresh generation but old clients cannot silently switch", async () => {
  const f = await setup(), old = await connectLocalServiceOwner(f.descriptorPath);
  const start = await f.call("service_start", { command: f.command, network: true }); const url = await f.endpoint();
  await f.call("service_stop", { service_id: start.result.runtime.service.serviceId });
  f.owner.kill("SIGTERM"); expect(await exit(f.owner)).toBe(0); expect(await unreachable(url)).toBe(true);
  const child = spawn(process.execPath, [worker, join(f.control, "fixture.json")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: join(f.root, "restart-data") } }); owners.push(child);
  let ready = "", error = ""; child.stdout!.on("data", d => ready += d); child.stderr!.on("data", d => error += d);
  const end = Date.now() + 5000;
  while (!ready.includes("\n") && child.exitCode === null && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  if (!ready.includes("\n")) throw new Error("clean owner restart failed: " + error);
  const current = await connectLocalServiceOwner(f.descriptorPath); expect(current.capabilities.ownerGeneration).not.toBe(old.capabilities.ownerGeneration);
  const a = authority(old); await expect(old.lookup("old", a)).rejects.toThrow("rejected");
}, 25_000);

native("owner crash is unavailable and unresolved old records prevent PID adoption or automatic replacement", async () => {
  const f = await setup();
  await writeFile(join(f.workspace, "service.ts"), `import{createServer}from'node:http';import{writeFileSync}from'node:fs';const s=createServer((_q,r)=>r.end('neutral-service'));s.listen(0,'127.0.0.1',()=>writeFileSync('port',String(s.address().port)));setTimeout(()=>s.close(),1500);`);
  const start = await f.call("service_start", { command: f.command, network: true }); expect(start.code).toBe(0); const url = await f.endpoint();
  const backend = await connectLocalServiceOwner(f.descriptorPath), workspace = { ...backend.workspace, mode: "root" as const };
  const broker = new DefaultExecutionBroker({ services: backend, sandboxMode: "required", allowUnsandboxed: false });
  const registry = new ToolRegistry(); serviceTools(broker, workspace).forEach(tool => registry.register(tool));
  const executor = new ToolExecutor(registry, { executionBroker: broker, workspace, cwd: workspace.root, onApproval: async () => true });
  f.owner.kill("SIGKILL"); await exit(f.owner); await expect(connectLocalServiceOwner(f.descriptorPath)).rejects.toThrow("unavailable");
  const unknown = await executor.execute("service_status", { operation_id: start.result.runtime.service.operationId });
  expect(unknown.success).toBe(false); expect(unknown.runtime?.service).toBeUndefined(); expect(unknown.runtime?.serviceOperation?.state).toBe("unknown");
  const child = spawn(process.execPath, [worker, join(f.control, "fixture.json")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: join(f.root, "crash-data") } }); owners.push(child);
  let out = ""; child.stdout!.on("data", d => out += d); child.stderr!.resume(); expect(await exit(child)).toBe(1); expect(out).toBe("");
  // This fixture has its own short application lifetime, so the test does not
  // adopt or signal a persisted PID to clean up after a deliberate owner crash.
  const end = Date.now() + 4000;
  while (!(await unreachable(url)) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  expect(await unreachable(url)).toBe(true);
}, 25_000);


filteredNative("real owner keeps the configured domain filter rather than widening a network grant", async () => {
  const f = await setup({ networkPolicy: { mode: "allowlist", allowedDomains: ["allowed.invalid"], deniedDomains: [] } });
  const source = join(f.workspace, "proxy-check.ts");
  await writeFile(source, `import{request}from'node:http';import{writeFileSync}from'node:fs';const p=new URL(process.env.HTTP_PROXY);const r=request({host:p.hostname,port:p.port,path:'http://blocked.invalid/',method:'GET'},s=>{s.resume();s.on('end',()=>writeFileSync('proxy-result',String(s.statusCode)))});r.on('error',()=>writeFileSync('proxy-result','ERROR'));r.end();`);
  const result = await f.call("service_start", { command: `exec ${shell(process.execPath)} ${shell(source)}`, network: true }); expect(result.code).toBe(0);
  const end = Date.now() + 3000;
  while (Date.now() < end) { try { await readFile(join(f.workspace, "proxy-result")); break; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(await readFile(join(f.workspace, "proxy-result"), "utf8")).toBe("403");
}, 20_000);


native("a second daemon cannot replace an active owner's socket or descriptor", async () => {
  const f = await setup(), before = await readFile(f.descriptorPath, "utf8");
  const child = spawn(process.execPath, [worker, join(f.control, "fixture.json")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: join(f.root, "duplicate-data") } }); owners.push(child);
  child.stdout!.resume(); child.stderr!.resume(); expect(await exit(child)).toBe(1);
  expect(await readFile(f.descriptorPath, "utf8")).toBe(before); await expect(connectLocalServiceOwner(f.descriptorPath)).resolves.toBeDefined();
}, 20_000);

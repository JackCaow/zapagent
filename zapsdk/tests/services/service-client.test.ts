import { afterEach, beforeEach, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionDigest } from "../../execution/observation.js";
import { BoundServiceClient } from "../../services/client.js";
import { FileServiceDispatchJournal } from "../../services/file-journal.js";
import { createServiceStartIntent, observeServiceReceipt, parseServiceReceipt, ServiceCapabilitiesSchema,
  type ServiceCapabilities, type ServiceLookup, type ServiceReceipt, type ServiceStartIntent, type ServiceTransport } from "../../services/contracts.js";

let root: string, now: number;
let cap: ServiceCapabilities;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-service-journal-"));
  chmodSync(root, 0o700);
  now = Date.now();
  cap = { version: 1, backendId: "selected-backend", ownerId: "owner", ownerGeneration: "generation-a", workspaceId: "workspace-a",
    ownerScope: "environment", defaultLeaseMs: 30_000, maxLeaseMs: 60_000, ownerExpiresAt: now + 120_000 };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function intent(changes: Partial<Parameters<typeof createServiceStartIntent>[1]> = {}): ServiceStartIntent {
  return createServiceStartIntent(cap, { operationId: "operation-a", command: "neutral-service", cwd: "/workspace", authorizationDigest: "a".repeat(64), ...changes }, now);
}
function receipt(request: ServiceStartIntent, changes: Partial<ServiceReceipt> = {}): ServiceReceipt {
  return { version: 1, backendId: cap.backendId, ownerId: cap.ownerId, ownerGeneration: cap.ownerGeneration, workspaceId: cap.workspaceId,
    ownerScope: cap.ownerScope, operationId: request.operationId, serviceId: "service-a", requestDigest: request.requestDigest, state: "running", observedAt: now,
    expiresAt: request.expiresAt, ...changes };
}
class Backend implements ServiceTransport {
  starts = 0;
  lookups = 0;
  current: ServiceLookup = { state: "absent" };
  dropReply = false;
  async lookup() { this.lookups++; return this.current; }
  async start(request: ServiceStartIntent) {
    this.starts++;
    const value = receipt(request);
    this.current = { state: "present", receipt: value };
    if (this.dropReply) throw new Error("reply lost");
    return value;
  }
}
const durableTest = process.platform === "win32" ? it.skip : it;

it("rejects malformed capabilities and Host lease overruns", () => {
  expect(() => ServiceCapabilitiesSchema.parse({ ...cap, defaultLeaseMs: 60_001 })).toThrow();
  for (const leaseMs of [0, -1, NaN, Infinity, 60_001]) expect(() => intent({ leaseMs })).toThrow();
  expect(() => createServiceStartIntent({ ...cap, ownerExpiresAt: now + 100 }, { operationId: "a", command: "c", cwd: "/w", authorizationDigest: "a".repeat(64) }, now)).toThrow();
});
it("request binding changes for command, cwd, authorization or lease; it grants no permission", () => {
  const original = intent();
  for (const change of [{ command: "different" }, { cwd: "/other" }, { authorizationDigest: "b".repeat(64) }, { leaseMs: 1000 }]) {
    expect(intent(change).requestDigest).not.toBe(original.requestDigest);
  }
  expect(Object.isFrozen(original)).toBe(true);
});
for (const field of ["backendId", "ownerId", "ownerGeneration", "workspaceId", "ownerScope", "operationId", "requestDigest", "expiresAt"] as const) {
  it(`rejects a service receipt with changed ${field}`, () => {
    const request = intent();
    const value = receipt(request, { [field]: field === "expiresAt" ? request.expiresAt + 1 : field === "requestDigest" ? "b".repeat(64) : field === "ownerScope" ? "host-session" : "different" });
    expect(() => parseServiceReceipt(value, cap, request)).toThrow();
  });
}
it("expiry, stale and future observations never prove process termination or health", () => {
  const value = receipt(intent());
  expect(observeServiceReceipt(value, now + 10, 100)).toEqual({ lease: "active", processObservedRunning: true });
  expect(observeServiceReceipt(value, now + 101, 100)).toEqual({ lease: "unknown", processObservedRunning: false });
  expect(observeServiceReceipt(value, now - 1, 100)).toEqual({ lease: "unknown", processObservedRunning: false });
  expect(observeServiceReceipt(value, value.expiresAt, 100_000)).toEqual({ lease: "expired", processObservedRunning: false });
  expect(value.state).toBe("running");
  expect(observeServiceReceipt({ ...value, state: "unknown" }, now, 100).processObservedRunning).toBe(false);
});
it("an environment client refuses an in-memory dispatch journal", () => {
  expect(() => new BoundServiceClient(cap, new Backend(), { durability: "host-session", async bindIntent() {}, async claimDispatch() { return true; }, async bindReceipt() {} })).toThrow("durable");
});

durableTest("durable client recovers a dropped acknowledgement after reopening without a second start", async () => {
  const backend = new Backend(); backend.dropReply = true;
  const request = intent();
  const first = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root));
  await expect(first.start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  const second = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root));
  expect(await second.start(request)).toEqual(receipt(request));
  expect(backend.starts).toBe(1);
  expect(readdirSync(root).filter(name => name.endsWith(".json"))).toHaveLength(3);
  for (const file of readdirSync(root)) {
    expect(lstatSync(join(root, file)).mode & 0o077).toBe(0);
    expect(readFileSync(join(root, file), "utf8")).not.toContain("neutral-service");
    expect(readFileSync(join(root, file), "utf8")).not.toContain("authorizationDigest");
  }
});
durableTest("unknown prior dispatch stays unknown when the backend later reports absence", async () => {
  const backend = new Backend(); backend.start = async () => { backend.starts++; throw new Error("connection lost"); };
  const request = intent();
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  expect(backend.starts).toBe(1);
});
durableTest("transient lookup failure can be queried again without prematurely claiming a dispatch", async () => {
  const backend = new Backend(); let first = true;
  backend.lookup = async () => { backend.lookups++; if (first) { first = false; throw new Error("query lost"); } return backend.current; };
  const client = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root));
  const request = intent();
  await expect(client.start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  expect(backend.starts).toBe(0);
  expect(await client.start(request)).toEqual(receipt(request));
  expect(backend.starts).toBe(1);
});
durableTest("reused operation with a changed request is rejected before backend interaction", async () => {
  const backend = new Backend(); const request = intent();
  await new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request);
  const calls = backend.lookups;
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(intent({ command: "different" }))).rejects.toMatchObject({ code: "SERVICE_OPERATION_CONFLICT" });
  expect(backend.starts).toBe(1); expect(backend.lookups).toBe(calls);
});
durableTest("concurrent calls and two journals have exactly one durable dispatch claim", async () => {
  const request = intent();
  const journals = Array.from({ length: 8 }, () => new FileServiceDispatchJournal(root));
  await Promise.all(journals.map(j => j.bindIntent(request)));
  const claims = await Promise.all(journals.map(j => j.claimDispatch(request)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(readdirSync(root).filter(name => name.startsWith(".pending-"))).toHaveLength(0);
  const backend = new Backend(); const other = intent({ operationId: "b" });
  const client = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root));
  const results = await Promise.all([client.start(other), client.start(other)]);
  expect(results[0]).toEqual(results[1]); expect(backend.starts).toBe(1);
});
durableTest("bound service identity cannot silently change after a client restart", async () => {
  const backend = new Backend(); const request = intent();
  await new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request);
  backend.current = { state: "present", receipt: receipt(request, { serviceId: "replacement" }) };
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_CONFLICT" });
  expect(backend.starts).toBe(1);
});
durableTest("corrupt durable intent or dispatch records fail closed without starting", async () => {
  const request = intent(); const journal = new FileServiceDispatchJournal(root);
  await journal.bindIntent(request);
  const path = join(root, readdirSync(root).find(name => name.endsWith(".intent.json"))!);
  writeFileSync(path, "{", { mode: 0o600 });
  const backend = new Backend();
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_JOURNAL_INVALID" });
  expect(backend.starts).toBe(0); expect(backend.lookups).toBe(0);
});
durableTest("journal failure, unknown backend and cancellation do not launch a service", async () => {
  const request = intent(); const backend = new Backend();
  const broken = { durability: "durable" as const, async bindIntent() { throw new Error("disk unavailable"); }, async claimDispatch() { return true; }, async bindReceipt() {} };
  await expect(new BoundServiceClient(cap, backend, broken).start(request)).rejects.toThrow("disk unavailable");
  backend.current = { state: "unknown" };
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request, abort.signal)).rejects.toThrow("cancelled");
  expect(backend.starts).toBe(0);
});
durableTest("invalid start receipt cannot authorize a replay of the original start", async () => {
  const backend = new Backend(); const request = intent();
  backend.start = async () => { backend.starts++; return receipt(request, { ownerGeneration: "wrong" }); };
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  expect(backend.starts).toBe(1);
});
durableTest("Host capability snapshot cannot be changed by mutating caller configuration", async () => {
  const backend = new Backend(); const request = intent();
  const client = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root));
  cap.ownerGeneration = "changed";
  await expect(client.start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  // Backend fixture now returns the changed generation, which the snapshotted client rejects.
  expect(backend.starts).toBe(1);
});

it("accepts long absolute backend paths while rejecting relative or NUL cwd", () => {
  expect(intent({ cwd: "/workspace/" + "a".repeat(500) }).cwd.length).toBeGreaterThan(256);
  expect(intent({ cwd: "C:\\workspace" }).cwd).toBe("C:\\workspace");
  for (const cwd of ["relative", "", "/workspace/\0bad"]) expect(() => intent({ cwd })).toThrow();
});

durableTest("malformed absent replies are unknown and never permit a new dispatch", async () => {
  const backend = new Backend();
  backend.lookup = async () => ({ state: "absent", receipt: receipt(intent()) }) as any;
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(intent())).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  expect(backend.starts).toBe(0);
  expect(readdirSync(root).some(name => name.endsWith(".dispatch.json"))).toBe(false);
});

durableTest("cancellation after the durable dispatch claim cannot cause a later replay", async () => {
  const request = intent(), backend = new Backend(), abort = new AbortController();
  const journal = new FileServiceDispatchJournal(root);
  const original = journal.claimDispatch.bind(journal);
  journal.claimDispatch = async value => { const claimed = await original(value); abort.abort(new Error("cancelled after claim")); return claimed; };
  await expect(new BoundServiceClient(cap, backend, journal).start(request, abort.signal)).rejects.toThrow("cancelled after claim");
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_OPERATION_UNKNOWN" });
  expect(backend.starts).toBe(0);
});

durableTest("receipt persistence failure is reconciled without repeating backend start", async () => {
  const request = intent(), backend = new Backend();
  const journal = new FileServiceDispatchJournal(root);
  journal.bindReceipt = async () => { throw new Error("receipt disk unavailable"); };
  await expect(new BoundServiceClient(cap, backend, journal).start(request)).rejects.toThrow("receipt disk unavailable");
  expect(await new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).toEqual(receipt(request));
  expect(backend.starts).toBe(1);
});

durableTest("separate Host processes still get only one dispatch claim", async () => {
  const request = intent();
  const journalModule = fileURLToPath(new URL("../../services/file-journal.ts", import.meta.url));
  const source = `import {FileServiceDispatchJournal} from ${JSON.stringify(journalModule)}; const [root, raw] = process.argv.slice(1); const intent = JSON.parse(raw); const journal = new FileServiceDispatchJournal(root); await journal.bindIntent(intent); console.log(await journal.claimDispatch(intent));`;
  const run = () => new Promise<string>((resolve, reject) => execFile(process.execPath, ["-e", source, root, JSON.stringify(request)], { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  const claims = await Promise.all([run(), run(), run(), run()]);
  expect(claims.filter(value => value === "true")).toHaveLength(1);
  expect(claims.filter(value => value === "false")).toHaveLength(3);
  expect(await new FileServiceDispatchJournal(root).claimDispatch(request)).toBe(false);
});

durableTest("journal refuses broad directories and never follows an existing record symlink", async () => {
  const backend = new Backend();
  chmodSync(root, 0o755);
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(intent())).rejects.toMatchObject({ code: "SERVICE_JOURNAL_INVALID" });
  expect(backend.starts).toBe(0);
  chmodSync(root, 0o700);
  const request = intent();
  const journal = new FileServiceDispatchJournal(root);
  await journal.bindIntent(request);
  const key = executionDigest({ backendId: request.backendId, ownerId: request.ownerId, ownerGeneration: request.ownerGeneration, workspaceId: request.workspaceId, operationId: request.operationId });
  const victim = join(root, "victim"); writeFileSync(victim, "unchanged", { mode: 0o600 });
  symlinkSync(victim, join(root, key + ".dispatch.json"));
  await expect(new BoundServiceClient(cap, backend, journal).start(request)).rejects.toThrow();
  expect(readFileSync(victim, "utf8")).toBe("unchanged"); expect(backend.starts).toBe(0);
});

durableTest("a noncooperative lookup is still cancellable and never reaches start", async () => {
  let seen!: () => void;
  const entered = new Promise<void>(resolve => { seen = resolve; });
  const backend = new Backend();
  backend.lookup = () => { seen(); return new Promise(() => {}); };
  const abort = new AbortController();
  const pending = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(intent(), abort.signal);
  await entered; abort.abort(new Error("stop waiting"));
  await expect(pending).rejects.toThrow("stop waiting");
  expect(backend.starts).toBe(0);
});

durableTest("a late reply after cancellation is recovered by lookup without a duplicate start", async () => {
  const request = intent(), backend = new Backend(), abort = new AbortController();
  let seen!: () => void, release!: (value: ServiceReceipt) => void;
  const entered = new Promise<void>(resolve => { seen = resolve; });
  backend.start = async () => {
    backend.starts++; seen();
    const value = await new Promise<ServiceReceipt>(resolve => { release = resolve; });
    backend.current = { state: "present", receipt: value };
    return value;
  };
  const pending = new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request, abort.signal);
  await entered; abort.abort(new Error("cancelled while starting"));
  await expect(pending).rejects.toThrow("cancelled while starting");
  release(receipt(request));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).toEqual(receipt(request));
  expect(backend.starts).toBe(1);
});

durableTest("an unresponsive transport cannot outlive the original lease wait", async () => {
  const request = intent({ leaseMs: 100 });
  const backend = new Backend(); backend.lookup = async () => new Promise(() => {});
  const started = Date.now();
  await expect(new BoundServiceClient(cap, backend, new FileServiceDispatchJournal(root)).start(request)).rejects.toMatchObject({ code: "SERVICE_LEASE_EXPIRED" });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(backend.starts).toBe(0);
});

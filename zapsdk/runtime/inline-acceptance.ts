import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunOptions } from "../agent/loop.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { OutcomeProtocolError, validateOutcome, type AcceptanceSpec, type AgentOutcomeV1 } from "./outcome.js";

export interface SnapshotSubject {
  subjectId: string;
  exists: boolean;
  /** Immutable object/version ID, including for directories and absence. */
  version: string;
}

export interface AcceptanceSnapshot {
  id: string;
  providerId: string;
  proof: "immutable_snapshot";
  subjects: SnapshotSubject[];
  /** Reads the pinned version, never the current workspace. Returns a copy. */
  readFile(subjectId: string, signal: AbortSignal): Promise<Uint8Array>;
}

export interface AcceptanceSnapshotProvider {
  id: string;
  preflight(context: { spec: AcceptanceSpec; signal: AbortSignal }): Promise<void>;
  /** undefined means that a stable version cannot be established. */
  capture(context: { outcome: AgentOutcomeV1; spec: AcceptanceSpec; signal: AbortSignal }): Promise<AcceptanceSnapshot | undefined>;
}

export interface InlineCheckResult {
  checkId: string;
  attemptId: string;
  specId: string;
  specRevision: number;
  snapshotId: string;
  dependencies: SnapshotSubject[];
  status: "passed" | "failed" | "error";
  code: string;
  evidenceRefs: string[];
  /** Host-declared public values; only explicitly opted-in checks feed these to a model. */
  publicDiagnostic?: { expected: string; actual: string };
}

export interface InlineHostVerifier {
  id: string;
  /** Optional host configuration/capability validation before Agent execution. */
  preflight?(context: { spec: AcceptanceSpec; signal: AbortSignal }): Promise<void>;
  verify(context: {
    outcome: AgentOutcomeV1;
    spec: AcceptanceSpec;
    snapshot: AcceptanceSnapshot;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<InlineCheckResult[]>;
}

export interface InlineAcceptanceRecord {
  schema: "zap.acceptance";
  schemaVersion: 1;
  revision: 1;
  id: string;
  /** The execution terminal remains byte-for-byte unchanged. */
  outcome: AgentOutcomeV1;
  spec: AcceptanceSpec;
  specDigest: string;
  startedAt: number;
  endedAt: number;
  snapshot?: Omit<AcceptanceSnapshot, "readFile">;
  report: {
    status: "passed" | "failed" | "unverified" | "error";
    code: string;
    checks: InlineCheckResult[];
  };
  workflow: { status: "ready" | "blocked"; code: string; snapshotId?: string };
}

export interface InlineAcceptanceStore {
  preflight(signal: AbortSignal): Promise<void>;
  load(id: string): Promise<InlineAcceptanceRecord | undefined>;
  /** Atomically insert an immutable record; identical retries are idempotent. */
  save(record: InlineAcceptanceRecord): Promise<void>;
}

export interface InlineAcceptanceConfiguration {
  mode: "required";
  timing: "inline";
  spec: AcceptanceSpec;
  snapshotProvider: AcceptanceSnapshotProvider;
  verifiers: InlineHostVerifier[];
  store: InlineAcceptanceStore;
  /** Separate budget for capture and all verifiers, starting after execution. */
  timeoutMs: number;
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = (message: string): never => { throw new OutcomeProtocolError("INVALID_ACCEPTANCE_CONFIG", message); };

export function validateAcceptanceSpec(value: unknown): asserts value is AcceptanceSpec {
  const spec = value as AcceptanceSpec | undefined;
  if (!spec || !nonempty(spec.id) || !Number.isSafeInteger(spec.revision) || spec.revision < 1
    || !Array.isArray(spec.subjects) || !spec.subjects.length || !Array.isArray(spec.checks) || !spec.checks.length) invalid("Acceptance requires a versioned spec, subjects and checks");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const subject of spec!.subjects) {
    if (!subject || !nonempty(subject.id) || ids.has(subject.id) || !nonempty(subject.path)
      || subject.path.includes("\\") || subject.path.includes("\0") || subject.path.startsWith("/")
      || /^[a-z]:/i.test(subject.path) || subject.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
      || paths.has(subject.path) || !["exists", "absent"].includes(subject.expected)) invalid("Invalid or duplicate acceptance subject");
    ids.add(subject.id); paths.add(subject.path);
  }
  const checkIds = new Set<string>();
  for (const check of spec!.checks) {
    if (!check || !nonempty(check.id) || checkIds.has(check.id) || !nonempty(check.verifierId)
      || !Array.isArray(check.subjectIds) || !check.subjectIds.length
      || new Set(check.subjectIds).size !== check.subjectIds.length || check.subjectIds.some(id => !ids.has(id))) invalid("Invalid acceptance check dependencies");
    checkIds.add(check.id);
  }
}

export function acceptanceSpecDigest(spec: AcceptanceSpec): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

export function acceptanceRecordId(outcome: AgentOutcomeV1): string {
  return createHash("sha256").update(JSON.stringify([outcome.threadId, outcome.attemptId])).digest("hex");
}

function executionAllowsRelease(outcome: AgentOutcomeV1): boolean {
  const execution = outcome.execution;
  return execution.status === "finished" && !execution.error && execution.unresolvedActions.length === 0
    && !execution.backgroundTasks?.some(task => task.disposition === "pending");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Cooperative callbacks may ignore abort; their late values are never consumed. */
async function bounded<T>(deadlineAt: number, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, fail) => { reject = fail; });
  const stop = (code: string) => {
    const error = new OutcomeProtocolError(code, code);
    reject(error);
    controller.abort(error);
  };
  const abort = () => stop("ACCEPTANCE_CANCELLED");
  const remaining = deadlineAt - Date.now();
  const timer = setTimeout(() => stop("ACCEPTANCE_TIMEOUT"), Math.max(0, remaining));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    else if (remaining <= 0) stop("ACCEPTANCE_TIMEOUT");
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return action(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

function snapshotMetadata(snapshot: AcceptanceSnapshot, providerId: string, spec: AcceptanceSpec): Omit<AcceptanceSnapshot, "readFile"> {
  if (!snapshot || !nonempty(snapshot.id) || snapshot.providerId !== providerId || snapshot.proof !== "immutable_snapshot"
    || typeof snapshot.readFile !== "function" || !Array.isArray(snapshot.subjects)
    || snapshot.subjects.length !== spec.subjects.length) throw new OutcomeProtocolError("INVALID_SNAPSHOT", "Invalid stable snapshot receipt");
  const subjects = snapshot.subjects;
  if (new Set(subjects.map(s => s?.subjectId)).size !== subjects.length
    || subjects.some(s => !s || !spec.subjects.some(subject => subject.id === s.subjectId)
      || typeof s.exists !== "boolean" || !nonempty(s.version))) throw new OutcomeProtocolError("INVALID_SNAPSHOT", "Snapshot subjects do not match the spec");
  return freeze(structuredClone({ id: snapshot.id, providerId, proof: snapshot.proof, subjects }));
}

function validateChecks(receipts: InlineCheckResult[], verifierId: string, spec: AcceptanceSpec, outcome: AgentOutcomeV1, snapshot: Omit<AcceptanceSnapshot, "readFile">): void {
  const expected = spec.checks.filter(check => check.verifierId === verifierId);
  if (!Array.isArray(receipts) || receipts.length !== expected.length || new Set(receipts.map(r => r?.checkId)).size !== receipts.length) {
    throw new OutcomeProtocolError("INVALID_VERIFIER_RESULT", "Verifier omitted or duplicated a check");
  }
  for (const receipt of receipts) {
    const check = expected.find(check => check.id === receipt?.checkId);
    const dependencies = check?.subjectIds.map(id => snapshot.subjects.find(s => s.subjectId === id)!);
    if (!check || receipt.attemptId !== outcome.attemptId || receipt.specId !== spec.id || receipt.specRevision !== spec.revision
      || receipt.snapshotId !== snapshot.id || !isDeepStrictEqual(receipt.dependencies, dependencies)
      || !["passed", "failed", "error"].includes(receipt.status) || !nonempty(receipt.code)
      || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.some(ref => !nonempty(ref))) {
      throw new OutcomeProtocolError("INVALID_VERIFIER_RESULT", "Verifier result is not bound to the current spec and snapshot");
    }
    if (receipt.publicDiagnostic !== undefined) {
      const diagnostic = receipt.publicDiagnostic;
      if (!diagnostic || Object.keys(diagnostic).some(key => key !== "expected" && key !== "actual")
        || [diagnostic.expected, diagnostic.actual].some(value => typeof value !== "string" || value.length > 4096)) {
        throw new OutcomeProtocolError("INVALID_VERIFIER_RESULT", "Invalid public diagnostic");
      }
    }
  }
}

export function validateInlineAcceptanceRecord(value: unknown): asserts value is InlineAcceptanceRecord {
  const r = value as InlineAcceptanceRecord;
  const fail = (): never => { throw new OutcomeProtocolError("INVALID_ACCEPTANCE_RECORD", "Malformed acceptance record"); };
  if (!r || r.schema !== "zap.acceptance" || r.schemaVersion !== 1 || r.revision !== 1) fail();
  validateOutcome(r.outcome); validateAcceptanceSpec(r.spec);
  if (r.id !== acceptanceRecordId(r.outcome) || r.specDigest !== acceptanceSpecDigest(r.spec)
    || !Number.isFinite(r.startedAt) || !Number.isFinite(r.endedAt) || r.endedAt < r.startedAt
    || !r.report || !["passed", "failed", "unverified", "error"].includes(r.report.status)
    || !nonempty(r.report.code) || !Array.isArray(r.report.checks) || !r.workflow || !nonempty(r.workflow.code)) fail();
  if (r.snapshot) {
    const snapshot = snapshotMetadata({ ...r.snapshot, readFile: async () => new Uint8Array() }, r.snapshot.providerId, r.spec);
    if (!nonempty(snapshot.providerId)) fail();
    for (const id of new Set(r.report.checks.map(check => r.spec.checks.find(s => s.id === check.checkId)?.verifierId))) {
      if (!id) fail();
      validateChecks(r.report.checks.filter(c => r.spec.checks.find(s => s.id === c.checkId)?.verifierId === id), id!, r.spec, r.outcome, snapshot);
    }
  } else if (r.report.checks.length || r.report.status === "passed" || r.report.status === "failed") fail();
  const subjectsMatch = r.snapshot && r.spec.subjects.every(s => r.snapshot!.subjects.find(v => v.subjectId === s.id)!.exists === (s.expected === "exists"));
  if (r.report.status === "passed" && (!subjectsMatch || r.report.checks.length !== r.spec.checks.length || r.report.checks.some(c => c.status !== "passed"))) fail();
  const ready = executionAllowsRelease(r.outcome) && r.report.status === "passed";
  if (r.workflow.status !== (ready ? "ready" : "blocked") || r.workflow.snapshotId !== r.snapshot?.id) fail();
}

/** Host-side coordinator. It never invokes the Agent or dispatches an action. */
export class InlineAcceptanceCoordinator {
  private readonly config: InlineAcceptanceConfiguration;
  private preflightComplete = false;

  constructor(config: InlineAcceptanceConfiguration) {
    if (!config || config.mode !== "required" || config.timing !== "inline"
      || Object.keys(config).some(k => !["mode", "timing", "spec", "snapshotProvider", "verifiers", "store", "timeoutMs"].includes(k))
      || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) invalid("Unsupported inline acceptance configuration");
    validateAcceptanceSpec(config.spec);
    const provider = config.snapshotProvider;
    if (!provider || !nonempty(provider.id) || typeof provider.preflight !== "function" || typeof provider.capture !== "function"
      || !config.store || typeof config.store.preflight !== "function" || typeof config.store.load !== "function" || typeof config.store.save !== "function"
      || !Array.isArray(config.verifiers) || config.verifiers.some(v => !v || !nonempty(v.id) || typeof v.verify !== "function"
        || (v.preflight !== undefined && typeof v.preflight !== "function"))
      || new Set(config.verifiers.map(v => v.id)).size !== config.verifiers.length
      || config.spec.checks.some(c => !config.verifiers.some(v => v.id === c.verifierId))) invalid("Missing snapshot, store or verifier capability");
    // Pin the spec and method identities before the asynchronous model run.
    this.config = { ...config, spec: freeze(structuredClone(config.spec)),
      snapshotProvider: { id: provider.id, preflight: provider.preflight.bind(provider), capture: provider.capture.bind(provider) },
      verifiers: config.verifiers.map(v => ({ id: v.id, verify: v.verify.bind(v), preflight: v.preflight?.bind(v) })),
      store: { preflight: config.store.preflight.bind(config.store), load: config.store.load.bind(config.store), save: config.store.save.bind(config.store) } };
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    await bounded(Date.now() + Math.min(10_000, this.config.timeoutMs), signal, async boundedSignal => {
      await this.config.store.preflight(boundedSignal);
      boundedSignal.throwIfAborted();
      await this.config.snapshotProvider.preflight({ spec: this.config.spec, signal: boundedSignal });
      for (const verifier of this.config.verifiers) {
        boundedSignal.throwIfAborted();
        if (this.config.spec.checks.some(check => check.verifierId === verifier.id)) {
          await verifier.preflight?.({ spec: this.config.spec, signal: boundedSignal });
        }
      }
    });
    this.preflightComplete = true;
  }

  async evaluate(input: AgentOutcomeV1, signal?: AbortSignal): Promise<InlineAcceptanceRecord> {
    validateOutcome(input);
    if (!this.preflightComplete) await this.preflight(signal);
    const outcome = freeze(structuredClone(input));
    const { spec, store, snapshotProvider, verifiers, timeoutMs } = this.config;
    const id = acceptanceRecordId(outcome);
    const startedAt = Date.now();
    const existing = await store.load(id);
    if (existing) {
      validateInlineAcceptanceRecord(existing);
      if (!isDeepStrictEqual(existing.outcome, outcome) || existing.specDigest !== acceptanceSpecDigest(spec)) {
        throw new OutcomeProtocolError("ACCEPTANCE_CONFLICT", "An immutable report already exists for this attempt");
      }
      return structuredClone(existing);
    }
    const record: InlineAcceptanceRecord = { schema: "zap.acceptance", schemaVersion: 1, revision: 1, id,
      outcome, spec, specDigest: acceptanceSpecDigest(spec), startedAt, endedAt: startedAt,
      report: { status: "unverified", code: "EXECUTION_NOT_ELIGIBLE", checks: [] }, workflow: { status: "blocked", code: "EXECUTION_NOT_FINISHED" } };
    if (["finished", "limited"].includes(outcome.execution.status)) {
      try {
        await bounded(startedAt + timeoutMs, signal, async boundedSignal => {
          const snapshot = await snapshotProvider.capture({ outcome, spec, signal: boundedSignal });
          boundedSignal.throwIfAborted();
          if (!snapshot) { record.report.code = "STABLE_SNAPSHOT_UNAVAILABLE"; return; }
          record.snapshot = snapshotMetadata(snapshot, snapshotProvider.id, spec);
          const read = snapshot.readFile.bind(snapshot);
          if (spec.subjects.some(s => record.snapshot!.subjects.find(v => v.subjectId === s.id)!.exists !== (s.expected === "exists"))) {
            record.report = { status: "failed", code: "SUBJECT_EXPECTATION_FAILED", checks: [] }; return;
          }
          for (const verifier of verifiers) {
            if (!spec.checks.some(c => c.verifierId === verifier.id)) continue;
            boundedSignal.throwIfAborted();
            const dependencies = new Set(spec.checks.filter(c => c.verifierId === verifier.id).flatMap(c => c.subjectIds));
            const view: AcceptanceSnapshot = Object.freeze({ ...record.snapshot,
              subjects: Object.freeze(record.snapshot.subjects.filter(s => dependencies.has(s.subjectId))) as SnapshotSubject[],
              readFile: async (subjectId: string, readSignal: AbortSignal) => {
                if (!dependencies.has(subjectId)) throw new OutcomeProtocolError("UNDECLARED_CHECK_DEPENDENCY", "Verifier read an undeclared subject");
                boundedSignal.throwIfAborted(); readSignal.throwIfAborted();
                return new Uint8Array(await read(subjectId, AbortSignal.any([boundedSignal, readSignal])));
              } });
            const receipts = await verifier.verify({ outcome, spec, snapshot: view, signal: boundedSignal, deadlineAt: startedAt + timeoutMs });
            boundedSignal.throwIfAborted();
            validateChecks(receipts, verifier.id, spec, outcome, record.snapshot);
            record.report.checks.push(...structuredClone(receipts));
          }
          const status = record.report.checks.some(c => c.status === "error") ? "error"
            : record.report.checks.some(c => c.status === "failed") ? "failed" : "passed";
          record.report.status = status; record.report.code = `ACCEPTANCE_${status.toUpperCase()}`;
        });
      } catch (error) {
        record.report = { status: "error", code: error instanceof OutcomeProtocolError ? error.code : "VERIFIER_OR_SNAPSHOT_ERROR", checks: record.report.checks };
      }
    }
    record.endedAt = Date.now();
    const ready = executionAllowsRelease(outcome) && record.report.status === "passed";
    record.workflow = { status: ready ? "ready" : "blocked", code: ready ? "ACCEPTANCE_PASSED"
      : !executionAllowsRelease(outcome) ? "EXECUTION_NOT_ELIGIBLE" : record.report.code, ...(record.snapshot ? { snapshotId: record.snapshot.id } : {}) };
    validateInlineAcceptanceRecord(record);
    // Durable publication is the boundary for exposing ready to the caller.
    try { await store.save(structuredClone(record)); }
    catch (error) { throw new OutcomeProtocolError("ACCEPTANCE_PERSISTENCE_FAILED", String(error)); }
    return structuredClone(record);
  }
}

/** Explicit host composition; default runWithOutcome and CLI behavior stay unchanged. */
export async function runWithInlineAcceptance(runtime: AgentRuntime, input: string, options: RunOptions & { acceptance: InlineAcceptanceConfiguration }) {
  const { acceptance, ...runOptions } = options;
  const coordinator = new InlineAcceptanceCoordinator(acceptance);
  await coordinator.preflight(runOptions.signal);
  runOptions.signal?.throwIfAborted();
  const execution = await runtime.runWithOutcome(input, runOptions);
  const accepted = await coordinator.evaluate(execution.outcome, runOptions.signal);
  return { ...execution, acceptance: accepted };
}

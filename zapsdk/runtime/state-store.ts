import { isDeepStrictEqual } from "node:util";
import { validPersistedAttemptOutcome } from "./outcome-state.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isRuntimeOwnerAlive, validRuntimeOwner } from "./owner.js";
import {
  LEGACY_RUNTIME_STATE_SCHEMA_VERSION,
  RUNTIME_STATE_SCHEMA_VERSION,
  type LegacyRuntimeStateSnapshot,
  type RuntimeStateSnapshotV2,
  type RuntimeOwnerState,
  type RuntimeStateSnapshot,
} from "./state-types.js";

export type RuntimeStateUpdater = (
  current: RuntimeStateSnapshot | undefined,
) => RuntimeStateSnapshot | null | Promise<RuntimeStateSnapshot | null>;

export interface RuntimeStateStore {
  load(threadId: string): Promise<RuntimeStateSnapshot | undefined>;
  list(): Promise<RuntimeStateSnapshot[]>;
  update(
    threadId: string,
    updater: RuntimeStateUpdater,
    options?: RuntimeStateUpdateOptions,
  ): Promise<RuntimeStateSnapshot | undefined>;
  acquireThreadLease(threadId: string, owner: RuntimeOwnerState): Promise<RuntimeThreadLease>;
}

export interface RuntimeStateUpdateOptions {
  expectedRevision?: number;
}

export interface RuntimeThreadLease {
  threadId: string;
  owner: RuntimeOwnerState;
  release(): Promise<void>;
}

export class RuntimeThreadLeaseConflictError extends Error {
  constructor(
    readonly threadId: string,
    readonly currentOwner?: RuntimeOwnerState,
  ) {
    super(currentOwner
      ? `Thread ${threadId} is owned by runtime ${currentOwner.instanceId} (pid ${currentOwner.pid})`
      : `Thread ${threadId} already has a writer lease`);
    this.name = "RuntimeThreadLeaseConflictError";
  }
}

export class RuntimeStateRevisionConflictError extends Error {
  constructor(
    readonly threadId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Runtime state revision conflict for ${threadId}: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "RuntimeStateRevisionConflictError";
  }
}

function cloneState(state: RuntimeStateSnapshot): RuntimeStateSnapshot {
  return structuredClone(state);
}

type LoadableRuntimeStateSnapshot = RuntimeStateSnapshot | LegacyRuntimeStateSnapshot | RuntimeStateSnapshotV2;

function validState(value: unknown): value is LoadableRuntimeStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LoadableRuntimeStateSnapshot>;
  return (state.schemaVersion === LEGACY_RUNTIME_STATE_SCHEMA_VERSION
      || state.schemaVersion === 2
      || state.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION)
    && typeof state.threadId === "string"
    && typeof state.workspaceRoot === "string"
    && Number.isSafeInteger(state.revision)
    && (state.revision ?? -1) >= 0
    && typeof state.createdAt === "number"
    && typeof state.updatedAt === "number"
    && Boolean(state.thread)
    && Boolean(state.turns)
    && Boolean(state.runs)
    && Boolean(state.toolRuns)
    && Boolean(state.approvals)
    && Boolean(state.workspaces)
    && Boolean(state.artifacts)
    && Boolean(state.merges)
    && (state.schemaVersion !== 3 || (!!state.attemptOutcomes && Object.entries(state.attemptOutcomes).every(([id, entry]) => validPersistedAttemptOutcome(entry) && entry.outcome.attemptId === id && entry.outcome.threadId === state.threadId)));
}

function migrateState(state: LoadableRuntimeStateSnapshot): RuntimeStateSnapshot {
  if (state.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION) return state;
  return {
    ...state,
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    attemptOutcomes: {},
  };
}

function finalizeRevision(
  current: RuntimeStateSnapshot | undefined,
  next: RuntimeStateSnapshot,
): RuntimeStateSnapshot {
  for (const [id, previous] of Object.entries(current?.attemptOutcomes ?? {})) {
    const following = next.attemptOutcomes[id];
    const { publication: priorPublication, ...priorTerminal } = previous;
    const { publication: nextPublication, ...nextTerminal } = following ?? {};
    if (!following || !isDeepStrictEqual(priorTerminal, nextTerminal)
      || (priorPublication === "published" && nextPublication !== "published")) throw new Error("Attempt terminal outcome is immutable");
  }
  for (const entry of Object.values(next.attemptOutcomes)) {
    if (!validPersistedAttemptOutcome(entry)) throw new Error("Invalid attempt terminal record");
  }
  return {
    ...next,
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    revision: (current?.revision ?? 0) + 1,
  };
}

export class InMemoryRuntimeStateStore implements RuntimeStateStore {
  private states = new Map<string, RuntimeStateSnapshot>();
  private tails = new Map<string, Promise<void>>();
  private leases = new Map<string, RuntimeOwnerState>();

  async load(threadId: string): Promise<RuntimeStateSnapshot | undefined> {
    await this.tails.get(threadId);
    const state = this.states.get(threadId);
    return state ? cloneState(state) : undefined;
  }

  async list(): Promise<RuntimeStateSnapshot[]> {
    await Promise.all(this.tails.values());
    return [...this.states.values()].map(cloneState);
  }

  async update(
    threadId: string,
    updater: RuntimeStateUpdater,
    options: RuntimeStateUpdateOptions = {},
  ): Promise<RuntimeStateSnapshot | undefined> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    let result: RuntimeStateSnapshot | undefined;
    const write = previous.then(async () => {
      const current = this.states.get(threadId);
      assertExpectedRevision(threadId, current, options.expectedRevision);
      const next = await updater(current ? cloneState(current) : undefined);
      if (next === null) {
        result = current ? cloneState(current) : undefined;
        return;
      }
      if (next.threadId !== threadId) throw new Error("Runtime state updater changed threadId");
      const finalized = finalizeRevision(current, next);
      this.states.set(threadId, cloneState(finalized));
      result = cloneState(finalized);
    });
    this.tails.set(threadId, write.then(() => undefined, () => undefined));
    await write;
    return result;
  }

  async acquireThreadLease(threadId: string, owner: RuntimeOwnerState): Promise<RuntimeThreadLease> {
    assertValidOwner(owner);
    const current = this.leases.get(threadId);
    if (current) {
      throw new RuntimeThreadLeaseConflictError(threadId, current);
    }
    this.leases.set(threadId, { ...owner });
    let released = false;
    return {
      threadId,
      owner: { ...owner },
      release: async () => {
        if (released) return;
        released = true;
        if (this.leases.get(threadId)?.instanceId === owner.instanceId) {
          this.leases.delete(threadId);
        }
      },
    };
  }
}

export interface JsonRuntimeStateStoreOptions {
  directory: string;
}

export class RuntimeStateStoreCorruptionError extends Error {
  constructor(readonly filePath: string) {
    super(`Invalid runtime state at ${filePath}`);
    this.name = "RuntimeStateStoreCorruptionError";
  }
}

function stateFileName(threadId: string): string {
  return `${createHash("sha256").update(threadId).digest("hex")}.json`;
}

export class JsonRuntimeStateStore implements RuntimeStateStore {
  readonly directory: string;
  private tails = new Map<string, Promise<void>>();
  private heldLeases = new Map<string, RuntimeOwnerState>();
  private directoryReady?: Promise<void>;

  constructor(options: JsonRuntimeStateStoreOptions) {
    this.directory = options.directory;
  }

  filePath(threadId: string): string {
    return join(this.directory, stateFileName(threadId));
  }

  leasePath(threadId: string): string {
    return join(this.directory, `${stateFileName(threadId)}.lease`);
  }

  async load(threadId: string): Promise<RuntimeStateSnapshot | undefined> {
    await this.tails.get(threadId);
    return this.readState(this.filePath(threadId), threadId);
  }

  async list(): Promise<RuntimeStateSnapshot[]> {
    await Promise.all(this.tails.values());
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const states: RuntimeStateSnapshot[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const state = await this.readState(join(this.directory, name));
      if (state) states.push(state);
    }
    return states;
  }

  async update(
    threadId: string,
    updater: RuntimeStateUpdater,
    options: RuntimeStateUpdateOptions = {},
  ): Promise<RuntimeStateSnapshot | undefined> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    let result: RuntimeStateSnapshot | undefined;
    const write = previous.then(async () => {
      await this.assertNoForeignLease(threadId);
      const path = this.filePath(threadId);
      const current = await this.readState(path, threadId);
      assertExpectedRevision(threadId, current, options.expectedRevision);
      const next = await updater(current ? cloneState(current) : undefined);
      if (next === null) {
        result = current ? cloneState(current) : undefined;
        return;
      }
      if (next.threadId !== threadId) throw new Error("Runtime state updater changed threadId");
      const finalized = finalizeRevision(current, next);
      if (current) {
        const raw = await readFile(path, "utf8");
        const version = JSON.parse(raw).schemaVersion;
        if (version !== RUNTIME_STATE_SCHEMA_VERSION) {
          try { await writeFile(`${path}.v${version}.backup`, raw, { flag: "wx", mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
      }
      await this.writeAtomic(path, finalized);
      result = cloneState(finalized);
    });
    this.tails.set(threadId, write.then(() => undefined, () => undefined));
    await write;
    return result;
  }

  async acquireThreadLease(threadId: string, owner: RuntimeOwnerState): Promise<RuntimeThreadLease> {
    assertValidOwner(owner);
    await this.ensureDirectory();
    const held = this.heldLeases.get(threadId);
    if (held) {
      throw new RuntimeThreadLeaseConflictError(threadId, held);
    }
    const path = this.leasePath(threadId);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (process.platform !== "win32") await chmod(path, 0o600);
        this.heldLeases.set(threadId, { ...owner });
        return this.createLeaseHandle(threadId, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const current = await this.readLeaseOwner(path);
      if (current && isRuntimeOwnerAlive(current)) {
        throw new RuntimeThreadLeaseConflictError(threadId, current);
      }
      if (!current && await recentlyCreated(path)) {
        await shortDelay();
        continue;
      }
      const stale = `${path}.stale.${process.pid}.${randomUUID()}`;
      try {
        await rename(path, stale);
        await rm(stale, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new RuntimeThreadLeaseConflictError(threadId, await this.readLeaseOwner(path));
  }

  private async readState(
    path: string,
    expectedThreadId?: string,
  ): Promise<RuntimeStateSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const state: unknown = JSON.parse(raw);
      if (!validState(state) || (expectedThreadId && state.threadId !== expectedThreadId)) {
        throw new RuntimeStateStoreCorruptionError(path);
      }
      return migrateState(state);
    } catch (error) {
      if (error instanceof RuntimeStateStoreCorruptionError) throw error;
      throw new RuntimeStateStoreCorruptionError(path);
    }
  }

  private ensureDirectory(): Promise<void> {
    if (!this.directoryReady) {
      this.directoryReady = mkdir(this.directory, { recursive: true, mode: 0o700 })
        .then(async () => {
          if (process.platform !== "win32") await chmod(this.directory, 0o700);
        });
    }
    return this.directoryReady;
  }

  private createLeaseHandle(threadId: string, owner: RuntimeOwnerState): RuntimeThreadLease {
    let released = false;
    return {
      threadId,
      owner: { ...owner },
      release: async () => {
        if (released) return;
        released = true;
        const held = this.heldLeases.get(threadId);
        if (held?.instanceId !== owner.instanceId) return;
        const current = await this.readLeaseOwner(this.leasePath(threadId));
        if (!current || current.instanceId === owner.instanceId) {
          await rm(this.leasePath(threadId), { force: true });
        }
        this.heldLeases.delete(threadId);
      },
    };
  }

  private async assertNoForeignLease(threadId: string): Promise<void> {
    if (this.heldLeases.has(threadId)) return;
    const owner = await this.readLeaseOwner(this.leasePath(threadId));
    if (owner) throw new RuntimeThreadLeaseConflictError(threadId, owner);
  }

  private async readLeaseOwner(path: string): Promise<RuntimeOwnerState | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return validRuntimeOwner(parsed) ? parsed : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private async writeAtomic(path: string, state: RuntimeStateSnapshot): Promise<void> {
    await this.ensureDirectory();
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await chmod(temp, 0o600);
      await rename(temp, path);
      if (process.platform !== "win32") await chmod(path, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function assertExpectedRevision(
  threadId: string,
  current: RuntimeStateSnapshot | undefined,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return;
  const actualRevision = current?.revision ?? 0;
  if (actualRevision !== expectedRevision) {
    throw new RuntimeStateRevisionConflictError(threadId, expectedRevision, actualRevision);
  }
}

function assertValidOwner(owner: RuntimeOwnerState): void {
  if (!validRuntimeOwner(owner)) throw new TypeError("Invalid runtime owner identity");
}

async function recentlyCreated(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs < 1_000;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function shortDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

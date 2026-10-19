import { validPersistedAttemptOutcome } from "./outcome-state.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  SqliteRuntimeEventIndex,
  type RuntimeEventIndexEntry,
  type RuntimeEventThreadSummary,
} from "./event-index.js";
import type { RuntimeEvent, ThreadId } from "./types.js";

export interface RuntimeEventQuery {
  afterSequence?: number;
  beforeSequence?: number;
  /** Selects the earliest or latest matching window. Returned items are always
   * chronological so host projections can append/prepend without reordering. */
  direction?: "forward" | "backward";
  limit?: number;
}

export interface RuntimeEventPage {
  items: RuntimeEvent[];
  firstSequence?: number;
  lastSequence?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/** Append-only runtime facts. Mutable recovery state deliberately lives in a
 * separate RuntimeStateStore introduced by the crash-recovery phase. */
export interface RuntimeEventStore {
  /** Callers may append multiple events without awaiting between calls. The
   * store must preserve invocation order within one thread. */
  append(event: RuntimeEvent): Promise<void>;
  list(threadId: ThreadId, query?: RuntimeEventQuery): Promise<RuntimeEvent[]>;
  page(threadId: ThreadId, query?: RuntimeEventQuery): Promise<RuntimeEventPage>;
  listThreads(limit?: number): Promise<RuntimeEventThreadSummary[]>;
  latestSequence(threadId: ThreadId): Promise<number>;
  close(): Promise<void>;
}

function cloneEvent(event: RuntimeEvent): RuntimeEvent {
  return structuredClone(event);
}

function normalizedBoundary(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error("Runtime event cursor must be a safe integer");
  return value;
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("Runtime event limit must be finite");
  return Math.max(0, Math.floor(value));
}

function normalizeQuery(query: RuntimeEventQuery, defaultLimit: number) {
  const afterSequence = normalizedBoundary(query.afterSequence, 0);
  const beforeSequence = normalizedBoundary(query.beforeSequence, Number.MAX_SAFE_INTEGER);
  if (afterSequence >= beforeSequence) {
    throw new Error("Runtime event afterSequence must be less than beforeSequence");
  }
  return {
    afterSequence,
    beforeSequence,
    direction: query.direction ?? "forward",
    limit: normalizedLimit(query.limit, defaultLimit),
  } as const;
}

function selectEventPage(
  events: RuntimeEvent[],
  query: RuntimeEventQuery,
  defaultLimit: number,
): RuntimeEventPage {
  const normalized = normalizeQuery(query, defaultLimit);
  const matching = events.filter((event) =>
    event.sequence > normalized.afterSequence && event.sequence < normalized.beforeSequence
  );
  const start = normalized.direction === "backward"
    ? Math.max(0, matching.length - normalized.limit)
    : 0;
  const items = matching.slice(start, start + normalized.limit).map(cloneEvent);
  const firstSequence = items[0]?.sequence;
  const lastSequence = items.at(-1)?.sequence;
  const firstAvailable = events[0]?.sequence;
  const lastAvailable = events.at(-1)?.sequence;
  return {
    items,
    firstSequence,
    lastSequence,
    hasMoreBefore: firstSequence !== undefined
      && firstAvailable !== undefined
      && firstAvailable < firstSequence,
    hasMoreAfter: lastSequence !== undefined
      && lastAvailable !== undefined
      && lastAvailable > lastSequence,
  };
}

export class InMemoryRuntimeEventStore implements RuntimeEventStore {
  private eventsByThread = new Map<ThreadId, RuntimeEvent[]>();

  async append(event: RuntimeEvent): Promise<void> {
    const events = this.eventsByThread.get(event.threadId) ?? [];
    const duplicate = events.find((item) => item.eventId === event.eventId);
    if (duplicate) {
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(duplicate)), JSON.parse(JSON.stringify(event)))) throw new Error("Runtime event ID conflict");
      return;
    }
    const previous = events.at(-1);
    if (previous && event.sequence <= previous.sequence) {
      throw new Error(
        `Runtime event sequence must increase for thread ${event.threadId}: ` +
        `${event.sequence} <= ${previous.sequence}`,
      );
    }
    events.push(cloneEvent(event));
    this.eventsByThread.set(event.threadId, events);
  }

  async list(threadId: ThreadId, query: RuntimeEventQuery = {}): Promise<RuntimeEvent[]> {
    return selectEventPage(
      this.eventsByThread.get(threadId) ?? [],
      query,
      Number.MAX_SAFE_INTEGER,
    ).items;
  }

  async page(threadId: ThreadId, query: RuntimeEventQuery = {}): Promise<RuntimeEventPage> {
    return selectEventPage(this.eventsByThread.get(threadId) ?? [], query, 100);
  }

  async listThreads(limit = 100): Promise<RuntimeEventThreadSummary[]> {
    const normalized = normalizedLimit(limit, 100);
    return [...this.eventsByThread.entries()]
      .map(([threadId, events]) => {
        const first = events[0]!;
        const latest = events.at(-1)!;
        return {
          threadId,
          fileName: "memory",
          fileSize: 0,
          fileMtimeMs: latest.timestamp,
          eventCount: events.length,
          firstSequence: first.sequence,
          latestSequence: latest.sequence,
          firstTimestamp: first.timestamp,
          latestTimestamp: latest.timestamp,
        };
      })
      .sort((left, right) =>
        right.latestTimestamp - left.latestTimestamp || left.threadId.localeCompare(right.threadId)
      )
      .slice(0, normalized);
  }

  async latestSequence(threadId: ThreadId): Promise<number> {
    return this.eventsByThread.get(threadId)?.at(-1)?.sequence ?? 0;
  }

  async close(): Promise<void> {}
}

export interface JsonlRuntimeEventStoreOptions {
  directory: string;
  /** Defaults to <directory>/index.sqlite. Set false for constrained hosts. */
  indexFile?: string | false;
  onIndexError?: (error: Error) => void;
}

export class RuntimeEventStoreCorruptionError extends Error {
  constructor(readonly filePath: string, readonly line: number) {
    super(`Invalid runtime event JSONL at ${filePath}:${line}`);
    this.name = "RuntimeEventStoreCorruptionError";
  }
}

function runtimeEventFileName(threadId: ThreadId): string {
  return `${createHash("sha256").update(threadId).digest("hex")}.jsonl`;
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RuntimeEvent>;
  const supportedVersion = event.schemaVersion === 1 || event.schemaVersion === 2 || event.schemaVersion === 3;
  const validCorrelation = event.schemaVersion === 1
    || typeof (event as { correlationId?: unknown }).correlationId === "string";
  return supportedVersion
    && validCorrelation
    && typeof event.eventId === "string"
    && Number.isSafeInteger(event.sequence)
    && (event.sequence ?? 0) > 0
    && typeof event.timestamp === "number"
    && typeof event.threadId === "string"
    && Boolean(event.payload)
    && typeof event.payload === "object"
    && typeof event.payload?.type === "string"
    && (event.payload.type !== "attempt_ended" || (event.schemaVersion === 3 && validPersistedAttemptOutcome({
      outcome: event.payload.outcome, legacyTerminal: event.payload.legacyTerminal,
      terminalEventId: event.eventId, terminalEventSequence: event.sequence, terminalEvent: event, publication: "pending",
    })));
}

/** Private append-only JSONL adapter. One hashed file per thread avoids path
 * traversal while retaining threadId inside every verifiable envelope. */
export class JsonlRuntimeEventStore implements RuntimeEventStore {
  readonly directory: string;
  readonly indexFile: string | false;

  private writeTails = new Map<ThreadId, Promise<void>>();
  private latestByThread = new Map<ThreadId, number>();
  private pendingByThread = new Map<ThreadId, Array<{
    event: RuntimeEvent;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>>();
  private flushScheduled = new Set<ThreadId>();
  private queuedWrites = new Set<ThreadId>();
  private preparedThreads = new Set<ThreadId>();
  private permissionCheckedThreads = new Set<ThreadId>();
  private directoryReady?: Promise<void>;
  private eventIndex?: SqliteRuntimeEventIndex;
  private indexDisabled = false;
  private readonly onIndexError?: (error: Error) => void;

  constructor(options: JsonlRuntimeEventStoreOptions) {
    this.directory = options.directory;
    this.indexFile = options.indexFile === false
      ? false
      : options.indexFile ?? join(options.directory, "index.sqlite");
    this.onIndexError = options.onIndexError;
  }

  filePath(threadId: ThreadId): string {
    return join(this.directory, runtimeEventFileName(threadId));
  }

  append(event: RuntimeEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingByThread.get(event.threadId) ?? [];
      pending.push({ event: cloneEvent(event), resolve, reject });
      this.pendingByThread.set(event.threadId, pending);
      if (this.flushScheduled.has(event.threadId)) return;
      this.flushScheduled.add(event.threadId);
      queueMicrotask(() => { this.flushPending(event.threadId); });
    });
  }

  async list(threadId: ThreadId, query: RuntimeEventQuery = {}): Promise<RuntimeEvent[]> {
    this.flushPending(threadId);
    await this.writeTails.get(threadId);
    return selectEventPage(await this.readEvents(threadId), query, Number.MAX_SAFE_INTEGER).items;
  }

  async page(threadId: ThreadId, query: RuntimeEventQuery = {}): Promise<RuntimeEventPage> {
    this.flushPending(threadId);
    await this.writeTails.get(threadId);
    const normalized = normalizeQuery(query, 100);
    await this.prepareThread(threadId);
    const index = await this.getEventIndex();
    if (index?.summary(threadId)) {
      try {
        const page = index.page(threadId, normalized);
        return {
          items: await this.readIndexedEvents(threadId, page.entries),
          firstSequence: page.entries[0]?.sequence,
          lastSequence: page.entries.at(-1)?.sequence,
          hasMoreBefore: page.hasMoreBefore,
          hasMoreAfter: page.hasMoreAfter,
        };
      } catch (error) {
        this.disableIndex(error);
      }
    }
    return selectEventPage(await this.readEvents(threadId), query, 100);
  }

  async listThreads(limit = 100): Promise<RuntimeEventThreadSummary[]> {
    const index = await this.getEventIndex();
    if (!index) return [];
    try {
      await this.ensureAllThreadsIndexed(index);
      return index.listThreads(normalizedLimit(limit, 100));
    } catch (error) {
      this.disableIndex(error);
      return [];
    }
  }

  async latestSequence(threadId: ThreadId): Promise<number> {
    this.flushPending(threadId);
    await this.writeTails.get(threadId);
    const cached = this.latestByThread.get(threadId);
    if (cached !== undefined) return cached;
    const latest = (await this.readEvents(threadId)).at(-1)?.sequence ?? 0;
    this.latestByThread.set(threadId, latest);
    return latest;
  }

  async close(): Promise<void> {
    for (const threadId of this.pendingByThread.keys()) this.flushPending(threadId);
    await Promise.all(this.writeTails.values());
    this.eventIndex?.close();
    this.eventIndex = undefined;
  }

  private readonly eventsById = new Map<string, Map<string, RuntimeEvent>>();

  private flushPending(threadId: ThreadId): void {
    this.flushScheduled.delete(threadId);
    if (!this.pendingByThread.get(threadId)?.length || this.queuedWrites.has(threadId)) return;
    this.queuedWrites.add(threadId);
    const previous = this.writeTails.get(threadId) ?? Promise.resolve();
    let pending: NonNullable<ReturnType<typeof this.pendingByThread.get>> = [];
    const write = previous.then(async () => {
      // Take the batch only when its predecessor has finished. While disk I/O
      // is in flight, subsequent stream chunks accumulate here instead of
      // queuing thousands of tiny JSONL writes and index transactions.
      this.queuedWrites.delete(threadId);
      pending = this.pendingByThread.get(threadId) ?? [];
      this.pendingByThread.delete(threadId);
      await this.prepareThread(threadId);
      let known = this.eventsById.get(threadId);
      if (!known) {
        known = new Map((await this.readEvents(threadId)).map((event) => [event.eventId, event]));
        this.eventsById.set(threadId, known);
      }
      const additions: typeof pending = [];
      // Stage only new IDs. Copying all historical deltas for every flush
      // makes a long stream quadratic; commit this overlay after durable append.
      const batch = new Map<string, RuntimeEvent>();
      let latest = this.latestByThread.get(threadId) ?? 0;
      for (const item of pending) {
        const { event } = item;
        const duplicate = batch.get(event.eventId) ?? known.get(event.eventId);
        if (duplicate) {
          if (!isDeepStrictEqual(JSON.parse(JSON.stringify(duplicate)), JSON.parse(JSON.stringify(event)))) throw new Error("Runtime event ID conflict");
          continue;
        }
        batch.set(event.eventId, event);
        additions.push(item);
        if (event.sequence <= latest) {
          throw new Error(
            `Runtime event sequence must increase for thread ${threadId}: ` +
            `${event.sequence} <= ${latest}`,
          );
        }
        latest = event.sequence;
      }
      if (additions.length === 0) return;
      await this.ensureDirectory();
      const path = this.filePath(threadId);
      const serialized = additions.map(({ event }) => JSON.stringify(event));
      const lines = serialized.join("\n") + "\n";
      const initialSize = await stat(path).then((value) => value.size, (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      });
      await appendFile(path, lines, { encoding: "utf8", mode: 0o600 });
      if (additions.some(item => item.event.payload.type === "attempt_ended")) {
        const handle = await open(path, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      if (process.platform !== "win32" && !this.permissionCheckedThreads.has(threadId)) {
        await chmod(path, 0o600);
        this.permissionCheckedThreads.add(threadId);
      }
      const fileStat = await stat(path);
      const indexEntries: RuntimeEventIndexEntry[] = [];
      let byteOffset = initialSize;
      for (let index = 0; index < additions.length; index++) {
        const event = additions[index]!.event;
        const byteLength = Buffer.byteLength(`${serialized[index]}\n`, "utf8");
        indexEntries.push(this.indexEntry(event, byteOffset, byteLength));
        byteOffset += byteLength;
      }
      const eventIndex = await this.getEventIndex();
      if (eventIndex) {
        try {
          const indexInput = {
            threadId,
            fileName: basename(path),
            fileSize: fileStat.size,
            fileMtimeMs: fileStat.mtimeMs,
            entries: indexEntries,
          };
          if (eventIndex.summary(threadId)) eventIndex.append(indexInput);
          else eventIndex.replaceThread(indexInput);
        } catch (error) {
          this.disableIndex(error);
        }
      }
      this.latestByThread.set(threadId, latest);
      for (const [id, event] of batch) known.set(id, event);
    });
    this.writeTails.set(threadId, write);
    write.then(
      () => { for (const item of pending) item.resolve(); },
      (error) => {
        this.queuedWrites.delete(threadId);
        for (const item of pending) item.reject(error);
        // A failed predecessor prevents the queued batch from starting. Its
        // callers must still settle, including readers waiting on the tail.
        const queued = this.pendingByThread.get(threadId) ?? [];
        this.pendingByThread.delete(threadId);
        for (const item of queued) item.reject(error);
      },
    );
  }

  private async prepareThread(threadId: ThreadId): Promise<void> {
    if (this.preparedThreads.has(threadId)) return;
    await this.repairIncompleteTail(threadId);
    const path = this.filePath(threadId);
    const fileStat = await stat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const index = await this.getEventIndex();
    if (fileStat && index?.isCurrent(threadId, fileStat.size, fileStat.mtimeMs)) {
      this.latestByThread.set(threadId, index.summary(threadId)?.latestSequence ?? 0);
      this.preparedThreads.add(threadId);
      return;
    }
    const scan = await this.scanEvents(threadId);
    this.latestByThread.set(threadId, scan.events.at(-1)?.sequence ?? 0);
    if (index && fileStat) {
      try {
        index.replaceThread({
          threadId,
          fileName: basename(path),
          fileSize: fileStat.size,
          fileMtimeMs: fileStat.mtimeMs,
          entries: scan.entries,
        });
      } catch (error) {
        this.disableIndex(error);
      }
    }
    this.preparedThreads.add(threadId);
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

  private async readEvents(threadId: ThreadId): Promise<RuntimeEvent[]> {
    return (await this.scanEvents(threadId)).events;
  }

  private async scanEvents(threadId: ThreadId): Promise<{
    events: RuntimeEvent[];
    entries: RuntimeEventIndexEntry[];
  }> {
    const path = this.filePath(threadId);
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], entries: [] };
      }
      throw error;
    }
    const events: RuntimeEvent[] = [];
    const entries: RuntimeEventIndexEntry[] = [];
    let byteOffset = 0;
    let lineNumber = 0;
    while (byteOffset < raw.length) {
      lineNumber++;
      const newline = raw.indexOf(0x0a, byteOffset);
      const complete = newline >= 0;
      const byteEnd = complete ? newline + 1 : raw.length;
      const lineEnd = complete ? newline : raw.length;
      const line = raw.subarray(byteOffset, lineEnd).toString("utf8");
      if (!line) {
        byteOffset = byteEnd;
        continue;
      }
      try {
        const event: unknown = JSON.parse(line);
        if (!isRuntimeEvent(event) || event.threadId !== threadId) {
          throw new RuntimeEventStoreCorruptionError(path, lineNumber);
        }
        events.push(event);
        entries.push(this.indexEntry(event, byteOffset, byteEnd - byteOffset));
      } catch (error) {
        if (!complete) break;
        if (error instanceof RuntimeEventStoreCorruptionError) throw error;
        throw new RuntimeEventStoreCorruptionError(path, lineNumber);
      }
      byteOffset = byteEnd;
    }
    return { events, entries };
  }

  private indexEntry(event: RuntimeEvent, byteOffset: number, byteLength: number): RuntimeEventIndexEntry {
    return {
      threadId: event.threadId,
      sequence: event.sequence,
      eventId: event.eventId,
      timestamp: event.timestamp,
      payloadType: event.payload.type,
      turnId: event.turnId,
      runId: event.runId,
      byteOffset,
      byteLength,
    };
  }

  private async readIndexedEvents(
    threadId: ThreadId,
    entries: readonly RuntimeEventIndexEntry[],
  ): Promise<RuntimeEvent[]> {
    if (entries.length === 0) return [];
    const first = entries[0]!;
    const latest = entries.at(-1)!;
    const byteEnd = latest.byteOffset + latest.byteLength;
    const buffer = Buffer.alloc(byteEnd - first.byteOffset);
    const handle = await open(this.filePath(threadId), "r");
    try {
      const read = await handle.read(buffer, 0, buffer.length, first.byteOffset);
      if (read.bytesRead !== buffer.length) throw new Error("Runtime event index points past JSONL end");
    } finally {
      await handle.close();
    }
    return entries.map((entry) => {
      const start = entry.byteOffset - first.byteOffset;
      const raw = buffer.subarray(start, start + entry.byteLength).toString("utf8").trimEnd();
      const parsed: unknown = JSON.parse(raw);
      if (!isRuntimeEvent(parsed)
        || parsed.threadId !== threadId
        || parsed.sequence !== entry.sequence
        || parsed.eventId !== entry.eventId) {
        throw new Error(`Runtime event index mismatch at sequence ${entry.sequence}`);
      }
      return cloneEvent(parsed);
    });
  }

  private async getEventIndex(): Promise<SqliteRuntimeEventIndex | undefined> {
    if (this.indexFile === false || this.indexDisabled) return undefined;
    if (this.eventIndex) return this.eventIndex;
    try {
      await this.ensureDirectory();
      this.eventIndex = new SqliteRuntimeEventIndex(this.indexFile);
      if (process.platform !== "win32") await chmod(this.indexFile, 0o600);
      return this.eventIndex;
    } catch (error) {
      const recovered = await this.recoverCorruptIndex(error);
      if (recovered) return recovered;
      this.disableIndex(error);
      return undefined;
    }
  }

  private async recoverCorruptIndex(error: unknown): Promise<SqliteRuntimeEventIndex | undefined> {
    if (this.indexFile === false) return undefined;
    try {
      await rename(this.indexFile, `${this.indexFile}.corrupt-${Date.now()}`);
      this.onIndexError?.(error instanceof Error ? error : new Error(String(error)));
      this.eventIndex = new SqliteRuntimeEventIndex(this.indexFile);
      if (process.platform !== "win32") await chmod(this.indexFile, 0o600);
      return this.eventIndex;
    } catch {
      return undefined;
    }
  }

  private async ensureAllThreadsIndexed(index: SqliteRuntimeEventIndex): Promise<void> {
    await this.ensureDirectory();
    const fileNames = new Set((await readdir(this.directory))
      .filter((name) => name.endsWith(".jsonl")));
    const summaries = index.allThreads();
    for (const summary of summaries) {
      if (!fileNames.has(summary.fileName)) index.removeThread(summary.threadId);
      else await this.prepareThread(summary.threadId);
    }
    const indexedFiles = new Set(summaries.map((summary) => summary.fileName));
    for (const fileName of fileNames) {
      if (indexedFiles.has(fileName)) continue;
      const threadId = await this.readThreadId(join(this.directory, fileName));
      if (basename(this.filePath(threadId)) !== fileName) {
        throw new RuntimeEventStoreCorruptionError(join(this.directory, fileName), 1);
      }
      await this.prepareThread(threadId);
    }
  }

  private async readThreadId(path: string): Promise<string> {
    const raw = await readFile(path, "utf8");
    const first = raw.split("\n").find((line) => line.trim());
    if (!first) throw new RuntimeEventStoreCorruptionError(path, 1);
    try {
      const event: unknown = JSON.parse(first);
      if (!isRuntimeEvent(event)) throw new Error("invalid event");
      return event.threadId;
    } catch {
      throw new RuntimeEventStoreCorruptionError(path, 1);
    }
  }

  private disableIndex(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.eventIndex?.close();
    } catch {
      // The JSONL fact stream remains authoritative even if index cleanup fails.
    }
    this.eventIndex = undefined;
    this.indexDisabled = true;
    this.onIndexError?.(normalized);
  }

  /** A killed process can leave only the final JSONL record incomplete. Drop
   * that tail before the next append so the new record cannot be concatenated
   * onto invalid JSON. A complete record missing only its newline is retained. */
  private async repairIncompleteTail(threadId: ThreadId): Promise<void> {
    const path = this.filePath(threadId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!raw || raw.endsWith("\n")) return;
    const lastNewline = raw.lastIndexOf("\n");
    const tail = raw.slice(lastNewline + 1);
    try {
      const parsed: unknown = JSON.parse(tail);
      if (!isRuntimeEvent(parsed) || parsed.threadId !== threadId) throw new Error("invalid tail");
      await appendFile(path, "\n", "utf8");
    } catch {
      const validPrefix = raw.slice(0, lastNewline + 1);
      await truncate(path, Buffer.byteLength(validPrefix, "utf8"));
      this.latestByThread.delete(threadId);
    }
  }
}

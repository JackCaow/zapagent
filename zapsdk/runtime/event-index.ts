import { Database } from "bun:sqlite";

export interface RuntimeEventIndexEntry {
  threadId: string;
  sequence: number;
  eventId: string;
  timestamp: number;
  payloadType: string;
  turnId?: string;
  runId?: string;
  byteOffset: number;
  byteLength: number;
}

export interface RuntimeEventThreadSummary {
  threadId: string;
  fileName: string;
  fileSize: number;
  fileMtimeMs: number;
  eventCount: number;
  firstSequence: number;
  latestSequence: number;
  firstTimestamp: number;
  latestTimestamp: number;
}

export interface RuntimeEventIndexQuery {
  afterSequence: number;
  beforeSequence: number;
  direction: "forward" | "backward";
  limit: number;
}

export interface RuntimeEventIndexPage {
  entries: RuntimeEventIndexEntry[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

interface ThreadRow {
  thread_id: string;
  file_name: string;
  file_size: number;
  file_mtime_ms: number;
  event_count: number;
  first_sequence: number;
  latest_sequence: number;
  first_timestamp: number;
  latest_timestamp: number;
}

interface EntryRow {
  thread_id: string;
  sequence: number;
  event_id: string;
  timestamp: number;
  payload_type: string;
  turn_id: string | null;
  run_id: string | null;
  byte_offset: number;
  byte_length: number;
}

function summaryFromRow(row: ThreadRow): RuntimeEventThreadSummary {
  return {
    threadId: row.thread_id,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileMtimeMs: row.file_mtime_ms,
    eventCount: row.event_count,
    firstSequence: row.first_sequence,
    latestSequence: row.latest_sequence,
    firstTimestamp: row.first_timestamp,
    latestTimestamp: row.latest_timestamp,
  };
}

function entryFromRow(row: EntryRow): RuntimeEventIndexEntry {
  return {
    threadId: row.thread_id,
    sequence: row.sequence,
    eventId: row.event_id,
    timestamp: row.timestamp,
    payloadType: row.payload_type,
    turnId: row.turn_id ?? undefined,
    runId: row.run_id ?? undefined,
    byteOffset: row.byte_offset,
    byteLength: row.byte_length,
  };
}

/** Rebuildable projection over append-only runtime JSONL files. The index
 * deliberately stores no prompt, tool argument, result, or message content. */
export class SqliteRuntimeEventIndex {
  private readonly database: Database;

  constructor(readonly filePath: string) {
    this.database = new Database(filePath, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode = DELETE");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runtime_event_threads (
        thread_id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        event_count INTEGER NOT NULL,
        first_sequence INTEGER NOT NULL,
        latest_sequence INTEGER NOT NULL,
        first_timestamp REAL NOT NULL,
        latest_timestamp REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_event_entries (
        thread_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        timestamp REAL NOT NULL,
        payload_type TEXT NOT NULL,
        turn_id TEXT,
        run_id TEXT,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        PRIMARY KEY (thread_id, sequence),
        FOREIGN KEY (thread_id) REFERENCES runtime_event_threads(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS runtime_event_entries_turn
        ON runtime_event_entries(thread_id, turn_id, sequence);
      CREATE INDEX IF NOT EXISTS runtime_event_entries_run
        ON runtime_event_entries(thread_id, run_id, sequence);
      CREATE INDEX IF NOT EXISTS runtime_event_threads_recent
        ON runtime_event_threads(latest_timestamp DESC, thread_id ASC);
    `);
  }

  close(): void {
    this.database.close(false);
  }

  summary(threadId: string): RuntimeEventThreadSummary | undefined {
    const row = this.database.query<ThreadRow, [string]>(`
      SELECT * FROM runtime_event_threads WHERE thread_id = ?
    `).get(threadId);
    return row ? summaryFromRow(row) : undefined;
  }

  isCurrent(threadId: string, fileSize: number, fileMtimeMs: number): boolean {
    const row = this.summary(threadId);
    return row !== undefined
      && row.fileSize === fileSize
      && Math.abs(row.fileMtimeMs - fileMtimeMs) < 0.001;
  }

  replaceThread(input: {
    threadId: string;
    fileName: string;
    fileSize: number;
    fileMtimeMs: number;
    entries: readonly RuntimeEventIndexEntry[];
  }): void {
    const entries = [...input.entries].sort((left, right) => left.sequence - right.sequence);
    const first = entries[0];
    const latest = entries.at(-1);
    const replace = this.database.transaction(() => {
      this.database.query<void, [string]>(`
        DELETE FROM runtime_event_entries WHERE thread_id = ?
      `).run(input.threadId);
      this.database.query<void, [string]>(`
        DELETE FROM runtime_event_threads WHERE thread_id = ?
      `).run(input.threadId);
      if (!first || !latest) return;
      this.database.query<void, [string, string, number, number, number, number, number, number, number]>(`
        INSERT INTO runtime_event_threads (
          thread_id, file_name, file_size, file_mtime_ms, event_count,
          first_sequence, latest_sequence, first_timestamp, latest_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.threadId,
        input.fileName,
        input.fileSize,
        input.fileMtimeMs,
        entries.length,
        first.sequence,
        latest.sequence,
        first.timestamp,
        latest.timestamp,
      );
      const insert = this.database.query<void, [string, number, string, number, string, string | null, string | null, number, number]>(`
        INSERT INTO runtime_event_entries (
          thread_id, sequence, event_id, timestamp, payload_type,
          turn_id, run_id, byte_offset, byte_length
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insert.run(
          entry.threadId,
          entry.sequence,
          entry.eventId,
          entry.timestamp,
          entry.payloadType,
          entry.turnId ?? null,
          entry.runId ?? null,
          entry.byteOffset,
          entry.byteLength,
        );
      }
    });
    replace();
  }

  append(input: {
    threadId: string;
    fileName: string;
    fileSize: number;
    fileMtimeMs: number;
    entries: readonly RuntimeEventIndexEntry[];
  }): void {
    if (input.entries.length === 0) return;
    const current = this.summary(input.threadId);
    if (!current) throw new Error(`Runtime event index is not prepared for ${input.threadId}`);
    const entries = [...input.entries].sort((left, right) => left.sequence - right.sequence);
    const first = entries[0]!;
    const latest = entries.at(-1)!;
    if (first.sequence <= current.latestSequence) {
      throw new Error(`Runtime event index sequence must increase for ${input.threadId}`);
    }
    const append = this.database.transaction(() => {
      const insert = this.database.query<void, [string, number, string, number, string, string | null, string | null, number, number]>(`
        INSERT INTO runtime_event_entries (
          thread_id, sequence, event_id, timestamp, payload_type,
          turn_id, run_id, byte_offset, byte_length
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insert.run(
          entry.threadId,
          entry.sequence,
          entry.eventId,
          entry.timestamp,
          entry.payloadType,
          entry.turnId ?? null,
          entry.runId ?? null,
          entry.byteOffset,
          entry.byteLength,
        );
      }
      this.database.query<void, [string, number, number, number, number, number, string]>(`
        UPDATE runtime_event_threads
        SET file_name = ?, file_size = ?, file_mtime_ms = ?,
            event_count = event_count + ?, latest_sequence = ?, latest_timestamp = ?
        WHERE thread_id = ?
      `).run(
        input.fileName,
        input.fileSize,
        input.fileMtimeMs,
        entries.length,
        latest.sequence,
        latest.timestamp,
        input.threadId,
      );
    });
    append();
  }

  page(threadId: string, query: RuntimeEventIndexQuery): RuntimeEventIndexPage {
    const order = query.direction === "backward" ? "DESC" : "ASC";
    const rows = this.database.query<EntryRow, [string, number, number, number]>(`
      SELECT * FROM runtime_event_entries
      WHERE thread_id = ? AND sequence > ? AND sequence < ?
      ORDER BY sequence ${order}
      LIMIT ?
    `).all(threadId, query.afterSequence, query.beforeSequence, query.limit);
    const entries = rows.map(entryFromRow);
    if (query.direction === "backward") entries.reverse();
    const first = entries[0]?.sequence;
    const latest = entries.at(-1)?.sequence;
    const summary = this.summary(threadId);
    return {
      entries,
      hasMoreBefore: first !== undefined
        && summary !== undefined
        && summary.firstSequence < first,
      hasMoreAfter: latest !== undefined
        && summary !== undefined
        && summary.latestSequence > latest,
    };
  }

  listThreads(limit = 100): RuntimeEventThreadSummary[] {
    if (!Number.isFinite(limit)) throw new Error("Runtime thread limit must be finite");
    const normalized = Math.max(0, Math.floor(limit));
    return this.database.query<ThreadRow, [number]>(`
      SELECT * FROM runtime_event_threads
      ORDER BY latest_timestamp DESC, thread_id ASC
      LIMIT ?
    `).all(normalized).map(summaryFromRow);
  }

  allThreads(): RuntimeEventThreadSummary[] {
    return this.database.query<ThreadRow, []>(`
      SELECT * FROM runtime_event_threads
      ORDER BY thread_id ASC
    `).all().map(summaryFromRow);
  }

  removeThread(threadId: string): void {
    const remove = this.database.transaction(() => {
      this.database.query<void, [string]>(`
        DELETE FROM runtime_event_entries WHERE thread_id = ?
      `).run(threadId);
      this.database.query<void, [string]>(`
        DELETE FROM runtime_event_threads WHERE thread_id = ?
      `).run(threadId);
    });
    remove();
  }
}

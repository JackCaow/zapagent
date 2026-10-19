import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateWorkflowRecord, validateWorkflowTransition, workflowError,
  type DeferredWorkflowRecord, type WorkflowControlStore } from "./workflow-control.js";

export class InMemoryWorkflowControlStore implements WorkflowControlStore {
  private readonly records = new Map<string, DeferredWorkflowRecord>();
  load(id: string): DeferredWorkflowRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }
  list(afterId = "", limit = 100): DeferredWorkflowRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) workflowError("INVALID_WORKFLOW_QUERY");
    return [...this.records.keys()].sort().filter(id => id > afterId).slice(0, limit).map(id => this.load(id)!);
  }
  compareAndSwap(expectedRevision: number, input: DeferredWorkflowRecord): void {
    const record = structuredClone(input);
    validateWorkflowTransition(this.records.get(record.id), record, expectedRevision);
    this.records.set(record.id, record);
  }
}

/** Durable source of truth, not a rebuildable cache. One SQLite transaction per control revision. */
export class SqliteWorkflowControlStore implements WorkflowControlStore {
  private readonly database: Database;
  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.database = new Database(filePath, { create: true, strict: true });
    try {
      if (filePath !== ":memory:") chmodSync(filePath, 0o600);
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec("PRAGMA journal_mode = DELETE");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec(`CREATE TABLE IF NOT EXISTS workflow_control_revisions (
        workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY (workflow_id, revision)
      )`);
    } catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }
  list(afterId = "", limit = 100): DeferredWorkflowRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) workflowError("INVALID_WORKFLOW_QUERY");
    const rows = this.database.query<{ workflow_id: string }, [string, number]>(
      "SELECT DISTINCT workflow_id FROM workflow_control_revisions WHERE workflow_id > ? ORDER BY workflow_id LIMIT ?",
    ).all(afterId, limit);
    return rows.map(row => this.load(row.workflow_id)!);
  }
  load(id: string): DeferredWorkflowRecord | undefined {
    const row = this.database.query<{ revision: number; record_json: string }, [string]>(
      "SELECT revision, record_json FROM workflow_control_revisions WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(id);
    if (!row) return undefined;
    const record: unknown = JSON.parse(row.record_json);
    validateWorkflowRecord(record);
    if (record.id !== id || record.revision !== row.revision) workflowError("INVALID_WORKFLOW_RECORD");
    return record;
  }
  compareAndSwap(expectedRevision: number, input: DeferredWorkflowRecord): void {
    const record = structuredClone(input);
    // IMMEDIATE serializes writers across independent host processes, including cancellation vs claims.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      validateWorkflowTransition(this.load(record.id), record, expectedRevision);
      this.database.query("INSERT INTO workflow_control_revisions (workflow_id, revision, record_json) VALUES (?, ?, ?)")
        .run(record.id, record.revision, JSON.stringify(record));
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { GoalRecord, GoalStatus } from "./contracts.js";

/** Durable Host-owned records. BEGIN IMMEDIATE serializes cross-process claims and CAS. */
export class GoalStore {
  private readonly db: Database;
  constructor(path: string, private readonly options: { requireLedger?: boolean } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS goal_budget_extensions (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, at INTEGER NOT NULL, old_limits TEXT NOT NULL, new_limits TEXT NOT NULL)");
  }
  close(): void { this.db.close(); }
  create(input: { objective: string; cwd: string; deadlineAt: number; deliveryPolicy?: "artifact" | "workspace"; machineCheck?: "bun" | "npm" | "pytest" | "go"; dependencyInstall?: "npm"; permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" }): GoalRecord {
    if (!input.objective.trim() || !input.cwd || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now() || (input.dependencyInstall !== undefined && input.dependencyInstall !== "npm")) throw new Error("INVALID_GOAL");
    const now = Date.now();
    const value: GoalRecord = { id: `goal_${randomUUID()}`, objective: input.objective, deliveryPolicy: input.deliveryPolicy ?? "workspace", permissionMode: input.permissionMode ?? "default", ...(input.machineCheck ? { machineCheck: input.machineCheck } : {}), ...(input.dependencyInstall ? { dependencyInstall: input.dependencyInstall } : {}), cwd: input.cwd, stateRevision: 1, specRevision: 1, planRevision: 0, status: "created", createdAt: now, updatedAt: now, deadlineAt: input.deadlineAt, ownerEpoch: 0, tasks: [] };
    this.db.query("INSERT INTO goals(id,revision,record) VALUES(?,?,?)").run(value.id, value.stateRevision, JSON.stringify(value));
    return value;
  }
  get(id: string): GoalRecord | undefined {
    const row = this.db.query<{revision: number; record: string}, [string]>("SELECT revision,record FROM goals WHERE id=?").get(id);
    if (!row) return undefined;
    const state = JSON.parse(row.record) as GoalRecord;
    if (state.id !== id || state.stateRevision !== row.revision) throw new Error("CORRUPT_GOAL_STATE");
    return state;
  }
  list(cwd?: string): GoalRecord[] {
    const rows = this.db.query<{record: string}, []>("SELECT record FROM goals ORDER BY rowid DESC").all();
    return rows.map(row => JSON.parse(row.record) as GoalRecord).filter(goal => !cwd || goal.cwd === cwd);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private save(previous: GoalRecord, next: GoalRecord): GoalRecord {
    next.stateRevision = previous.stateRevision + 1;
    next.updatedAt = Date.now();
    const result = this.db.query("UPDATE goals SET revision=?,record=? WHERE id=? AND revision=?").run(next.stateRevision, JSON.stringify(next), next.id, previous.stateRevision) as { changes: number };
    const changed = result.changes;
    if (changed !== 1) throw new Error("GOAL_REVISION_CONFLICT");
    return structuredClone(next);
  }
  claim(id: string, instanceId: string, pid: number, forRecovery = false): GoalRecord {
    return this.transaction(() => {
      const goal = this.get(id); if (!goal) throw new Error("GOAL_NOT_FOUND");
      if (goal.owner) throw new Error("GOAL_OWNER_ACTIVE_OR_UNRESOLVED");
      if (["completed", "cancelled", "failed"].includes(goal.status)) throw new Error("GOAL_TERMINAL");
      if (goal.inFlight && !forRecovery) throw new Error("GOAL_RECOVERY_REQUIRED");
      if (forRecovery && !goal.inFlight) throw new Error("GOAL_NO_RECOVERY_REQUIRED");
      const next = structuredClone(goal); next.ownerEpoch++; next.owner = { instanceId, pid }; next.status = "running"; next.stopReason = undefined; next.control = undefined;
      // The Goal and its ledger reside in the same Host database. Advancing
      // both epochs under this transaction prevents a crash or SQLite error
      // from stranding a Goal at a revision its meter will never accept.
      const table = this.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='goal_budget_accounts'").get();
      if (table) {
        const changed = this.db.query("UPDATE goal_budget_accounts SET epoch=? WHERE goal_id=? AND epoch=?")
          .run(next.ownerEpoch, id, goal.ownerEpoch) as { changes: number };
        if (changed.changes !== 1) throw new Error("GOAL_BUDGET_EPOCH_CONFLICT");
      } else if (this.options.requireLedger) throw new Error("GOAL_BUDGET_ACCOUNT_MISSING");
      return this.save(goal, next);
    });
  }
  update(id: string, epoch: number, instanceId: string, fn: (value: GoalRecord) => void): GoalRecord {
    return this.transaction(() => {
      const goal = this.get(id); if (!goal) throw new Error("GOAL_NOT_FOUND");
      if (goal.ownerEpoch !== epoch || goal.owner?.instanceId !== instanceId) throw new Error("GOAL_STALE_OWNER");
      const next = structuredClone(goal); fn(next);
      if (next.id !== goal.id || next.ownerEpoch !== goal.ownerEpoch || next.owner?.instanceId !== goal.owner.instanceId || next.specRevision !== goal.specRevision || next.objective !== goal.objective || next.deliveryPolicy !== goal.deliveryPolicy || next.machineCheck !== goal.machineCheck || next.dependencyInstall !== goal.dependencyInstall || next.permissionMode !== goal.permissionMode || next.cwd !== goal.cwd || next.deadlineAt !== goal.deadlineAt) throw new Error("GOAL_IMMUTABLE_FIELD");
      return this.save(goal, next);
    });
  }
  release(id: string, epoch: number, instanceId: string, status: GoalStatus, reason?: string): GoalRecord {
    return this.transaction(() => {
      const goal = this.get(id); if (!goal) throw new Error("GOAL_NOT_FOUND");
      if (goal.ownerEpoch !== epoch || goal.owner?.instanceId !== instanceId) throw new Error("GOAL_STALE_OWNER");
      const next = structuredClone(goal); next.owner = undefined; next.status = status; next.stopReason = reason;
      return this.save(goal, next);
    });
  }
  /** A user-requested extension updates Goal and ledger in the same SQLite transaction. */
  extendBudget(id: string, delta: { tokens?: number; modelCalls?: number; providerAttempts?: number; toolCalls?: number; minutes?: number }): GoalRecord {
    if (!Object.values(delta).some(value => value !== undefined) || Object.values(delta).some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) throw new Error("INVALID_GOAL_BUDGET_EXTENSION");
    return this.transaction(() => {
      const goal = this.get(id); if (!goal) throw new Error("GOAL_NOT_FOUND");
      if (goal.owner) throw new Error("GOAL_OWNER_ACTIVE_OR_UNRESOLVED");
      if (["completed", "cancelled", "failed"].includes(goal.status)) throw new Error("GOAL_TERMINAL");
      const account = this.db.query<{epoch: number; limits_json: string}, [string]>("SELECT epoch, limits_json FROM goal_budget_accounts WHERE goal_id=?").get(id);
      if (!account || account.epoch !== goal.ownerEpoch) throw new Error("GOAL_BUDGET_EPOCH_CONFLICT");
      const limits = JSON.parse(account.limits_json) as Record<string, unknown>; const nextLimits = structuredClone(limits);
      const add = (key: string, amount: number | undefined) => {
        if (amount === undefined) return;
        const prior = nextLimits[key];
        if (typeof prior !== "number" || !Number.isSafeInteger(prior) || !Number.isSafeInteger(prior + amount)) throw new Error("GOAL_BUDGET_LIMIT_UNAVAILABLE");
        nextLimits[key] = prior + amount;
      };
      add("maxTokens", delta.tokens); add("maxModelCalls", delta.modelCalls); add("maxProviderAttempts", delta.providerAttempts); add("maxToolCalls", delta.toolCalls);
      if (delta.minutes !== undefined) add("deadlineAt", delta.minutes * 60_000);
      const next = structuredClone(goal);
      if (delta.minutes !== undefined) {
        if (typeof nextLimits.deadlineAt !== "number") throw new Error("GOAL_BUDGET_LIMIT_UNAVAILABLE");
        next.deadlineAt = nextLimits.deadlineAt;
      }
      this.db.query("UPDATE goal_budget_accounts SET limits_json=? WHERE goal_id=? AND epoch=?").run(JSON.stringify(nextLimits), id, account.epoch);
      this.db.query("INSERT INTO goal_budget_extensions(id,goal_id,at,old_limits,new_limits) VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, Date.now(), account.limits_json, JSON.stringify(nextLimits));
      return this.save(goal, next);
    });
  }
  /** User control requests are persisted separately from owner transitions. */
  requestControl(id: string, control: "pause" | "cancel"): GoalRecord {
    return this.transaction(() => {
      const goal = this.get(id); if (!goal) throw new Error("GOAL_NOT_FOUND");
      if (["completed", "cancelled", "failed"].includes(goal.status)) throw new Error("GOAL_TERMINAL");
      const next = structuredClone(goal); next.control = control;
      if (!next.owner && !next.inFlight) { next.status = control === "pause" ? "paused" : "cancelled"; next.control = undefined; }
      return this.save(goal, next);
    });
  }
  /** Caller must independently establish prior writer and its children are stopped. */
  recoverOwner(id: string, expectedInstanceId: string, stopped: boolean): GoalRecord {
    if (!stopped) throw new Error("GOAL_OWNER_STOP_UNCONFIRMED");
    return this.transaction(() => {
      const goal = this.get(id); if (!goal) throw new Error("GOAL_NOT_FOUND");
      if (goal.owner?.instanceId !== expectedInstanceId) throw new Error("GOAL_OWNER_CHANGED");
      const next = structuredClone(goal); next.owner = undefined; next.status = "blocked";
      next.stopReason = next.inFlight ? "INTERRUPTED_OPERATION_REQUIRES_RECONCILIATION" : "INTERRUPTED_OWNER";
      return this.save(goal, next);
    });
  }
}

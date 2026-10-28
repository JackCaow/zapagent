import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Durable admission and accounting for calls controlled by a Goal host.
 * This ledger cannot measure calls made outside the host's instrumented
 * transports (for example an opaque CLI launched by a shell). */
export type GoalBudgetRole = "planner" | "worker" | "verifier" | "repair" | "maintenance" | "finalization";
export type GoalBudgetDenial = "budget_exhausted" | "role_limit" | "usage_unknown" | "price_unknown" | "deadline" | "stale_epoch" | "operation_exists";
export type GoalBudgetResult = { ok: true; operationId: string } | { ok: false; reason: GoalBudgetDenial };

export interface GoalRoleLimits {
  maxTokens?: number;
  maxModelCalls?: number;
  maxProviderAttempts?: number;
  maxToolCalls?: number;
  maxSpawns?: number;
}

export interface GoalBudgetLimits extends GoalRoleLimits {
  /** Absolute UTC deadline. It continues to pass while paused. */
  deadlineAt?: number;
  /** All prices must use the same host-defined currency and price snapshot. */
  maxCostMicro?: number;
  /** Reserve tokens for the verifier and finalization; other roles cannot consume them. */
  reservedTokens?: number;
  /** Strict is the default. When false, unknown usage is visible but does not block admission. */
  strict?: boolean;
  roles?: Partial<Record<GoalBudgetRole, GoalRoleLimits>>;
}

export interface GoalBudgetRequest {
  operationId: string;
  /** Stable for all HTTP attempts belonging to one logical model invocation. */
  logicalCallId: string;
  role: GoalBudgetRole;
  estimatedTokens: number;
  /** null or absent denotes an unknown price, not a zero price. */
  estimatedCostMicro?: number | null;
  /** Public billing identity only; never include credentials or raw prompts. */
  scope?: { providerId: string; modelId: string; priceRevision?: string; currency?: string };
}

export interface GoalBudgetUsage {
  /** SDK inputTokens is already fresh input, not the total including caches. */
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costMicro: number | null;
  usageIncomplete?: boolean;
}

export interface GoalBudgetReservation extends GoalBudgetRequest {
  goalId: string;
  epoch: number;
  status: "reserved" | "dispatched" | "uncertain" | "settled" | "released";
  estimatedCostMicro: number | null;
  usage: GoalBudgetUsage | null;
}

export interface GoalBudgetSnapshot {
  goalId: string;
  epoch: number;
  limits: GoalBudgetLimits;
  totals: {
    modelCalls: number;
    providerAttempts: number;
    toolCalls: number;
    spawns: number;
    tokensUsed: number;
    tokensReserved: number;
    costMicroUsed: number;
    costMicroReserved: number;
    unknownUsage: number;
    unknownPrice: number;
    /** Number of admitted tools whose external spend cannot be observed. */
    opaqueToolCalls: number;
  };
  reservations: GoalBudgetReservation[];
}

interface AccountRow { epoch: number; limits_json: string }
interface ReservationRow {
  goal_id: string; operation_id: string; logical_id: string; role: GoalBudgetRole; epoch: number;
  status: GoalBudgetReservation["status"]; estimated_tokens: number; estimated_cost: number | null; usage_json: string | null; scope_json: string | null;
}
interface EventRow { operation_id: string; role: GoalBudgetRole; kind: "tool" | "spawn"; opaque: number }

const roles: readonly GoalBudgetRole[] = ["planner", "worker", "verifier", "repair", "maintenance", "finalization"];
const limitKeys = ["maxTokens", "maxModelCalls", "maxProviderAttempts", "maxToolCalls", "maxSpawns"] as const;

function identifier(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid Goal budget identifier");
}
function integer(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Goal budget ${field}`);
}
function validateRole(role: GoalBudgetRole): void {
  if (!roles.includes(role)) throw new Error("Invalid Goal budget role");
}
function validateLimits(limits: GoalBudgetLimits): void {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error("Invalid Goal budget limits");
  const allowed = [...limitKeys, "maxCostMicro", "deadlineAt", "reservedTokens", "strict", "roles"];
  if (Object.keys(limits).some(key => !allowed.includes(key as never))) throw new Error("Unknown Goal budget limit");
  for (const key of [...limitKeys, "maxCostMicro", "deadlineAt", "reservedTokens"] as const) {
    if (limits[key] !== undefined) integer(limits[key]!, key);
  }
  if (limits.strict !== undefined && typeof limits.strict !== "boolean") throw new Error("Invalid Goal budget strict mode");
  if (limits.roles !== undefined) {
    if (!limits.roles || typeof limits.roles !== "object" || Array.isArray(limits.roles)) throw new Error("Invalid Goal role limits");
    for (const [role, item] of Object.entries(limits.roles)) {
      validateRole(role as GoalBudgetRole);
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !limitKeys.includes(key as never))) throw new Error("Invalid Goal role limits");
      for (const key of limitKeys) if (item[key] !== undefined) integer(item[key]!, key);
    }
  }
  if (limits.maxTokens !== undefined && (limits.reservedTokens ?? 0) > limits.maxTokens) throw new Error("Goal token reserve exceeds limit");
}
function validateUsage(usage: GoalBudgetUsage): void {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Invalid Goal usage");
  for (const key of ["freshInputTokens", "cacheReadTokens", "cacheCreationTokens", "outputTokens"] as const) integer(usage[key], key);
  if (usage.costMicro !== null) integer(usage.costMicro, "costMicro");
  if (usage.usageIncomplete !== undefined && typeof usage.usageIncomplete !== "boolean") throw new Error("Invalid Goal usage completeness");
  if (!Number.isSafeInteger(tokenTotal(usage))) throw new Error("Goal token total exceeds safe integer range");
}
function tokenTotal(usage: GoalBudgetUsage): number {
  return usage.freshInputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens;
}
function sameUsage(a: GoalBudgetUsage, b: GoalBudgetUsage): boolean {
  return a.freshInputTokens === b.freshInputTokens && a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens && a.outputTokens === b.outputTokens &&
    a.costMicro === b.costMicro && Boolean(a.usageIncomplete) === Boolean(b.usageIncomplete);
}

export class GoalBudgetLedger {
  private readonly database: Database;

  constructor(readonly filePath: string) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.database = new Database(filePath, { create: true, strict: true });
    try {
      if (filePath !== ":memory:") chmodSync(filePath, 0o600);
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec("PRAGMA journal_mode = DELETE");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec(`CREATE TABLE IF NOT EXISTS goal_budget_accounts (
        goal_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, limits_json TEXT NOT NULL
      )`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS goal_budget_reservations (
        goal_id TEXT NOT NULL, operation_id TEXT NOT NULL, logical_id TEXT NOT NULL,
        role TEXT NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL, estimated_cost INTEGER, usage_json TEXT, scope_json TEXT,
        PRIMARY KEY (goal_id, operation_id), FOREIGN KEY (goal_id) REFERENCES goal_budget_accounts(goal_id)
      )`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS goal_budget_events (
        goal_id TEXT NOT NULL, operation_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
        opaque INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (goal_id, operation_id), FOREIGN KEY (goal_id) REFERENCES goal_budget_accounts(goal_id)
      )`);
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void { this.database.close(); }

  private transaction<T>(fn: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private account(goalId: string): { epoch: number; limits: GoalBudgetLimits } {
    identifier(goalId);
    const row = this.database.query<AccountRow, [string]>("SELECT epoch, limits_json FROM goal_budget_accounts WHERE goal_id = ?").get(goalId);
    if (!row) throw new Error("Goal budget account not found");
    const limits = JSON.parse(row.limits_json) as GoalBudgetLimits;
    validateLimits(limits);
    return { epoch: row.epoch, limits };
  }

  create(goalId: string, epoch: number, limits: GoalBudgetLimits): void {
    identifier(goalId); integer(epoch, "epoch"); validateLimits(limits);
    this.transaction(() => this.database.query("INSERT INTO goal_budget_accounts(goal_id, epoch, limits_json) VALUES (?, ?, ?)")
      .run(goalId, epoch, JSON.stringify(limits)));
  }

  /** Host must first prove that the old owner's writers have stopped. */
  advanceEpoch(goalId: string, expectedEpoch: number, nextEpoch: number): boolean {
    integer(expectedEpoch, "expected epoch"); integer(nextEpoch, "next epoch");
    if (nextEpoch <= expectedEpoch) throw new Error("Goal epoch must increase");
    return this.transaction(() => {
      this.account(goalId);
      const result = this.database.query("UPDATE goal_budget_accounts SET epoch = ? WHERE goal_id = ? AND epoch = ?")
        .run(nextEpoch, goalId, expectedEpoch) as { changes: number };
      return result.changes === 1;
    });
  }

  /** Only explicitly authorized, monotonic limit extensions are accepted. */
  extend(goalId: string, epoch: number, limits: GoalBudgetLimits): boolean {
    validateLimits(limits);
    return this.transaction(() => {
      const account = this.account(goalId);
      if (account.epoch !== epoch) return false;
      const previous = account.limits;
      for (const key of [...limitKeys, "maxCostMicro", "deadlineAt"] as const) {
        if (previous[key] === undefined && limits[key] !== undefined ||
          previous[key] !== undefined && limits[key] !== undefined && limits[key]! < previous[key]!) {
          throw new Error(`Goal budget extension cannot restrict ${key}`);
        }
      }
      for (const role of roles) for (const key of limitKeys) {
        const before = previous.roles?.[role]?.[key], after = limits.roles?.[role]?.[key];
        if (before === undefined && after !== undefined || before !== undefined && after !== undefined && after < before) throw new Error("Goal budget extension cannot restrict a role");
      }
      if (previous.strict !== false && limits.strict === false) throw new Error("Changing unknown-usage policy requires a separate explicit authorization");
      if ((limits.reservedTokens ?? 0) > (previous.reservedTokens ?? 0)) throw new Error("Goal budget extension cannot increase withheld reserve");
      this.database.query("UPDATE goal_budget_accounts SET limits_json = ? WHERE goal_id = ?").run(JSON.stringify(limits), goalId);
      return true;
    });
  }

  private rows(goalId: string): { reservations: GoalBudgetReservation[]; events: EventRow[] } {
    const rows = this.database.query<ReservationRow, [string]>("SELECT * FROM goal_budget_reservations WHERE goal_id = ? ORDER BY rowid").all(goalId);
    const reservations = rows.map(row => ({
      goalId: row.goal_id, operationId: row.operation_id, logicalCallId: row.logical_id, role: row.role,
      epoch: row.epoch, status: row.status, estimatedTokens: row.estimated_tokens,
      estimatedCostMicro: row.estimated_cost, usage: row.usage_json === null ? null : JSON.parse(row.usage_json) as GoalBudgetUsage,
      ...(row.scope_json === null ? {} : { scope: JSON.parse(row.scope_json) as GoalBudgetRequest["scope"] }),
    }));
    const events = this.database.query<EventRow, [string]>("SELECT operation_id, role, kind, opaque FROM goal_budget_events WHERE goal_id = ? ORDER BY rowid").all(goalId);
    return { reservations, events };
  }

  snapshot(goalId: string): GoalBudgetSnapshot {
    return this.transaction(() => this.snapshotUnlocked(goalId));
  }

  private snapshotUnlocked(goalId: string): GoalBudgetSnapshot {
    const account = this.account(goalId);
    const { reservations, events } = this.rows(goalId);
    const active = reservations.filter(item => item.status !== "released");
    const outstanding = active.filter(item => item.status !== "settled");
    return {
      goalId, epoch: account.epoch, limits: account.limits, reservations,
      totals: {
        modelCalls: new Set(active.map(item => item.logicalCallId)).size,
        providerAttempts: active.length,
        toolCalls: events.filter(item => item.kind === "tool").length,
        spawns: events.filter(item => item.kind === "spawn").length,
        tokensUsed: active.reduce((n, item) => n + (item.usage ? tokenTotal(item.usage) : 0), 0),
        tokensReserved: outstanding.reduce((n, item) => n + Math.max(0, item.estimatedTokens - (item.usage ? tokenTotal(item.usage) : 0)), 0),
        costMicroUsed: active.reduce((n, item) => n + (item.usage?.costMicro ?? 0), 0),
        costMicroReserved: outstanding.reduce((n, item) => n + Math.max(0, (item.estimatedCostMicro ?? 0) - (item.usage?.costMicro ?? 0)), 0),
        unknownUsage: active.filter(item => item.status === "uncertain" || item.usage?.usageIncomplete).length,
        unknownPrice: active.filter(item => item.usage ? item.usage.costMicro === null : item.estimatedCostMicro === null).length,
        opaqueToolCalls: events.filter(item => item.opaque === 1).length,
      },
    };
  }

  reserve(goalId: string, epoch: number, request: GoalBudgetRequest): GoalBudgetResult {
    identifier(request.operationId); identifier(request.logicalCallId); validateRole(request.role);
    integer(epoch, "epoch"); integer(request.estimatedTokens, "estimatedTokens");
    if (request.estimatedCostMicro != null) integer(request.estimatedCostMicro, "estimatedCostMicro");
    if (request.scope !== undefined) {
      if (!request.scope || typeof request.scope !== "object" || Object.keys(request.scope).some(key => !["providerId", "modelId", "priceRevision", "currency"].includes(key))) throw new Error("Invalid Goal budget scope");
      identifier(request.scope.providerId); identifier(request.scope.modelId);
      if (request.scope.priceRevision !== undefined) identifier(request.scope.priceRevision);
      if (request.scope.currency !== undefined) identifier(request.scope.currency);
    }
    return this.transaction(() => {
      const snap = this.snapshotUnlocked(goalId), { limits, totals, reservations } = snap;
      if (snap.epoch !== epoch) return { ok: false, reason: "stale_epoch" };
      const existing = reservations.find(item => item.operationId === request.operationId);
      if (existing) {
        if (existing.status === "reserved" && existing.epoch === epoch && existing.logicalCallId === request.logicalCallId && existing.role === request.role &&
          existing.estimatedTokens === request.estimatedTokens && existing.estimatedCostMicro === (request.estimatedCostMicro ?? null) &&
          JSON.stringify(existing.scope ?? null) === JSON.stringify(request.scope ?? null)) return { ok: true, operationId: request.operationId };
        return { ok: false, reason: "operation_exists" };
      }
      if (limits.deadlineAt !== undefined && Date.now() >= limits.deadlineAt) return { ok: false, reason: "deadline" };
      if (limits.maxTokens !== undefined && request.estimatedTokens === 0) throw new Error("Token-limited Goal requests require a positive reservation");
      if (limits.strict !== false && totals.opaqueToolCalls > 0 && [limits.maxTokens, limits.maxCostMicro,
        limits.maxModelCalls, limits.maxProviderAttempts, limits.maxSpawns].some(value => value !== undefined)) return { ok: false, reason: "usage_unknown" };
      if (limits.strict !== false && limits.maxTokens !== undefined && totals.unknownUsage > 0) return { ok: false, reason: "usage_unknown" };
      if (limits.strict !== false && limits.maxCostMicro !== undefined && (totals.unknownPrice > 0 || request.estimatedCostMicro == null)) return { ok: false, reason: "price_unknown" };
      const sameLogical = reservations.filter(item => item.status !== "released" && item.logicalCallId === request.logicalCallId);
      if (sameLogical.some(item => item.role !== request.role)) throw new Error("Logical Goal call cannot change roles");
      const addsModelCall = sameLogical.length === 0 ? 1 : 0;
      const protectedTokens = request.role === "verifier" || request.role === "finalization" ? 0 : (limits.reservedTokens ?? 0);
      if (limits.maxModelCalls !== undefined && totals.modelCalls + addsModelCall > limits.maxModelCalls ||
          limits.maxProviderAttempts !== undefined && totals.providerAttempts + 1 > limits.maxProviderAttempts ||
          limits.maxTokens !== undefined && totals.tokensUsed + totals.tokensReserved + request.estimatedTokens > limits.maxTokens - protectedTokens ||
          limits.maxCostMicro !== undefined && totals.costMicroUsed + totals.costMicroReserved + (request.estimatedCostMicro ?? 0) > limits.maxCostMicro) return { ok: false, reason: "budget_exhausted" };
      const role = limits.roles?.[request.role];
      const own = reservations.filter(item => item.role === request.role && item.status !== "released");
      const ownCalls = new Set(own.map(item => item.logicalCallId)).size;
      const ownTokens = own.reduce((n, item) => n + (item.usage ? tokenTotal(item.usage) : 0) + (item.status !== "settled" ? Math.max(0, item.estimatedTokens - (item.usage ? tokenTotal(item.usage) : 0)) : 0), 0);
      if (role?.maxModelCalls !== undefined && ownCalls + addsModelCall > role.maxModelCalls ||
          role?.maxProviderAttempts !== undefined && own.length + 1 > role.maxProviderAttempts ||
          role?.maxTokens !== undefined && ownTokens + request.estimatedTokens > role.maxTokens) return { ok: false, reason: "role_limit" };
      this.database.query(`INSERT INTO goal_budget_reservations
        (goal_id, operation_id, logical_id, role, epoch, status, estimated_tokens, estimated_cost, usage_json, scope_json)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, ?)`)
        .run(goalId, request.operationId, request.logicalCallId, request.role, epoch, request.estimatedTokens, request.estimatedCostMicro ?? null, request.scope ? JSON.stringify(request.scope) : null);
      return { ok: true, operationId: request.operationId };
    });
  }

  /** The committed transition must precede the actual transport call.
   * A duplicate dispatch is refused: callers must never replay an ambiguous call. */
  dispatch(goalId: string, epoch: number, operationId: string): GoalBudgetResult {
    identifier(operationId); integer(epoch, "epoch");
    return this.transaction(() => {
      const account = this.account(goalId);
      if (account.epoch !== epoch) return { ok: false, reason: "stale_epoch" };
      if (account.limits.deadlineAt !== undefined && Date.now() >= account.limits.deadlineAt) return { ok: false, reason: "deadline" };
      const result = this.database.query("UPDATE goal_budget_reservations SET status = 'dispatched' WHERE goal_id = ? AND operation_id = ? AND epoch = ? AND status = 'reserved'")
        .run(goalId, operationId, epoch) as { changes: number };
      return result.changes === 1 ? { ok: true, operationId } : { ok: false, reason: "operation_exists" };
    });
  }

  /** Settlement is a trusted host operation. A late report from an already
   * dispatched attempt remains chargeable after a lease/epoch change. */
  settle(goalId: string, operationId: string, usage: GoalBudgetUsage): void {
    identifier(operationId); validateUsage(usage);
    this.transaction(() => {
      this.account(goalId);
      const item = this.rows(goalId).reservations.find(row => row.operationId === operationId);
      if (!item || !["dispatched", "uncertain", "settled"].includes(item.status)) throw new Error("Goal usage was not dispatched");
      if (item.usage) {
        if (sameUsage(item.usage, usage)) return;
        const canResolve = (item.usage.usageIncomplete || item.usage.costMicro === null) &&
          usage.freshInputTokens >= item.usage.freshInputTokens && usage.cacheReadTokens >= item.usage.cacheReadTokens &&
          usage.cacheCreationTokens >= item.usage.cacheCreationTokens && usage.outputTokens >= item.usage.outputTokens &&
          (item.usage.costMicro === null || usage.costMicro === item.usage.costMicro) &&
          (!item.usage.usageIncomplete || !usage.usageIncomplete);
        if (!canResolve) throw new Error("Conflicting Goal usage settlement");
      }
      this.database.query("UPDATE goal_budget_reservations SET status = ?, usage_json = ? WHERE goal_id = ? AND operation_id = ?")
        .run(usage.usageIncomplete ? "uncertain" : "settled", JSON.stringify(usage), goalId, operationId);
    });
  }

  markUncertain(goalId: string, operationId: string): void {
    identifier(operationId);
    this.transaction(() => {
      this.account(goalId);
      const item = this.rows(goalId).reservations.find(row => row.operationId === operationId);
      if (!item || !["dispatched", "uncertain"].includes(item.status)) throw new Error("Only dispatched Goal requests can be uncertain");
      if (item.status === "dispatched") this.database.query("UPDATE goal_budget_reservations SET status = 'uncertain' WHERE goal_id = ? AND operation_id = ?").run(goalId, operationId);
    });
  }

  /** After the host has fenced and stopped older owners, record all of their
   * dispatched requests as uncertain. Reserved entries are intentionally left
   * untouched until the caller proves they never crossed dispatch. */
  recoverDispatched(goalId: string, epoch: number): number {
    integer(epoch, "epoch");
    return this.transaction(() => {
      if (this.account(goalId).epoch !== epoch) throw new Error("Stale Goal budget epoch");
      const result = this.database.query("UPDATE goal_budget_reservations SET status = 'uncertain' WHERE goal_id = ? AND epoch < ? AND status = 'dispatched'")
        .run(goalId, epoch) as { changes: number };
      return result.changes;
    });
  }

  /** Caller must prove this operation never crossed the dispatch boundary. */
  releaseUnsent(goalId: string, epoch: number, operationId: string): boolean {
    identifier(operationId); integer(epoch, "epoch");
    return this.transaction(() => {
      if (this.account(goalId).epoch !== epoch) return false;
      const result = this.database.query("UPDATE goal_budget_reservations SET status = 'released' WHERE goal_id = ? AND operation_id = ? AND status = 'reserved'").run(goalId, operationId) as { changes: number };
      return result.changes === 1;
    });
  }

  /** Persists tool/spawn admission before invocation. Duplicate IDs never
   * authorize replay, even if the caller did not receive the prior response. */
  admit(goalId: string, epoch: number, event: { operationId: string; role: GoalBudgetRole; kind: "tool" | "spawn"; opaque?: boolean }): GoalBudgetResult {
    identifier(event.operationId); integer(epoch, "epoch"); validateRole(event.role);
    if (event.kind !== "tool" && event.kind !== "spawn") throw new Error("Invalid Goal budget event");
    if (event.opaque !== undefined && typeof event.opaque !== "boolean") throw new Error("Invalid Goal opaque-tool flag");
    return this.transaction(() => {
      const snap = this.snapshotUnlocked(goalId);
      if (snap.epoch !== epoch) return { ok: false, reason: "stale_epoch" };
      if (snap.limits.deadlineAt !== undefined && Date.now() >= snap.limits.deadlineAt) return { ok: false, reason: "deadline" };
      const { events } = this.rows(goalId);
      if (events.some(item => item.operation_id === event.operationId)) return { ok: false, reason: "operation_exists" };
      if (event.opaque && snap.limits.strict !== false &&
          ["maxTokens", "maxCostMicro", "maxModelCalls", "maxProviderAttempts", "maxSpawns"].some(key => snap.limits[key as keyof GoalBudgetLimits] !== undefined)) {
        return { ok: false, reason: "usage_unknown" };
      }
      const kindKey = event.kind === "tool" ? "maxToolCalls" : "maxSpawns";
      const count = event.kind === "tool" ? snap.totals.toolCalls : snap.totals.spawns;
      const max = snap.limits[kindKey];
      if (max !== undefined && count >= max) return { ok: false, reason: "budget_exhausted" };
      const roleMax = snap.limits.roles?.[event.role]?.[kindKey];
      if (roleMax !== undefined && events.filter(item => item.role === event.role && item.kind === event.kind).length >= roleMax) return { ok: false, reason: "role_limit" };
      this.database.query("INSERT INTO goal_budget_events(goal_id, operation_id, role, kind, opaque) VALUES (?, ?, ?, ?, ?)").run(goalId, event.operationId, event.role, event.kind, event.opaque ? 1 : 0);
      return { ok: true, operationId: event.operationId };
    });
  }
}

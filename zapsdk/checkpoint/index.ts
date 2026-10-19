// zapsdk/checkpoint/index.ts
import { randomUUID } from "node:crypto";
import { CheckpointArchive } from "./archive.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "./blob-store.js";
import { SnapshotStore } from "./snapshot-store.js";
import { trackEdit } from "./track-edit.js";
import { makeSnapshot } from "./make-snapshot.js";
import { rewind, rewindDryRun } from "./rewind.js";
import { checkpointSkipReason, resolveCheckpointPath } from "./paths.js";
import type {
  CheckpointConfig, CheckpointCoverage, CheckpointEditTracker, DiffStats, FileBackup, RewindMode, RewindResult, Snapshot,
} from "./types.js";
import { DEFAULT_CHECKPOINT_CONFIG } from "./types.js";
import { getAppDataDir } from "../utils/platform.js";
import { resolveProjectDataSegment } from "../utils/project-paths.js";

export type SnapshotJsonlEntry = { type: "snapshot"; snapshot: Snapshot };

/** Ordered stream of checkpoint-related JSONL entries consumed by
 *  `hydrateFromJsonl`. Snapshots hydrate the index; rewind-markers prune
 *  any previously-hydrated snapshot whose turnStartIndex fell inside the
 *  rewound-away range. This mirrors the in-memory fork semantics so /load
 *  doesn't resurrect the abandoned forward branch. */
export type CheckpointJournalEntry =
  | SnapshotJsonlEntry
  | { type: "rewind-marker"; sessionId: string; targetTurnStartIndex: number; logIndex?: number; snapshotId?: string };

export interface SnapshotLogPosition {
  journalLogIndex: number;
  uiLogIndex: number;
}

/** What kind of recoverable issue did the checkpoint subsystem hit? Hosts
 *  typically translate these into user-visible log entries / toasts. */
export type CheckpointErrorReason =
  | "track-edit-failed"        // read/blob-write threw while backing up a path
  | "track-edit-skipped-directory"
  | "track-edit-skipped-link"
  | "track-edit-skipped-large" // file > maxFileBytes — silently skipped
  | "track-edit-skipped-outside-cwd" // writesPath resolved outside the project cwd
  | "snapshot-jsonl-failed"    // writeJsonlEntry threw during commit
  | "snapshot-jsonl-skipped-path" // persisted snapshot path was unsafe for cwd
  ;

export interface CheckpointError {
  reason: CheckpointErrorReason;
  path?: string;
  /** File size that triggered the skip (skipped-large). */
  size?: number;
  /** Size limit (skipped-large). */
  limit?: number;
  /** Raw error message from the failing call. */
  message?: string;
}

export interface CheckpointManagerOpts {
  sessionId: string;
  cwd: string;
  config?: Partial<CheckpointConfig>;
  writeJsonlEntry?: (entry: SnapshotJsonlEntry) => void;
  /** Receives recoverable failures + skip notices. Host should surface
   *  these into the UI (addLog / toast). When omitted, errors are swallowed
   *  silently — appropriate for tests but not production. */
  onError?: (err: CheckpointError) => void;
}

export class CheckpointManager {
  private config: CheckpointConfig;
  private blobs: BlobStore;
  private snaps: SnapshotStore;
  private archive?: CheckpointArchive;
  private activeId?: string;
  private implicitActive = false;
  private editQueue: Promise<void> = Promise.resolve();
  private readonly reported = new Set<string>();
  /** Mutable on purpose — `setSessionId` updates it on /new and /sessions
   *  resume so the host's `getCurrentSessionId()` (which rotates on writer
   *  swap) stays aligned with what this manager labels its snapshots with. */
  private sessionId: string;
  private readonly cwd: string;
  private readonly writeJsonlEntry?: (entry: SnapshotJsonlEntry) => void;
  private readonly onError?: (err: CheckpointError) => void;
  private blobDir: string;
  private readonly fallbackBlobDirs = new Set<string>();

  constructor(opts: CheckpointManagerOpts) {
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...opts.config };
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.writeJsonlEntry = opts.writeJsonlEntry;
    this.onError = opts.onError;
    const legacyBlobDir = join(homedir(), ".zapcode", "snapshots", "blobs");
    this.blobDir = this.resolveBlobDir(this.config);
    if (!this.config.blobDir) this.fallbackBlobDirs.add(legacyBlobDir);
    this.blobs = this.createBlobStore(this.blobDir);
    this.snaps = new SnapshotStore({ maxSnapshots: this.config.maxSnapshots });
    this.configureStorage();
    this.restoreArchive();
  }

  isEnabled(): boolean { return this.config.enabled && this.config.maxSnapshots > 0; }

  private configureStorage(): void {
    const base = this.resolveBlobDir(this.config);
    this.fallbackBlobDirs.add(this.blobDir);
    this.fallbackBlobDirs.add(base);
    this.archive = this.config.managedStorage ? new CheckpointArchive(base, this.sessionId) : undefined;
    this.blobDir = this.archive?.blobs ?? base;
    this.blobs = this.createBlobStore(this.blobDir);
  }

  private blobBytes(snapshots: Snapshot[]): number {
    const unique = new Map<string, number>();
    for (const snapshot of snapshots) for (const backup of Object.values(snapshot.trackedFiles)) {
      if (backup.kind === "present") unique.set(backup.blob.sha256, backup.blob.size);
    }
    return [...unique.values()].reduce((sum, size) => sum + size, 0);
  }

  private isExpired(snapshot: Snapshot): boolean {
    return !!this.archive && Date.parse(snapshot.timestamp) < Date.now() - (this.config.retentionDays ?? 30) * 86400000;
  }

  private persist(): void {
    // Expiry and byte retention apply to this session's private archive only.
    if (this.archive) for (const point of this.listSnapshots()) {
      if (point.id !== this.activeId && this.isExpired(point)) this.snaps.evictOldest(this.sessionId);
      else break;
    }
    const budget = this.config.maxStorageBytes ?? 512 * 1024 * 1024;
    while (this.archive && this.listSnapshots().length > 1 && this.blobBytes(this.listSnapshots()) > budget) this.snaps.evictOldest(this.sessionId);
    this.archive?.save(this.listSnapshots(), this.activeId);
  }

  private collect(): void {
    try { this.archive?.collect(this.listSnapshots()); }
    catch (error) { this.onError?.({ reason: "snapshot-jsonl-failed", message: `checkpoint retention: ${String(error)}` }); }
  }

  private publish(snapshot: Snapshot): void {
    this.persist();
    this.writeJsonlEntry?.({ type: "snapshot", snapshot: structuredClone(snapshot) });
  }

  /** Logical recovery point, created before input/model/tool execution even
   * when file tracking is disabled or the turn never edits a file. */
  async beginTurn(turnStartIndex: number, position?: SnapshotLogPosition, prompt?: string): Promise<Snapshot | null> {
    if (this.config.maxSnapshots <= 0) return null;
    if (this.activeId) await this.makeSnapshot(turnStartIndex);
    const snapshot: Snapshot = { id: randomUUID(), kind: "turn", sessionId: this.sessionId,
      blobSessionId: this.archive ? this.sessionId : undefined, prompt, turnStartIndex,
      timestamp: new Date().toISOString(), parentId: this.listSnapshots().at(-1)?.id ?? null,
      logIndex: position?.journalLogIndex, journalLogIndex: position?.journalLogIndex, uiLogIndex: position?.uiLogIndex,
      trackedFiles: {}, fileTrackingEnabled: this.isEnabled() };
    this.snaps.beginSnapshot(snapshot); this.activeId = snapshot.id; this.implicitActive = false; this.reported.clear();
    this.publish(snapshot); this.collect(); return snapshot;
  }

  /** Load only this session's authoritative private index. Legacy JSONL import
   * remains explicit so reopening an unrelated session cannot resurrect it. */
  restoreArchive(): void {
    const value = this.archive?.load();
    if (!value) return;
    for (const raw of value.snapshots) {
      const safe = this.sanitizeSnapshot(raw);
      if (safe && safe.sessionId === this.sessionId && !this.isExpired(safe)) this.snaps.hydrateOne(safe);
    }
    // An interrupted turn is a usable recovery point, not a resumed writer.
    this.activeId = undefined;
  }

  private trackNotice(error: CheckpointError): void {
    if (this.activeId && error.path) {
      const path = resolveCheckpointPath(this.cwd, error.path)?.rel ?? error.path;
      const current = this.snaps.getById(this.activeId);
      if (current) this.snaps.updateSnapshot(current.id, { skippedFiles: [...(current.skippedFiles ?? [])
        .filter(value => value.path !== path), { path, reason: error.message ?? error.reason }].slice(-1000) });
    }
    const key = `${error.reason}:${error.path ?? ""}`;
    if (!this.reported.has(key)) { this.reported.add(key); this.onError?.(error); }
  }

  /** Keep model-visible coverage attached to the same live tracking callback. */
  createEditTracker(): CheckpointEditTracker {
    return Object.freeze(Object.assign(
      async (paths: string[], options?: { required: boolean }) => {
        if (!this.isEnabled()) throw new Error("checkpointing is disabled");
        return this.trackEditsWithCoverage(paths, options);
      },
      { describeCoverage: () => Object.freeze({
        scope: "workspace" as const, root: resolve(this.cwd), enabled: this.isEnabled(),
        maxFileBytes: this.config.maxFileBytes,
      }) },
    ));
  }

  updateConfig(config: Partial<CheckpointConfig>): void {
    const next = { ...this.config, ...config };
    const oldBase = this.resolveBlobDir(this.config);
    const oldManaged = this.config.managedStorage;
    this.config = next;
    this.snaps.setMaxSnapshots(next.maxSnapshots);
    if (this.activeId && !this.snaps.getById(this.activeId)) {
      this.activeId = undefined; this.snaps.clearPending(this.sessionId);
    }
    if (oldBase !== this.resolveBlobDir(next) || oldManaged !== next.managedStorage) {
      this.configureStorage();
      if (this.archive) for (const snapshot of this.listSnapshots()) for (const backup of Object.values(snapshot.trackedFiles)) {
        if (backup.kind === "present") this.blobs.importLocal(backup.blob.sha256);
      }
    }
    this.persist(); this.collect();
  }

  /** Returns the session id this manager currently labels new snapshots with. */
  getSessionId(): string { return this.sessionId; }

  /**
   * Rebind to a new session id. Called by the host after `startNewSession`
   * (/new) or after a `/sessions` resume creates a fresh writer UUID.
   *
   * Does NOT touch the in-memory snapshot store — previously-indexed entries
   * under the old id stay (harmlessly) reachable only through that id; new
   * snapshots commit under `newId`. To carry historical entries into the new
   * session, follow this call with `hydrateFromJsonl(entries, { remapToCurrentSession: true })`.
   */
  setSessionId(newId: string): void {
    this.sessionId = newId;
    this.activeId = undefined; this.reported.clear();
    if (this.config.managedStorage) {
      this.snaps = new SnapshotStore({ maxSnapshots: this.config.maxSnapshots });
      this.configureStorage(); this.restoreArchive();
    }
  }

  async trackEdits(paths: string[], options: { required?: boolean } = {}): Promise<void> {
    const operation = this.editQueue.then(() => this.trackEditsInternal(paths, options));
    this.editQueue = operation.catch(() => {});
    return operation;
  }

  private async trackEditsInternal(paths: string[], options: { required?: boolean }): Promise<void> {
    if (!this.isEnabled()) {
      if (options.required) throw new Error("checkpointing is disabled");
      return;
    }
    if (this.archive && !this.activeId) { await this.beginTurn(0); this.implicitActive = true; }
    for (const p of paths) {
      await trackEdit({
        // Pass the caller's lexical path through so trackEdit can preserve the
        // cwd-relative snapshot key while resolving the canonical target once.
        // Passing resolved.abs here breaks on platforms where realpath adds a
        // prefix (macOS /var -> /private/var) and causes a false outside-cwd.
        absPath: p,
        sessionId: this.sessionId,
        cwd: this.cwd,
        blobs: this.blobs,
        snaps: this.snaps,
        maxFileBytes: this.archive ? Math.min(this.config.maxFileBytes,
          Math.max(0, (this.config.maxStorageBytes ?? 512 * 1024 * 1024) - this.blobBytes([{ trackedFiles: this.snaps.getPending(this.sessionId) } as Snapshot]))) : this.config.maxFileBytes,
        onError: error => this.trackNotice(error),
      });
    }
    if (this.activeId) {
      const snapshot = this.snaps.updateSnapshot(this.activeId, { trackedFiles: this.snaps.getPending(this.sessionId) });
      this.publish(snapshot); this.collect();
    }
    if (options.required) {
      const pending = this.snaps.getPending(this.sessionId);
      for (const path of paths) {
        const resolved = resolveCheckpointPath(this.cwd, path);
        const reason = checkpointSkipReason(this.cwd, path);
        if (!resolved || reason) {
          throw new Error(`Required checkpoint coverage is missing for ${path}: ${reason === "outside_workspace" ? `outside workspace ${this.cwd}` : reason ?? "unsupported path"}`);
        }
        if (!(resolved.rel in pending)) {
          throw new Error(`Required checkpoint coverage is missing for ${path}`);
        }
      }
    }
  }

  /** Best-effort tracking may skip a path without throwing. Report actual
   * pending backups so callers do not mistake hook completion for coverage. */
  async trackEditsWithCoverage(paths: string[], options: { required?: boolean } = {}): Promise<CheckpointCoverage> {
    await this.trackEdits(paths, options);
    const pending = this.snaps.getPending(this.sessionId);
    const uncoveredPaths = paths.filter((path) => {
      if (!this.config.enabled) return true;
      const resolved = resolveCheckpointPath(this.cwd, path);
      return !resolved || !!checkpointSkipReason(this.cwd, path) || !Object.hasOwn(pending, resolved.rel);
    });
    return { covered: this.config.enabled && uncoveredPaths.length === 0, uncoveredPaths };
  }

  async makeSnapshot(
    turnStartIndex: number,
    position?: number | SnapshotLogPosition,
  ): Promise<Snapshot | null> {
    await this.editQueue;
    if (this.activeId) {
      let snapshot = this.snaps.getById(this.activeId);
      if (snapshot && this.implicitActive) {
        const journal = typeof position === "number" ? position : position?.journalLogIndex;
        snapshot = this.snaps.updateSnapshot(snapshot.id, { turnStartIndex, logIndex: journal, journalLogIndex: journal,
          uiLogIndex: typeof position === "number" ? undefined : position?.uiLogIndex });
        this.publish(snapshot);
      }
      this.implicitActive = false;
      this.activeId = undefined; this.snaps.clearPending(this.sessionId); this.reported.clear();
      this.persist(); this.collect(); return snapshot;
    }
    if (!this.isEnabled()) return null;
    const journalLogIndex = typeof position === "number"
      ? position
      : position?.journalLogIndex;
    return makeSnapshot({
      sessionId: this.sessionId,
      turnStartIndex,
      // Keep writing the legacy field for downgrade/read compatibility. New
      // code never uses it as an in-memory transcript index.
      logIndex: journalLogIndex,
      journalLogIndex,
      uiLogIndex: typeof position === "number" ? undefined : position?.uiLogIndex,
      snaps: this.snaps,
      writeJsonlEntry: this.writeJsonlEntry,
      onError: this.onError,
    });
  }

  async rewindDryRun(snapshotId: string): Promise<DiffStats> {
    return rewindDryRun({
      snapshotId, cwd: this.cwd, blobs: this.blobs, snaps: this.snaps,
    });
  }

  async rewind(
    snapshotId: string,
    options: { mode?: RewindMode; finalize?: () => void | Promise<void> } = {},
  ): Promise<RewindResult> {
    await this.editQueue;
    const result = await rewind({
      mode: options.mode,
      snapshotId,
      cwd: this.cwd,
      blobs: this.blobs,
      snaps: this.snaps,
      finalize: options.finalize,
    });
    if (result.failed.length === 0) { this.activeId = undefined; this.persist(); this.collect(); }
    return result;
  }

  /**
   * Rebuild snapshot index from a stream of JSONL entries (snapshots +
   * rewind-markers) returned by `readCheckpointJournal(sessionId)`.
   *
   * `remapToCurrentSession`: when true, every loaded snapshot's `sessionId`
   * field is rewritten to `this.sessionId` before storing — used after a
   * `/sessions` resume so historical snapshots from the loaded session
   * appear in `listSnapshots()` for the new fork id. Rewind-markers' session
   * scoping is similarly remapped. When false (default), entries are
   * indexed exactly under their stored sessionId — matches in-process
   * resumes within the same session and is what existing tests depend on.
   */
  hydrateFromJsonl(
    entries: CheckpointJournalEntry[],
    opts: { remapToCurrentSession?: boolean } = {},
  ): void {
    const remap = opts.remapToCurrentSession === true;
    const archives = new Map<string, ReturnType<CheckpointArchive["load"]>>();
    for (const e of entries) {
      if (e.type === "snapshot") {
        let persisted = e.snapshot;
        if (this.archive) {
          const owner = e.snapshot.blobSessionId ?? e.snapshot.sessionId;
          if (typeof owner === "string") {
            const source = new CheckpointArchive(this.resolveBlobDir(this.config), owner);
            this.fallbackBlobDirs.add(source.blobs);
            if (!archives.has(owner)) archives.set(owner, source.load());
            const retained = archives.get(owner);
            if (retained) {
              const point = retained.snapshots.find(point => point.id === e.snapshot.id);
              if (!point) continue;
              persisted = point;
            }
          }
        }
        const snap = remap
          ? { ...persisted, sessionId: this.sessionId }
          : persisted;
        const safeSnap = this.sanitizeSnapshot(snap);
        if (safeSnap && !this.isExpired(safeSnap)) this.snaps.hydrateOne(safeSnap);
      } else {
        // rewind-marker: prune any previously-hydrated snapshots whose
        // turnStartIndex fell in the rewound-away range.
        const targetSessionId = remap ? this.sessionId : e.sessionId;
        if (typeof e.snapshotId === "string") {
          this.snaps.truncateSnapshotsFromId(targetSessionId, e.snapshotId);
        } else {
          this.snaps.truncateSnapshotsFrom(targetSessionId, e.targetTurnStartIndex);
        }
      }
    }
    if (this.archive) {
      this.blobs = this.createBlobStore(this.blobDir);
      for (const snapshot of this.listSnapshots()) {
        for (const backup of Object.values(snapshot.trackedFiles)) if (backup.kind === "present") this.blobs.importLocal(backup.blob.sha256);
        this.snaps.updateSnapshot(snapshot.id, { blobSessionId: this.sessionId });
      }
      this.persist(); this.collect();
    }
  }

  listSnapshots(): Snapshot[] {
    return this.snaps.listSnapshots(this.sessionId);
  }

  getSnapshotById(id: string): Snapshot | null {
    return this.snaps.getById(id);
  }

  private sanitizeSnapshot(snapshot: Snapshot): Snapshot | null {
    if (
      !snapshot
      || typeof snapshot !== "object"
      || Array.isArray(snapshot)
      || typeof snapshot.id !== "string"
      || typeof snapshot.sessionId !== "string"
      || !Number.isSafeInteger(snapshot.turnStartIndex)
      || snapshot.turnStartIndex < 0
      || typeof snapshot.timestamp !== "string"
      || (snapshot.parentId !== null && typeof snapshot.parentId !== "string")
      || !snapshot.trackedFiles
      || typeof snapshot.trackedFiles !== "object"
      || Array.isArray(snapshot.trackedFiles)
    ) {
      this.onError?.({
        reason: "snapshot-jsonl-skipped-path",
        message: "persisted checkpoint snapshot metadata is invalid",
      });
      return null;
    }
    const trackedFiles: Record<string, FileBackup> = {};
    for (const [path, backup] of Object.entries(snapshot.trackedFiles)) {
      const resolved = resolveCheckpointPath(this.cwd, path);
      if (!resolved || resolved.rel !== path) {
        this.onError?.({
          reason: "snapshot-jsonl-skipped-path",
          path,
          message: "persisted checkpoint path is outside the project cwd",
        });
        continue;
      }
      if (!this.isValidBackup(backup)) {
        this.onError?.({
          reason: "snapshot-jsonl-skipped-path",
          path,
          message: "persisted checkpoint backup metadata is invalid",
        });
        continue;
      }
      trackedFiles[path] = backup;
    }
    if (Object.keys(trackedFiles).length === 0 && snapshot.kind !== "turn") return null;
    return { ...snapshot, trackedFiles,
      prompt: typeof snapshot.prompt === "string" ? snapshot.prompt.slice(0, 1000000) : undefined,
      skippedFiles: Array.isArray(snapshot.skippedFiles) ? snapshot.skippedFiles.filter(value => value && typeof value.path === "string" && typeof value.reason === "string").slice(-1000) : undefined,
    };
  }

  private isValidBackup(backup: unknown): backup is FileBackup {
    if (!backup || typeof backup !== "object") return false;
    const candidate = backup as Record<string, any>;
    if (candidate.kind === "absent") return true;
    return candidate.kind === "present"
      && typeof candidate.blob?.sha256 === "string"
      && /^[a-f0-9]{64}$/.test(candidate.blob.sha256)
      && Number.isSafeInteger(candidate.blob.size)
      && candidate.blob.size >= 0
      && Number.isSafeInteger(candidate.mode)
      && candidate.mode >= 0
      && candidate.mode <= 0o777;
  }

  /** Lightweight diagnostics for the /rewind empty-state screen — helps the user
   *  (and us) tell whether trackEdit/makeSnapshot ever fired. */
  getDiagnostics(): {
    enabled: boolean;
    sessionId: string;
    maxSnapshots: number;
    maxFileBytes: number;
    blobDir: string;
    snapshotCount: number;
    pendingCount: number;
  } {
    return {
      enabled: this.config.enabled,
      sessionId: this.sessionId,
      maxSnapshots: this.config.maxSnapshots,
      maxFileBytes: this.config.maxFileBytes,
      blobDir: this.blobDir,
      snapshotCount: this.snaps.listSnapshots(this.sessionId).length,
      pendingCount: Object.keys(this.snaps.getPending(this.sessionId)).length,
    };
  }

  private resolveBlobDir(config: CheckpointConfig): string {
    return config.blobDir
      ?? join(getAppDataDir(), "projects", resolveProjectDataSegment(this.cwd), "snapshots", "blobs");
  }

  private createBlobStore(root: string): BlobStore {
    return new BlobStore(root, {
      fallbackRoots: Array.from(this.fallbackBlobDirs),
    });
  }
}

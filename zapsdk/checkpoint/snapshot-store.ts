// zapsdk/checkpoint/snapshot-store.ts
import { randomUUID } from "node:crypto";
import type { FileBackup, Snapshot, SnapshotIndex } from "./types.js";

export interface SnapshotStoreOptions {
  maxSnapshots: number;
}

export class SnapshotStore {
  private indexBySession = new Map<string, SnapshotIndex>();
  private snapshotsById = new Map<string, Snapshot>();
  private pendingBackups = new Map<string, Map<string, FileBackup>>();
  private maxSnapshots: number;

  constructor(opts: SnapshotStoreOptions) {
    this.maxSnapshots = opts.maxSnapshots;
  }

  setMaxSnapshots(maxSnapshots: number): void {
    this.maxSnapshots = Math.max(0, Math.floor(maxSnapshots));
    for (const index of this.indexBySession.values()) {
      this.pruneIndex(index);
    }
  }

  addPending(sessionId: string, path: string, backup: FileBackup): void {
    let bucket = this.pendingBackups.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.pendingBackups.set(sessionId, bucket);
    }
    if (bucket.has(path)) return; // idempotent — first write wins
    bucket.set(path, backup);
  }

  getPending(sessionId: string): Record<string, FileBackup> {
    const bucket = this.pendingBackups.get(sessionId);
    if (!bucket) return {};
    const out: Record<string, FileBackup> = {};
    for (const [k, v] of bucket) out[k] = v;
    return out;
  }

  clearPending(sessionId: string): void {
    this.pendingBackups.delete(sessionId);
  }

  private getOrCreateIndex(sessionId: string): SnapshotIndex {
    let idx = this.indexBySession.get(sessionId);
    if (!idx) {
      idx = { sessionId, snapshots: [], snapshotSequence: 0 };
      this.indexBySession.set(sessionId, idx);
    }
    return idx;
  }

  commitSnapshot(opts: {
    sessionId: string;
    turnStartIndex: number;
    logIndex?: number;
    journalLogIndex?: number;
    uiLogIndex?: number;
    timestamp: string;
  }): Snapshot | null {
    const pending = this.getPending(opts.sessionId);
    if (Object.keys(pending).length === 0) return null;

    const index = this.getOrCreateIndex(opts.sessionId);
    const parentId = index.snapshots.length > 0
      ? index.snapshots[index.snapshots.length - 1]
      : null;

    const snapshot: Snapshot = {
      id: randomUUID(),
      sessionId: opts.sessionId,
      turnStartIndex: opts.turnStartIndex,
      logIndex: opts.logIndex,
      journalLogIndex: opts.journalLogIndex,
      uiLogIndex: opts.uiLogIndex,
      timestamp: opts.timestamp,
      trackedFiles: pending,
      parentId,
    };

    this.snapshotsById.set(snapshot.id, snapshot);
    if (!index.snapshots.includes(snapshot.id)) {
      index.snapshots.push(snapshot.id);
      index.snapshotSequence += 1;
    }

    this.pruneIndex(index);

    this.clearPending(opts.sessionId);
    return snapshot;
  }

  evictOldest(sessionId: string): void {
    const index = this.indexBySession.get(sessionId);
    const id = index?.snapshots.shift();
    if (id) this.snapshotsById.delete(id);
  }

  listSnapshots(sessionId: string): Snapshot[] {
    const index = this.indexBySession.get(sessionId);
    if (!index) return [];
    return index.snapshots
      .map((id) => this.snapshotsById.get(id))
      .filter((s): s is Snapshot => s !== undefined);
  }

  getById(id: string): Snapshot | null {
    return this.snapshotsById.get(id) ?? null;
  }

  beginSnapshot(snapshot: Snapshot): void { this.hydrateOne(snapshot); }

  updateSnapshot(id: string, patch: Partial<Snapshot>): Snapshot {
    const snapshot = this.snapshotsById.get(id);
    if (!snapshot) throw new Error("checkpoint not found");
    const next = { ...snapshot, ...patch, id: snapshot.id, sessionId: snapshot.sessionId };
    this.snapshotsById.set(id, next);
    return next;
  }

  /** Rebuild from persisted snapshot array (session resume). */
  hydrate(snapshots: Snapshot[]): void {
    for (const s of snapshots) this.hydrateOne(s);
  }

  /** Single-entry variant used by marker-aware hydrate in CheckpointManager. */
  hydrateOne(snapshot: Snapshot): void {
    this.snapshotsById.set(snapshot.id, snapshot);
    const index = this.getOrCreateIndex(snapshot.sessionId);
    if (!index.snapshots.includes(snapshot.id)) {
      index.snapshots.push(snapshot.id);
      index.snapshotSequence += 1;
    }
    this.pruneIndex(index);
  }

  private pruneIndex(index: SnapshotIndex): void {
    while (index.snapshots.length > this.maxSnapshots) {
      const evicted = index.snapshots.shift();
      if (evicted) this.snapshotsById.delete(evicted);
    }
  }

  /** Drop all snapshots in the session whose turnStartIndex >= fromTurnStartIndex
   *  (inclusive). Used by rewind: after jumping back, the target snapshot and
   *  all later ones become "the abandoned forward branch" and disappear from
   *  the checkpoint list. Mirrors CCB's setMessages(prev.slice(0, idx)) +
   *  setConversationId(randomUUID()) fork semantics.
   *
   *  Blobs are NOT deleted — they are content-addressed and may still be
   *  referenced by surviving snapshots or by ancestors of future snapshots.
   *  GC is a separate concern. */
  truncateSnapshotsFrom(sessionId: string, fromTurnStartIndex: number): Snapshot[] {
    const index = this.indexBySession.get(sessionId);
    if (!index) return [];
    const dropped: Snapshot[] = [];
    const kept: string[] = [];
    for (const id of index.snapshots) {
      const snap = this.snapshotsById.get(id);
      if (!snap) continue;
      if (snap.turnStartIndex >= fromTurnStartIndex) {
        this.snapshotsById.delete(id);
        dropped.push(snap);
      } else {
        kept.push(id);
      }
    }
    index.snapshots = kept;
    return dropped;
  }

  /** Drop the target snapshot and every later snapshot by their stable index
   *  position. Unlike turnStartIndex, snapshot ids/order survive conversation
   *  compaction, whose summary rewrite changes message cardinality. */
  truncateSnapshotsFromId(sessionId: string, targetId: string): Snapshot[] {
    const index = this.indexBySession.get(sessionId);
    if (!index) return [];
    const targetIndex = index.snapshots.indexOf(targetId);
    if (targetIndex < 0) return [];
    const droppedIds = index.snapshots.slice(targetIndex);
    index.snapshots = index.snapshots.slice(0, targetIndex);
    const dropped: Snapshot[] = [];
    for (const id of droppedIds) {
      const snapshot = this.snapshotsById.get(id);
      if (snapshot) dropped.push(snapshot);
      this.snapshotsById.delete(id);
    }
    return dropped;
  }

  /** Collect the abandoned branch from target through the newest snapshot.
   *  A snapshot stores each file's content immediately BEFORE that turn edited
   *  it. Therefore the first backup for a path while walking forward is the
   *  exact state that path had at the selected pre-turn boundary. Older parent
   *  backups belong to history that must survive; later backups are superseded
   *  by the first post-boundary edit. */
  resolveBackupsFrom(targetId: string): Map<string, FileBackup> {
    const result = new Map<string, FileBackup>();
    const target = this.getById(targetId);
    if (!target) return result;
    const index = this.indexBySession.get(target.sessionId);
    if (!index) return result;
    const targetIndex = index.snapshots.indexOf(targetId);
    if (targetIndex < 0) return result;
    for (const id of index.snapshots.slice(targetIndex)) {
      const snapshot = this.snapshotsById.get(id);
      if (!snapshot) continue;
      for (const [path, backup] of Object.entries(snapshot.trackedFiles)) {
        if (!result.has(path)) result.set(path, backup);
      }
    }
    return result;
  }
}

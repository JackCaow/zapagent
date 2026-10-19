// zapsdk/checkpoint/make-snapshot.ts
import type { Snapshot } from "./types.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { CheckpointError } from "./index.js";

export interface MakeSnapshotOpts {
  sessionId: string;
  turnStartIndex: number;
  /** Legacy journal position retained for callers/session files predating the
   *  split between persisted rows and rendered transcript rows. */
  logIndex?: number;
  journalLogIndex?: number;
  uiLogIndex?: number;
  snaps: SnapshotStore;
  /** Persists snapshot metadata (not blob content) to session JSONL. */
  writeJsonlEntry?: (entry: { type: "snapshot"; snapshot: Snapshot }) => void;
  /** Surface JSONL write failures so the host can warn the user. The
   *  in-memory snapshot is unaffected — only the disk persistence missed. */
  onError?: (err: CheckpointError) => void;
}

export function makeSnapshot(opts: MakeSnapshotOpts): Snapshot | null {
  const snapshot = opts.snaps.commitSnapshot({
    sessionId: opts.sessionId,
    turnStartIndex: opts.turnStartIndex,
    logIndex: opts.logIndex,
    journalLogIndex: opts.journalLogIndex,
    uiLogIndex: opts.uiLogIndex,
    timestamp: new Date().toISOString(),
  });
  if (!snapshot) return null;

  if (opts.writeJsonlEntry) {
    try {
      opts.writeJsonlEntry({ type: "snapshot", snapshot });
    } catch (err: any) {
      opts.onError?.({
        reason: "snapshot-jsonl-failed",
        message: err?.message ?? String(err),
      });
    }
  }

  return snapshot;
}

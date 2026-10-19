// zapsdk/checkpoint/snapshot-store.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { SnapshotStore } from "../../checkpoint/snapshot-store.js";
import type { FileBackup, Snapshot } from "../../checkpoint/types.js";

function makeBackup(sha: string, size = 10): FileBackup {
  return { kind: "present", blob: { sha256: sha, size }, mode: 0o644 };
}

describe("SnapshotStore", () => {
  let store: SnapshotStore;
  const sessionId = "sess-1";
  beforeEach(() => { store = new SnapshotStore({ maxSnapshots: 3 }); });

  it("addPending stores a backup and getPending returns it", () => {
    store.addPending(sessionId, "src/a.ts", makeBackup("aa"));
    const pending = store.getPending(sessionId);
    expect(pending).toEqual({ "src/a.ts": makeBackup("aa") });
  });

  it("addPending second time for same path does not overwrite", () => {
    store.addPending(sessionId, "src/a.ts", makeBackup("aa"));
    store.addPending(sessionId, "src/a.ts", makeBackup("bb"));
    expect(store.getPending(sessionId)["src/a.ts"].kind === "present"
      && (store.getPending(sessionId)["src/a.ts"] as any).blob.sha256).toBe("aa");
  });

  it("commitSnapshot builds Snapshot from pending and clears pending", () => {
    store.addPending(sessionId, "src/a.ts", makeBackup("aa"));
    const snap = store.commitSnapshot({
      sessionId,
      turnStartIndex: 2,
      timestamp: "2026-04-18T00:00:00Z",
    });
    expect(snap).not.toBeNull();
    expect(snap!.trackedFiles["src/a.ts"]).toEqual(makeBackup("aa"));
    expect(store.getPending(sessionId)).toEqual({});
    expect(store.listSnapshots(sessionId)).toHaveLength(1);
  });

  it("commitSnapshot with empty pending returns null (no snapshot produced)", () => {
    const snap = store.commitSnapshot({
      sessionId, turnStartIndex: 0, timestamp: "2026-04-18T00:00:00Z",
    });
    expect(snap).toBeNull();
  });

  it("FIFO evicts oldest when maxSnapshots exceeded", () => {
    for (let i = 0; i < 4; i++) {
      store.addPending(sessionId, `src/${i}.ts`, makeBackup(`h${i}`));
      store.commitSnapshot({ sessionId, turnStartIndex: i, timestamp: `t${i}` });
    }
    const list = store.listSnapshots(sessionId);
    expect(list).toHaveLength(3);
    expect(list[0].turnStartIndex).toBe(1);  // first was evicted
    expect(list[2].turnStartIndex).toBe(3);
  });

  it("getById returns snapshot by id", () => {
    store.addPending(sessionId, "src/a.ts", makeBackup("aa"));
    const snap = store.commitSnapshot({ sessionId, turnStartIndex: 0, timestamp: "t" });
    expect(store.getById(snap!.id)).toEqual(snap!);
    expect(store.getById("nonexistent")).toBeNull();
  });

  it("parentId chains snapshots", () => {
    store.addPending(sessionId, "a", makeBackup("1"));
    const s1 = store.commitSnapshot({ sessionId, turnStartIndex: 0, timestamp: "t1" });
    store.addPending(sessionId, "b", makeBackup("2"));
    const s2 = store.commitSnapshot({ sessionId, turnStartIndex: 1, timestamp: "t2" });
    expect(s1!.parentId).toBeNull();
    expect(s2!.parentId).toBe(s1!.id);
  });

  it("clearPending drops pending without commit", () => {
    store.addPending(sessionId, "a", makeBackup("1"));
    store.clearPending(sessionId);
    expect(store.getPending(sessionId)).toEqual({});
  });

  it("hydrate rebuilds index from snapshot array (session resume)", () => {
    const s: Snapshot = {
      id: "snap-1", sessionId, turnStartIndex: 0, timestamp: "t",
      trackedFiles: { "a.ts": makeBackup("aa") }, parentId: null,
    };
    store.hydrate([s]);
    expect(store.listSnapshots(sessionId)).toHaveLength(1);
    expect(store.getById("snap-1")).toEqual(s);
  });

  describe("truncateSnapshotsFrom", () => {
    function buildThree(): [Snapshot, Snapshot, Snapshot] {
      store.addPending(sessionId, "a", makeBackup("1"));
      const s1 = store.commitSnapshot({ sessionId, turnStartIndex: 2, timestamp: "t1" })!;
      store.addPending(sessionId, "b", makeBackup("2"));
      const s2 = store.commitSnapshot({ sessionId, turnStartIndex: 5, timestamp: "t2" })!;
      store.addPending(sessionId, "c", makeBackup("3"));
      const s3 = store.commitSnapshot({ sessionId, turnStartIndex: 9, timestamp: "t3" })!;
      return [s1, s2, s3];
    }

    it("drops target and all later snapshots (inclusive of fromTurnStartIndex)", () => {
      const [s1, s2, s3] = buildThree();
      const dropped = store.truncateSnapshotsFrom(sessionId, s2.turnStartIndex);
      expect(dropped.map(s => s.id).sort()).toEqual([s2.id, s3.id].sort());
      expect(store.listSnapshots(sessionId).map(s => s.id)).toEqual([s1.id]);
      expect(store.getById(s2.id)).toBeNull();
      expect(store.getById(s3.id)).toBeNull();
    });

    it("next commit after truncate parents to the surviving tail", () => {
      const [s1] = buildThree();
      store.truncateSnapshotsFrom(sessionId, 5);
      store.addPending(sessionId, "d", makeBackup("4"));
      const s4 = store.commitSnapshot({ sessionId, turnStartIndex: 5, timestamp: "t4" })!;
      expect(s4.parentId).toBe(s1.id);
    });

    it("returns [] and is a no-op for unknown session", () => {
      const dropped = store.truncateSnapshotsFrom("no-such-session", 0);
      expect(dropped).toEqual([]);
    });

    it("fromTurnStartIndex beyond all snapshots drops nothing", () => {
      const [, , s3] = buildThree();
      const dropped = store.truncateSnapshotsFrom(sessionId, s3.turnStartIndex + 100);
      expect(dropped).toEqual([]);
      expect(store.listSnapshots(sessionId)).toHaveLength(3);
    });

    it("fromTurnStartIndex at 0 drops everything", () => {
      buildThree();
      const dropped = store.truncateSnapshotsFrom(sessionId, 0);
      expect(dropped).toHaveLength(3);
      expect(store.listSnapshots(sessionId)).toEqual([]);
    });
  });

  it("truncateSnapshotsFromId follows snapshot order when message indexes are non-monotonic", () => {
    store.addPending(sessionId, "a", makeBackup("1"));
    const beforeCompact = store.commitSnapshot({ sessionId, turnStartIndex: 50, timestamp: "t1" })!;
    store.addPending(sessionId, "b", makeBackup("2"));
    const afterCompact = store.commitSnapshot({ sessionId, turnStartIndex: 3, timestamp: "t2" })!;
    store.addPending(sessionId, "c", makeBackup("3"));
    const newest = store.commitSnapshot({ sessionId, turnStartIndex: 5, timestamp: "t3" })!;

    const dropped = store.truncateSnapshotsFromId(sessionId, afterCompact.id);
    expect(dropped.map(snapshot => snapshot.id)).toEqual([afterCompact.id, newest.id]);
    expect(store.listSnapshots(sessionId).map(snapshot => snapshot.id)).toEqual([beforeCompact.id]);
  });
});

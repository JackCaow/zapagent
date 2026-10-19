// zapsdk/checkpoint/make-snapshot.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { SnapshotStore } from "../../checkpoint/snapshot-store.js";
import { makeSnapshot } from "../../checkpoint/make-snapshot.js";
import type { FileBackup } from "../../checkpoint/types.js";

function present(sha: string): FileBackup {
  return { kind: "present", blob: { sha256: sha, size: 1 }, mode: 0o644 };
}

describe("makeSnapshot", () => {
  let snaps: SnapshotStore;
  const sessionId = "sess-1";
  beforeEach(() => { snaps = new SnapshotStore({ maxSnapshots: 10 }); });

  it("returns null when no pending backups", () => {
    const result = makeSnapshot({ sessionId, turnStartIndex: 0, snaps });
    expect(result).toBeNull();
  });

  it("creates snapshot, clears pending, triggers writeJsonlEntry callback", () => {
    snaps.addPending(sessionId, "a.ts", present("aa"));
    const writes: any[] = [];
    const result = makeSnapshot({
      sessionId, turnStartIndex: 3, snaps,
      writeJsonlEntry: (entry) => { writes.push(entry); },
    });
    expect(result).not.toBeNull();
    expect(result!.turnStartIndex).toBe(3);
    expect(result!.trackedFiles["a.ts"]).toEqual(present("aa"));
    expect(snaps.getPending(sessionId)).toEqual({});
    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe("snapshot");
    expect(writes[0].snapshot.id).toBe(result!.id);
  });

  it("swallows writeJsonlEntry errors (in-memory snapshot still valid)", () => {
    snaps.addPending(sessionId, "a.ts", present("aa"));
    const result = makeSnapshot({
      sessionId, turnStartIndex: 0, snaps,
      writeJsonlEntry: () => { throw new Error("disk full"); },
    });
    expect(result).not.toBeNull();
    expect(snaps.getById(result!.id)).not.toBeNull();
  });
});

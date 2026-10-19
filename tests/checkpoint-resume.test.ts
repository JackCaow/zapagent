/**
 * App-layer regression test for the rewind+resume wiring (P0 bugs B1–B5).
 *
 * Simulates the App.tsx contract end-to-end without booting Ink:
 *   1. Session A runs, makes one tracked edit, turn ends → snapshot
 *      persists into A's JSONL stream (captured via writeJsonlEntry).
 *   2. Session B "resumes" A (CheckpointManager.setSessionId + hydrate
 *      with remapToCurrentSession). listSnapshots now surfaces A's
 *      snapshot under B's session id.
 *   3. New work in B commits a second snapshot.
 *   4. Rewind to the FIRST snapshot reverts the file to its pre-edit
 *      state AND truncates the snapshot index past it.
 *
 * Before the P0 fixes, step 2 would return [] (writeJsonlEntry wasn't
 * wired in App.tsx and there was no setSessionId + remap path).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CheckpointManager, type SnapshotJsonlEntry } from "../zapsdk/checkpoint/index.js"

function mkTmp(): string {
  const dir = join(tmpdir(), `zap-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("rewind across session resume (P0 wiring)", () => {
  let cwd: string
  let blobDir: string

  beforeEach(() => {
    cwd = mkTmp()
    blobDir = mkTmp()
  })
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }) } catch {}
    try { rmSync(blobDir, { recursive: true, force: true }) } catch {}
  })

  it("persists snapshots and restores them after a session fork", async () => {
    const filePath = join(cwd, "foo.ts")
    writeFileSync(filePath, "ORIGINAL")

    // ── Session A: mimics what App.tsx does at mount ───────────────────
    const sessionA = "sess-A"
    const journalA: SnapshotJsonlEntry[] = []
    const mgrA = new CheckpointManager({
      sessionId: sessionA, cwd,
      writeJsonlEntry: (entry) => { journalA.push(entry) },
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    })

    // Turn 1: edit_file-style mutation → trackEdit pre-call, then write,
    // then onRunEnd commits the snapshot.
    await mgrA.trackEdits([filePath])
    writeFileSync(filePath, "EDITED-A")
    const snapA = await mgrA.makeSnapshot(0, { journalLogIndex: 0, uiLogIndex: 3 })
    expect(snapA).not.toBeNull()
    expect(snapA).toMatchObject({ logIndex: 0, journalLogIndex: 0, uiLogIndex: 3 })
    expect(mgrA.listSnapshots()).toHaveLength(1)
    expect(journalA).toHaveLength(1)
    expect(journalA[0].snapshot.sessionId).toBe(sessionA)

    // ── /sessions resume: fork creates session B; App calls setSessionId
    //    + hydrateFromJsonl(remap) so A's history surfaces under B. ────
    const sessionB = "sess-B-fork"
    mgrA.setSessionId(sessionB)
    mgrA.hydrateFromJsonl(journalA, { remapToCurrentSession: true })
    const list = mgrA.listSnapshots()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(snapA!.id)           // identity preserved
    expect(list[0].sessionId).toBe(sessionB)     // re-labelled under B

    // Turn 2 in the resumed session: another mutation under B.
    const journalB: SnapshotJsonlEntry[] = []
    // After setSessionId, new writeJsonlEntry events still flow into the
    // same outer callback — simulate the App routing them into B's journal.
    const mgrB = new CheckpointManager({
      sessionId: sessionB, cwd,
      writeJsonlEntry: (entry) => { journalB.push(entry) },
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    })
    mgrB.hydrateFromJsonl(journalA, { remapToCurrentSession: true })
    expect(mgrB.listSnapshots()).toHaveLength(1)

    await mgrB.trackEdits([filePath])
    writeFileSync(filePath, "EDITED-B")
    const snapB = await mgrB.makeSnapshot(2, 2)
    expect(snapB).not.toBeNull()
    expect(mgrB.listSnapshots()).toHaveLength(2)
    expect(journalB).toHaveLength(1)
    expect(journalB[0].snapshot.sessionId).toBe(sessionB)

    // ── Rewind to snapA (the historical, remapped one) ─────────────────
    const result = await mgrB.rewind(snapA!.id)
    expect(result.failed).toHaveLength(0)
    expect(readFileSync(filePath, "utf-8")).toBe("ORIGINAL")
    // Forward branch (snapA + snapB) dropped from index after rewind.
    expect(mgrB.listSnapshots()).toHaveLength(0)
  })

  it("setSessionId without remap hides old session's in-memory snapshots", async () => {
    // Defensive: the App MUST call hydrate with remap after setSessionId
    // for resume to work. Verify that setSessionId alone (no remap) leaves
    // old entries unreachable — protects against a future caller forgetting
    // the second step.
    const filePath = join(cwd, "x.ts")
    writeFileSync(filePath, "v1")
    const mgr = new CheckpointManager({
      sessionId: "old", cwd,
      config: { enabled: true, maxFileBytes: 1_000_000, maxSnapshots: 10, blobDir },
    })
    await mgr.trackEdits([filePath])
    await mgr.makeSnapshot(0)
    expect(mgr.listSnapshots()).toHaveLength(1)
    mgr.setSessionId("new")
    expect(mgr.listSnapshots()).toHaveLength(0)
  })
})

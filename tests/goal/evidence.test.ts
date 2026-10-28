import { describe, expect, it } from "bun:test"
import { goalSnapshotEvidence } from "../../src/goal-host.js"
import type { AcceptanceSnapshot } from "../../zapsdk/runtime/inline-acceptance.js"

describe("Goal semantic evidence", () => {
  it("reads the Host-pinned bytes and binds subject versions before model review", async () => {
    let reads = 0
    const snapshot: AcceptanceSnapshot = { id: "snap", providerId: "fixture", proof: "immutable_snapshot",
      subjects: [{ subjectId: "report", exists: true, version: "sha256:123" }],
      async readFile(id) { expect(id).toBe("report"); reads++; return new TextEncoder().encode("actual content") },
    }
    expect(await goalSnapshotEvidence(snapshot, new AbortController().signal)).toEqual([{ id: "report", version: "sha256:123", present: true, content: "actual content" }])
    expect(reads).toBe(1)
  })
  it("fails closed for evidence that cannot be represented to the semantic verifier", async () => {
    const snapshot: AcceptanceSnapshot = { id: "snap", providerId: "fixture", proof: "immutable_snapshot",
      subjects: [{ subjectId: "binary", exists: true, version: "v" }], async readFile() { return Uint8Array.of(0, 1) } }
    await expect(goalSnapshotEvidence(snapshot, new AbortController().signal)).rejects.toThrow("binary")
  })
})

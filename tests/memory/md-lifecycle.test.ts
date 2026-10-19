import { describe, expect, it } from "bun:test"
import {
  activeMdMemoryRecords,
  normalizeMdMemoryLifecycle,
  resolveMdMemoryLifecycles,
} from "../../zapsdk/memory/md-lifecycle.js"
import type { MdMemoryRecord } from "../../zapsdk/memory/md-store.js"

describe("normalizeMdMemoryLifecycle", () => {
  it("canonicalizes dates and supersedes names while preserving omitted fields", () => {
    const existing = {
      version: 1 as const,
      confidence: "medium" as const,
      validFrom: "2026-07-01T00:00:00.000Z",
      supersedes: ["old_state"],
    }

    expect(normalizeMdMemoryLifecycle({
      expiresAt: "2026-08-01T08:00:00+08:00",
      supersedes: ["older_state", "old_state", "OLDER_STATE"],
    }, existing)).toEqual({
      version: 1,
      confidence: "medium",
      validFrom: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      supersedes: ["old_state", "older_state"],
    })
    expect(normalizeMdMemoryLifecycle({ confidence: "high", validFrom: null }, existing)).toEqual({
      version: 1,
      confidence: "high",
      supersedes: ["old_state"],
    })
    expect(normalizeMdMemoryLifecycle(null, existing)).toBeUndefined()
  })

  it("rejects invalid windows and unsafe supersedes names", () => {
    expect(() => normalizeMdMemoryLifecycle({
      validFrom: "2026-08-01T00:00:00Z",
      expiresAt: "2026-07-01T00:00:00Z",
    })).toThrow("later than validFrom")
    expect(() => normalizeMdMemoryLifecycle({ supersedes: ["../old"] }))
      .toThrow("invalid supersedes memory name")
  })
})

describe("resolveMdMemoryLifecycles", () => {
  const now = new Date("2026-07-22T12:00:00.000Z")

  it("keeps only active admitted facts and applies effective supersession", () => {
    const records = [
      record("old_state", "high"),
      record("new_state", "high", { supersedes: ["old_state"] }),
      record("observed_state", "medium"),
      record("candidate", "low"),
      record("future", "high", { validFrom: "2026-07-23T00:00:00.000Z" }),
      record("expired", "high", { expiresAt: "2026-07-22T00:00:00.000Z" }),
      record("future_old", "high"),
      record("future_replacement", "high", {
        validFrom: "2026-07-23T00:00:00.000Z",
        supersedes: ["future_old"],
      }),
    ]

    const resolved = resolveMdMemoryLifecycles(records, now)

    expect(resolved.get("old_state.md")).toMatchObject({
      state: "superseded",
      supersededBy: ["new_state.md"],
    })
    expect(resolved.get("new_state.md")).toMatchObject({ state: "active", confidence: "high" })
    expect(resolved.get("candidate.md")?.state).toBe("low_confidence")
    expect(resolved.get("future.md")?.state).toBe("not_yet_valid")
    expect(resolved.get("expired.md")?.state).toBe("expired")
    expect(resolved.get("future_old.md")?.state).toBe("active")
    expect(activeMdMemoryRecords(records, now).map((item) => item.filename).sort()).toEqual([
      "future_old.md",
      "new_state.md",
      "observed_state.md",
    ])
  })

  it("fails closed for malformed metadata and cycles but reports missing predecessors without hiding the successor", () => {
    const malformed = record("malformed", "high")
    malformed.frontmatter.lifecycleInvalid = true
    const a = record("a", "high", { supersedes: ["b"] })
    const b = record("b", "high", { supersedes: ["a"] })
    const dangling = record("dangling", "high", { supersedes: ["missing"] })
    const unsafeCandidate = record("unsafe_candidate", "low", { supersedes: ["dangling"] })

    const resolved = resolveMdMemoryLifecycles([malformed, a, b, dangling, unsafeCandidate], now)

    expect(resolved.get("malformed.md")).toMatchObject({
      state: "invalid",
      problems: [{ kind: "invalid_metadata" }],
    })
    expect(resolved.get("a.md")?.state).toBe("invalid")
    expect(resolved.get("b.md")?.state).toBe("invalid")
    expect(resolved.get("dangling.md")).toMatchObject({
      state: "active",
      problems: [{ kind: "missing_supersedes_target", target: "missing" }],
    })
    expect(resolved.get("unsafe_candidate.md")).toMatchObject({
      state: "invalid",
      problems: [{ kind: "non_high_confidence_supersession" }],
    })
  })
})

function record(
  name: string,
  confidence: "high" | "medium" | "low",
  lifecycle: { validFrom?: string; expiresAt?: string; supersedes?: string[] } = {},
): MdMemoryRecord {
  const hasLifecycle = confidence !== "high" || Object.keys(lifecycle).length > 0
  return {
    filename: `${name}.md`,
    frontmatter: {
      name,
      description: `${name} memory`,
      type: "project",
      ...(hasLifecycle ? {
        lifecycle: { version: 1, confidence, ...lifecycle },
      } : {}),
    },
    body: `${name} body\n`,
  }
}

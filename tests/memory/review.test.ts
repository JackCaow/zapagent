import { describe, expect, it } from "bun:test"
import {
  normalizeMemoryContent,
  reviewMemoryRecords,
  type MemoryReviewRecord,
} from "../../zapsdk/memory/review.js"
import type { MdMemoryType } from "../../zapsdk/memory/md-types.js"
import { createHash } from "node:crypto"

describe("reviewMemoryRecords", () => {
  it("reports stale, unknown-age, duplicate, scope-conflict, and scope-mismatch records", () => {
    const records: MemoryReviewRecord[] = [
      record("global:global_pref.md", "global", "global_pref", "user", "Use concise replies.", "2026-07-20T00:00:00.000Z"),
      record("project:repo_style.md", "project", "repo_style", "project", "use  concise\nreplies.", "2026-07-20T00:00:00.000Z"),
      record("global:shared.md", "global", "shared", "feedback", "Global rule.", "2026-07-20T00:00:00.000Z"),
      record("project:shared.md", "project", "Shared", "project", "Project fact.", "2026-07-20T00:00:00.000Z"),
      record("project:legacy_user.md", "project", "legacy_user", "user", "Legacy personal memory.", "2026-07-20T00:00:00.000Z"),
      record("project:old_fact.md", "project", "old_fact", "project", "Old project fact.", "2026-05-01T00:00:00.000Z"),
      record("project:unknown_age.md", "project", "unknown_age", "reference", "No timestamp."),
    ]

    const result = reviewMemoryRecords(records, { now: new Date("2026-07-22T12:00:00.000Z") })

    expect(result.issuesById.get("global:global_pref.md")).toEqual([
      { kind: "duplicate_content", relatedIds: ["project:repo_style.md"] },
    ])
    expect(result.issuesById.get("project:repo_style.md")).toEqual([
      { kind: "duplicate_content", relatedIds: ["global:global_pref.md"] },
    ])
    expect(result.issuesById.get("global:shared.md")).toEqual([
      { kind: "scope_conflict", relatedIds: ["project:shared.md"] },
    ])
    expect(result.issuesById.get("project:shared.md")).toEqual([
      { kind: "scope_conflict", relatedIds: ["global:shared.md"] },
    ])
    expect(result.issuesById.get("project:legacy_user.md")).toEqual([
      { kind: "scope_mismatch" },
    ])
    expect(result.issuesById.get("project:old_fact.md")).toEqual([
      { kind: "stale", ageDays: 82 },
    ])
    expect(result.issuesById.get("project:unknown_age.md")).toEqual([
      { kind: "age_unknown" },
    ])
    expect(result.counts).toEqual({
      stale: 1,
      age_unknown: 1,
      duplicate_content: 2,
      near_duplicate_content: 0,
      scope_conflict: 2,
      scope_mismatch: 1,
      provenance_mismatch: 0,
      low_confidence: 0,
      not_yet_valid: 0,
      expired: 0,
      superseded: 0,
      lifecycle_invalid: 0,
      supersedes_missing: 0,
    })
    expect(result.suggestions).toEqual([{
      id: "move_scope:project:legacy_user.md->global:legacy_user",
      kind: "move_scope",
      confidence: "high",
      sources: [{ id: "project:legacy_user.md", scope: "project", name: "legacy_user" }],
      target: { scope: "global", name: "legacy_user", type: "user" },
    }])
    expect(result.suggestionsById.get("project:legacy_user.md")).toEqual(result.suggestions)
  })

  it("uses a strict greater-than stale threshold on UTC day boundaries", () => {
    const records = [
      record("project:day30.md", "project", "day30", "project", "At threshold.", "2026-06-22T23:59:59.000Z"),
      record("project:day31.md", "project", "day31", "project", "Past threshold.", "2026-06-21T23:59:59.000Z"),
    ]

    const result = reviewMemoryRecords(records, {
      now: new Date("2026-07-22T00:01:00.000Z"),
      staleAfterDays: 30,
    })

    expect(result.issuesById.get("project:day30.md")).toBeUndefined()
    expect(result.issuesById.get("project:day31.md")).toEqual([{ kind: "stale", ageDays: 31 }])
  })

  it("flags changed bodies whose latest host provenance hash no longer matches", () => {
    const verified = record(
      "project:verified.md",
      "project",
      "verified",
      "project",
      "Verified body.\n",
      "2026-07-22T00:00:00.000Z",
    )
    const hash = `sha256:${createHash("sha256").update(verified.record.body).digest("hex")}`
    verified.record.frontmatter.provenance = {
      version: 1,
      updated: { origin: "memory_save", contentHash: hash },
    }
    const changed = record(
      "project:changed.md",
      "project",
      "changed",
      "project",
      "Changed after save.\n",
      "2026-07-22T00:00:00.000Z",
    )
    changed.record.frontmatter.provenance = {
      version: 1,
      updated: { origin: "memory_save", contentHash: `sha256:${"0".repeat(64)}` },
    }
    const legacy = record(
      "project:legacy.md",
      "project",
      "legacy",
      "project",
      "Legacy body without provenance.\n",
      "2026-07-22T00:00:00.000Z",
    )

    const result = reviewMemoryRecords([verified, changed, legacy], { now: new Date("2026-07-22T00:00:00.000Z") })

    expect(result.issuesById.get(verified.id)).toBeUndefined()
    expect(result.issuesById.get(legacy.id)).toBeUndefined()
    expect(result.issuesById.get(changed.id)).toEqual([{
      kind: "provenance_mismatch",
      expectedContentHash: `sha256:${"0".repeat(64)}`,
      actualContentHash: `sha256:${createHash("sha256").update(changed.record.body).digest("hex")}`,
    }])
    expect(result.counts.provenance_mismatch).toBe(1)
  })

  it("reports confidence, temporal validity, supersession, and malformed lifecycle metadata", () => {
    const old = record("project:old.md", "project", "old", "project", "old body", "2026-07-20T00:00:00.000Z")
    const replacement = record("project:new.md", "project", "new", "project", "new body", "2026-07-20T00:00:00.000Z")
    replacement.record.frontmatter.lifecycle = {
      version: 1,
      confidence: "high",
      supersedes: ["old"],
    }
    const candidate = record("project:candidate.md", "project", "candidate", "project", "candidate body", "2026-07-20T00:00:00.000Z")
    candidate.record.frontmatter.lifecycle = { version: 1, confidence: "low" }
    const future = record("project:future.md", "project", "future", "project", "future body", "2026-07-20T00:00:00.000Z")
    future.record.frontmatter.lifecycle = {
      version: 1,
      confidence: "high",
      validFrom: "2026-07-23T00:00:00.000Z",
    }
    const expired = record("project:expired.md", "project", "expired", "project", "expired body", "2026-07-20T00:00:00.000Z")
    expired.record.frontmatter.lifecycle = {
      version: 1,
      confidence: "high",
      expiresAt: "2026-07-22T00:00:00.000Z",
    }
    const malformed = record("project:malformed.md", "project", "malformed", "project", "bad body", "2026-07-20T00:00:00.000Z")
    malformed.record.frontmatter.lifecycleInvalid = true
    const dangling = record("project:dangling.md", "project", "dangling", "project", "current body", "2026-07-20T00:00:00.000Z")
    dangling.record.frontmatter.lifecycle = {
      version: 1,
      confidence: "high",
      supersedes: ["missing"],
    }

    const result = reviewMemoryRecords(
      [old, replacement, candidate, future, expired, malformed, dangling],
      { now: new Date("2026-07-22T12:00:00.000Z") },
    )

    expect(result.issuesById.get(old.id)?.find((issue) => issue.kind === "superseded")).toEqual({
      kind: "superseded",
      relatedIds: [replacement.id],
    })
    expect(result.issuesById.get(candidate.id)?.find((issue) => issue.kind === "low_confidence"))
      .toEqual({ kind: "low_confidence" })
    expect(result.issuesById.get(future.id)?.find((issue) => issue.kind === "not_yet_valid")).toEqual({
      kind: "not_yet_valid",
      effectiveAt: "2026-07-23T00:00:00.000Z",
    })
    expect(result.issuesById.get(expired.id)?.find((issue) => issue.kind === "expired")).toEqual({
      kind: "expired",
      effectiveAt: "2026-07-22T00:00:00.000Z",
    })
    expect(result.issuesById.get(malformed.id)?.[0]).toMatchObject({ kind: "lifecycle_invalid" })
    expect(result.issuesById.get(dangling.id)?.[0]).toMatchObject({ kind: "supersedes_missing" })
    expect(result.counts).toMatchObject({
      low_confidence: 1,
      not_yet_valid: 1,
      expired: 1,
      superseded: 1,
      lifecycle_invalid: 1,
      supersedes_missing: 1,
    })
  })

  it("suggests merging exact same-type duplicates into the correct, newest target", () => {
    const records = [
      record("global:old_project_rule.md", "global", "old_project_rule", "project", "Same rule.\n", "2026-07-01T00:00:00.000Z"),
      record("project:canonical_rule.md", "project", "canonical_rule", "project", " same  rule. ", "2026-07-20T00:00:00.000Z"),
    ]

    const result = reviewMemoryRecords(records, { now: new Date("2026-07-22T00:00:00.000Z") })

    expect(result.suggestions).toEqual([{
      id: "merge_duplicate:global:old_project_rule.md|project:canonical_rule.md->project:canonical_rule",
      kind: "merge_duplicate",
      confidence: "high",
      sources: [
        { id: "global:old_project_rule.md", scope: "global", name: "old_project_rule" },
        { id: "project:canonical_rule.md", scope: "project", name: "canonical_rule" },
      ],
      target: { scope: "project", name: "canonical_rule", type: "project" },
    }])
    expect(result.suggestionsById.get("global:old_project_rule.md")).toEqual(result.suggestions)
    expect(result.suggestionsById.get("project:canonical_rule.md")).toEqual(result.suggestions)
  })

  it("suggests review-only consolidation for same-type cross-scope conflicts", () => {
    const records = [
      record("global:reply_style.md", "global", "reply_style", "user", "Use concise replies.", "2026-07-20T00:00:00.000Z"),
      record("project:reply_style.md", "project", "Reply_Style", "user", "Lead with findings.", "2026-07-21T00:00:00.000Z"),
    ]

    const result = reviewMemoryRecords(records)

    expect(result.suggestions).toEqual([{
      id: "consolidate_scope_conflict:global:reply_style.md|project:reply_style.md->global:reply_style",
      kind: "consolidate_scope_conflict",
      confidence: "review",
      sources: [
        { id: "global:reply_style.md", scope: "global", name: "reply_style" },
        { id: "project:reply_style.md", scope: "project", name: "Reply_Style" },
      ],
      target: { scope: "global", name: "reply_style", type: "user" },
    }])
  })

  it("suggests review-only merging for same-type near-duplicate content", () => {
    const records = [
      record(
        "project:cache_policy_old.md",
        "project",
        "cache_policy_old",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message.",
        "2026-07-01T00:00:00.000Z",
      ),
      record(
        "project:cache_policy.md",
        "project",
        "cache_policy",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message. Verify hashes in status.",
        "2026-07-21T00:00:00.000Z",
      ),
    ]

    const result = reviewMemoryRecords(records, { now: new Date("2026-07-31T00:00:00.000Z") })

    expect(result.counts.near_duplicate_content).toBe(2)
    expect(result.issuesById.get("project:cache_policy_old.md")).toEqual([{
      kind: "near_duplicate_content",
      relatedIds: ["project:cache_policy.md"],
      similarity: 0.922,
    }])
    expect(result.issuesById.get("project:cache_policy.md")).toEqual([{
      kind: "near_duplicate_content",
      relatedIds: ["project:cache_policy_old.md"],
      similarity: 0.922,
    }])
    expect(result.suggestions).toEqual([{
      id: "merge_near_duplicate:project:cache_policy_old.md|project:cache_policy.md->project:cache_policy",
      kind: "merge_near_duplicate",
      confidence: "review",
      sources: [
        { id: "project:cache_policy_old.md", scope: "project", name: "cache_policy_old" },
        { id: "project:cache_policy.md", scope: "project", name: "cache_policy" },
      ],
      target: { scope: "project", name: "cache_policy", type: "project" },
    }])
  })

  it("detects conservative CJK near duplicates", () => {
    const records = [
      record(
        "project:cache_check_old.md",
        "project",
        "cache_check_old",
        "project",
        "模型缓存命中率低时，先检查稳定前缀、工具定义和会话历史是否发生变化。",
        "2026-07-20T00:00:00.000Z",
      ),
      record(
        "project:cache_check.md",
        "project",
        "cache_check",
        "project",
        "模型缓存命中率较低时，先检查稳定前缀、工具定义以及会话历史是否发生变化。",
        "2026-07-21T00:00:00.000Z",
      ),
    ]

    const result = reviewMemoryRecords(records, { now: new Date("2026-07-22T00:00:00.000Z") })

    expect(result.issuesById.get("project:cache_check_old.md")).toEqual([{
      kind: "near_duplicate_content",
      relatedIds: ["project:cache_check.md"],
      similarity: 0.8,
    }])
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({
      kind: "merge_near_duplicate",
      confidence: "review",
    })
  })

  it("allows hosts to disable near-duplicate review", () => {
    const records = [
      record(
        "project:cache_policy_old.md",
        "project",
        "cache_policy_old",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message.",
      ),
      record(
        "project:cache_policy.md",
        "project",
        "cache_policy",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message. Verify hashes in status.",
      ),
    ]

    const result = reviewMemoryRecords(records, { nearDuplicateThreshold: false })

    expect(result.counts.near_duplicate_content).toBe(0)
    expect(result.suggestions.some((suggestion) =>
      suggestion.kind === "merge_near_duplicate")).toBe(false)
  })

  it("does not treat short, cross-type, or merely topical content as near duplicates", () => {
    const records = [
      record("project:short_a.md", "project", "short_a", "project", "Keep prompt cache stable.", "2026-07-20T00:00:00.000Z"),
      record("project:short_b.md", "project", "short_b", "project", "Keep the prompt cache stable.", "2026-07-20T00:00:00.000Z"),
      record(
        "project:topic_a.md",
        "project",
        "topic_a",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory belongs in the transient tail.",
        "2026-07-20T00:00:00.000Z",
      ),
      record(
        "project:topic_b.md",
        "project",
        "topic_b",
        "project",
        "Prompt cache diagnostics should report cache reads and writes separately for every provider and model scope.",
        "2026-07-20T00:00:00.000Z",
      ),
      record(
        "project:cross_type.md",
        "project",
        "cross_type",
        "reference",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory belongs in the transient tail. Verify it in status.",
        "2026-07-20T00:00:00.000Z",
      ),
      record(
        "project:router_policy.md",
        "project",
        "router_policy",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message.",
        "2026-07-20T00:00:00.000Z",
      ),
      record(
        "project:database_policy.md",
        "project",
        "database_policy",
        "project",
        "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message. Verify hashes in status.",
        "2026-07-20T00:00:00.000Z",
      ),
    ]

    const result = reviewMemoryRecords(records)

    expect(result.counts.near_duplicate_content).toBe(0)
    expect([...result.issuesById.values()].flat().some((issue) =>
      issue.kind === "near_duplicate_content")).toBe(false)
    expect(result.suggestions.some((suggestion) =>
      suggestion.kind === "merge_near_duplicate")).toBe(false)
  })

  it("does not suggest a scope move when an unrelated target filename is occupied", () => {
    const misplaced = record(
      "project:legacy_user.md",
      "project",
      "legacy_user",
      "user",
      "Personal preference.",
      "2026-07-20T00:00:00.000Z",
    )
    const occupied = record(
      "global:legacy_user.md",
      "global",
      "different_name",
      "feedback",
      "Different record.",
      "2026-07-20T00:00:00.000Z",
    )
    occupied.record.filename = "Legacy_User.md"

    const result = reviewMemoryRecords([misplaced, occupied], { now: new Date("2026-07-22T00:00:00.000Z") })

    expect(result.issuesById.get(misplaced.id)).toEqual([{ kind: "scope_mismatch" }])
    expect(result.suggestions).toEqual([])
  })

  it("does not emit an unresolvable suggestion for same-scope case aliases", () => {
    const upper = record(
      "project:Rule.md",
      "project",
      "Rule",
      "project",
      "Same body.",
      "2026-07-20T00:00:00.000Z",
    )
    upper.record.filename = "Rule.md"
    const lower = record(
      "project:rule.md",
      "project",
      "rule",
      "project",
      "same body.",
      "2026-07-20T00:00:00.000Z",
    )

    const result = reviewMemoryRecords([upper, lower], { now: new Date("2026-07-22T00:00:00.000Z") })

    expect(result.issuesById.get(upper.id)?.map((issue) => issue.kind)).toEqual(["duplicate_content"])
    expect(result.issuesById.get(lower.id)?.map((issue) => issue.kind)).toEqual(["duplicate_content"])
    expect(result.suggestions).toEqual([])
  })

  it("treats personal memory in project scope as valid for a project-only host", () => {
    const personal = record(
      "project:reply_style.md",
      "project",
      "reply_style",
      "user",
      "Use concise replies.",
      "2026-07-20T00:00:00.000Z",
    )

    const result = reviewMemoryRecords([personal], { availableScopes: ["project"], now: new Date("2026-07-22T00:00:00.000Z") })

    expect(result.issuesById.get(personal.id)).toBeUndefined()
    expect(result.suggestions).toEqual([])
  })
})

describe("normalizeMemoryContent", () => {
  it("normalizes logical newlines, case, and whitespace for duplicate detection", () => {
    expect(normalizeMemoryContent("Cache\rHit\tRate 90%\n")).toBe("cache hit rate 90%")
  })
})

function record(
  id: string,
  scope: "global" | "project",
  name: string,
  type: MdMemoryType,
  body: string,
  updatedAt?: string,
): MemoryReviewRecord {
  return {
    id,
    scope,
    record: {
      filename: `${name.toLowerCase()}.md`,
      frontmatter: {
        name,
        description: `${name} description`,
        type,
        ...(updatedAt ? { updatedAt } : {}),
      },
      body,
    },
  }
}

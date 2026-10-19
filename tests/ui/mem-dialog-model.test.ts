import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { openMdStore } from "../../zapsdk/memory/md-store.js"
import { serializeMdFile } from "../../zapsdk/memory/md-frontmatter.js"
import {
  deleteScopedMemoryRecord,
  findScopedMemoryRecord,
  formatScopedMemoryMeta,
  formatScopedMemoryReviewNotices,
  formatScopedMemorySuggestionNotices,
  formatScopedMemoryTitle,
  listScopedMemoryRecords,
} from "../../src/ui/mem-dialog-model.js"

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `zapcode-mem-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("mem dialog model", () => {
  it("lists global and project memories while flagging legacy global project records for review", () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))

    globalStore.save({
      name: "reply_style",
      description: "concise response preference",
      type: "user",
      body: "Keep engineering updates concise.\n",
    })
    globalStore.save({
      name: "review_feedback",
      description: "review comments should lead with findings",
      type: "feedback",
      body: "Lead reviews with findings.\n",
    })
    globalStore.save({
      name: "other_repo_state",
      description: "global project record should not appear",
      type: "project",
      body: "This belongs to another repository.\n",
    })
    projectStore.save({
      name: "repo_rules",
      description: "current repository rules",
      type: "project",
      body: "Run Bun tests before submitting.\n",
    })

    const records = listScopedMemoryRecords({ projectStore, globalStore })

    expect(records.map((record) => record.id)).toEqual([
      "global:reply_style.md",
      "global:review_feedback.md",
      "global:other_repo_state.md",
      "project:repo_rules.md",
    ])
    expect(records.map(formatScopedMemoryMeta)).toEqual([
      "[global:user] concise response preference",
      "[global:feedback] review comments should lead with findings",
      "[global:project] global project record should not appear · review: scope mismatch · suggested: move -> project:other_repo_state",
      "[project:project] current repository rules",
    ])
    expect(records.map(formatScopedMemoryTitle)).toEqual([
      "reply_style  [global:user]",
      "review_feedback  [global:feedback]",
      "other_repo_state  [global:project]",
      "repo_rules  [project:project]",
    ])
    expect(formatScopedMemoryReviewNotices(records[2]!)).toEqual([
      "Scope mismatch: project/reference memory is stored globally. Review and move it explicitly.",
    ])
  })

  it("deletes the selected scope when filenames collide across global and project stores", () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))

    globalStore.save({
      name: "reply_style",
      description: "global user preference",
      type: "user",
      body: "Global preference.\n",
    })
    projectStore.save({
      name: "reply_style",
      description: "legacy project-scoped user record",
      type: "user",
      body: "Project-local preference.\n",
    })

    const globalRecord = findScopedMemoryRecord(
      listScopedMemoryRecords({ projectStore, globalStore }),
      "global:reply_style.md",
    )

    expect(globalRecord).toBeDefined()
    expect(deleteScopedMemoryRecord(globalRecord!)).toBe(true)
    expect(globalStore.get("reply_style.md")).toBeUndefined()
    expect(projectStore.get("reply_style.md")?.body).toContain("Project-local preference")
  })

  it("shows lifecycle state while keeping superseded and candidate records auditable", () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    projectStore.save({
      name: "old_state",
      description: "old state",
      type: "project",
      body: "old state body\n",
    })
    projectStore.save({
      name: "current_state",
      description: "current state",
      type: "project",
      lifecycle: { confidence: "high", supersedes: ["old_state"] },
      body: "current state body\n",
    })
    projectStore.save({
      name: "candidate_state",
      description: "candidate state",
      type: "project",
      lifecycle: { confidence: "low" },
      body: "candidate state body\n",
    })

    const records = listScopedMemoryRecords({ projectStore, globalStore })
    const old = findScopedMemoryRecord(records, "project:old_state.md")!
    const candidate = findScopedMemoryRecord(records, "project:candidate_state.md")!

    expect(formatScopedMemoryMeta(old)).toContain("review: superseded")
    expect(formatScopedMemoryReviewNotices(old)).toEqual([
      "Superseded: a newer memory replaces this record, so it remains audit-only. Related: project:current_state.md.",
    ])
    expect(formatScopedMemoryMeta(candidate)).toContain("review: low confidence")
    expect(formatScopedMemoryReviewNotices(candidate)).toEqual([
      "Low-confidence candidate: excluded from automatic recall until it is verified and saved with medium or high confidence.",
    ])
  })

  it("surfaces review issues without mutating or deleting memory records", () => {
    const projectDir = join(dir, "project")
    const globalDir = join(dir, "global")
    const projectStore = openMdStore(projectDir)
    const globalStore = openMdStore(globalDir)
    globalStore.save({
      name: "shared",
      description: "global rule",
      type: "feedback",
      body: "Keep cache diagnostics visible.\n",
    })
    projectStore.save({
      name: "shared",
      description: "project fact with colliding name",
      type: "project",
      body: "Project uses Bun.\n",
    })
    projectStore.save({
      name: "duplicate_cache_rule",
      description: "duplicate of global rule",
      type: "project",
      body: "keep  cache diagnostics\nvisible.\n",
    })
    projectStore.save({
      name: "legacy_user",
      description: "personal record in project scope",
      type: "user",
      body: "User prefers concise updates.\n",
    })
    writeFileSync(join(projectDir, "old_fact.md"), serializeMdFile({
      name: "old_fact",
      description: "old project fact",
      type: "project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, "Old fact.\n"))
    writeFileSync(join(projectDir, "unknown_age.md"), serializeMdFile({
      name: "unknown_age",
      description: "manually authored without timestamps",
      type: "reference",
    }, "Reference.\n"))

    const records = listScopedMemoryRecords({
      projectStore,
      globalStore,
      review: { now: new Date("2026-07-22T00:00:00.000Z") },
    })
    const byId = new Map(records.map((record) => [record.id, record]))

    expect(byId.get("global:shared.md")?.issues.map((issue) => issue.kind)).toEqual([
      "scope_conflict",
      "duplicate_content",
    ])
    expect(byId.get("project:shared.md")?.issues.map((issue) => issue.kind)).toEqual([
      "scope_conflict",
    ])
    expect(byId.get("project:duplicate_cache_rule.md")?.issues.map((issue) => issue.kind)).toEqual([
      "duplicate_content",
    ])
    expect(byId.get("project:legacy_user.md")?.issues.map((issue) => issue.kind)).toEqual([
      "scope_mismatch",
    ])
    expect(byId.get("project:old_fact.md")?.issues.map((issue) => issue.kind)).toEqual([
      "stale",
    ])
    expect(byId.get("project:unknown_age.md")?.issues.map((issue) => issue.kind)).toEqual([
      "age_unknown",
    ])
    expect(formatScopedMemoryMeta(byId.get("global:shared.md")!)).toContain(
      "review: scope conflict, duplicate content",
    )
    expect(formatScopedMemoryReviewNotices(byId.get("global:shared.md")!)).toEqual([
      "Scope conflict: the same memory name exists in global and project stores. Related: project:shared.md.",
      "Duplicate content: another memory has equivalent normalized content. Related: project:duplicate_cache_rule.md.",
    ])
    expect(formatScopedMemorySuggestionNotices(byId.get("project:legacy_user.md")!)).toEqual([
      "Suggested maintenance: inspect project:legacy_user.md in /mem before deciding whether to replace them with a record in global:legacy_user. No automatic records are changed.",
    ])
    expect(formatScopedMemoryMeta(byId.get("project:legacy_user.md")!)).toContain(
      "suggested: move -> global:legacy_user",
    )
    expect(globalStore.get("shared.md")).toBeDefined()
    expect(projectStore.get("shared.md")).toBeDefined()
  })

  it("shows one deterministic merge suggestion on every exact duplicate source", () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    projectStore.save({
      name: "cache_rule_old",
      description: "old cache rule",
      type: "project",
      body: "Keep the prompt prefix stable.\n",
    })
    projectStore.save({
      name: "cache_rule",
      description: "canonical cache rule",
      type: "project",
      body: " keep  the prompt prefix stable. ",
    })

    const records = listScopedMemoryRecords({ projectStore, globalStore })
    const first = findScopedMemoryRecord(records, "project:cache_rule.md")!
    const second = findScopedMemoryRecord(records, "project:cache_rule_old.md")!

    expect(first.suggestions).toHaveLength(1)
    expect(second.suggestions).toEqual(first.suggestions)
    expect(first.suggestions[0]).toMatchObject({
      kind: "merge_duplicate",
      confidence: "high",
      target: { scope: "project", type: "project" },
    })
    expect(formatScopedMemorySuggestionNotices(first)[0]).toContain(
      "inspect duplicate records project:cache_rule_old.md, project:cache_rule.md in /mem",
    )
    expect(projectStore.get("cache_rule.md")).toBeDefined()
    expect(projectStore.get("cache_rule_old.md")).toBeDefined()
  })

  it("shows conservative near-duplicate review without modifying either record", () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    projectStore.save({
      name: "cache_policy_old",
      description: "old cache policy",
      type: "project",
      body: "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message.\n",
    })
    projectStore.save({
      name: "cache_policy",
      description: "canonical cache policy",
      type: "project",
      body: "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message. Verify hashes in status.\n",
    })

    const records = listScopedMemoryRecords({ projectStore, globalStore })
    const current = findScopedMemoryRecord(records, "project:cache_policy.md")!

    expect(current.issues).toEqual([{
      kind: "near_duplicate_content",
      relatedIds: ["project:cache_policy_old.md"],
      similarity: 0.922,
    }])
    expect(current.suggestions[0]).toMatchObject({
      kind: "merge_near_duplicate",
      confidence: "review",
    })
    expect(formatScopedMemoryReviewNotices(current)).toEqual([
      "Near-duplicate content: another same-type memory is 92% similar. Read both bodies before merging. Related: project:cache_policy_old.md.",
    ])
    expect(formatScopedMemorySuggestionNotices(current)[0]).toContain(
      "inspect near-duplicate records",
    )
    expect(projectStore.get("cache_policy.md")).toBeDefined()
    expect(projectStore.get("cache_policy_old.md")).toBeDefined()
  })

  it("shows a bounded provenance warning when a host-authored memory body changes", () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    const record = projectStore.save({
      name: "verified_state",
      description: "verified project state",
      type: "project",
      provenance: { origin: "memory_save", sessionId: "session-1", toolCallId: "call-1", step: 2 },
      body: "Original body.\n",
    })
    writeFileSync(
      join(projectStore.dir, record.filename),
      serializeMdFile(record.frontmatter, "Externally changed body.\n"),
    )

    const reviewed = findScopedMemoryRecord(
      listScopedMemoryRecords({ projectStore, globalStore }),
      "project:verified_state.md",
    )!
    const expected = record.frontmatter.provenance!.updated.contentHash.slice("sha256:".length, 19)
    const actual = createHash("sha256").update("Externally changed body.\n").digest("hex").slice(0, 12)

    expect(formatScopedMemoryMeta(reviewed)).toContain("review: provenance mismatch")
    expect(formatScopedMemoryReviewNotices(reviewed)).toEqual([
      `Provenance mismatch: body hash ${actual} no longer matches the latest host record ${expected}. Verify the file before reuse.`,
    ])
    expect(projectStore.get(record.filename)?.body).toBe("Externally changed body.\n")
  })
})

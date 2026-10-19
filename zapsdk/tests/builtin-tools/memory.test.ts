import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, renameSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { memoryMergeTool, memoryReviewTool, memorySaveTool } from "../../builtin-tools/memory"
import { openMdStore, type MdMemoryStore } from "../../memory/md-store"
import { ToolExecutor } from "../../tools/executor"
import { ToolRegistry } from "../../tools/registry"

let dir: string
beforeEach(() => {
  dir = join(tmpdir(), `zapcode-memtool-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("memory_save tool", () => {
  it("registers as memory_save with confirm permission", () => {
    const tool = memorySaveTool({ store: openMdStore(dir) })
    expect(tool.definition.name).toBe("memory_save")
    expect(tool.definition.permission).toBe("confirm")
  })

  it("writes a markdown file via the store and returns success", async () => {
    const store = openMdStore(dir)
    const tool = memorySaveTool({ store })
    const r = await tool.handler({
      type: "user",
      name: "user_role",
      description: "senior eng",
      content: "the user is a senior eng\n",
    }, undefined, { sessionId: "session-1", toolCallId: "call-1", step: 2 })
    expect(r.success).toBe(true)
    expect(r.output).toContain("user_role.md")
    const onDisk = readFileSync(join(dir, "user_role.md"), "utf-8")
    expect(onDisk).toContain("type: user")
    expect(onDisk).toContain("the user is a senior eng")
    expect(store.get("user_role.md")?.frontmatter.provenance?.updated).toMatchObject({
      origin: "memory_save",
      sessionId: "session-1",
      toolCallId: "call-1",
      step: 2,
    })
    expect(store.get("user_role.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "medium",
    })
  })

  it("redacts credentials before saving and reports the rewrite", async () => {
    const store = openMdStore(dir)
    const result = await memorySaveTool({ store }).handler({
      type: "project",
      name: "provider_setup",
      description: "provider setup api_key = sk-description-secret",
      tags: ["token=tag-secret"],
      source: "Authorization: Bearer source-secret",
      content: "api_key = sk-live-secret-value\nKeep the endpoint stable.\n",
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain("credentials redacted")
    const record = store.get("provider_setup.md")
    expect(record?.body).toContain("api_key = [REDACTED]")
    expect(record?.frontmatter.description).toContain("api_key = [REDACTED]")
    expect(record?.frontmatter.tags).toEqual(["token=[redacted]"])
    expect(record?.frontmatter.source).toBe("Authorization: Bearer [REDACTED]")
    expect(JSON.stringify(record)).not.toContain("secret")
  })

  it("rejects credential-like memory names before creating a file", async () => {
    const store = openMdStore(dir)
    const result = await memorySaveTool({ store }).handler({
      type: "project",
      name: "sk-live-secret-value",
      description: "unsafe filename",
      content: "body\n",
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("memory name must not contain a credential-like value")
    expect(store.list()).toEqual([])
  })

  it("checks duplicates after credential redaction", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "safe_provider_setup",
      description: "redacted provider setup",
      type: "project",
      body: "api_key = [REDACTED]\n",
    })

    const result = await memorySaveTool({ store }).handler({
      type: "project",
      name: "raw_provider_setup",
      description: "raw provider setup",
      content: "api_key = sk-live-secret-value\n",
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain("equivalent memory already exists")
    expect(result.output).toContain("credentials redacted")
    expect(store.get("raw_provider_setup.md")).toBeUndefined()
  })

  it("routes personal memories to the global store when configured", async () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    const tool = memorySaveTool({ store: projectStore, globalStore })

    const userResult = await tool.handler({
      type: "user",
      name: "user_role",
      description: "senior eng",
      content: "the user is a senior eng\n",
    })
    const projectResult = await tool.handler({
      type: "project",
      name: "repo_rules",
      description: "project rules",
      content: "run bun test before finishing\n",
    })

    expect(userResult.success).toBe(true)
    expect(userResult.output).toContain("(global)")
    expect(projectResult.success).toBe(true)
    expect(projectResult.output).toContain("(project)")
    expect(globalStore.get("user_role.md")?.frontmatter.type).toBe("user")
    expect(projectStore.get("user_role.md")).toBeUndefined()
    expect(projectStore.get("repo_rules.md")?.frontmatter.type).toBe("project")
    expect(globalStore.get("repo_rules.md")).toBeUndefined()
  })

  it("passes optional tags and source metadata to the store", async () => {
    const store = openMdStore(dir)
    const tool = memorySaveTool({ store })
    const r = await tool.handler({
      type: "project",
      name: "cache_notes",
      description: "cache hit investigation",
      tags: ["cache", "provider"],
      source: "user feedback",
      content: "normalize cache usage\n",
    })
    expect(r.success).toBe(true)
    const rec = store.get("cache_notes.md")
    expect(rec?.frontmatter.tags).toEqual(["cache", "provider"])
    expect(rec?.frontmatter.source).toBe("user feedback")
  })

  it("persists lifecycle admission metadata and keeps low-confidence candidates review-only", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "old_release",
      description: "old release",
      type: "project",
      body: "old release state\n",
    })
    const tool = memorySaveTool({ store })

    const result = await tool.handler({
      type: "project",
      name: "current_release",
      description: "current release",
      confidence: "high",
      validFrom: "2026-07-22T08:00:00+08:00",
      expiresAt: "2026-08-01T00:00:00Z",
      supersedes: ["old_release"],
      content: "current release state\n",
    })
    const candidate = await tool.handler({
      type: "project",
      name: "possible_release",
      description: "unverified release candidate",
      confidence: "low",
      content: "candidate release state\n",
    })

    expect(result.success).toBe(true)
    expect(candidate.success).toBe(true)
    expect(store.get("current_release.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "high",
      validFrom: "2026-07-22T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      supersedes: ["old_release"],
    })
    expect(store.get("possible_release.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "low",
    })
  })

  it("does not promote a new partial lifecycle to high confidence", async () => {
    const store = openMdStore(dir)
    const result = await memorySaveTool({ store }).handler({
      type: "project",
      name: "temporary_schedule",
      description: "temporary schedule",
      expiresAt: "2026-08-01T00:00:00Z",
      content: "Temporary schedule.\n",
    })

    expect(result.success).toBe(true)
    expect(store.get("temporary_schedule.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "medium",
      expiresAt: "2026-08-01T00:00:00.000Z",
    })
  })

  it("rejects missing, cross-type, self, and cyclic supersession transitions", async () => {
    const store = openMdStore(dir)
    store.save({ name: "state_a", description: "state a", type: "project", body: "a\n" })
    store.save({ name: "state_b", description: "state b", type: "project", body: "b\n" })
    store.save({ name: "user_pref", description: "user pref", type: "user", body: "pref\n" })
    const tool = memorySaveTool({ store })

    const missing = await tool.handler({
      type: "project", name: "state_c", description: "state c", confidence: "high", supersedes: ["missing"], content: "c\n",
    })
    const crossType = await tool.handler({
      type: "project", name: "state_c", description: "state c", confidence: "high", supersedes: ["user_pref"], content: "c\n",
    })
    const self = await tool.handler({
      type: "project", name: "state_a", description: "state a", confidence: "high", supersedes: ["state_a"], content: "a2\n",
    })
    const medium = await tool.handler({
      type: "project", name: "state_c", description: "state c", confidence: "medium", supersedes: ["state_a"], content: "c\n",
    })
    const firstEdge = await tool.handler({
      type: "project", name: "state_a", description: "state a", confidence: "high", supersedes: ["state_b"], content: "a2\n",
    })
    const cycle = await tool.handler({
      type: "project", name: "state_b", description: "state b", confidence: "high", supersedes: ["state_a"], content: "b2\n",
    })

    expect(missing).toMatchObject({ success: false })
    expect(missing.error).toContain("not found")
    expect(crossType.error).toContain("same memory type")
    expect(self.error).toContain("cannot supersede itself")
    expect(medium.error).toContain("requires high confidence")
    expect(firstEdge.success).toBe(true)
    expect(cycle.error).toContain("create a cycle")
    expect(store.get("state_b.md")?.body).toBe("b\n")
  })

  it("returns failure on store rejection (bad name)", async () => {
    const tool = memorySaveTool({ store: openMdStore(dir) })
    const r = await tool.handler({ type: "user", name: "../escape", description: "x", content: "x\n" })
    expect(r.success).toBe(false)
    expect(r.error ?? "").toMatch(/name/)
  })

  it("upserts when called twice with the same name", async () => {
    const store = openMdStore(dir)
    const tool = memorySaveTool({ store })
    await tool.handler({ type: "user", name: "x", description: "v1", content: "body1\n" })
    await tool.handler({ type: "user", name: "x", description: "v2", content: "body2\n" })
    const all = store.list()
    expect(all.length).toBe(1)
    expect(all[0].body).toBe("body2\n")
  })

  it("reports updates separately from new saves", async () => {
    const store = openMdStore(dir)
    const tool = memorySaveTool({ store })
    await tool.handler({ type: "project", name: "state", description: "v1", content: "body1\n" })

    const result = await tool.handler({
      type: "project",
      name: "state",
      description: "v2",
      content: "body2\n",
    })

    expect(result.success).toBe(true)
    expect(result.output).toBe("updated state.md (project)")
  })

  it("rejects cross-scope name conflicts without deleting or overwriting either store", async () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    globalStore.save({
      name: "Shared_State",
      description: "global preference",
      type: "user",
      body: "Keep replies concise.\n",
    })
    const tool = memorySaveTool({ store: projectStore, globalStore })

    const result = await tool.handler({
      type: "project",
      name: "shared_state",
      description: "project state",
      content: "Cache audit is enabled.\n",
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("memory name conflict")
    expect(result.error).toContain("No record was changed")
    expect(result.error).toContain("Run memory_review or inspect /mem")
    expect(globalStore.get("Shared_State.md")?.body).toContain("Keep replies concise")
    expect(projectStore.get("Shared_State.md")).toBeUndefined()
  })

  it("rejects case-only logical name aliases in the same scope", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "cache_state",
      description: "existing cache state",
      type: "project",
      body: "Existing state.\n",
    })
    const tool = memorySaveTool({ store })

    const result = await tool.handler({
      type: "project",
      name: "Cache_State",
      description: "case alias",
      content: "Different state.\n",
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("already exists as cache_state.md in project memory")
    expect(store.get("cache_state.md")?.body).toContain("Existing state")
    expect(store.list().map((record) => record.filename)).toEqual(["cache_state.md"])
  })

  it("does not write equivalent content under a second name or scope", async () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    globalStore.save({
      name: "reply_style",
      description: "global preference",
      type: "user",
      body: "Keep  replies\nconcise.\n",
    })
    const tool = memorySaveTool({ store: projectStore, globalStore })

    const result = await tool.handler({
      type: "project",
      name: "duplicate_style",
      description: "duplicate project memory",
      content: "keep replies concise.",
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain("equivalent memory already exists as reply_style.md (global)")
    expect(result.output).toContain("no duplicate was written")
    expect(projectStore.get("duplicate_style.md")).toBeUndefined()
  })

  it("rejects oversized verbatim memory bodies before writing", async () => {
    const store = openMdStore(dir)
    const tool = memorySaveTool({ store })

    const r = await tool.handler({
      type: "project",
      name: "huge_paste",
      description: "oversized pasted transcript",
      content: "x".repeat(24_001),
    })

    expect(r.success).toBe(false)
    expect(r.error ?? "").toContain("memory content is 24001 chars")
    expect(r.error ?? "").toContain("above the 24000 char limit")
    expect(r.error ?? "").toContain("Save a concise durable summary")
    expect(store.get("huge_paste.md")).toBeUndefined()
  })

  it("accepts non-BMP memory content by Unicode character count through the executor", async () => {
    const store = openMdStore(dir)
    const registry = new ToolRegistry()
    registry.register(memorySaveTool({ store }))
    const executor = new ToolExecutor(registry, { allowConfirmWithoutApproval: true })
    const content = "😀".repeat(12_001)
    expect(content.length).toBeGreaterThan(24_000)
    expect(Array.from(content).length).toBeLessThanOrEqual(24_000)

    const r = await executor.execute("memory_save", {
      type: "project",
      name: "unicode_memory",
      description: "unicode content within code point limit",
      content,
    })

    expect(r.success).toBe(true)
    expect(store.get("unicode_memory.md")?.body).toBe(`${content}\n`)
  })

  it("rejects non-BMP memory content above the Unicode character limit before writing", async () => {
    const store = openMdStore(dir)
    const registry = new ToolRegistry()
    registry.register(memorySaveTool({ store }))
    const executor = new ToolExecutor(registry, { allowConfirmWithoutApproval: true })

    const r = await executor.execute("memory_save", {
      type: "project",
      name: "unicode_huge_paste",
      description: "unicode content above limit",
      content: "😀".repeat(24_001),
    })

    expect(r.success).toBe(false)
    expect(r.error ?? "").toContain("24000 Unicode characters")
    expect(store.get("unicode_huge_paste.md")).toBeUndefined()
  })
})

describe("memory_review tool", () => {
  it("registers as a confirmation-gated read-only maintenance tool", () => {
    const tool = memoryReviewTool({ store: openMdStore(dir) })

    expect(tool.definition.name).toBe("memory_review")
    expect(tool.definition.permission).toBe("confirm")
    expect(tool.definition.readOnly).toBe(true)
    expect(tool.definition.prompt).toContain("read every required source body")
    expect(tool.definition.description).toContain("without returning memory bodies")
    expect(tool.definition.description).toContain("near-duplicate")
  })

  it("returns issue records and deterministic suggestions without bodies or mutation", async () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    globalStore.save({
      name: "old_rule",
      description: "mis-scoped old rule",
      type: "project",
      body: "SECRET durable cache rule body.\n",
    })
    projectStore.save({
      name: "canonical_rule",
      description: "canonical cache rule",
      type: "project",
      body: " secret  durable cache rule body. ",
    })
    projectStore.save({
      name: "clean_rule",
      description: "clean unrelated record",
      type: "project",
      body: "PRIVATE clean body must stay out of review output.\n",
    })
    const beforeGlobal = globalStore.list()
    const beforeProject = projectStore.list()

    const result = await memoryReviewTool({ store: projectStore, globalStore }).handler({})

    expect(result.success).toBe(true)
    const payload = JSON.parse(result.output) as {
      readOnly: boolean
      totalRecords: number
      matchingRecords: number
      pagination: { returned: number; hasMore: boolean }
      issueCounts: Record<string, number>
      records: Array<{ id: string; path: string; issues: Array<{ kind: string }> }>
      suggestions: Array<{
        kind: string
        confidence: string
        sources: Array<{ id: string; scope: string; name: string }>
        target: { scope: string; name: string; type: string }
      }>
    }
    expect(payload.readOnly).toBe(true)
    expect(payload.totalRecords).toBe(3)
    expect(payload.matchingRecords).toBe(2)
    expect(payload.pagination).toMatchObject({ returned: 2, hasMore: false })
    expect(payload.records.map((record) => record.id)).toEqual([
      "global:old_rule.md",
      "project:canonical_rule.md",
    ])
    expect(payload.records[0].path).toBe(join(globalStore.dir, "old_rule.md"))
    expect(payload.issueCounts).toMatchObject({ duplicate_content: 2, scope_mismatch: 1 })
    expect(payload.suggestions).toEqual([{
      id: "merge_duplicate:global:old_rule.md|project:canonical_rule.md->project:canonical_rule",
      kind: "merge_duplicate",
      confidence: "high",
      sources: [
        { id: "global:old_rule.md", scope: "global", name: "old_rule" },
        { id: "project:canonical_rule.md", scope: "project", name: "canonical_rule" },
      ],
      target: { scope: "project", name: "canonical_rule", type: "project" },
    }])
    expect(result.output).not.toContain("SECRET durable")
    expect(result.output).not.toContain("PRIVATE clean body")
    expect(globalStore.list()).toEqual(beforeGlobal)
    expect(projectStore.list()).toEqual(beforeProject)
  })

  it("returns review-only near-duplicate suggestions without exposing bodies", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "cache_policy_old",
      description: "old cache policy",
      type: "project",
      body: "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message.\n",
    })
    store.save({
      name: "cache_policy",
      description: "canonical cache policy with current details",
      type: "project",
      body: "The prompt cache must keep the stable system prefix unchanged. Dynamic memory and todo context belong in the transient tail message. Verify hashes in status.\n",
    })

    const result = await memoryReviewTool({ store }).handler({})

    expect(result.success).toBe(true)
    const payload = JSON.parse(result.output) as {
      matchingRecords: number
      issueCounts: Record<string, number>
      records: Array<{ id: string; issues: Array<{ kind: string; similarity?: number }> }>
      suggestions: Array<{ kind: string; confidence: string }>
    }
    expect(payload.matchingRecords).toBe(2)
    expect(payload.issueCounts.near_duplicate_content).toBe(2)
    expect(payload.records.every((record) =>
      record.issues.some((issue) =>
        issue.kind === "near_duplicate_content" && issue.similarity === 0.922))).toBe(true)
    expect(payload.suggestions).toHaveLength(1)
    expect(payload.suggestions[0]).toMatchObject({
      kind: "merge_near_duplicate",
      confidence: "review",
    })
    expect(result.output).not.toContain("stable system prefix unchanged")
    expect(store.list()).toHaveLength(2)
  })

  it("paginates the stable full inventory only when include_clean is requested", async () => {
    const store = openMdStore(dir)
    for (const name of ["alpha", "beta", "gamma"]) {
      store.save({ name, description: `${name} description`, type: "project", body: `${name} body.\n` })
    }

    const result = await memoryReviewTool({ store }).handler({
      include_clean: true,
      offset: 1,
      limit: 1,
    })

    expect(result.success).toBe(true)
    const payload = JSON.parse(result.output) as {
      matchingRecords: number
      pagination: { offset: number; limit: number; returned: number; hasMore: boolean }
      records: Array<{ id: string }>
      suggestions: unknown[]
    }
    expect(payload.matchingRecords).toBe(3)
    expect(payload.pagination).toEqual({ offset: 1, limit: 1, returned: 1, hasMore: true })
    expect(payload.records).toEqual([{
      id: "project:beta.md",
      scope: "project",
      filename: "beta.md",
      path: join(store.dir, "beta.md"),
      name: "beta",
      type: "project",
      description: "beta description",
      updatedAt: store.get("beta.md")!.frontmatter.updatedAt,
      issues: [],
    }])
    expect(payload.suggestions).toEqual([])
  })

  it("does not suggest an unavailable global move for a project-only host", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "reply_style",
      description: "personal response preference",
      type: "user",
      body: "Keep replies concise.\n",
    })

    const result = await memoryReviewTool({ store }).handler({})

    expect(result.success).toBe(true)
    const payload = JSON.parse(result.output) as {
      matchingRecords: number
      records: unknown[]
      suggestions: unknown[]
    }
    expect(payload.matchingRecords).toBe(0)
    expect(payload.records).toEqual([])
    expect(payload.suggestions).toEqual([])
  })

  it("rejects an oversized page before execution", async () => {
    const store = openMdStore(dir)
    const registry = new ToolRegistry()
    registry.register(memoryReviewTool({ store }))
    const executor = new ToolExecutor(registry, { allowConfirmWithoutApproval: true })

    const result = await executor.execute("memory_review", { limit: 101 })

    expect(result.success).toBe(false)
    expect(result.error).toContain("Invalid arguments")
  })
})

describe("memory_merge tool", () => {
  it("registers as a confirm-only maintenance tool", () => {
    const tool = memoryMergeTool({ store: openMdStore(dir) })

    expect(tool.definition.name).toBe("memory_merge")
    expect(tool.definition.permission).toBe("confirm")
    expect(tool.definition.prompt).toContain("self-contained final target body")
  })

  it("consolidates source records into one complete project target", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "cache_rule_old",
      description: "old cache rule",
      type: "project",
      body: "Keep the prefix stable.\n",
    })
    store.save({
      name: "cache_diagnostics_old",
      description: "old cache diagnostics",
      type: "project",
      body: "Inspect cache read and write tokens.\n",
    })

    const result = await memoryMergeTool({ store }).handler({
      sources: [
        { scope: "project", name: "cache_rule_old" },
        { scope: "project", name: "cache_diagnostics_old" },
      ],
      target: {
        type: "project",
        name: "cache_strategy",
        description: "cache stability and diagnostics",
        tags: ["cache", "pinned"],
        source: "memory consolidation",
        content: "Keep the prefix stable and inspect cache read/write tokens.\n",
      },
    }, undefined, { sessionId: "session-2", toolCallId: "merge-1", step: 5 })

    expect(result.success).toBe(true)
    expect(result.output).toContain("merged 2 memory records into cache_strategy.md (project)")
    expect(result.output).toContain("removed 2 obsolete source records")
    expect(store.get("cache_rule_old.md")).toBeUndefined()
    expect(store.get("cache_diagnostics_old.md")).toBeUndefined()
    expect(store.get("cache_strategy.md")).toMatchObject({
      frontmatter: {
        name: "cache_strategy",
        type: "project",
        tags: ["cache", "pinned"],
        source: "memory consolidation",
        lifecycle: {
          version: 1,
          confidence: "medium",
        },
        provenance: {
          updated: {
            origin: "memory_merge",
            sessionId: "session-2",
            toolCallId: "merge-1",
            step: 5,
          },
        },
      },
      body: "Keep the prefix stable and inspect cache read/write tokens.\n",
    })
  })

  it("accepts explicit lifecycle admission for a new merged target", async () => {
    const store = openMdStore(dir)
    store.save({ name: "old_schedule", description: "old", type: "project", body: "Old schedule.\n" })

    const result = await memoryMergeTool({ store }).handler({
      sources: [{ scope: "project", name: "old_schedule" }],
      target: {
        type: "project",
        name: "release_schedule",
        description: "verified release schedule",
        confidence: "high",
        validFrom: "2026-07-22T08:00:00+08:00",
        expiresAt: "2026-08-01T00:00:00Z",
        content: "Release schedule.\n",
      },
    })

    expect(result.success).toBe(true)
    expect(store.get("release_schedule.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "high",
      validFrom: "2026-07-22T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    })
  })

  it("does not promote a partial merged lifecycle to high confidence", async () => {
    const store = openMdStore(dir)
    store.save({ name: "old_window", description: "old", type: "project", body: "Old window.\n" })

    const result = await memoryMergeTool({ store }).handler({
      sources: [{ scope: "project", name: "old_window" }],
      target: {
        type: "project",
        name: "temporary_window",
        description: "temporary window",
        expiresAt: "2026-08-01T00:00:00Z",
        content: "Temporary window.\n",
      },
    })

    expect(result.success).toBe(true)
    expect(store.get("temporary_window.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "medium",
      expiresAt: "2026-08-01T00:00:00.000Z",
    })
  })

  it("preserves an existing target lifecycle when merge omits admission fields", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "canonical",
      description: "candidate",
      type: "project",
      lifecycle: { confidence: "low", expiresAt: "2026-08-01T00:00:00Z" },
      body: "Candidate fact.\n",
    })
    store.save({ name: "supporting", description: "supporting", type: "project", body: "Supporting fact.\n" })

    const result = await memoryMergeTool({ store }).handler({
      sources: [
        { scope: "project", name: "canonical" },
        { scope: "project", name: "supporting" },
      ],
      target: {
        type: "project",
        name: "canonical",
        description: "consolidated candidate",
        content: "Consolidated candidate fact.\n",
      },
    })

    expect(result.success).toBe(true)
    expect(store.get("canonical.md")?.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "low",
      expiresAt: "2026-08-01T00:00:00.000Z",
    })
    expect(store.get("supporting.md")).toBeUndefined()
  })

  it("redacts credentials from merged targets and reports the rewrite", async () => {
    const store = openMdStore(dir)
    store.save({
      name: "provider_setup_old",
      description: "old provider setup",
      type: "project",
      body: "Keep the provider endpoint stable.\n",
    })

    const result = await memoryMergeTool({ store }).handler({
      sources: [{ scope: "project", name: "provider_setup_old" }],
      target: {
        type: "project",
        name: "provider_setup",
        description: "provider setup",
        content: "Keep the provider endpoint stable.\napi_key = sk-live-secret-value\n",
      },
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain("credentials redacted")
    expect(store.get("provider_setup.md")?.body).toContain("api_key = [REDACTED]")
    expect(store.get("provider_setup.md")?.body).not.toContain("sk-live-secret-value")
    expect(store.get("provider_setup_old.md")).toBeUndefined()
  })

  it("moves a mis-scoped personal source into global memory", async () => {
    const projectStore = openMdStore(join(dir, "project"))
    const globalStore = openMdStore(join(dir, "global"))
    projectStore.save({
      name: "legacy_reply_style",
      description: "legacy personal preference",
      type: "user",
      body: "Use concise engineering updates.\n",
    })

    const result = await memoryMergeTool({ store: projectStore, globalStore }).handler({
      sources: [{ scope: "project", name: "legacy_reply_style" }],
      target: {
        type: "user",
        name: "reply_style",
        description: "concise engineering response preference",
        content: "Use concise engineering updates.\n",
      },
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain("reply_style.md (global)")
    expect(projectStore.get("legacy_reply_style.md")).toBeUndefined()
    expect(globalStore.get("reply_style.md")?.frontmatter.type).toBe("user")
  })

  it("rejects an unlisted target-name conflict without changing records", async () => {
    const store = openMdStore(dir)
    store.save({ name: "old_fact", description: "old", type: "project", body: "Old fact.\n" })
    store.save({ name: "canonical", description: "keep", type: "project", body: "Existing target.\n" })

    const result = await memoryMergeTool({ store }).handler({
      sources: [{ scope: "project", name: "old_fact" }],
      target: {
        type: "project",
        name: "canonical",
        description: "replacement",
        content: "Replacement target.\n",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("target name conflicts with project:canonical.md")
    expect(result.error).toContain("include that record in sources")
    expect(store.get("old_fact.md")?.body).toBe("Old fact.\n")
    expect(store.get("canonical.md")?.body).toBe("Existing target.\n")
  })

  it("rejects an occupied target filename even when its frontmatter name differs", async () => {
    const store = openMdStore(dir)
    store.save({ name: "source", description: "source", type: "project", body: "Source body.\n" })
    store.save({ name: "hidden_name", description: "manual record", type: "project", body: "Keep me.\n" })
    renameSync(join(dir, "hidden_name.md"), join(dir, "canonical.md"))

    const result = await memoryMergeTool({ store }).handler({
      sources: [{ scope: "project", name: "source" }],
      target: {
        type: "project",
        name: "canonical",
        description: "replacement",
        content: "Replacement target.\n",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("target file conflicts with project:canonical.md")
    expect(store.get("source.md")?.body).toBe("Source body.\n")
    expect(store.get("canonical.md")?.body).toBe("Keep me.\n")
  })

  it("rejects target content duplicated by an unlisted record", async () => {
    const store = openMdStore(dir)
    store.save({ name: "source", description: "source", type: "project", body: "Source body.\n" })
    store.save({ name: "equivalent", description: "existing", type: "project", body: "Canonical body.\n" })

    const result = await memoryMergeTool({ store }).handler({
      sources: [{ scope: "project", name: "source" }],
      target: {
        type: "project",
        name: "merged",
        description: "merged",
        content: " canonical  body. ",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("target content duplicates project:equivalent.md")
    expect(store.get("source.md")).toBeDefined()
    expect(store.get("merged.md")).toBeUndefined()
  })

  it("rolls back the target and already-deleted sources when a later delete fails", async () => {
    const base = openMdStore(dir)
    base.save({ name: "source_a", description: "first", type: "project", body: "First source.\n" })
    base.save({ name: "source_b", description: "second", type: "project", body: "Second source.\n" })
    const sourceA = base.get("source_a.md")!
    const sourceB = base.get("source_b.md")!
    const failingStore: MdMemoryStore = {
      dir: base.dir,
      list: (filter) => base.list(filter),
      get: (filename) => base.get(filename),
      save: (record) => base.save(record),
      restore: (record) => base.restore!(record),
      delete(filename) {
        if (filename === "source_b.md") throw new Error("simulated delete failure")
        return base.delete(filename)
      },
    }

    const result = await memoryMergeTool({ store: failingStore }).handler({
      sources: [
        { scope: "project", name: "source_a" },
        { scope: "project", name: "source_b" },
      ],
      target: {
        type: "project",
        name: "merged",
        description: "merged target",
        content: "First and second source.\n",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("simulated delete failure")
    expect(result.error).toContain("All changes were rolled back")
    expect(base.get("merged.md")).toBeUndefined()
    expect(base.get("source_a.md")).toEqual(sourceA)
    expect(base.get("source_b.md")).toEqual(sourceB)
  })

  it("restores an existing target snapshot when a later source delete fails", async () => {
    const base = openMdStore(dir)
    base.save({
      name: "canonical",
      description: "original target",
      type: "project",
      tags: ["original"],
      source: "original source",
      body: "Original target body.\n",
    })
    base.save({ name: "source_a", description: "first", type: "project", body: "First source.\n" })
    base.save({ name: "source_b", description: "second", type: "project", body: "Second source.\n" })
    const targetSnapshot = base.get("canonical.md")!
    const sourceASnapshot = base.get("source_a.md")!
    const failingStore: MdMemoryStore = {
      dir: base.dir,
      list: (filter) => base.list(filter),
      get: (filename) => base.get(filename),
      save: (record) => base.save(record),
      restore: (record) => base.restore!(record),
      delete(filename) {
        if (filename === "source_b.md") throw new Error("simulated delete failure")
        return base.delete(filename)
      },
    }

    const result = await memoryMergeTool({ store: failingStore }).handler({
      sources: [
        { scope: "project", name: "canonical" },
        { scope: "project", name: "source_a" },
        { scope: "project", name: "source_b" },
      ],
      target: {
        type: "project",
        name: "canonical",
        description: "merged target",
        tags: ["merged"],
        source: "merge",
        content: "Merged target body.\n",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("All changes were rolled back")
    expect(base.get("canonical.md")).toEqual(targetSnapshot)
    expect(base.get("source_a.md")).toEqual(sourceASnapshot)
    expect(base.get("source_b.md")?.body).toBe("Second source.\n")
  })

  it("stops before writing when a source changes after preflight", async () => {
    const base = openMdStore(dir)
    base.save({ name: "source", description: "original", type: "project", body: "Original source.\n" })
    let changed = false
    const racingStore: MdMemoryStore = {
      dir: base.dir,
      list: (filter) => base.list(filter),
      get(filename) {
        if (filename === "source.md" && !changed) {
          changed = true
          base.save({
            name: "source",
            description: "newer update",
            type: "project",
            body: "Newer source content.\n",
          })
        }
        return base.get(filename)
      },
      save: (record) => base.save(record),
      delete: (filename) => base.delete(filename),
      restore: (record) => base.restore!(record),
    }

    const result = await memoryMergeTool({ store: racingStore }).handler({
      sources: [{ scope: "project", name: "source" }],
      target: {
        type: "project",
        name: "merged",
        description: "merged target",
        content: "Merged source.\n",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("source changed during merge: project:source.md")
    expect(base.get("source.md")?.body).toBe("Newer source content.\n")
    expect(base.get("merged.md")).toBeUndefined()
  })

  it("validates merge arguments before requesting execution", async () => {
    const store = openMdStore(dir)
    const registry = new ToolRegistry()
    registry.register(memoryMergeTool({ store }))
    const executor = new ToolExecutor(registry, { allowConfirmWithoutApproval: true })

    const result = await executor.execute("memory_merge", {
      sources: [],
      target: {
        type: "project",
        name: "merged",
        description: "merged target",
        content: "Merged.\n",
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("Invalid arguments")
    expect(store.get("merged.md")).toBeUndefined()
  })
})

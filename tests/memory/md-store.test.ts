import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { chmodSync, mkdirSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, utimesSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { openMdStore } from "../../zapsdk/memory/md-store"

let dir: string
beforeEach(() => {
  dir = join(tmpdir(), `zapcode-md-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("MdMemoryStore.save", () => {
  it("writes a markdown file with frontmatter + body and updates MEMORY.md", () => {
    const store = openMdStore(dir)
    const rec = store.save({ name: "user_role", description: "senior eng", type: "user", body: "the user is...\n" })
    expect(rec.filename).toBe("user_role.md")
    const onDisk = readFileSync(join(dir, "user_role.md"), "utf-8")
    expect(onDisk.startsWith("---\n")).toBe(true)
    expect(onDisk).toContain("name: user_role")
    expect(onDisk).toContain("type: user")
    expect(onDisk).toMatch(/createdAt: \d{4}-\d{2}-\d{2}T/)
    expect(onDisk).toMatch(/updatedAt: \d{4}-\d{2}-\d{2}T/)
    expect(onDisk).toContain("the user is...")
    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    expect(idx).toContain("- [user_role](user_role.md) — senior eng")
  })

  it("upserts: second save with same name overwrites", () => {
    const store = openMdStore(dir)
    const first = store.save({ name: "user_role", description: "v1", type: "user", body: "body1\n" })
    store.save({ name: "user_role", description: "v2", type: "user", body: "body2\n" })
    const all = store.list()
    expect(all.length).toBe(1)
    expect(all[0].body).toBe("body2\n")
    expect(all[0].frontmatter.description).toBe("v2")
    expect(all[0].frontmatter.createdAt).toBe(first.frontmatter.createdAt)
    expect(typeof all[0].frontmatter.updatedAt).toBe("string")
  })

  it("does not refresh updatedAt or rewrite unchanged memories", () => {
    const store = openMdStore(dir)
    const first = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["cache"],
      source: "user feedback",
      body: "same body\n",
    })
    const onDiskBefore = readFileSync(join(dir, "cache_notes.md"), "utf-8")
    const second = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["cache"],
      source: "user feedback",
      body: "same body\n",
    })
    const onDiskAfter = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    expect(second.frontmatter.updatedAt).toBe(first.frontmatter.updatedAt)
    expect(onDiskAfter).toBe(onDiskBefore)
  })

  it("persists canonical lifecycle metadata and preserves or clears it explicitly", () => {
    const store = openMdStore(dir)
    const first = store.save({
      name: "release_window",
      description: "release window",
      type: "project",
      lifecycle: {
        confidence: "medium",
        validFrom: "2026-07-22T08:00:00+08:00",
        expiresAt: "2026-08-01T00:00:00Z",
        supersedes: ["old_release", "OLD_RELEASE"],
      },
      body: "release details\n",
    })
    expect(first.frontmatter.lifecycle).toEqual({
      version: 1,
      confidence: "medium",
      validFrom: "2026-07-22T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      supersedes: ["old_release"],
    })
    const preserved = store.save({
      name: "release_window",
      description: "release window",
      type: "project",
      body: "release details updated\n",
    })
    expect(preserved.frontmatter.lifecycle).toEqual(first.frontmatter.lifecycle)
    const cleared = store.save({
      name: "release_window",
      description: "release window",
      type: "project",
      lifecycle: null,
      body: "release details updated again\n",
    })
    expect(cleared.frontmatter.lifecycle).toBeUndefined()
    expect(readFileSync(join(dir, "release_window.md"), "utf-8")).not.toContain("lifecycle:")
  })

  it("records canonical host provenance and preserves creation lineage across updates", () => {
    const store = openMdStore(dir)
    const first = store.save({
      name: "cache_notes",
      description: "cache notes",
      type: "project",
      provenance: {
        origin: "memory_save",
        sessionId: " session-1\n ",
        toolCallId: "call-1",
        step: 2,
      },
      body: "body v1",
    })
    const firstHash = `sha256:${createHash("sha256").update("body v1\n").digest("hex")}`
    expect(first.frontmatter.provenance).toEqual({
      version: 1,
      created: {
        origin: "memory_save",
        sessionId: "session-1",
        toolCallId: "call-1",
        step: 2,
        contentHash: firstHash,
      },
      updated: {
        origin: "memory_save",
        sessionId: "session-1",
        toolCallId: "call-1",
        step: 2,
        contentHash: firstHash,
      },
    })
    expect(first.body).toBe("body v1\n")

    const before = readFileSync(join(dir, "cache_notes.md"), "utf-8")
    const unchanged = store.save({
      name: "cache_notes",
      description: "cache notes",
      type: "project",
      provenance: { origin: "memory_save", sessionId: "session-retry", toolCallId: "call-retry", step: 3 },
      body: "body v1\n",
    })
    expect(readFileSync(join(dir, "cache_notes.md"), "utf-8")).toBe(before)
    expect(unchanged.frontmatter.provenance?.updated.sessionId).toBe("session-1")

    const updated = store.save({
      name: "cache_notes",
      description: "cache notes v2",
      type: "project",
      provenance: { origin: "memory_merge", sessionId: "session-2", toolCallId: "call-2", step: 4 },
      body: "body v2\n",
    })
    const secondHash = `sha256:${createHash("sha256").update("body v2\n").digest("hex")}`
    expect(updated.frontmatter.provenance?.created).toEqual(first.frontmatter.provenance?.created)
    expect(updated.frontmatter.provenance?.updated).toEqual({
      origin: "memory_merge",
      sessionId: "session-2",
      toolCallId: "call-2",
      step: 4,
      contentHash: secondHash,
    })
  })

  it("hashes oversized host provenance identifiers instead of failing the memory write", () => {
    const store = openMdStore(dir)
    const longSessionId = "session-segment-".repeat(20)

    const saved = store.save({
      name: "long_provenance_id",
      description: "long provenance id",
      type: "project",
      provenance: { origin: "memory_save", sessionId: longSessionId },
      body: "body\n",
    })

    expect(saved.frontmatter.provenance?.updated.sessionId).toBe(
      `sha256:${createHash("sha256").update(longSessionId).digest("hex")}`,
    )
  })

  it("does not invent a creation event when adding provenance to a legacy record", () => {
    const store = openMdStore(dir)
    store.save({
      name: "legacy_record",
      description: "legacy record",
      type: "project",
      body: "legacy body\n",
    })

    const updated = store.save({
      name: "legacy_record",
      description: "updated legacy record",
      type: "project",
      provenance: { origin: "memory_save", sessionId: "session-1" },
      body: "updated body\n",
    })

    expect(updated.frontmatter.provenance?.created).toBeUndefined()
    expect(updated.frontmatter.provenance?.updated).toMatchObject({
      origin: "memory_save",
      sessionId: "session-1",
    })
  })

  it("does not rewrite MEMORY.md when an unchanged save leaves the index identical", () => {
    const store = openMdStore(dir)
    store.save({ name: "cache_notes", description: "cache", type: "project", body: "body\n" })
    const indexPath = join(dir, "MEMORY.md")
    const old = new Date("2000-01-01T00:00:00.000Z")
    utimesSync(indexPath, old, old)
    const beforeMtime = statSync(indexPath).mtimeMs

    store.save({ name: "cache_notes", description: "cache", type: "project", body: "body\n" })

    expect(statSync(indexPath).mtimeMs).toBe(beforeMtime)
    expect(readFileSync(indexPath, "utf-8"))
      .toContain("- [cache_notes](cache_notes.md) — cache")
  })

  it("does not rewrite MEMORY.md when only a memory body changes", () => {
    const store = openMdStore(dir)
    store.save({ name: "cache_notes", description: "cache", type: "project", body: "body v1\n" })
    const indexPath = join(dir, "MEMORY.md")
    const old = new Date("2000-01-01T00:00:00.000Z")
    utimesSync(indexPath, old, old)
    const beforeMtime = statSync(indexPath).mtimeMs

    store.save({ name: "cache_notes", description: "cache", type: "project", body: "body v2\n" })

    expect(store.get("cache_notes.md")?.body).toBe("body v2\n")
    expect(statSync(indexPath).mtimeMs).toBe(beforeMtime)
    expect(readFileSync(indexPath, "utf-8"))
      .toContain("- [cache_notes](cache_notes.md) — cache")
  })

  it("repairs MEMORY.md on unchanged saves without refreshing the memory record", () => {
    const store = openMdStore(dir)
    const first = store.save({ name: "cache_notes", description: "cache", type: "project", body: "body\n" })
    writeFileSync(join(dir, "MEMORY.md"), "")

    const second = store.save({ name: "cache_notes", description: "cache", type: "project", body: "body\n" })

    expect(second.frontmatter.updatedAt).toBe(first.frontmatter.updatedAt)
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8"))
      .toContain("- [cache_notes](cache_notes.md) — cache")
  })

  it("saves optional tags and source metadata", () => {
    const store = openMdStore(dir)
    const rec = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["Cache", "agent", "cache"],
      source: "user feedback",
      body: "cache details\n",
    })
    expect(rec.frontmatter.tags).toEqual(["agent", "cache"])
    expect(rec.frontmatter.source).toBe("user feedback")
    const onDisk = readFileSync(join(dir, "cache_notes.md"), "utf-8")
    expect(onDisk).toContain('tags: ["agent","cache"]')
    expect(onDisk).toContain("source: user feedback")
  })

  it("treats tags as a canonical set so reordering does not rewrite memory", () => {
    const store = openMdStore(dir)
    const first = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["provider", "Cache", "agent"],
      body: "cache details\n",
    })
    const before = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    const second = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["agent", "cache", "provider"],
      body: "cache details\n",
    })
    const after = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    expect(first.frontmatter.tags).toEqual(["agent", "cache", "provider"])
    expect(second.frontmatter.updatedAt).toBe(first.frontmatter.updatedAt)
    expect(after).toBe(before)
  })

  it("treats tag whitespace as canonical so repeated saves stay byte-stable", () => {
    const store = openMdStore(dir)
    const first = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["Cache\nHit", " provider\tcache "],
      body: "cache details\n",
    })
    const before = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    const second = store.save({
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project",
      tags: ["cache hit", "provider cache"],
      body: "cache details\n",
    })
    const after = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    expect(first.frontmatter.tags).toEqual(["cache hit", "provider cache"])
    expect(second.frontmatter.updatedAt).toBe(first.frontmatter.updatedAt)
    expect(after).toBe(before)
    expect(after).toContain('tags: ["cache hit","provider cache"]')
  })

  it("writes memory files and index with owner-only permissions", () => {
    if (process.platform === "win32") return
    chmodSync(dir, 0o777)
    const store = openMdStore(dir)
    store.save({ name: "secret_note", description: "private", type: "project", body: "token-like note\n" })

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, "secret_note.md")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "MEMORY.md")).mode & 0o777).toBe(0o600)
  })

  it("tightens broad permissions when overwriting an existing memory file", () => {
    if (process.platform === "win32") return
    const path = join(dir, "secret_note.md")
    writeFileSync(path, "---\nname: secret_note\ndescription: old\ntype: project\n---\n\nold\n", { mode: 0o666 })
    chmodSync(path, 0o666)

    const store = openMdStore(dir)
    store.save({ name: "secret_note", description: "new", type: "project", body: "new\n" })

    expect(readFileSync(path, "utf-8")).toContain("new")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("canonicalizes multiline description and source metadata", () => {
    const store = openMdStore(dir)
    store.save({
      name: "multi_note",
      description: " first line\n second   line ",
      type: "reference",
      source: " user note\n compact   summary ",
      body: "details\n",
    })

    const rec = store.get("multi_note.md")
    expect(rec?.frontmatter.description).toBe("first line second line")
    expect(rec?.frontmatter.source).toBe("user note compact summary")
    expect(store.list().map((r) => r.frontmatter.description)).toEqual(["first line second line"])
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8"))
      .toContain("- [multi_note](multi_note.md) — first line second line")
  })

  it("treats description and source whitespace as canonical so repeated saves stay byte-stable", () => {
    const store = openMdStore(dir)
    const first = store.save({
      name: "cache_notes",
      description: " cache hit\n investigation ",
      type: "project",
      source: " user\n feedback ",
      body: "same body\n",
    })
    const before = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    const second = store.save({
      name: "cache_notes",
      description: "cache   hit investigation",
      type: "project",
      source: "user feedback",
      body: "same body\n",
    })
    const after = readFileSync(join(dir, "cache_notes.md"), "utf-8")

    expect(second.frontmatter.updatedAt).toBe(first.frontmatter.updatedAt)
    expect(after).toBe(before)
    expect(after).toContain("description: cache hit investigation")
    expect(after).toContain("source: user feedback")
  })

  it("keeps metadata on upsert unless explicitly cleared", () => {
    const store = openMdStore(dir)
    store.save({
      name: "cache_notes",
      description: "v1",
      type: "project",
      tags: ["cache"],
      source: "user feedback",
      body: "body1\n",
    })
    store.save({ name: "cache_notes", description: "v2", type: "project", body: "body2\n" })
    expect(store.get("cache_notes.md")?.frontmatter.tags).toEqual(["cache"])
    expect(store.get("cache_notes.md")?.frontmatter.source).toBe("user feedback")

    store.save({
      name: "cache_notes",
      description: "v3",
      type: "project",
      tags: [],
      source: "",
      body: "body3\n",
    })
    expect(store.get("cache_notes.md")?.frontmatter.tags).toBeUndefined()
    expect(store.get("cache_notes.md")?.frontmatter.source).toBeUndefined()
  })

  it("rejects names with path separators or .. (defense)", () => {
    const store = openMdStore(dir)
    expect(() => store.save({ name: "../escape", description: "x", type: "user", body: "b\n" })).toThrow()
    expect(() => store.save({ name: "a/b", description: "x", type: "user", body: "b\n" })).toThrow()
    expect(() => store.save({ name: "", description: "x", type: "user", body: "b\n" })).toThrow()
    expect(() => store.save({ name: "blank_description", description: " \n\t ", type: "user", body: "b\n" })).toThrow("description required")
  })

  it("releases the write lock when validation fails", () => {
    const store = openMdStore(dir)
    expect(() => store.save({ name: "../escape", description: "x", type: "user", body: "b\n" })).toThrow()
    expect(existsSync(join(dir, ".memory.lock"))).toBe(false)

    store.save({ name: "after_failure", description: "ok", type: "project", body: "body\n" })
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8"))
      .toContain("- [after_failure](after_failure.md) — ok")
  })

  it("refuses to write while another live process owns the memory lock", () => {
    writeFileSync(join(dir, ".memory.lock"), `${process.pid}\n`, { mode: 0o600 })
    const store = openMdStore(dir, { lockTimeoutMs: 5, lockRetryMs: 1, staleLockMs: 60_000 })

    expect(() => store.save({ name: "blocked", description: "x", type: "project", body: "body\n" }))
      .toThrow(/memory store is locked/)
    expect(existsSync(join(dir, "blocked.md"))).toBe(false)
  })

  it("removes abandoned dead-pid locks and proceeds", () => {
    const lockPath = join(dir, ".memory.lock")
    writeFileSync(lockPath, "999999999\n", { mode: 0o600 })

    const store = openMdStore(dir, { lockTimeoutMs: 50, lockRetryMs: 1, staleLockMs: 60_000 })
    store.save({ name: "after_stale", description: "ok", type: "project", body: "body\n" })

    expect(existsSync(lockPath)).toBe(false)
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8"))
      .toContain("- [after_stale](after_stale.md) — ok")
  })

  it("removes old pidless stale locks and proceeds", () => {
    const lockPath = join(dir, ".memory.lock")
    writeFileSync(lockPath, "not-a-pid\n", { mode: 0o600 })
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)

    const store = openMdStore(dir, { lockTimeoutMs: 50, lockRetryMs: 1, staleLockMs: 1 })
    store.save({ name: "after_pidless_stale", description: "ok", type: "project", body: "body\n" })

    expect(existsSync(lockPath)).toBe(false)
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8"))
      .toContain("- [after_pidless_stale](after_pidless_stale.md) — ok")
  })

  it("serializes concurrent cross-process saves so the index keeps every record", async () => {
    const worker = join(dir, "worker-save-memory.ts")
    const storeModule = join(process.cwd(), "zapsdk/memory/md-store.ts")
    writeFileSync(worker, [
      `import { openMdStore } from ${JSON.stringify(storeModule)}`,
      `const dir = process.argv[2]`,
      `const name = process.argv[3]`,
      `openMdStore(dir, { lockTimeoutMs: 10_000, lockRetryMs: 1 }).save({`,
      `  name,`,
      `  description: "concurrent " + name,`,
      `  type: "project",`,
      `  body: "body " + name + "\\n",`,
      `})`,
    ].join("\n"))

    const names = Array.from({ length: 8 }, (_, i) => `parallel_${i}`)
    const exits = await Promise.all(names.map((name) => runBunWorker(worker, dir, name)))
    expect(exits).toEqual(names.map(() => 0))

    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    for (const name of names) {
      expect(idx).toContain(`- [${name}](${name}.md) — concurrent ${name}`)
      expect(existsSync(join(dir, `${name}.md`))).toBe(true)
    }
    expect(existsSync(join(dir, ".memory.lock"))).toBe(false)
  })
})

function runBunWorker(worker: string, dir: string, name: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [worker, dir, name], { stdio: "ignore" })
    child.on("error", reject)
    child.on("exit", (code) => resolve(code))
  })
}

describe("MdMemoryStore.list / get", () => {
  it("list returns all valid records sorted by name", () => {
    const store = openMdStore(dir)
    store.save({ name: "b_thing", description: "x", type: "user", body: "b\n" })
    store.save({ name: "a_thing", description: "y", type: "user", body: "a\n" })
    const names = store.list().map(r => r.frontmatter.name)
    expect(names).toEqual(["a_thing", "b_thing"])
  })

  it("breaks duplicate frontmatter-name ties by filename for stable memory context order", () => {
    writeFileSync(
      join(dir, "z_manual.md"),
      "---\nname: same_name\ndescription: z\ntype: project\n---\n\nz\n",
    )
    writeFileSync(
      join(dir, "a_manual.md"),
      "---\nname: same_name\ndescription: a\ntype: project\n---\n\na\n",
    )
    const store = openMdStore(dir)

    expect(store.list().map(r => r.filename)).toEqual(["a_manual.md", "z_manual.md"])
  })

  it("list filters by type", () => {
    const store = openMdStore(dir)
    store.save({ name: "u1", description: "x", type: "user",     body: "x\n" })
    store.save({ name: "p1", description: "x", type: "project",  body: "x\n" })
    expect(store.list("user").map(r => r.frontmatter.name)).toEqual(["u1"])
    expect(store.list("project").map(r => r.frontmatter.name)).toEqual(["p1"])
  })

  it("list silently skips files without valid frontmatter", () => {
    const store = openMdStore(dir)
    store.save({ name: "good", description: "x", type: "user", body: "x\n" })
    writeFileSync(join(dir, "stray.md"), "no frontmatter here\n")
    writeFileSync(join(dir, "MEMORY.md"), "manually edited index\n")
    const names = store.list().map(r => r.frontmatter.name)
    expect(names).toEqual(["good"])  // MEMORY.md and stray.md not included
  })

  it("preserves indexed invalid records when rewriting MEMORY.md", () => {
    const warnings: Array<{ filename: string; message: string }> = []
    const store = openMdStore(dir, {
      onWarning: (warning) => warnings.push(warning),
    })
    store.save({ name: "good", description: "x", type: "user", body: "x\n" })
    writeFileSync(join(dir, "corrupt.md"), "no frontmatter here\n")
    writeFileSync(
      join(dir, "MEMORY.md"),
      "- [corrupt](corrupt.md) — previous index line\n- [good](good.md) — x\n",
    )

    store.save({ name: "new_note", description: "fresh", type: "project", body: "fresh\n" })

    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    expect(idx).toContain("- [corrupt](corrupt.md) — previous index line")
    expect(idx).toContain("- [new_note](new_note.md) — fresh")
    expect(store.list().map(r => r.frontmatter.name)).toEqual(["good", "new_note"])
    expect(warnings.some(w => w.filename === "corrupt.md" && w.message.includes("invalid frontmatter"))).toBe(true)
  })

  it("preserves unreadable indexed records in existing MEMORY.md order", () => {
    const store = openMdStore(dir)
    store.save({ name: "good", description: "x", type: "user", body: "x\n" })
    writeFileSync(join(dir, "a_corrupt.md"), "no frontmatter a\n")
    writeFileSync(join(dir, "z_corrupt.md"), "no frontmatter z\n")
    writeFileSync(
      join(dir, "MEMORY.md"),
      [
        "- [z_corrupt](z_corrupt.md) — previous z line",
        "- [good](good.md) — x",
        "- [a_corrupt](a_corrupt.md) — previous a line",
        "",
      ].join("\n"),
    )

    store.save({ name: "new_note", description: "fresh", type: "project", body: "fresh\n" })

    const lines = readFileSync(join(dir, "MEMORY.md"), "utf-8").split("\n").filter(Boolean)
    expect(lines).toEqual([
      "- [good](good.md) — x",
      "- [new_note](new_note.md) — fresh",
      "- [z_corrupt](z_corrupt.md) — previous z line",
      "- [a_corrupt](a_corrupt.md) — previous a line",
    ])
  })

  it("keeps MEMORY.md single-line and parseable for manually-authored unsafe display names", () => {
    writeFileSync(join(dir, "manual.md"), [
      "---",
      'name: "manual]note\\nnext"',
      'description: "first line\\n- [evil](evil.md) — injected"',
      "type: project",
      "---",
      "",
      "body\n",
    ].join("\n"))

    const store = openMdStore(dir)
    store.save({ name: "safe_note", description: "safe", type: "project", body: "safe\n" })

    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    expect(idx).toContain("- [manualnote next](manual.md) — first line - \\[evil\\]\\(evil.md\\) — injected")
    expect(idx).toContain("- [safe_note](safe_note.md) — safe")
    expect(idx.split("\n").filter(Boolean)).toHaveLength(2)
  })

  it("escapes fallback labels, descriptions, and destinations for manually-authored unsafe filenames", () => {
    writeFileSync(join(dir, "manual file).md"), [
      "---",
      'name: "[]"',
      'description: "see [evil](evil.md) and (paren)"',
      "type: project",
      "---",
      "",
      "body\n",
    ].join("\n"))

    const store = openMdStore(dir)
    store.save({ name: "safe_note", description: "safe", type: "project", body: "safe\n" })

    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    expect(idx).toContain("- [manual file\\)](manual%20file\\).md) — see \\[evil\\]\\(evil.md\\) and \\(paren\\)")
    expect(idx).toContain("- [safe_note](safe_note.md) — safe")
    expect(idx.split("\n").filter(Boolean)).toHaveLength(2)
  })

  it("preserves indexed unsafe filenames when their memory file becomes unreadable", () => {
    const manualPath = join(dir, "manual file).md")
    writeFileSync(manualPath, [
      "---",
      'name: "[]"',
      'description: "see [evil](evil.md) and (paren)"',
      "type: project",
      "---",
      "",
      "body\n",
    ].join("\n"))

    const store = openMdStore(dir)
    store.save({ name: "safe_note", description: "safe", type: "project", body: "safe\n" })
    writeFileSync(manualPath, "frontmatter temporarily broken\n")

    store.save({ name: "next_note", description: "next", type: "project", body: "next\n" })

    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    expect(idx).toContain("- [manual file\\)](manual%20file\\).md) — see \\[evil\\]\\(evil.md\\) and \\(paren\\)")
    expect(idx).toContain("- [safe_note](safe_note.md) — safe")
    expect(idx).toContain("- [next_note](next_note.md) — next")
  })

  it("get returns the record or undefined", () => {
    const store = openMdStore(dir)
    store.save({ name: "x", description: "d", type: "user", body: "b\n" })
    expect(store.get("x.md")?.frontmatter.name).toBe("x")
    expect(store.get("missing.md")).toBeUndefined()
  })

  it("refuses path traversal and reserved index filenames", () => {
    const store = openMdStore(dir)
    const outside = join(dirname(dir), "outside.md")
    writeFileSync(outside, "---\nname: outside\ndescription: leaked\ntype: user\n---\n\nsecret\n")
    try {
      expect(store.get("../outside.md")).toBeUndefined()
      expect(store.get(outside)).toBeUndefined()
      expect(store.get("MEMORY.md")).toBeUndefined()
      expect(store.get("nested/x.md")).toBeUndefined()
    } finally {
      rmSync(outside, { force: true })
    }
  })
})

describe("MdMemoryStore.delete", () => {
  it("removes the file and updates MEMORY.md", () => {
    const store = openMdStore(dir)
    store.save({ name: "x", description: "d", type: "user", body: "b\n" })
    expect(store.delete("x.md")).toBe(true)
    expect(existsSync(join(dir, "x.md"))).toBe(false)
    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8")
    expect(idx.includes("x.md")).toBe(false)
  })

  it("returns false when the file does not exist", () => {
    const store = openMdStore(dir)
    expect(store.delete("nope.md")).toBe(false)
  })

  it("does not delete files outside the memory directory or MEMORY.md", () => {
    const store = openMdStore(dir)
    store.save({ name: "x", description: "d", type: "user", body: "b\n" })
    const outside = join(dirname(dir), "outside-delete.md")
    writeFileSync(outside, "outside\n")
    try {
      expect(store.delete("../outside-delete.md")).toBe(false)
      expect(existsSync(outside)).toBe(true)
      expect(store.delete("MEMORY.md")).toBe(false)
      expect(existsSync(join(dir, "MEMORY.md"))).toBe(true)
    } finally {
      rmSync(outside, { force: true })
    }
  })
})

describe("MdMemoryStore.restore", () => {
  it("restores an exact record snapshot including timestamps and metadata", () => {
    const store = openMdStore(dir)
    store.save({
      name: "cache_state",
      description: "original state",
      type: "project",
      tags: ["cache", "pinned"],
      source: "original source",
      lifecycle: { confidence: "medium", expiresAt: "2026-08-01T00:00:00.000Z" },
      body: "Original body.\n",
    })
    const snapshot = store.get("cache_state.md")!
    store.save({
      name: "cache_state",
      description: "changed state",
      type: "project",
      tags: ["changed"],
      source: "changed source",
      lifecycle: { confidence: "low", expiresAt: null },
      body: "Changed body.\n",
    })

    store.restore!(snapshot)

    expect(store.get("cache_state.md")).toEqual(snapshot)
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("original state")
  })

  it("preserves malformed lifecycle metadata during rollback restore", () => {
    const store = openMdStore(dir)
    writeFileSync(
      join(dir, "manual.md"),
      "---\nname: manual\ndescription: manual lifecycle\ntype: project\nlifecycle: not-json\n---\n\nbody\n",
    )
    const snapshot = store.get("manual.md")!

    expect(snapshot.frontmatter).toMatchObject({ lifecycleInvalid: true, lifecycleRaw: "not-json" })
    expect(store.delete("manual.md")).toBe(true)
    store.restore!(snapshot)

    expect(store.get("manual.md")?.frontmatter).toMatchObject({
      lifecycleInvalid: true,
      lifecycleRaw: "not-json",
    })
    expect(readFileSync(join(dir, "manual.md"), "utf-8")).toContain("lifecycle: not-json")
  })
})

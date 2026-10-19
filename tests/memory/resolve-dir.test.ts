import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { getAppDataDir } from "../../zapsdk/utils/platform"
import { AutoMemory } from "../../zapsdk/memory/auto-memory"
import { openMdStore } from "../../zapsdk/memory/md-store"

// Regression: resolveMemoryDir used to do `cwd.replace(/\//g, "-")`, which left
// Windows paths (C:\Users\foo) untouched — the drive-letter colon survived into
// a mid-path segment and produced an illegal dir → ENOENT. It must match
// src/session.ts:sanitizePath, flattening `\`, `/`, and `:` alike.
describe("AutoMemory directory resolution", () => {
  let dataDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    prevDataDir = process.env.ZAPCODE_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), "zapcode-memory-dir-"))
    process.env.ZAPCODE_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = prevDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  const projects = () => join(getAppDataDir(), "projects")

  it("flattens Windows drive-letter colon and backslashes", () => {
    const mem = new AutoMemory("C:\\Users\\foo\\workspace").memoryDir
    expect(mem).toBe(join(projects(), "C--Users-foo-workspace", "memory"))
    // the cwd-derived segment must not reintroduce a drive colon mid-path
    const segment = mem.slice(projects().length + 1)
    expect(segment).not.toContain(":")
  })

  it("flattens POSIX separators", () => {
    const mem = new AutoMemory("/Users/foo/workspace").memoryDir
    expect(mem).toBe(join(projects(), "-Users-foo-workspace", "memory"))
  })

  it("matches src/session.ts sanitizePath rule for mixed separators", () => {
    const cwd = "C:\\a/b:c"
    const mem = new AutoMemory(cwd).memoryDir
    expect(mem).toBe(join(projects(), cwd.replace(/[\\/:]/g, "-"), "memory"))
  })

  it("uses the same git-backed memory dir from repo root and subdirectories", () => {
    const repo = mkdtempSync(join(tmpdir(), "zapcode-git-memory-"))
    try {
      git(repo, "init")
      git(repo, "remote", "add", "origin", "git@github.com:Acme/ZapCode.git")
      const subdir = join(repo, "packages", "app")
      mkdirSync(subdir, { recursive: true })

      const rootMem = new AutoMemory(repo).memoryDir
      const subdirMem = new AutoMemory(subdir).memoryDir

      expect(subdirMem).toBe(rootMem)
      expect(rootMem).toContain(join(projects(), "git-zapcode-"))
      expect(rootMem.endsWith(join("memory"))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("copies existing legacy cwd memory into a new git-backed directory on ensure", async () => {
    const repo = mkdtempSync(join(tmpdir(), "zapcode-git-memory-"))
    try {
      git(repo, "init")
      git(repo, "remote", "add", "origin", "https://github.com/acme/zapcode.git")

      const legacyDir = join(projects(), repo.replace(/[\\/:]/g, "-"), "memory")
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, "MEMORY.md"), "- [old](old.md) — legacy memory\n")
      writeFileSync(join(legacyDir, "old.md"), "---\nname: old\ndescription: legacy memory\ntype: project\n---\n\nbody\n")

      const mem = new AutoMemory(repo)
      const memoryDir = mem.memoryDir

      expect(memoryDir).not.toBe(legacyDir)
      expect(existsSync(join(memoryDir, "old.md"))).toBe(false)

      await mem.ensure()

      expect(existsSync(join(memoryDir, "old.md"))).toBe(true)
      expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf-8")).toContain("legacy memory")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("can migrate legacy memory synchronously before the markdown store opens", () => {
    const repo = mkdtempSync(join(tmpdir(), "zapcode-git-memory-"))
    try {
      git(repo, "init")
      git(repo, "remote", "add", "origin", "https://github.com/acme/zapcode.git")

      const legacyDir = join(projects(), repo.replace(/[\\/:]/g, "-"), "memory")
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, "MEMORY.md"), "- [old](old.md) — legacy memory\n")
      writeFileSync(join(legacyDir, "old.md"), "---\nname: old\ndescription: legacy memory\ntype: project\n---\n\nbody\n")

      const mem = new AutoMemory(repo)
      mem.ensureSync()
      openMdStore(mem.memoryDir).save({
        name: "new_after_store_open",
        description: "new memory after singleton store opened",
        type: "project",
        body: "new body\n",
      })

      expect(existsSync(join(mem.memoryDir, "old.md"))).toBe(true)
      expect(existsSync(join(mem.memoryDir, "new_after_store_open.md"))).toBe(true)
      expect(readFileSync(join(mem.memoryDir, "MEMORY.md"), "utf-8")).toContain("legacy memory")
      expect(readFileSync(join(mem.memoryDir, "MEMORY.md"), "utf-8")).toContain("new memory after singleton store opened")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("does not migrate legacy memory lock or temp files into git-backed memory", async () => {
    const repo = mkdtempSync(join(tmpdir(), "zapcode-git-memory-"))
    try {
      git(repo, "init")
      git(repo, "remote", "add", "origin", "https://github.com/acme/zapcode.git")

      const legacyDir = join(projects(), repo.replace(/[\\/:]/g, "-"), "memory")
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, "MEMORY.md"), "- [old](old.md) — legacy memory\n")
      writeFileSync(join(legacyDir, "old.md"), "---\nname: old\ndescription: legacy memory\ntype: project\n---\n\nbody\n")
      writeFileSync(join(legacyDir, ".memory.lock"), `${process.pid}\n`)
      writeFileSync(join(legacyDir, ".old.md.abcd1234.tmp"), "partial write\n")

      const mem = new AutoMemory(repo)
      await mem.ensure()

      expect(existsSync(join(mem.memoryDir, "old.md"))).toBe(true)
      expect(existsSync(join(mem.memoryDir, ".memory.lock"))).toBe(false)
      expect(existsSync(join(mem.memoryDir, ".old.md.abcd1234.tmp"))).toBe(false)

      openMdStore(mem.memoryDir, { lockTimeoutMs: 5, lockRetryMs: 1 }).save({
        name: "after_migration",
        description: "write still works",
        type: "project",
        body: "body\n",
      })
      expect(existsSync(join(mem.memoryDir, "after_migration.md"))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] })
}

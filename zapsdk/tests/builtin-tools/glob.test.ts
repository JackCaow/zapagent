import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { globFilesTool } from "../../builtin-tools/glob.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("glob_files defaultCwd", () => {
  let projectDir: string
  let otherDir: string

  beforeEach(() => {
    projectDir = makeTmpDir()
    otherDir = makeTmpDir()
  })

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
    try { rmSync(otherDir, { recursive: true, force: true }) } catch {}
  })

  it("resolves relative search directories against defaultCwd", async () => {
    mkdirSync(join(projectDir, "src"), { recursive: true })
    mkdirSync(join(otherDir, "src"), { recursive: true })
    writeFileSync(join(projectDir, "src", "project.ts"), "")
    writeFileSync(join(otherDir, "src", "other.ts"), "")
    const tool = globFilesTool({ defaultCwd: projectDir })

    const result = await tool.handler({ path: "src", pattern: "*.ts" })

    expect(result.success).toBe(true)
    expect(result.output).toContain("project.ts")
    expect(result.output).not.toContain("other.ts")
  })

  it("stops traversal after the configured entry budget even with no matches", async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(projectDir, `file-${i}.txt`), "")
    const tool = globFilesTool({ defaultCwd: projectDir, maxVisitedEntries: 2 })

    const result = await tool.handler({ path: ".", pattern: "*.never" })

    expect(result.success).toBe(false)
    expect(result.error).toContain("traversal limit exceeded")
  })

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = globFilesTool({ defaultCwd: projectDir })

    const result = await tool.handler({ path: ".", pattern: "*" }, controller.signal)

    expect(result.success).toBe(false)
    expect(result.error).toBe("aborted")
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createBuiltinRegistry } from "../../builtin-tools/index.js"
import { ToolExecutor } from "../../tools/executor.js"

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-registry-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("createBuiltinRegistry defaultCwd forwarding", () => {
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

  it("forwards executeCommand.defaultCwd to common filesystem discovery/edit tools", async () => {
    mkdirSync(join(projectDir, "src"), { recursive: true })
    mkdirSync(join(otherDir, "src"), { recursive: true })
    writeFileSync(join(projectDir, "src", "target.ts"), "const marker = 'project'\n")
    writeFileSync(join(otherDir, "src", "target.ts"), "const marker = 'wrong'\n")
    const registry = createBuiltinRegistry({
      executeCommand: { defaultCwd: projectDir },
      exclude: ["bash"],
    })

    const search = await registry.get("search_files")!.handler({
      pattern: "project",
      path: "src",
      context_lines: 0,
    })
    expect(search.success).toBe(true)
    expect(search.output).toContain("target.ts")
    expect(search.output).not.toContain("wrong")

    const glob = await registry.get("glob_files")!.handler({
      pattern: "*.ts",
      path: "src",
    })
    expect(glob.success).toBe(true)
    expect(glob.output).toContain("target.ts")

    const tree = await registry.get("list_tree")!.handler({ path: "src" })
    expect(tree.success).toBe(true)
    expect(tree.output).toContain("target.ts")

    const edit = await registry.get("edit_file")!.handler({
      path: "src/target.ts",
      old_string: "'project'",
      new_string: "'edited'",
    })
    expect(edit.success).toBe(true)
    expect(readFileSync(join(projectDir, "src", "target.ts"), "utf-8")).toContain("'edited'")
    expect(readFileSync(join(otherDir, "src", "target.ts"), "utf-8")).toContain("'wrong'")
  })

  it("requires approval for path read tools by default", async () => {
    const registry = createBuiltinRegistry({
      executeCommand: { defaultCwd: projectDir },
      exclude: ["bash"],
    })

    expect(registry.get("read_file")!.definition.permission).toBe("confirm")
    expect(registry.get("list_tree")!.definition.permission).toBe("confirm")
    expect(registry.get("search_files")!.definition.permission).toBe("confirm")
    expect(registry.get("glob_files")!.definition.permission).toBe("confirm")
    expect(registry.get("read_document")!.definition.permission).toBe("confirm")
    expect(registry.get("read_pdf")).toBeUndefined()
    expect(registry.get("read_docx")).toBeUndefined()

    const executor = new ToolExecutor(registry)
    const result = await executor.execute("read_file", { path: "." })
    expect(result.success).toBe(false)
    expect(result.error).toContain("requires approval")
  })

  it("declares write paths against executeCommand.defaultCwd for checkpoint tracking", async () => {
    const registry = createBuiltinRegistry({
      executeCommand: { defaultCwd: projectDir },
      exclude: ["bash"],
    })

    expect(registry.get("write_file")!.definition.writesPath?.({ path: "src/a.ts" })).toEqual([
      join(projectDir, "src", "a.ts"),
    ])
    expect(registry.get("append_file")).toBeUndefined()
    expect(registry.get("list_directory")).toBeUndefined()
    expect(registry.get("delete_file")!.definition.writesPath?.({ path: "src/a.ts" })).toEqual([
      join(projectDir, "src", "a.ts"),
    ])
    expect(registry.get("edit_file")!.definition.writesPath?.({ path: "src/a.ts" })).toEqual([
      join(projectDir, "src", "a.ts"),
    ])
    expect(registry.get("multi_edit")!.definition.writesPath?.({ path: "src/a.ts" })).toEqual([
      join(projectDir, "src", "a.ts"),
    ])
    expect(registry.get("move_file")!.definition.writesPath?.({
      source: "src/a.ts",
      destination: "src/b.ts",
    })).toEqual([
      join(projectDir, "src", "a.ts"),
      join(projectDir, "src", "b.ts"),
    ])
  })

  it("passes defaultCwd-resolved write paths to executor onTrackEdit", async () => {
    const registry = createBuiltinRegistry({
      executeCommand: { defaultCwd: projectDir },
      exclude: ["bash"],
    })
    const tracked: string[][] = []
    const executor = new ToolExecutor(registry, {
      onApproval: async () => true,
      onTrackEdit: async (paths) => {
        tracked.push(paths)
      },
    })

    const result = await executor.execute("write_file", {
      path: "src/generated.txt",
      content: "from project\n",
    })

    expect(result.success).toBe(true)
    // Native undo follows the exact lexical target; canonical effect scopes
    // remain available to permissions without backing a symlink's referent.
    expect(tracked).toEqual([[join(projectDir, "src", "generated.txt")]])
    expect(readFileSync(join(projectDir, "src", "generated.txt"), "utf-8")).toBe("from project\n")
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildToolGrantRules } from "../src/tool-grants.js"
import { getProjectSettingsPath, patternCovers, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { matchGlob } from "../zapsdk/builtin-tools/glob-util.js"

let root: string, cwd: string, previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-resource-grant-review-")); cwd = join(root, "project"); mkdirSync(cwd)
  previous = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = join(root, "data")
})
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

describe("project-relative file authorization", () => {
  it("only annotates authorization coverage supported by the actual file matcher", () => {
    expect(patternCovers("Write(**)", "write_file")).toBe(false)
    expect(patternCovers("Write(**)", `Write(${join(root, "outside.txt")})`)).toBe(false)
    expect(patternCovers("Write(**)", "Write(src/**)")).toBe(true)
    expect(patternCovers("Write(*)", "Write(src/note.txt)")).toBe(false)
    expect(patternCovers("Write(src/**)", "Write(src)")).toBe(false)
    expect(patternCovers("Write", "write_file")).toBe(true)
    expect(patternCovers("Read(**)", "read_tool_output")).toBe(true)
  })
  for (const name of ["read_file", "write_file", "multi_edit", "read_document", "delete_file"]) {
    it(`${name}(**) cannot grant paths outside the project`, () => {
      const manager = new PermissionManager(cwd)
      const rules = buildToolGrantRules({ tools: [name], resource: { kind: "pattern", value: "**" }, lifetime: "session" }, [name])
      manager.addToolRules(rules, "session")
      for (const path of [join(root, "outside.txt"), "../outside.txt"]) {
        expect(manager.checkPermission(name, { path }).decision).toBe("ask")
        expect(manager.grantCoversCall(rules, name, { path })).toBe(false)
      }
      expect(manager.checkPermission(name, { path: "src/inside.txt" }).decision).toBe("allow")
      manager.addToolRules([{ pattern: name, type: "allow" }], "session")
      expect(manager.checkPermission(name, { path: join(root, "outside.txt") }).decision).toBe("allow")
    })
  }
  it("a project directory link does not turn a relative wildcard into an outside grant", () => {
    mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(cwd, "linked"))
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "write_file(**)", type: "allow" }], "session")
    expect(manager.checkPermission("write_file", { path: "linked/new.txt" }).decision).toBe("ask")
  })
  it("canonical and lexical restrictions both apply to a leaf entry behind a directory link", () => {
    mkdirSync(join(cwd, "entries")); mkdirSync(join(cwd, "targets"))
    writeFileSync(join(cwd, "targets", "data.txt"), "fixture")
    symlinkSync("targets/data.txt", join(cwd, "leaf"))
    symlinkSync("..", join(cwd, "entries", "up"))
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "delete_file(leaf)", type: "deny" }] })
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "delete_file", type: "allow" }], "session")
    expect(manager.checkPermission("delete_file", { path: "entries/up/leaf" }).decision).toBe("deny")
  })
  it("glob syntax cannot inject regex alternation into an allowed path", () => {
    const manager = new PermissionManager(cwd)
    manager.addToolRules([{ pattern: "write_file(src|private/**)", type: "allow" }], "session")
    expect(manager.checkPermission("write_file", { path: "private/note.txt" }).decision).toBe("ask")
    expect(manager.checkPermission("write_file", { path: "src|private/note.txt" }).decision).toBe("allow")
  })
})

describe("file globs treat regex punctuation as literal filename characters", () => {
  for (const value of ["a+b.txt", "[draft].txt", "name$.txt", "a(b).txt", "a|b.txt"]) {
    it(value, () => {
      expect(matchGlob(`src/${value}`, `src/${value}`)).toBe(true)
      expect(matchGlob("src/unrelated.txt", `src/${value}`)).toBe(false)
    })
  }
  it("preserves supported wildcard and brace alternatives", () => {
    expect(matchGlob("src/deep/a.ts", "src/**/*.{ts,tsx}")).toBe(true)
    expect(matchGlob("src/a.tsx", "src/**/*.{ts,tsx}")).toBe(true)
    expect(matchGlob("src/a.js", "src/**/*.{ts,tsx}")).toBe(false)
  })
})

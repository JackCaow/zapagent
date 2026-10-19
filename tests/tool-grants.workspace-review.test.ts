import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateApprovalPolicy, type ApprovalPolicyDecision } from "../src/permission-policy.js"
import { getProjectSettingsPath, inferInvocationRules, PermissionManager, savePermissionSettings } from "../src/permissions.js"
import { FILE_GRANT_TOOLS } from "../src/tool-grants.js"
import { createBuiltinRegistry, deleteFileTool, readFileTool, subagentTool, writeFileTool } from "../zapsdk/builtin-tools/index.js"
import { matchGlob } from "../zapsdk/builtin-tools/glob-util.js"
import type { LLMProvider } from "../zapsdk/core/llm.js"
import { ToolExecutor } from "../zapsdk/tools/executor.js"
import { ToolRegistry } from "../zapsdk/tools/registry.js"
import { WorkspaceManager } from "../zapsdk/workspace/manager.js"

let fixture: string, cwd: string, previousDataDir: string | undefined
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "zap-grant-workspace-review-"))
  cwd = join(fixture, "project")
  mkdirSync(cwd)
  // Broker depth accounting compares against the workspace root; macOS temp
  // paths have /var and /private/var aliases, while tool effects are canonical.
  cwd = realpathSync(cwd)
  previousDataDir = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(fixture, "data")
})
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previousDataDir
  rmSync(fixture, { recursive: true, force: true })
})

describe("file grants retain restrictions across real path aliases", () => {
  for (const type of ["deny", "ask"] as const) {
    for (const subject of ["lexical", "canonical"] as const) {
      it(`${subject} ${type} wins over a grant when a real executor writes through a project symlink`, async () => {
        mkdirSync(join(cwd, "src"))
        mkdirSync(join(cwd, "private"))
        writeFileSync(join(cwd, "private", "note.txt"), "original")
        symlinkSync("../private", join(cwd, "src", "linked"))
        const restriction = subject === "lexical" ? "src/linked/**" : "private/**"
        const grant = subject === "lexical" ? "private/**" : "src/**"
        savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: `write_file(${restriction})`, type }] })
        const permissions = new PermissionManager(cwd)
        permissions.addToolRules([{ pattern: `write_file(${grant})`, type: "allow" }], "session")
        const registry = new ToolRegistry()
        registry.register(writeFileTool({ defaultCwd: cwd, allowedPaths: [cwd] }))
        const decisions: ApprovalPolicyDecision[] = []
        const executor = new ToolExecutor(registry, { cwd, onApproval: async (name, args, _signal, context) => {
          const decision = evaluateApprovalPolicy(permissions, name, args, { mode: "default", cwd, context })
          decisions.push(decision)
          return decision.decision === "allow"
        } })
        const result = await executor.execute("write_file", { path: "src/linked/note.txt", content: "unauthorized" })
        expect(decisions.map(decision => decision.decision)).toEqual([type])
        expect(result.success).toBe(false)
        expect(readFileSync(join(cwd, "private", "note.txt"), "utf8")).toBe("original")
      })
    }
  }
})

describe("read_file cannot expand an authorized spelling into a restricted file", () => {
  for (const type of ["deny", "ask"] as const) {
    for (const path of ["secret.txt", "**/secret.txt"]) {
      it(`${type} protects the actual target of an auto-resolved ${path}`, async () => {
        mkdirSync(join(cwd, "private"))
        writeFileSync(join(cwd, "private", "secret.txt"), "RESTRICTED_CONTENT_MUST_NOT_BE_READ")
        savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Read(private/**)", type }] })
        const permissions = new PermissionManager(cwd)
        const registry = new ToolRegistry()
        registry.register(readFileTool({ defaultCwd: cwd, allowedPaths: [cwd] }))
        const executor = new ToolExecutor(registry, { cwd, onApproval: async (name, args, _signal, context) =>
          evaluateApprovalPolicy(permissions, name, args, { mode: "default", cwd, context }).decision === "allow",
        })
        const result = await executor.execute("read_file", { path })
        expect(result.success).toBe(false)
        expect(result.output).not.toContain("RESTRICTED_CONTENT_MUST_NOT_BE_READ")
      })
    }
  }
})

describe("leaf symlink mutations need authority over the directory entry", () => {
  for (const name of ["delete_file", "write_file"] as const) {
    for (const includeEntry of [false, true]) {
      it(`${name} ${includeEntry ? "allows" : "requires"} entry authorization in addition to the symlink target`, async () => {
        mkdirSync(join(cwd, "src"))
        mkdirSync(join(cwd, "private"))
        writeFileSync(join(cwd, "private", "note.txt"), "target-original")
        const entry = join(cwd, "src", "link.txt")
        symlinkSync("../private/note.txt", entry)
        const permissions = new PermissionManager(cwd)
        permissions.addToolRules([
          { pattern: `${name}(private/**)`, type: "allow" },
          ...(includeEntry ? [{ pattern: `${name}(src/**)`, type: "allow" as const }] : []),
        ], "session")
        const registry = new ToolRegistry()
        registry.register(name === "delete_file"
          ? deleteFileTool({ defaultCwd: cwd, allowedPaths: [cwd] })
          : writeFileTool({ defaultCwd: cwd, allowedPaths: [cwd] }))
        const decisions: ApprovalPolicyDecision[] = []
        const executor = new ToolExecutor(registry, { cwd, onApproval: async (tool, args, _signal, context) => {
          const decision = evaluateApprovalPolicy(permissions, tool, args, { mode: "default", cwd, context })
          decisions.push(decision)
          return decision.decision === "allow"
        } })
        const result = await executor.execute(name, { path: "src/link.txt", ...(name === "write_file" ? { content: "new-entry" } : {}) })
        expect(decisions.map(decision => decision.decision)).toEqual([includeEntry ? "allow" : "ask"])
        expect(result.success).toBe(includeEntry)
        expect(readFileSync(join(cwd, "private", "note.txt"), "utf8")).toBe("target-original")
        if (!includeEntry) expect(lstatSync(entry).isSymbolicLink()).toBe(true)
        else if (name === "write_file") {
          expect(lstatSync(entry).isSymbolicLink()).toBe(false)
          expect(readFileSync(entry, "utf8")).toBe("new-entry")
        } else expect(() => lstatSync(entry)).toThrow()
      })
    }
  }
})

describe("isolated SDK children use their parent's logical project scopes", () => {
  for (const pathStyle of ["relative", "absolute"] as const) {
    for (const scenario of ["deny", "ask", "allow"] as const) {
      it(`${scenario} applies to a ${pathStyle} path in a real isolated child workspace`, async () => {
        const folder = scenario === "allow" ? "src" : "private"
        mkdirSync(join(cwd, folder))
        writeFileSync(join(cwd, folder, "note.txt"), "parent-original")
        if (scenario !== "allow") savePermissionSettings(getProjectSettingsPath(cwd), {
          rules: [{ pattern: `write_file(${folder}/**)`, type: scenario }],
        })
        const permissions = new PermissionManager(cwd)
        permissions.setSessionId("root-session")
        if (scenario === "allow") permissions.addToolRules([{ pattern: "write_file(src/**)", type: "allow" }], "session")
        const workspaceManager = new WorkspaceManager({ root: cwd })
        const registryFor = (root: string) => createBuiltinRegistry({
          writeFile: { defaultCwd: root, allowedPaths: [root] },
          executeCommand: { defaultCwd: root, disableBackgroundTasks: true },
        })
        let privateRoot = "", calls = 0
        const decisions: ApprovalPolicyDecision[] = []
        const provider: LLMProvider = { async call() {
          calls++
          if (calls === 1) return {
            type: "tool_call", text: "", toolCalls: [{ id: `write-${scenario}-${pathStyle}`, name: "write_file", arguments: {
              path: pathStyle === "absolute" ? join(privateRoot, folder, "note.txt") : `${folder}/note.txt`, content: "child-changed",
            } }], usage: { inputTokens: 1, outputTokens: 1 },
          }
          return { type: "text", text: "Finished fixture inspection.", usage: { inputTokens: 1, outputTokens: 1 } }
        } }
        const child = subagentTool({ provider, registry: registryFor(cwd), workspaceManager,
          createRegistryForCwd: root => { privateRoot = root; return registryFor(root) },
          requireWriteIsolation: true, storageProjectCwd: cwd, maxSteps: 3,
          onApproval: async (name, args, _signal, context) => {
            expect(context?.workspaceRoot).toBe(privateRoot)
            expect(realpathSync(privateRoot)).not.toBe(realpathSync(cwd))
            const decision = evaluateApprovalPolicy(permissions, name, args, {
              mode: scenario === "allow" ? "default" : "acceptEdits", cwd, context,
            })
            decisions.push(decision)
            return decision.decision === "allow"
          },
        })
        try {
          await child.handler({ task: "Update the fixture only if authorized.", agent_type: "general" })
          expect(decisions.map(decision => decision.decision)).toEqual([scenario])
          expect(readFileSync(join(privateRoot, folder, "note.txt"), "utf8")).toBe(scenario === "allow" ? "child-changed" : "parent-original")
          expect(readFileSync(join(cwd, folder, "note.txt"), "utf8")).toBe("parent-original")
        } finally { await workspaceManager.cleanup() }
      })
    }
  }
})

it("registered file tools infer rules that cover and authorize their original invocation", () => {
  const registry = createBuiltinRegistry()
  const permissions = new PermissionManager(cwd)
  permissions.setSessionId("file-roundtrip")
  const tools = registry.definitions().filter(tool => FILE_GRANT_TOOLS.includes(tool.name)).map(tool => tool.name)
  expect(tools).toContain("read_document")
  expect(tools).toContain("multi_edit")
  for (const name of tools) {
    const args = name === "move_file"
      ? { source: join(cwd, "docs", "source.txt"), destination: join(cwd, "docs", "destination.txt") }
      : { path: join(cwd, "docs", name === "read_document" ? "guide.pdf" : "note.txt") }
    const rules = inferInvocationRules(name, args, cwd)
    expect(rules.length).toBeGreaterThan(0)
    expect(permissions.grantCoversCall(rules, name, args)).toBe(true)
    permissions.addToolRules(rules, "session")
    expect(permissions.checkPermission(name, args).decision).toBe("allow")
  }
})

describe("recursive directory reads cannot cross descendant restrictions", () => {
  for (const name of ["search_files", "glob_files", "list_tree"] as const) {
    for (const type of ["deny", "ask"] as const) {
      for (const path of [".", "src"]) {
        it(`${name} respects ${type} for private descendants when scanning ${path}`, async () => {
          mkdirSync(join(cwd, "private"))
          mkdirSync(join(cwd, "src"))
          writeFileSync(join(cwd, "private", "secret.txt"), "fixture-marker RESTRICTED_BODY")
          writeFileSync(join(cwd, "src", "visible.txt"), "fixture-marker PUBLIC_BODY")
          savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: `${name}(private/**)`, type }] })
          const permissions = new PermissionManager(cwd)
          permissions.addToolRules([{ pattern: name, type: "allow" }], "session")
          const registry = createBuiltinRegistry({
            searchFiles: { defaultCwd: cwd, allowedPaths: [cwd] },
            globFiles: { defaultCwd: cwd, allowedPaths: [cwd] },
            listTree: { defaultCwd: cwd, allowedPaths: [cwd] },
          })
          const decisions: ApprovalPolicyDecision[] = []
          const executor = new ToolExecutor(registry, { cwd, onApproval: async (tool, args, _signal, context) => {
            const decision = evaluateApprovalPolicy(permissions, tool, args, { mode: "default", cwd, context })
            decisions.push(decision)
            return decision.decision === "allow"
          } })
          const args = name === "search_files" ? { path, pattern: "fixture-marker", context_lines: 0 }
            : name === "glob_files" ? { path, pattern: "**/*.txt" } : { path, depth: 3 }
          const result = await executor.execute(name, args)
          expect(decisions.map(decision => decision.decision)).toEqual([path === "." ? type : "allow"])
          expect(result.success).toBe(path === "src")
          expect(result.output).not.toContain("RESTRICTED_BODY")
          expect(result.output).not.toContain("secret.txt")
          if (path === "src") expect(result.output).toContain("visible.txt")
        })
      }
    }
  }
})

it("a src/** authorization cannot write a sibling directory with the same prefix", async () => {
  mkdirSync(join(cwd, "src"))
  mkdirSync(join(cwd, "src-private"))
  const permissions = new PermissionManager(cwd)
  const rules = [{ pattern: "write_file(src/**)", type: "allow" as const }]
  permissions.addToolRules(rules, "session")
  expect(permissions.grantCoversCall(rules, "write_file", { path: "src-private/note.txt" })).toBe(false)
  const registry = new ToolRegistry()
  registry.register(writeFileTool({ defaultCwd: cwd, allowedPaths: [cwd] }))
  const executor = new ToolExecutor(registry, { cwd, onApproval: async (name, args, _signal, context) =>
    evaluateApprovalPolicy(permissions, name, args, { mode: "default", cwd, context }).decision === "allow",
  })
  expect((await executor.execute("write_file", { path: "src/note.txt", content: "authorized" })).success).toBe(true)
  expect((await executor.execute("write_file", { path: "src-private/note.txt", content: "unauthorized" })).success).toBe(false)
  expect(() => lstatSync(join(cwd, "src-private", "note.txt"))).toThrow()
})

it("double-star globs preserve directory boundaries and match zero intermediate directories", () => {
  expect(matchGlob("src-private/note.txt", "src/**")).toBe(false)
  expect(matchGlob("a/bx/note.txt", "a/b/**")).toBe(false)
  expect(matchGlob("src/note.txt", "src/**")).toBe(true)
  expect(matchGlob("src/nested/note.txt", "src/**")).toBe(true)
  expect(matchGlob("a/note.txt", "a/**/note.txt")).toBe(true)
  expect(matchGlob("a/nested/note.txt", "a/**/note.txt")).toBe(true)
  expect(matchGlob("note.txt", "**/note.txt")).toBe(true)
})

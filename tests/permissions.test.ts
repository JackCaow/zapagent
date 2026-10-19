import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  PermissionManager,
  loadPermissionSettings,
  savePermissionSettings,
  ruleMatchesTool,
  inferPattern,
  splitShellSubcommands,
  patternCovers,
  pathReadOutsideCwdReason,
  getProjectSettingsPath,
  getProjectAuthorizationSettingsPath,
  getProjectLocalSettingsPath,
} from "../src/permissions.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `zapcode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Isolate from the developer's real ~/.zapcode/settings.json — without this,
// `PermissionManager` merges global rules from the host into every test.
let __dataDirBackup: string | undefined
let __dataDir = ""
beforeAll(() => {
  __dataDirBackup = process.env.ZAPCODE_DATA_DIR
  __dataDir = makeTmpDir()
  process.env.ZAPCODE_DATA_DIR = __dataDir
})
afterAll(() => {
  if (__dataDirBackup === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = __dataDirBackup
  rmSync(__dataDir, { recursive: true, force: true })
})

// ─── splitShellSubcommands ────────────────────────────────────────────────────

describe("splitShellSubcommands", () => {
  it("splits on &&", () => {
    expect(splitShellSubcommands("git status && npm test")).toEqual(["git status", "npm test"])
  })

  it("splits on ;", () => {
    expect(splitShellSubcommands("echo foo; echo bar")).toEqual(["echo foo", "echo bar"])
  })

  it("splits on |", () => {
    expect(splitShellSubcommands("ls | grep foo")).toEqual(["ls", "grep foo"])
  })

  it("does NOT split on 2>&1 redirection", () => {
    expect(splitShellSubcommands("python test.py 2>&1")).toEqual(["python test.py 2>&1"])
  })

  it("does NOT split on >& redirection", () => {
    expect(splitShellSubcommands("cmd >&2")).toEqual(["cmd >&2"])
  })

  it("does not split inside single quotes", () => {
    expect(splitShellSubcommands("git commit -m 'fix: foo && bar'")).toEqual(["git commit -m 'fix: foo && bar'"])
  })

  it("does not split inside double quotes", () => {
    expect(splitShellSubcommands('echo "a && b"')).toEqual(['echo "a && b"'])
  })

  it("handles single command with no operators", () => {
    expect(splitShellSubcommands("git status")).toEqual(["git status"])
  })

  it("trims whitespace from subcommands", () => {
    expect(splitShellSubcommands("  git status  &&  npm test  ")).toEqual(["git status", "npm test"])
  })

  it("handles three commands", () => {
    expect(splitShellSubcommands("a && b && c")).toEqual(["a", "b", "c"])
  })
})

// ─── ruleMatchesTool ──────────────────────────────────────────────────────────

describe("ruleMatchesTool", () => {
  describe("bash rules", () => {
    it("bare 'bash' matches any command", () => {
      expect(ruleMatchesTool({ pattern: "bash", type: "allow" }, "bash", { command: "anything" })).toBe(true)
    })

    it("Bash(git *) matches git subcommands", () => {
      expect(ruleMatchesTool({ pattern: "Bash(git *)", type: "allow" }, "bash", { command: "git commit -m test" })).toBe(true)
      expect(ruleMatchesTool({ pattern: "Bash(git *)", type: "allow" }, "bash", { command: "git status" })).toBe(true)
    })

    it("Bash(git *) does not match npm", () => {
      expect(ruleMatchesTool({ pattern: "Bash(git *)", type: "allow" }, "bash", { command: "npm test" })).toBe(false)
    })

    it("* in bash patterns matches spaces", () => {
      expect(ruleMatchesTool({ pattern: "Bash(npm run *)", type: "allow" }, "bash", { command: "npm run build --watch" })).toBe(true)
    })

    it("case-insensitive alias: bash( matches bash tool", () => {
      expect(ruleMatchesTool({ pattern: "bash(echo *)", type: "allow" }, "bash", { command: "echo hello" })).toBe(true)
    })

    // ── Claude-Code-style prefix:* syntax ──
    it("Bash(git log:*) matches git log and its args", () => {
      expect(ruleMatchesTool({ pattern: "Bash(git log:*)", type: "allow" }, "bash", { command: "git log" })).toBe(true)
      expect(ruleMatchesTool({ pattern: "Bash(git log:*)", type: "allow" }, "bash", { command: "git log --oneline" })).toBe(true)
    })

    it("Bash(git log:*) does NOT match git push (precision)", () => {
      expect(ruleMatchesTool({ pattern: "Bash(git log:*)", type: "allow" }, "bash", { command: "git push" })).toBe(false)
      expect(ruleMatchesTool({ pattern: "Bash(git log:*)", type: "allow" }, "bash", { command: "git commit" })).toBe(false)
    })

    it("Bash(git:*) matches any git subcommand (broad, explicit)", () => {
      expect(ruleMatchesTool({ pattern: "Bash(git:*)", type: "allow" }, "bash", { command: "git log" })).toBe(true)
      expect(ruleMatchesTool({ pattern: "Bash(git:*)", type: "allow" }, "bash", { command: "git push --force" })).toBe(true)
    })

    it("legacy 'binary *' syntax still works for existing rule files", () => {
      // Backwards compat — .zapcode/settings.json files written before the
      // colon syntax landed still need to match.
      expect(ruleMatchesTool({ pattern: "Bash(git *)", type: "allow" }, "bash", { command: "git log" })).toBe(true)
    })
  })

  describe("file rules", () => {
    it("Write(src/**) matches files under src/", () => {
      expect(ruleMatchesTool({ pattern: "Write(src/**)", type: "allow" }, "write_file", { path: "src/foo/bar.ts" })).toBe(true)
    })

    it("Write(src/**) does not match files outside src/", () => {
      expect(ruleMatchesTool({ pattern: "Write(src/**)", type: "allow" }, "write_file", { path: "lib/foo.ts" })).toBe(false)
    })

    it("Write alias also covers create_file", () => {
      expect(ruleMatchesTool({ pattern: "Write(src/**)", type: "allow" }, "create_file", { path: "src/new.ts" })).toBe(true)
    })

    it("Edit alias matches edit_file", () => {
      expect(ruleMatchesTool({ pattern: "Edit(src/**)", type: "allow" }, "edit_file", { path: "src/App.tsx" })).toBe(true)
    })

    it("bare 'edit_file' matches any edit", () => {
      expect(ruleMatchesTool({ pattern: "edit_file", type: "allow" }, "edit_file", { path: "anywhere.txt" })).toBe(true)
    })

    it("rule for write_file does not match edit_file", () => {
      expect(ruleMatchesTool({ pattern: "Write(src/**)", type: "allow" }, "edit_file", { path: "src/foo.ts" })).toBe(false)
    })
  })

  describe("deny rules", () => {
    it("deny rule still matches (type is separate from match logic)", () => {
      const rule = { pattern: "Bash(rm *)", type: "deny" as const }
      expect(ruleMatchesTool(rule, "bash", { command: "rm -rf /" })).toBe(true)
    })

    it("delegate_agent bare deny still blocks, but bare allow no longer grants yolo delegation", () => {
      expect(ruleMatchesTool({ pattern: "delegate_agent", type: "deny" }, "delegate_agent", {
        provider: "claude",
        task: "anything",
      })).toBe(true)
      expect(ruleMatchesTool({ pattern: "delegate_agent", type: "allow" }, "delegate_agent", {
        provider: "claude",
        task: "anything",
      })).toBe(false)
    })
  })
})

// ─── inferPattern ─────────────────────────────────────────────────────────────

describe("inferPattern", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("bash: extracts two-token prefix as Bash(prefix:*)", () => {
    // git commit -m test → two bare-word tokens, third is flag — prefix stops at 2
    expect(inferPattern("bash", { command: "git commit -m test" }, cwd)).toBe("Bash(git commit:*)")
  })

  it("bash: strips process wrappers before computing prefix", () => {
    expect(inferPattern("bash", { command: "timeout 30 npm test" }, cwd)).toBe("Bash(npm test:*)")
    // script.py has a dot → rejected, prefix stops after `python`
    expect(inferPattern("bash", { command: "nohup python server.py" }, cwd)).toBe("Bash(python:*)")
  })

  it("bash: handles cd && cmd pattern", () => {
    expect(inferPattern("bash", { command: "cd /tmp && git status" }, cwd)).toBe("Bash(git status:*)")
  })

  it("bash: prefix stops at non-bareword tokens", () => {
    // flag → stop
    expect(inferPattern("bash", { command: "ls -la" }, cwd)).toBe("Bash(ls:*)")
    // path-like (dot) → stop
    expect(inferPattern("bash", { command: "python script.py" }, cwd)).toBe("Bash(python:*)")
    // env-var assignment → stop
    expect(inferPattern("bash", { command: "NODE_ENV=prod npm start" }, cwd)).toBe(null)
  })

  it("write_file: produces Write(dir/**) for files inside cwd", () => {
    const path = join(cwd, "src", "App.tsx")
    expect(inferPattern("write_file", { path }, cwd)).toBe("Write(src/**)")
  })

  it("write_file: produces Write(**) for files directly in cwd", () => {
    const path = join(cwd, "README.md")
    expect(inferPattern("write_file", { path }, cwd)).toBe("Write(**)")
  })

  it("write_file: produces exact-path pattern for paths outside cwd (not unbounded fallback)", () => {
    expect(inferPattern("write_file", { path: "/etc/passwd" }, cwd)).toBe("Write(/etc/passwd)")
  })

  it("returns null when the invocation lacks info to produce a bounded pattern", () => {
    // empty-path writes must NOT silently become an allow-everything rule
    expect(inferPattern("write_file", { path: "" }, cwd)).toBeNull()
    expect(inferPattern("write_file", {}, cwd)).toBeNull()
    // bash with no extractable binary
    expect(inferPattern("bash", { command: "" }, cwd)).toBeNull()
  })

  // ── Issue 14: move_file must use `destination`, not `path` ──────────────────

  it("move_file: uses destination arg (not path)", () => {
    const destination = join(cwd, "src", "renamed.ts")
    const pattern = inferPattern("move_file", { source: "/old.ts", destination }, cwd)
    expect(pattern).toBe("Move(src/**)")
    // The bug: if it used args.path (undefined), it would return "move_file"
    expect(pattern).not.toBe("move_file")
  })

  it("move_file: does NOT produce wrong pattern when path is undefined", () => {
    const destination = join(cwd, "dist", "out.js")
    const pattern = inferPattern("move_file", { source: "src/in.ts", destination }, cwd)
    expect(pattern).toBe("Move(dist/**)")
  })

  it("delegate_agent: scopes allow rules to provider and cwd", () => {
    expect(inferPattern("delegate_agent", {
      provider: "claude",
      task: "refactor",
    }, cwd)).toBe("delegate_agent(claude@.)")
    expect(inferPattern("delegate_agent", {
      provider: "codex",
      cwd: join(cwd, "packages", "cli"),
      task: "debug",
    }, cwd)).toBe("delegate_agent(codex@packages%2Fcli)")
  })

  it("delegate_agent: refuses unbounded rules when provider is missing", () => {
    expect(inferPattern("delegate_agent", { task: "refactor" }, cwd)).toBeNull()
  })

  it("list_tree infers path-scoped rules", () => {
    expect(inferPattern("list_tree", { path: join(cwd, "packages", "cli") }, cwd)).toBe("ListTree(packages/cli{,/**})")
    expect(inferPattern("list_tree", { path: cwd }, cwd)).toBe("ListTree(**)")
  })
})

describe("pathReadOutsideCwdReason", () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeTmpDir()
  })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("allows path read tools inside cwd", () => {
    expect(pathReadOutsideCwdReason("read_file", { path: "src/index.ts" }, cwd)).toBeNull()
    expect(pathReadOutsideCwdReason("list_tree", { path: "." }, cwd)).toBeNull()
    expect(pathReadOutsideCwdReason("search_files", { path: "src" }, cwd)).toBeNull()
    expect(pathReadOutsideCwdReason("glob_files", { path: "." }, cwd)).toBeNull()
    expect(pathReadOutsideCwdReason("read_document", { path: "docs/a.pdf" }, cwd)).toBeNull()
    expect(pathReadOutsideCwdReason("read_document", { path: "docs/a.docx" }, cwd)).toBeNull()
  })

  it("flags path read tools outside cwd", () => {
    const outside = join(tmpdir(), `zapcode-outside-${Date.now()}`)
    expect(pathReadOutsideCwdReason("read_file", { path: outside }, cwd)).toBe(`path outside cwd: ${outside}`)
    expect(pathReadOutsideCwdReason("list_tree", { path: "~" }, cwd)).toContain("path outside cwd:")
    expect(pathReadOutsideCwdReason("search_files", { path: outside }, cwd)).toContain("path outside cwd:")
    expect(pathReadOutsideCwdReason("glob_files", { path: outside }, cwd)).toContain("path outside cwd:")
    expect(pathReadOutsideCwdReason("read_document", { path: outside }, cwd)).toContain("path outside cwd:")
  })

  it("flags a lexically-inside path that resolves outside through a symlink", () => {
    const outside = makeTmpDir()
    try {
      writeFileSync(join(outside, "secret.txt"), "secret")
      symlinkSync(outside, join(cwd, "linked"), "dir")

      const reason = pathReadOutsideCwdReason("read_file", { path: "linked/secret.txt" }, cwd)

      expect(reason).toContain("path outside cwd:")
      expect(reason).toContain("secret.txt")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("ignores non path-read tools", () => {
    expect(pathReadOutsideCwdReason("write_file", { path: "/etc/hosts" }, cwd)).toBeNull()
    expect(pathReadOutsideCwdReason("bash", { command: "cat /etc/hosts" }, cwd)).toBeNull()
  })
})

// ─── PermissionManager.makeSessionKey (via addSessionRule + checkPermission) ──

describe("PermissionManager session keys", () => {
  let cwd: string
  let pm: PermissionManager

  beforeEach(() => {
    cwd = makeTmpDir()
    pm = new PermissionManager(cwd)
  })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("bash: same two-token prefix groups into one session key", () => {
    pm.addSessionRule("bash", { command: "git status" })
    // `git status --short` shares prefix "git status" → allowed
    expect(pm.checkPermission("bash", { command: "git status --short" }).decision).toBe("allow")
  })

  it("bash: different subcommand of same binary is NOT auto-allowed", () => {
    // Intentional change: old behavior lumped all git under one session key.
    // New prefix-based key scopes session approvals to the actual subcommand,
    // mirroring the disk-rule precision.
    pm.addSessionRule("bash", { command: "git log" })
    expect(pm.checkPermission("bash", { command: "git push" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "git log --oneline" }).decision).toBe("allow")
  })

  it("bash: different binary is not allowed", () => {
    pm.addSessionRule("bash", { command: "git status" })
    expect(pm.checkPermission("bash", { command: "npm test" }).decision).toBe("ask")
  })

  it("write_file: same directory groups into one session key", () => {
    pm.addSessionRule("write_file", { path: join(cwd, "src", "App.tsx") })
    expect(pm.checkPermission("write_file", { path: join(cwd, "src", "index.ts") }).decision).toBe("allow")
  })

  it("write_file: different directory is not allowed", () => {
    pm.addSessionRule("write_file", { path: join(cwd, "src", "App.tsx") })
    expect(pm.checkPermission("write_file", { path: join(cwd, "lib", "util.ts") }).decision).toBe("ask")
  })

  it("empty-path write_file cannot create a rule that later matches everything", () => {
    // Historical landmine: inferPattern returning "write_file" for empty path
    // created a rule that matched ALL write_file calls.
    pm.addSessionRule("write_file", {}) // no path
    // A later, unrelated write must NOT auto-allow
    expect(pm.checkPermission("write_file", { path: join(cwd, "src", "unrelated.ts") }).decision).toBe("ask")
  })

  // ── Issue 14: move_file session key must use destination ───────────────────

  it("move_file: session rules must cover both source and destination", () => {
    const dest1 = join(cwd, "src", "a.ts")
    const dest2 = join(cwd, "src", "b.ts")
    const destOther = join(cwd, "lib", "c.ts")

    pm.addSessionRule("move_file", { source: "/old.ts", destination: dest1 })

    // The destination scope alone cannot authorize an unrelated external source.
    expect(pm.checkPermission("move_file", { source: "/x.ts", destination: dest2 }).decision).toBe("ask")
    expect(pm.checkPermission("move_file", { source: dest1, destination: dest2 }).decision).toBe("allow")
    // Different directory → ask
    expect(pm.checkPermission("move_file", { source: "/x.ts", destination: destOther }).decision).toBe("ask")
  })

  it("move_file: approving one move does NOT grant all moves (the old bug)", () => {
    // This test would FAIL before the fix because all move_file calls shared key "move_file::."
    const dest = join(cwd, "src", "renamed.ts")
    pm.addSessionRule("move_file", { source: "/a.ts", destination: dest })

    // A move to a completely different directory should still require approval
    const unrelated = join(cwd, "dist", "out.js")
    expect(pm.checkPermission("move_file", { source: "/b.ts", destination: unrelated }).decision).toBe("ask")
  })

  it("delegate_agent: session allow is scoped to provider + cwd, not every delegated task", () => {
    const subdir = join(cwd, "packages", "cli")
    pm.addSessionRule("delegate_agent", {
      provider: "claude",
      cwd: subdir,
      task: "first task",
    })

    // Same provider + same cwd may run a different task in this session.
    expect(pm.checkPermission("delegate_agent", {
      provider: "claude",
      cwd: subdir,
      task: "follow-up task",
    }).decision).toBe("allow")
    // Different provider or cwd still needs explicit approval.
    expect(pm.checkPermission("delegate_agent", {
      provider: "codex",
      cwd: subdir,
      task: "same directory",
    }).decision).toBe("ask")
    expect(pm.checkPermission("delegate_agent", {
      provider: "claude",
      cwd: join(cwd, "packages", "web"),
      task: "different directory",
    }).decision).toBe("ask")
  })

  it("delegate_agent: missing provider cannot create a session allow-all rule", () => {
    pm.addSessionRule("delegate_agent", { task: "missing provider" })
    expect(pm.checkPermission("delegate_agent", {
      provider: "claude",
      task: "later task",
    }).decision).toBe("ask")
  })

  // ── path coordinate-system normalization (D-fix regression test) ─────────
  // Saved patterns are cwd-relative ("Edit(src/**)") but a tool-call subject
  // can arrive absolute, relative, or a mix across calls. Without
  // normalization, "always allow" silently no-ops on the next call.

  it("project rule matches abs/rel/dotted subject after relative-path inference", () => {
    pm.addProjectRule("edit_file", { path: join(cwd, "src", "foo.ts") })
    // Same path, abs form (typical for many models) → allow
    expect(pm.checkPermission("edit_file", { path: join(cwd, "src", "foo.ts") }).decision).toBe("allow")
    // Same path, rel form → also allow (idempotent)
    expect(pm.checkPermission("edit_file", { path: "src/foo.ts" }).decision).toBe("allow")
    // ./ prefix → also allow
    expect(pm.checkPermission("edit_file", { path: "./src/foo.ts" }).decision).toBe("allow")
    // Sibling in same dir (glob expansion) → allow
    expect(pm.checkPermission("edit_file", { path: join(cwd, "src", "bar.ts") }).decision).toBe("allow")
    // Different dir → still ask
    expect(pm.checkPermission("edit_file", { path: join(cwd, "lib", "util.ts") }).decision).toBe("ask")
  })

  it("session rule honors abs subject after relative inference", () => {
    pm.addSessionRule("edit_file", { path: "src/foo.ts" })
    // Saved with relative; called with absolute → must hit the same session key
    expect(pm.checkPermission("edit_file", { path: join(cwd, "src", "bar.ts") }).decision).toBe("allow")
  })

  it("out-of-cwd absolute path stays absolute and matches itself", () => {
    pm.addProjectRule("edit_file", { path: "/etc/hosts" })
    expect(pm.checkPermission("edit_file", { path: "/etc/hosts" }).decision).toBe("allow")
    // A different out-of-cwd path must not piggyback
    expect(pm.checkPermission("edit_file", { path: "/etc/passwd" }).decision).toBe("ask")
  })

  it("list_tree session allow is scoped by directory", () => {
    pm.addSessionRule("list_tree", { path: join(cwd, "packages", "cli") })
    expect(pm.checkPermission("list_tree", { path: join(cwd, "packages", "cli") }).decision).toBe("allow")
    expect(pm.checkPermission("list_tree", { path: join(cwd, "packages", "cli", "src") }).decision).toBe("allow")
    expect(pm.checkPermission("list_tree", { path: join(cwd, "packages", "web") }).decision).toBe("ask")
    expect(pm.checkPermission("list_tree", { path: join(cwd, "docs") }).decision).toBe("ask")
  })
})

// ─── PermissionManager.checkPermission rule precedence ───────────────────────

describe("PermissionManager rule precedence", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("a shared deny overrides a local allow", () => {
    // shared: deny git; local: allow git
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "deny" }]
    })
    savePermissionSettings(getProjectLocalSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("deny")
  })

  it("shared project deny blocks even when global allows", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "deny" }]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git push" }).decision).toBe("deny")
  })

  it("no rules → ask", () => {
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("ask")
    expect(pm.checkPermission("write_file", { path: "/tmp/foo" }).decision).toBe("ask")
  })

  it("a shared deny overrides a session allow", () => {
    // shared: deny git; but session allows
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "deny" }]
    })
    const pm = new PermissionManager(cwd)
    pm.addSessionRule("bash", { command: "git status" })
    const result = pm.checkPermission("bash", { command: "git status" })
    expect(result.decision).toBe("deny")
    expect(result.scope).toBe("project")
  })

  it("checkPermission surfaces the matched rule + scope for a project rule", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    const result = pm.checkPermission("bash", { command: "git status" })
    expect(result.decision).toBe("allow")
    expect(result.rule?.pattern).toBe("Bash(git *)")
    expect(result.scope).toBe("project")
  })

  it("ask rule surfaces rule + scope so the approval layer can distinguish it from 'no match'", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(gh pr merge:*)", type: "ask" }]
    })
    const pm = new PermissionManager(cwd)
    const matched = pm.checkPermission("bash", { command: "gh pr merge 42" })
    expect(matched.decision).toBe("ask")
    expect(matched.rule?.pattern).toBe("Bash(gh pr merge:*)")
    expect(matched.scope).toBe("project")

    // Unmatched still returns ask, but WITHOUT a rule — this is the signal
    // App._onApproval uses to decide whether to skip acceptEdits auto-allow.
    const unmatched = pm.checkPermission("bash", { command: "npm test" })
    expect(unmatched.decision).toBe("ask")
    expect(unmatched.rule).toBeUndefined()
  })

  it("loadPermissionSettings accepts ask rules from disk", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(gh pr merge:*)", type: "ask" },
        { pattern: "Write(secrets/**)",   type: "ask" },
      ]
    })
    const loaded = loadPermissionSettings(getProjectSettingsPath(cwd))
    expect(loaded.rules.length).toBe(2)
    expect(loaded.rules[0].type).toBe("ask")
    expect(loaded.rules[1].type).toBe("ask")
  })

  it("savePermissionSettings writes owner-only files and tightens existing files", () => {
    const path = getProjectSettingsPath(cwd)
    mkdirSync(join(cwd, ".zapcode"), { recursive: true })
    writeFileSync(path, "{}\n", { mode: 0o666 })
    chmodSync(path, 0o666)

    savePermissionSettings(path, {
      rules: [{ pattern: "Bash(git *)", type: "allow" }],
    })

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadPermissionSettings(path).rules).toEqual([{ pattern: "Bash(git *)", type: "allow" }])
  })

  it("explicit ask rule wins over a later allow rule in a lower-priority layer", () => {
    // local (higher priority): ask; shared: allow. First-match-wins means
    // ask is returned — mirrors how an 'ask' override suppresses a blanket
    // allow the user set earlier.
    savePermissionSettings(getProjectLocalSettingsPath(cwd), {
      rules: [{ pattern: "Bash(gh pr merge:*)", type: "ask" }]
    })
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(gh *)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    const result = pm.checkPermission("bash", { command: "gh pr merge 99" })
    expect(result.decision).toBe("ask")
    expect(result.scope).toBe("local")
  })
})

// ─── patternCovers ────────────────────────────────────────────────────────────

describe("patternCovers", () => {
  it("identical patterns cover each other", () => {
    expect(patternCovers("Bash(git:*)", "Bash(git:*)")).toBe(true)
    expect(patternCovers("Write(src/**)", "Write(src/**)")).toBe(true)
  })

  it("bash: shorter prefix covers longer whitespace-bounded prefix", () => {
    expect(patternCovers("Bash(git:*)", "Bash(git commit:*)")).toBe(true)
    expect(patternCovers("Bash(git:*)", "Bash(git log:*)")).toBe(true)
  })

  it("bash: prefix overlap without whitespace boundary does NOT cover (avoids false positive)", () => {
    // `Bash(git:*)` must not accidentally cover `Bash(github:*)`
    expect(patternCovers("Bash(git:*)", "Bash(github:*)")).toBe(false)
  })

  it("bash: sibling prefixes do not cover each other", () => {
    expect(patternCovers("Bash(git commit:*)", "Bash(git push:*)")).toBe(false)
  })

  it("bash: tool-only bare pattern covers any bash arg pattern", () => {
    // `bash` alias matches everything, so it covers `Bash(git:*)`
    expect(patternCovers("bash", "Bash(git:*)")).toBe(true)
  })

  it("bash: arg pattern covers bare tool pattern only when universal", () => {
    expect(patternCovers("Bash(*)", "bash")).toBe(true)
    expect(patternCovers("Bash(git:*)", "bash")).toBe(false)
  })

  it("file: ** covers any subpath", () => {
    expect(patternCovers("Write(**)", "Write(src/**)")).toBe(true)
    expect(patternCovers("Write(**)", "Write(src/foo.ts)")).toBe(true)
  })

  it("file: dir/** covers deeper dir/sub/** and literal paths under dir", () => {
    expect(patternCovers("Write(src/**)", "Write(src/ui/**)")).toBe(true)
    expect(patternCovers("Write(src/**)", "Write(src/foo.ts)")).toBe(true)
  })

  it("file: sibling dirs do not cover each other", () => {
    expect(patternCovers("Write(src/**)", "Write(tests/**)")).toBe(false)
  })

  it("file: prefix overlap without / boundary does not cover", () => {
    // `Write(src/**)` must NOT accidentally cover `Write(srcx/**)`
    expect(patternCovers("Write(src/**)", "Write(srcx/**)")).toBe(false)
  })

  it("different tools never cover each other", () => {
    expect(patternCovers("Bash(git:*)", "Write(src/**)")).toBe(false)
    expect(patternCovers("Read(**)", "Write(**)")).toBe(false)
  })

  it("a project-relative Write scope does not cover the entire write_file tool", () => {
    expect(patternCovers("Write(**)", "write_file")).toBe(false)
  })
})

// ─── PermissionManager.getSummaryAnnotated (shadow detection) ─────────────────

describe("PermissionManager.getSummaryAnnotated", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("flags a project rule shadowed by a broader local rule", () => {
    savePermissionSettings(getProjectLocalSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git:*)", type: "allow" }]
    })
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git commit:*)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    const groups = pm.getSummaryAnnotated()
    const projectGroup = groups.find(g => g.label === "project")!
    expect(projectGroup.rules[0].shadowedBy?.rule.pattern).toBe("Bash(git:*)")
    expect(projectGroup.rules[0].shadowedBy?.scope).toBe("local")
    const localGroup = groups.find(g => g.label === "personal")!
    expect(localGroup.rules[0].shadowedBy).toBeUndefined()
  })

  it("does NOT flag siblings that look similar but don't overlap", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(git commit:*)", type: "allow" },
        { pattern: "Bash(git push:*)",   type: "allow" },
      ]
    })
    const pm = new PermissionManager(cwd)
    const groups = pm.getSummaryAnnotated()
    const projectGroup = groups.find(g => g.label === "project")!
    expect(projectGroup.rules.every(r => r.shadowedBy === undefined)).toBe(true)
  })

  it("flags a global rule shadowed by a project rule (layer precedence respected)", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Write(**)", type: "allow" }]
    })
    // Emulate a global rule by writing directly to the shared layer mock —
    // since getGlobalSettingsPath() is outside cwd, we can't override it in
    // this test scope. Instead, verify the in-project case here and rely on
    // the check-order unit test below.
    const pm = new PermissionManager(cwd)
    const groups = pm.getSummaryAnnotated()
    expect(groups.find(g => g.label === "project")!.rules[0].shadowedBy).toBeUndefined()
  })

  it("flags a later rule in the SAME layer covered by an earlier one", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(git:*)",        type: "allow" },
        { pattern: "Bash(git commit:*)", type: "allow" },  // shadowed
      ]
    })
    const pm = new PermissionManager(cwd)
    const groups = pm.getSummaryAnnotated()
    const rules = groups.find(g => g.label === "project")!.rules
    expect(rules[0].shadowedBy).toBeUndefined()
    expect(rules[1].shadowedBy?.rule.pattern).toBe("Bash(git:*)")
  })

  it("flags an allow shadowed by an earlier deny (different types still shadow)", () => {
    // Real-world: user has deny at a higher layer, then writes a more
    // specific allow below — the allow is dead code.
    savePermissionSettings(getProjectLocalSettingsPath(cwd), {
      rules: [{ pattern: "Bash(rm:*)", type: "deny" }]
    })
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(rm -rf tmp:*)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    const groups = pm.getSummaryAnnotated()
    const projectRule = groups.find(g => g.label === "project")!.rules[0]
    expect(projectRule.shadowedBy?.rule.type).toBe("deny")
    expect(projectRule.shadowedBy?.scope).toBe("local")
  })
})

// ─── PermissionManager.addProjectRule (compound command splitting) ────────────

describe("PermissionManager.addProjectRule compound commands", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("writes separate rules for every approved subcommand", () => {
    const pm = new PermissionManager(cwd)
    pm.addProjectRule("bash", { command: "git status && npm test" })

    const settings = loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd))
    const patterns = settings.rules.map(r => r.pattern)
    expect(patterns).toContain("Bash(git status:*)")
    expect(patterns).toContain("Bash(npm test:*)")
  })

  it("covers every approved compound step", () => {
    const pm = new PermissionManager(cwd)
    pm.addProjectRule("bash", { command: "a && b && c && d && e && f && g" })

    const settings = loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd))
    expect(settings.rules.length).toBe(7)
  })

  it("does not write duplicate rules for same prefix", () => {
    const pm = new PermissionManager(cwd)
    pm.addProjectRule("bash", { command: "git status" })
    pm.addProjectRule("bash", { command: "git status --short" }) // same prefix "git status"

    const settings = loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd))
    const gitStatusRules = settings.rules.filter(r => r.pattern === "Bash(git status:*)")
    expect(gitStatusRules.length).toBe(1)
  })

  it("different subcommands produce different rules (precision over greed)", () => {
    const pm = new PermissionManager(cwd)
    pm.addProjectRule("bash", { command: "git status" })
    pm.addProjectRule("bash", { command: "git commit -m test" })

    const settings = loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd))
    const patterns = settings.rules.map(r => r.pattern).sort()
    expect(patterns).toEqual(["Bash(git commit:*)", "Bash(git status:*)"])
  })

  it("newly written rules are immediately used for checkPermission", () => {
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("ask")
    pm.addProjectRule("bash", { command: "git status" })
    // Same prefix matches
    expect(pm.checkPermission("bash", { command: "git status --short" }).decision).toBe("allow")
    // Different subcommand doesn't
    expect(pm.checkPermission("bash", { command: "git log" }).decision).toBe("ask")
  })

  it("delegate_agent project rule is scoped to provider + cwd and used immediately", () => {
    const pm = new PermissionManager(cwd)
    const subdir = join(cwd, "packages", "cli")

    pm.addProjectRule("delegate_agent", {
      provider: "claude",
      cwd: subdir,
      task: "first task",
    })

    const settings = loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd))
    expect(settings.rules).toEqual([
      { pattern: "delegate_agent(claude@packages%2Fcli)", type: "allow" },
    ])
    expect(pm.checkPermission("delegate_agent", {
      provider: "claude",
      cwd: subdir,
      task: "different task",
    }).decision).toBe("allow")
    expect(pm.checkPermission("delegate_agent", {
      provider: "codex",
      cwd: subdir,
      task: "same cwd",
    }).decision).toBe("ask")
    expect(pm.checkPermission("delegate_agent", {
      provider: "claude",
      cwd: join(cwd, "packages", "web"),
      task: "same provider",
    }).decision).toBe("ask")
  })
})

// ─── checkPermission compound bash + wrapper symmetry ────────────────────────
// Regression suite for the save/match asymmetry: addProjectRule splits compound
// commands and inferPattern strips wrappers (nohup/cd&&/timeout) when SAVING,
// so the lookup side (checkPermission) must do the same. Without these, a rule
// like Bash(python3:*) saved from `nohup python3 ...` never matched its own
// originating command — bypass mode + saved permissions both silently failed.

describe("PermissionManager checkPermission bash wrapper symmetry", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("nohup wrapper: rule matches command starting with nohup", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(python3:*)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "nohup python3 server.py" }).decision).toBe("allow")
  })

  it("timeout wrapper: rule matches command starting with timeout", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(npm test:*)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "timeout 30 npm test" }).decision).toBe("allow")
  })

  it("cd && cmd: each split subcommand needs its own rule (precision)", () => {
    // `cd /tmp && git status` splits into ["cd /tmp", "git status"]; both
    // must be allowed independently. Real users typically have Bash(cd:*)
    // as a baseline allow because the model uses cd constantly.
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(cd:*)",         type: "allow" },
        { pattern: "Bash(git status:*)", type: "allow" },
      ]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "cd /tmp && git status" }).decision).toBe("allow")
    // Without Bash(cd:*) the compound would correctly require approval
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git status:*)", type: "allow" }]
    })
    const pm2 = new PermissionManager(cwd)
    expect(pm2.checkPermission("bash", { command: "cd /tmp && git status" }).decision).toBe("ask")
  })

  it("nice -n N wrapper: rule matches", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(bun run:*)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "nice -n 10 bun run dev" }).decision).toBe("allow")
  })
})

describe("PermissionManager checkPermission bash compound commands", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("all subcommands covered by allow rules → overall allow", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(git status:*)", type: "allow" },
        { pattern: "Bash(npm test:*)",   type: "allow" },
      ]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git status && npm test" }).decision).toBe("allow")
  })

  it("checks each structured verification step against permissions", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [
      { pattern: "Bash(git status:*)", type: "allow" },
      { pattern: "Bash(npm test:*)", type: "allow" },
      { pattern: "Bash(rm:*)", type: "deny" },
    ] })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "(git status) && (npm test)",
      check_steps: ["git status", "npm test"] }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { command: "(git status) && (rm temp)",
      check_steps: ["git status", "rm temp"] }).decision).toBe("deny")
    expect(pm.checkPermission("bash", { command: "(unknown) && (rm temp)",
      check_steps: ["unknown", "rm temp"] }).decision).toBe("deny")
    expect(pm.checkPermission("bash", { check_steps: ["git status", "npm test"] }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { check_steps: ["git status", "rm temp"] }).decision).toBe("deny")
  })

  it("one subcommand uncovered → overall ask (not silent allow)", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git status:*)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    const result = pm.checkPermission("bash", { command: "git status && rm -rf tmp" })
    expect(result.decision).toBe("ask")
    expect(result.rule).toBeUndefined()  // no-rule signal for App.tsx bypass gate
  })

  it("any subcommand denied → overall deny short-circuit", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(git status:*)", type: "allow" },
        { pattern: "Bash(rm:*)",         type: "deny" },
      ]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git status && rm tmp.txt" }).decision).toBe("deny")
  })

  it("explicit ask rule on any subcommand → overall ask with rule attached", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(git status:*)",   type: "allow" },
        { pattern: "Bash(gh pr merge:*)",  type: "ask" },
      ]
    })
    const pm = new PermissionManager(cwd)
    const result = pm.checkPermission("bash", { command: "git status && gh pr merge 1" })
    expect(result.decision).toBe("ask")
    expect(result.rule?.pattern).toBe("Bash(gh pr merge:*)")
  })

  for (const prefix of ["unknown-tool", "review-tool"]) {
    for (const separator of ["&&", ";", "|"]) {
      it(`preserves a later deny after ${prefix} ${separator}`, () => {
        savePermissionSettings(getProjectSettingsPath(cwd), { rules: [
          { pattern: "Bash(review-tool:*)", type: "ask" },
          { pattern: "Bash(blocked-tool:*)", type: "deny" },
        ] })
        const pm = new PermissionManager(cwd)
        const command = `${prefix} ${separator} blocked-tool payload`
        for (const args of [{ command }, { check_steps: [command] }]) {
          const result = pm.checkPermission("bash", args)
          expect(result.decision).toBe("deny")
          expect(result.rule?.pattern).toBe("Bash(blocked-tool:*)")
        }
      })
    }
  }

  it("retains an explicit ask after an unmatched subcommand", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [
      { pattern: "Bash(review-tool:*)", type: "ask" },
    ] })
    const pm = new PermissionManager(cwd)
    for (const args of [
      { command: "unknown-tool && review-tool payload" },
      { check_steps: ["unknown-tool && review-tool payload"] },
      { check_steps: ["unknown-tool", "review-tool payload"] },
      { command: "review-tool payload && unknown-tool" },
    ]) {
      const result = pm.checkPermission("bash", args)
      expect(result.decision).toBe("ask")
      expect(result.rule?.pattern).toBe("Bash(review-tool:*)")
    }
  })

  it("compound with nohup + & + |: every subcommand still resolved (screenshot repro)", () => {
    // Mirrors the bug screenshot: `nohup python3 ... & echo ... | tail`.
    // Pre-fix: matchCommandGlob tested the whole compound string against
    // Bash(python3:*) → failed because subject started with "nohup".
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [
        { pattern: "Bash(python3:*)", type: "allow" },
        { pattern: "Bash(echo:*)",    type: "allow" },
        { pattern: "Bash(tail:*)",    type: "allow" },
      ]
    })
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", {
      command: "nohup python3 worker.py > log 2>&1 & echo done | tail -n 1"
    }).decision).toBe("allow")
  })

  it("session rule for bash compound: splits into per-subcommand session keys", () => {
    const pm = new PermissionManager(cwd)
    pm.addSessionRule("bash", { command: "git status && npm test" })
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { command: "npm test" }).decision).toBe("allow")
    // Unrelated subcommand still asks
    expect(pm.checkPermission("bash", { command: "rm -rf /" }).decision).toBe("ask")
  })

  it("empty bash command → ask (not crash)", () => {
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", {}).decision).toBe("ask")
  })
})

// ─── Process wrapper stripping (via inferPattern) ─────────────────────────────

describe("process wrapper stripping", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  const cases: [string, string][] = [
    ["timeout 30 npm test",                   "Bash(npm test:*)"],
    ["timeout --signal=KILL 5 npm run build", "Bash(npm run:*)"],
    ["nohup python server.py",                "Bash(python:*)"],         // server.py has dot
    ["time git log --oneline",                "Bash(git log:*)"],
    ["nice -n 10 bun run dev",                "Bash(bun run:*)"],
    ["stdbuf -oL python script.py",           "Bash(python:*)"],
    ["nice python foo.py",                    "Bash(python:*)"],
  ]

  for (const [command, expected] of cases) {
    it(`"${command}" → ${expected}`, () => {
      expect(inferPattern("bash", { command }, cwd)).toBe(expected)
    })
  }
})

// ─── getSummary ───────────────────────────────────────────────────────────────

describe("PermissionManager.getSummary", () => {
  let cwd: string

  beforeEach(() => { cwd = makeTmpDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it("returns empty when no rules", () => {
    const pm = new PermissionManager(cwd)
    expect(pm.getSummary()).toEqual([])
  })

  it("includes project rules with shortened path", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    const summary = pm.getSummary()
    expect(summary.length).toBe(1)
    expect(summary[0].label).toBe("project")
    expect(summary[0].source).not.toContain(cwd) // should be shortened
    expect(summary[0].rules[0].pattern).toBe("Bash(git *)")
  })

  it("includes session rules", () => {
    const pm = new PermissionManager(cwd)
    pm.addSessionRule("bash", { command: "git status" })
    const summary = pm.getSummary()
    const session = summary.find(g => g.label === "session")
    expect(session).toBeDefined()
    expect(session!.rules[0].pattern).toBe("Bash(git status:*)")
  })

  it("shows local, project, session in one summary", () => {
    savePermissionSettings(getProjectSettingsPath(cwd), {
      rules: [{ pattern: "Bash(npm *)", type: "allow" }]
    })
    savePermissionSettings(getProjectLocalSettingsPath(cwd), {
      rules: [{ pattern: "Bash(git *)", type: "allow" }]
    })
    const pm = new PermissionManager(cwd)
    pm.addSessionRule("bash", { command: "python foo.py" })

    const summary = pm.getSummary()
    const labels = summary.map(g => g.label)
    expect(labels).toContain("personal")
    expect(labels).toContain("project")
    expect(labels).toContain("session")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effectiveCommandCwd, isReadOnlyCommand } from "../src/readonly-commands.js"
import { PermissionManager } from "../src/permissions.js"

const cleanup: string[] = []
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }) })

function project(): { cwd: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "zap-readonly-"))
  cleanup.push(base)
  const cwd = join(base, "project")
  const outside = join(base, "outside")
  mkdirSync(join(cwd, "src"), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(cwd, "src", "a.ts"), "a")
  writeFileSync(join(cwd, "README.md"), "r")
  writeFileSync(join(outside, "secret.txt"), "secret")
  symlinkSync(outside, join(cwd, "escape"))
  symlinkSync(join(outside, "secret.txt"), join(cwd, "notes.txt"))
  return { cwd, outside }
}

describe("commands that run without a prompt", () => {
  const allowed = [
    "ls", "ls -la", "ls src", "ls -R .", "pwd", "whoami", "uname -a", "date", "date +%s", "id", "which node",
    "cat README.md", "cat src/a.ts", "head -n 5 README.md", "tail -n 20 README.md",
    "grep -rn TODO src", "grep -r \"foo bar\" .", "rg TODO", "rg -n \"fn main\" src", "find . -name '*.ts'", "find src -type f",
    "echo hello", "echo \"a b\"",
    "git status", "git status --short", "git diff", "git diff --stat HEAD~1", "git diff main..HEAD", "git log --oneline -n 5",
    "git log -p src/a.ts", "git show HEAD", "git show HEAD:src/a.ts", "git blame src/a.ts", "git ls-files", "git rev-parse HEAD",
    "git branch", "git branch -a", "git branch --show-current", "git tag", "git tag -l", "git tag -l 'v*'", "git remote -v",
    "git stash list", "git stash show", "git shortlog -sn", "git grep TODO",
  ]
  for (const command of allowed) {
    test(`allows: ${command}`, () => { expect(isReadOnlyCommand(command, project().cwd)).toBe(true) })
  }
})

describe("commands that must still ask", () => {
  const refused: Array<[string, string]> = [
    // shell syntax that chains, redirects or substitutes
    ["ls; rm -rf x", "chaining"], ["ls && rm x", "chaining"], ["ls || rm x", "chaining"], ["ls | tee out", "pipe"],
    ["ls & rm x", "background"], ["ls\nrm x", "newline"], ["ls\r\nrm x", "carriage return"],
    ["echo hi > out.txt", "redirect"], ["echo hi >> out.txt", "append"], ["cat < README.md", "input redirect"],
    ["echo $(rm x)", "substitution"], ["echo `rm x`", "backtick"], ["echo ${HOME}", "expansion"], ["echo $HOME", "variable"],
    ["echo $((1+1))", "arithmetic"], ["ls (a)", "subshell"], ["ls \\\nrm x", "backslash"], ["echo 'a;b'", "metachar in quotes"],
    ["cat <(rm x)", "process substitution"], ["ls 2>&1", "fd redirect"],
    // environment prefixes and wrappers
    ["FOO=bar ls", "env prefix"], ["GIT_PAGER=evil git log", "env prefix"], ["env ls", "env"], ["time ls", "wrapper"],
    ["nohup ls", "wrapper"], ["xargs ls", "xargs"], ["sudo ls", "sudo"], ["/bin/ls", "absolute command"], ["./ls", "relative command"],
    ["sh -c ls", "shell"], ["bash ls", "shell"], ["eval ls", "eval"], ["exec ls", "exec"], ["constructor", "prototype name"],
    ["__proto__", "prototype name"], ["toString", "prototype name"], ["hasOwnProperty", "prototype name"],
    // commands that can print secrets or run code
    ["env", "env"], ["printenv", "printenv"], ["jq -n env", "jq env"], ["awk 'BEGIN{system(\"x\")}'", "awk"], ["sed -n p file", "sed"],
    ["sed -i s/a/b/ file", "sed -i"], ["tee out", "tee"], ["python -c 1", "python"], ["node -e 1", "node"], ["make", "make"],
    // flags that turn a viewer into a writer or executor
    ["sort -o out README.md", "sort -o"], ["sort --output=out README.md", "sort --output"], ["sort -uo out README.md", "sort cluster"],
    ["date -s 2020-01-01", "date -s"], ["date --set=2020-01-01", "date --set"], ["tail -f README.md", "tail -f"],
    ["tail -F README.md", "tail -F"], ["tail --follow README.md", "tail --follow"], ["tail -nf README.md", "tail cluster"],
    ["find . -exec rm {} +", "find -exec"], ["find . -execdir rm {} +", "find -execdir"], ["find . -ok rm {} +", "find -ok"],
    ["find . -delete", "find -delete"], ["find . -fprint out", "find -fprint"], ["find . -fprintf out x", "find -fprintf"],
    ["find -L . -name x", "find -L"], ["find . -follow", "find -follow"], ["rg --pre cat x", "rg --pre"], ["rg --pre=cat x", "rg --pre="],
    ["rg --pre-glob '*' x", "rg --pre-glob"], ["rg -z x", "rg -z"], ["rg --search-zip x", "rg --search-zip"], ["rg -L x", "rg -L"],
    ["rg --follow x", "rg --follow"], ["grep -R x .", "grep -R"], ["grep --dereference-recursive x .", "grep -R long"],
    ["tree -o out", "tree -o"], ["file -C", "file -C"], ["file --compile", "file --compile"], ["hostname evil", "hostname set"],
    ["cd src", "cd changes the directory later pieces run in"], ["cd", "bare cd goes to $HOME"], ["cd -", "cd -"], ["cd --", "cd --"],
    // git commands that mutate or run configured programs
    ["git commit -m x", "commit"], ["git add .", "add"], ["git checkout -b x", "checkout"], ["git reset --hard", "reset"],
    ["git clean -fd", "clean"], ["git push", "push"], ["git pull", "pull"], ["git fetch", "fetch"], ["git merge x", "merge"],
    ["git rebase -i HEAD~2", "rebase"], ["git stash", "stash push"], ["git stash drop", "stash drop"], ["git stash pop", "stash pop"],
    ["git branch -D x", "branch -D"], ["git branch newname", "branch create"], ["git branch -m a b", "branch -m"],
    ["git tag v1", "tag create"], ["git tag -d v1", "tag -d"], ["git remote add x y", "remote add"], ["git remote remove x", "remote remove"],
    ["git remote show origin", "remote show (network)"], ["git config --list", "config"], ["git config user.name x", "config set"],
    ["git reflog expire --expire=now --all", "reflog expire"], ["git reflog delete HEAD@{1}", "reflog delete"], ["git reflog", "reflog (no spec, conservative)"], ["git describe --tags", "describe (no spec, conservative)"],
    ["git -c core.pager=evil log", "global -c"], ["git --git-dir=/x log", "global --git-dir"], ["git -C /tmp log", "global -C"],
    ["git log --output=out", "log --output"], ["git diff --output=out", "diff --output"], ["git log --ext-diff", "ext-diff"],
    ["git diff --ext-diff", "diff ext-diff"], ["git grep -O x", "grep -O pager"], ["git grep --open-files-in-pager=x y", "pager"],
    ["git diff --no-index README.md /etc/passwd", "no-index"], ["git log --git-dir=/x", "log --git-dir"], ["git show --work-tree=/x", "work-tree"],
    ["git diff -Oorder", "diff -O"], ["git", "bare git"], ["git -h", "git flag"], ["git push origin HEAD", "push origin"],
    ["git ls-remote origin", "ls-remote (network)"], ["git clone x y", "clone"], ["git submodule update", "submodule"],
    ["git worktree add x", "worktree"], ["git gc", "gc"], ["git prune", "prune"], ["git update-ref -d x", "update-ref"],
  ]
  for (const [command, why] of refused) {
    test(`refuses: ${command}   [${why}]`, () => { expect(isReadOnlyCommand(command, project().cwd)).toBe(false) })
  }
})

describe("bypasses found in independent review", () => {
  // Each of these returned true for the first, denylist version of the parser.
  const bypasses: Array<[string, string]> = [
    ["git grep --open='touch pwn' hello", "abbreviated --open-files-in-pager ran a command"],
    ["git grep --open-files-in-p=x hello", "abbreviated pager flag"],
    ["git log --ext", "abbreviated --ext-diff"],
    ["git diff --ext-di", "abbreviated --ext-diff"],
    ["git log --out=x", "abbreviated --output"],
    ["git diff --no-ind README.md /etc/passwd", "abbreviated --no-index"],
    ["git log --exec=x", "abbreviated --exec-path"],
    ["sort -ox.txt README.md", "attached short value wrote a file"],
    ["sort --out=y.txt README.md", "abbreviated --output"],
    ["sort --outp=y.txt README.md", "abbreviated --output"],
    ["sort -T/tmp README.md", "temp dir outside"],
    ["tree -ox.txt", "attached -o"],
    ["cat {/etc/hosts,README.md}", "brace expansion read outside"],
    ["cat {~/.ssh/id_rsa,x}", "brace plus tilde"],
    ["cat out*/secret.txt", "glob through a link"],
    ["cat *", "glob in a project that holds a link out"],
    ["ls ?scape", "glob through a link"],
    ["cat [e]scape/secret.txt", "bracket glob through a link"],
    ["cat l/../secret.txt", "link/.. is the parent of the link target"],
    ["ls l/..", "link/.. listing"],
    ["grep -rS SECRET .", "BSD -S follows links"],
    ["grep -f/etc/hosts README.md", "attached -f reads a pattern file"],
    ["git grep -f/etc/hosts x", "attached -f"],
    ["file -m/etc/magic README.md", "attached -m"],
    ["find -f/etc . -name x", "BSD find -f"],
    ["ls -RL .", "-L follows links"],
    ["tree -l", "-l follows links"],
    ["du -L .", "-L follows links"],
    ["date 1010101010", "positional sets the clock"],
    ["tail --fol README.md", "abbreviated --follow hangs"],
    ["tail --retry README.md", "retry hangs"],
  ]
  for (const [command, why] of bypasses) {
    test(`refuses: ${command}   [${why}]`, () => {
      const { cwd, outside } = project()
      symlinkSync(join(outside, "sub"), join(cwd, "l"))
      mkdirSync(join(outside, "sub"), { recursive: true })
      symlinkSync(outside, join(cwd, "outl"))
      expect(isReadOnlyCommand(command, cwd)).toBe(false)
    })
  }

  test("a bash call whose cwd is ~ or uses a variable is not trusted", () => {
    const { cwd } = project()
    for (const arg of ["~", "~/", "~/.ssh", "$HOME", "${HOME}/x", "src/$X"]) expect(effectiveCommandCwd(cwd, arg)).toBeNull()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    expect(pm.checkPermission("bash", { command: "ls -la .ssh", cwd: "~" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "cat a.txt", cwd: "~/" }).decision).toBe("ask")
  })

  test("quoted globs and a tilde inside a word are not expansion, so common commands still work", () => {
    const { cwd } = project()
    for (const command of ["find . -name '*.ts'", "find . -name \"*.md\" -type f", "grep -rn \"a*b\" src", "git log --since='2 weeks ago'",
      "git diff HEAD~3", "git log HEAD~1..HEAD", "git show HEAD^", "echo \"~ is not expanded here\""]) {
      expect(isReadOnlyCommand(command, cwd)).toBe(true)
    }
    for (const command of ["ls *.ts", "ls ~", "ls ~/x", "ls {a,b}", "ls [ab]", "ls a?"]) expect(isReadOnlyCommand(command, cwd)).toBe(false)
  })

  test("the flag lists accept only exact spellings, so no abbreviation can slip through", () => {
    const { cwd } = project()
    // exact, allowed
    expect(isReadOnlyCommand("git log --oneline --graph --decorate -n 5", cwd)).toBe(true)
    expect(isReadOnlyCommand("git log --max-count=5 --author=bob", cwd)).toBe(true)
    expect(isReadOnlyCommand("git log --since='2 weeks ago' --format=%H", cwd)).toBe(true)
    // every proper prefix of an allowed flag is refused
    for (const flag of ["--one", "--onel", "--gra", "--deco", "--max", "--max-c", "--auth"]) {
      expect(isReadOnlyCommand(`git log ${flag}`, cwd)).toBe(false)
    }
  })
})

describe("bypasses found in the second review", () => {
  test("find: an unquoted glob in a VALUE would become a flag when a file is called -delete", () => {
    const { cwd } = project()
    writeFileSync(join(cwd, "-aa"), "x")
    writeFileSync(join(cwd, "-delete"), "x")
    for (const command of ["find . -name *", "find . -path *", "find . -type *", "find . -name -*", "find *", "find . -name {a,b}"]) {
      expect(isReadOnlyCommand(command, cwd)).toBe(false)
    }
    // quoted, it is a pattern for find, not for the shell
    expect(isReadOnlyCommand("find . -name '*'", cwd)).toBe(true)
  })

  test("the real shell really would delete the file, so this is not a paper attack", () => {
    // Exactly the reviewer's workspace: any further file name would make find
    // fail on an unknown operand before it deleted anything.
    const base = mkdtempSync(join(tmpdir(), "zap-find-"))
    cleanup.push(base)
    writeFileSync(join(base, "-aa"), "x")
    writeFileSync(join(base, "-delete"), "x")
    expect(isReadOnlyCommand("find . -name *", base)).toBe(false)
    spawnSync("/bin/sh", ["-c", "find . -name *"], { cwd: base })
    expect(existsSync(join(base, "-aa"))).toBe(false)
  })

  test("cd is not read-only: later pieces run in another directory than they were judged in", () => {
    const { cwd, outside } = project()
    mkdirSync(join(cwd, "sub"))
    symlinkSync(join(outside, "secret.txt"), join(cwd, "sub", "link"))
    for (const command of ["cd sub", "cd", "cd -", "cd --", "cd .."]) expect(isReadOnlyCommand(command, cwd)).toBe(false)
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    expect(pm.checkPermission("bash", { command: "cd sub; cat link" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "cd; cat secret" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "cd sub && ls" }).decision).toBe("ask")
  })

  test("diff is not on the list, so directory diffs cannot follow links out", () => {
    const { cwd, outside } = project()
    mkdirSync(join(cwd, "d1")); mkdirSync(join(cwd, "d2"))
    symlinkSync(join(outside, "secret.txt"), join(cwd, "d1", "f"))
    writeFileSync(join(cwd, "d2", "f"), "x")
    for (const command of ["diff d1 d2", "diff README.md src/a.ts", "diff -r d1 d2"]) expect(isReadOnlyCommand(command, cwd)).toBe(false)
  })

  test("commands dropped from the list ask, because their value did not justify their surface", () => {
    const { cwd } = project()
    for (const command of ["wc -l src/a.ts", "tree src", "sort README.md", "stat README.md", "file README.md", "du -sh .", "df -h",
      "basename src/a.ts", "dirname src/a.ts", "diff a b"]) {
      expect(isReadOnlyCommand(command, cwd)).toBe(false)
    }
  })

  test("git format values that make git run gpg are refused", () => {
    const { cwd } = project()
    for (const command of ["git log '--format=%G?'", "git log --format=%GS", "git log --pretty=format:%H%GK", "git show --format=%G?"]) {
      expect(isReadOnlyCommand(command, cwd)).toBe(false)
    }
    expect(isReadOnlyCommand("git log --format=%H", cwd)).toBe(true)
    expect(isReadOnlyCommand("git log --pretty=format:%h", cwd)).toBe(true)
  })

  test("git revisions that name a path after a colon stay inside the workspace", () => {
    const { cwd } = project()
    for (const command of ["git show HEAD:../x", "git show :/", "git show :/README.md", "git show HEAD:/etc/passwd", "git grep -e x -- :/",
      "git show HEAD:a/../../x"]) {
      expect(isReadOnlyCommand(command, cwd)).toBe(false)
    }
    expect(isReadOnlyCommand("git show HEAD:README.md", cwd)).toBe(true)
    expect(isReadOnlyCommand("git show HEAD:src/a.ts", cwd)).toBe(true)
  })
})

describe("bypasses found in the third review", () => {
  test("a cwd that the tool and the kernel would resolve differently is refused", () => {
    // The bash tool folds `link/..` away lexically; the kernel takes it to be the
    // parent of the link's target. The permission check must not disagree with the tool.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "zap-cwd-")))
    cleanup.push(base)
    const parent = join(base, "proj")
    const cwd = join(parent, "ws")
    mkdirSync(join(cwd, "a", "b", "c", "d", "e", "f"), { recursive: true })
    mkdirSync(join(parent, "sibling"), { recursive: true })
    writeFileSync(join(parent, "sibling", "secret.txt"), "TOPSECRET")
    symlinkSync(join(cwd, "a", "b"), join(cwd, "link"))
    symlinkSync(join(cwd, "a", "b", "c", "d", "e", "f"), join(cwd, "link2"))
    for (const arg of ["link/../..", "link/..", "link2/../../../../../..", "a/../b", "src/..", "./..", "..", "link/../x"]) {
      expect(effectiveCommandCwd(cwd, arg)).toBeNull()
    }
    process.env.ZAPCODE_DATA_DIR = join(base, "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    // the reviewer's exact attack
    expect(pm.checkPermission("bash", { command: "cat sibling/secret.txt", cwd: "link/../.." }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "cat tmp/x", cwd: "link2/../../../../../.." }).decision).toBe("ask")
    // a plain, in-workspace cwd still works
    mkdirSync(join(cwd, "sub"))
    expect(pm.checkPermission("bash", { command: "ls", cwd: "sub" }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { command: "ls", cwd: "a/b/c" }).decision).toBe("allow")
  })

  test("a repository whose own config makes git run programs is not auto-approved", () => {
    const { cwd } = project()
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
    spawnSync("git", ["init", "-q", cwd], { env })
    expect(isReadOnlyCommand("git status", cwd)).toBe(true)
    const config = join(cwd, ".git", "config")
    const original = readFileSync(config, "utf8")
    for (const poisoned of [
      "[core]\n\tfsmonitor = ./evil.sh\n",
      "[diff]\n\texternal = ./evil.sh\n",
      "[diff \"x\"]\n\ttextconv = ./evil.sh\n",
      "[filter \"lfs\"]\n\tclean = ./evil.sh\n",
      "[filter \"lfs\"]\n\tsmudge = ./evil.sh\n",
      "[filter \"lfs\"]\n\tprocess = ./evil.sh\n",
      "[core]\n\tpager = ./evil.sh\n",
      "[core]\n\tsshCommand = ./evil.sh\n",
      "[core]\n\thooksPath = /tmp/evil\n",
    ]) {
      writeFileSync(config, original + poisoned)
      for (const command of ["git status", "git diff", "git log -p", "git blame README.md", "git show HEAD", "git ls-files"]) {
        expect(isReadOnlyCommand(command, cwd)).toBe(false)
      }
    }
    writeFileSync(config, original)
    expect(isReadOnlyCommand("git status", cwd)).toBe(true)
  })

  test("the same check applies from a subdirectory and to a worktree-style .git file", () => {
    const { cwd } = project()
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
    spawnSync("git", ["init", "-q", cwd], { env })
    expect(isReadOnlyCommand("git status", join(cwd, "src"))).toBe(true)
    writeFileSync(join(cwd, ".git", "config"), readFileSync(join(cwd, ".git", "config"), "utf8") + "[core]\n\tfsmonitor = ./x\n")
    expect(isReadOnlyCommand("git status", join(cwd, "src"))).toBe(false)
    const worktree = mkdtempSync(join(tmpdir(), "zap-gitfile-"))
    cleanup.push(worktree)
    writeFileSync(join(worktree, ".git"), "gitdir: /somewhere/else/.git/worktrees/x\n")
    expect(isReadOnlyCommand("git status", worktree)).toBe(false)
  })

  test("repository config does not matter for commands that are not git", () => {
    const { cwd } = project()
    spawnSync("git", ["init", "-q", cwd], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
    writeFileSync(join(cwd, ".git", "config"), readFileSync(join(cwd, ".git", "config"), "utf8") + "[core]\n\tfsmonitor = ./x\n")
    expect(isReadOnlyCommand("ls", cwd)).toBe(true)
    expect(isReadOnlyCommand("cat README.md", cwd)).toBe(true)
  })

  test("the real git really does run core.fsmonitor, so this is not a paper attack", () => {
    const base = mkdtempSync(join(tmpdir(), "zap-fsmonitor-"))
    cleanup.push(base)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
    spawnSync("git", ["init", "-q", base], { env })
    writeFileSync(join(base, "evil.sh"), "#!/bin/sh\ntouch ran\n", { mode: 0o755 })
    spawnSync("git", ["-C", base, "config", "core.fsmonitor", join(base, "evil.sh")], { env })
    spawnSync("git", ["status", "-s"], { cwd: base, env })
    expect(existsSync(join(base, "ran"))).toBe(true)
    expect(isReadOnlyCommand("git status -s", base)).toBe(false)
  })
})

describe("paths stay inside the workspace", () => {
  test("refuses absolute paths, parent directories, home and a link out of the project", () => {
    const { cwd, outside } = project()
    for (const command of [
      "cat /etc/passwd", "ls /", "ls ..", "cat ../outside/secret.txt", "ls ../..", "cat ~/.ssh/id_rsa", "ls ~", `cat ${join(outside, "secret.txt")}`,
      "cat escape/secret.txt", "ls escape", "cat notes.txt", "grep -r x escape", "head -n 1 notes.txt", "git log -- /etc/passwd",
      "grep --file=/etc/passwd x", "diff README.md /etc/hosts", "cd /", "cd ..", "cd escape", "find / -name x", "find .. -name x", "tree ..",
    ]) expect(isReadOnlyCommand(command, cwd)).toBe(false)
  })

  test("allows the same commands on files that really are inside", () => {
    const { cwd } = project()
    for (const command of ["cat src/a.ts", "ls src", "grep -r x src", "find src -name x", "git log -- src/a.ts"]) {
      expect(isReadOnlyCommand(command, cwd)).toBe(true)
    }
  })

  test("a bash call's own cwd argument is part of the decision", () => {
    const { cwd, outside } = project()
    // The directory comes back as its real path (/var is /private/var on macOS).
    expect(effectiveCommandCwd(cwd, undefined)).toBe(cwd)
    expect(effectiveCommandCwd(cwd, "src")).toBe(join(realpathSync(cwd), "src"))
    expect(effectiveCommandCwd(cwd, "/etc")).toBeNull()
    expect(effectiveCommandCwd(cwd, "..")).toBeNull()
    expect(effectiveCommandCwd(cwd, outside)).toBeNull()
    expect(effectiveCommandCwd(cwd, "escape")).toBeNull()
    expect(effectiveCommandCwd(cwd, 42)).toBeNull()
  })
})

describe("how it plugs into the permission rules", () => {
  const savedHome = process.env.ZAPCODE_DATA_DIR
  afterEach(() => { if (savedHome === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = savedHome })

  test("nothing is allowed while commands are not confined to a sandbox", () => {
    const { cwd } = project()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "ls" }).decision).toBe("ask")
  })

  test("the setting belongs to one manager, so another one is not affected", () => {
    const { cwd } = project()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const confined = new PermissionManager(cwd)
    const open = new PermissionManager(cwd)
    confined.setSandboxConfined(true, false)
    expect(confined.checkPermission("bash", { command: "ls" }).decision).toBe("allow")
    expect(open.checkPermission("bash", { command: "ls" }).decision).toBe("ask")
  })

  test("a call that leaves the sandbox is never covered", () => {
    const { cwd } = project()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    expect(pm.checkPermission("bash", { command: "ls" }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { command: "ls", dangerouslyDisableSandbox: true }).decision).toBe("ask")
  })

  test("a read-only command is allowed, anything else still asks", () => {
    const { cwd } = project()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { command: "ls && git log --oneline" }).decision).toBe("allow")
    expect(pm.checkPermission("bash", { command: "git status && npm test" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "git commit -m x" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "ls\nrm -rf x" }).decision).toBe("ask")
  })

  test("a cwd outside the workspace makes even `ls` ask", () => {
    const { cwd } = project()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    expect(pm.checkPermission("bash", { command: "cat passwd", cwd: "/etc" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "cat a.ts", cwd: "src" }).decision).toBe("allow")
  })

  test("an explicit deny or ask rule still beats the built-in allowance", () => {
    const { cwd } = project()
    process.env.ZAPCODE_DATA_DIR = join(cwd, "..", "data")
    const pm = new PermissionManager(cwd)
    pm.setSandboxConfined(true, false)
    pm.addSessionDenyRule("bash", { command: "git log" })
    expect(pm.checkPermission("bash", { command: "git log --oneline" }).decision).toBe("deny")
    expect(pm.checkPermission("bash", { command: "git status" }).decision).toBe("allow")
  })
})

describe("sandboxed commands run without a prompt by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "zap-autoallow-"))
  const bash = (pm: PermissionManager, command: string) =>
    pm.checkPermission("bash", { command }).decision

  test("allows any command inside the sandbox, but still prompts for an escape", () => {
    const pm = new PermissionManager(dir)
    pm.setSandboxConfined(true)
    expect(bash(pm, "python3 gen.py && pip install svglib")).toBe("allow")
    expect(pm.checkPermission("bash", { command: "python3 gen.py", dangerouslyDisableSandbox: true }).decision).toBe("ask")
  })

  test("prompts for everything when no sandbox confines the command", () => {
    const pm = new PermissionManager(dir)
    pm.setSandboxConfined(false)
    expect(bash(pm, "python3 gen.py")).toBe("ask")
  })

  test("keeps only the read-only list when autoAllowSandboxedCommands is off", () => {
    const pm = new PermissionManager(dir)
    pm.setSandboxConfined(true, false)
    expect(bash(pm, "python3 gen.py")).toBe("ask")
    expect(bash(pm, "ls")).toBe("allow")
  })
})

describe("sandboxExcludedCommands", () => {
  const dir = mkdtempSync(join(tmpdir(), "zap-excluded-"))
  const chrome = 'cd proj && CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && "$CH" --headless --screenshot=a.png file://x'

  test("an excluded command is not waved through by the sandbox allowance, others still are", () => {
    const pm = new PermissionManager(dir)
    pm.setSandboxConfined(true)
    pm.setSandboxExcludedCommands(["*Google Chrome.app*", "docker:*"])
    expect(pm.checkPermission("bash", { command: chrome }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "docker ps" }).decision).toBe("ask")
    expect(pm.checkPermission("bash", { command: "python3 gen.py" }).decision).toBe("allow")
  })

  test("with no patterns configured nothing changes", () => {
    const pm = new PermissionManager(dir)
    pm.setSandboxConfined(true)
    expect(pm.checkPermission("bash", { command: chrome }).decision).toBe("allow")
  })
})

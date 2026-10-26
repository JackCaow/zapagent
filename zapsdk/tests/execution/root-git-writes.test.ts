import { rootGitArguments, prepareRootGit } from "../../execution/root-git.js";
import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { integrationGitWriteRoots } from "../../execution/workspace-runtime.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import { emptyToolEffects } from "../../tools/effects.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import type { WorkspaceIdentity } from "../../policy/types.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "zap-root-git-"))); cleanup.push(base);
  const root = join(base, "repo"); mkdirSync(root);
  return { base, root };
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }, stdio: ["ignore", "pipe", "pipe"] });
}
function init(root: string) {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "input"), "initial\n"); git(root, "add", "input"); git(root, "commit", "-qm", "initial");
}
function context(root: string, enabled: boolean, mode: WorkspaceIdentity["mode"] = "root", write = [root]) {
  const effects = emptyToolEffects();
  effects.filesystem = [{ kind: "filesystem", operation: "modify", paths: write }];
  return createPlatformSandbox({ platform: "linux", bwrapPath: process.execPath, rootWorkspaceGitWrites: enabled }).createContext({
    executionId: "fixture", workspace: { root, mode }, effects, grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
  });
}
it("requires both Host opt-in and a root workspace write grant", () => {
  const { root } = fixture(); init(root);
  const metadata = join(root, ".git");
  expect(context(root, false).protectedPaths).toContain(metadata);
  expect(context(root, true).writablePaths).not.toContain(metadata);
  expect(context(root, true).protectedPaths).toContain(metadata);
  expect(context(root, true).protectedPaths).toContain(join(root, ".zapcode"));
  for (const mode of ["shared-readonly", "isolated-write"] as const) expect(context(root, true, mode).protectedPaths).toContain(metadata);
  expect(context(root, true, "root", [join(root, "input")]).protectedPaths).toContain(metadata);
});
it("permits only reciprocal worktree metadata and leaves common config outside write roots", () => {
  const { base, root } = fixture(); init(root);
  const linked = join(base, "linked"); git(root, "worktree", "add", "-qb", "linked", linked);
  const metadata = git(linked, "rev-parse", "--absolute-git-dir").trim();
  const sandbox = context(linked, true);
  expect(sandbox.writablePaths).not.toContain(metadata);
  expect(sandbox.writablePaths).not.toContain(join(root, ".git", "objects"));
  expect(sandbox.writablePaths).not.toContain(join(root, ".git", "refs"));
  expect(sandbox.writablePaths).not.toContain(join(root, ".git"));
  expect(sandbox.writablePaths).not.toContain(join(root, ".git", "config"));
  expect(sandbox.protectedPaths).toContain(join(linked, ".git"));
  writeFileSync(join(linked, ".git"), `gitdir: ${join(root, ".git")}\n`);
  expect(integrationGitWriteRoots(linked)).toEqual([]);
  expect(context(linked, true).writablePaths).not.toContain(join(root, ".git"));
});
it("does not follow a symlink pretending to be the repository Git directory", () => {
  const { base, root } = fixture(); const outside = join(base, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(root, ".git"), process.platform === "win32" ? "junction" : "dir");
  expect(integrationGitWriteRoots(root)).toEqual([]);
  expect(context(root, true).writablePaths).not.toContain(outside);
  expect(context(root, true).protectedPaths).toContain(outside);
});

const realSandbox = process.platform !== "win32" && createPlatformSandbox().status().available;
(realSandbox ? it : it.skip)("add, commit, stash and rebase execute through Bash without leaving the OS sandbox", async () => {
  const { base, root } = fixture(); init(root);
  const registry = new ToolRegistry(); registry.register(executeCommandTool({ defaultCwd: root }));
  const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => true,
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "required", allowUnsandboxed: false,
      sandbox: createPlatformSandbox({ rootWorkspaceGitWrites: true, tempRoot: join(base, "scratch") }) }) });
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "feature"), "feature\n");
  const run = async (command: string) => {
    const result = await executor.execute("bash", { command });
    if (!result.success) throw new Error(result.error ?? result.output);
    expect(result.runtime?.broker?.sandboxEnforced).toBe(true);
  };
  await run("git add feature"); await run("git commit -m feature");
  writeFileSync(join(root, "input"), "pending\n");
  await run("git stash push -m pending"); await run("git stash pop");
  git(root, "restore", "input"); git(root, "checkout", "main");
  writeFileSync(join(root, "main-file"), "main\n"); git(root, "add", "main-file"); git(root, "commit", "-qm", "main"); git(root, "checkout", "feature");
  await run("git rebase main");
  expect(git(root, "status", "--porcelain")).toBe("");
  expect(git(root, "log", "--format=%s", "-3").trim().split("\n")).toEqual(["feature", "main", "initial"]);
  expect(readFileSync(join(root, "feature"), "utf8")).toBe("feature\n");
  const denied = await executor.execute("bash", { command: `touch '${join(base, "outside-write")}'` });
  expect(denied.success).toBe(false);
}, 30_000);


it("only parses standalone builtin Git operations with inert arguments", () => {
  expect(rootGitArguments("git commit -m 'subject with spaces'")).toEqual(["commit", "-m", "subject with spaces"]);
  expect(rootGitArguments("git add -- 'a b'")).toEqual(["add", "--", "a b"]);
  for (const command of ["git add . && touch marker", "git -C /tmp add .", "git -c core.editor=sh commit", "git rebase --exec sh main", "git rebase -i main", "git rebase --continue", "git commit -F /tmp/message", "git add $(id)", "env GIT_DIR=/tmp git add .", "./git add .", "git add . > /tmp/log", "git stash branch other", "git add --pathspec-from-file=/tmp/files"]) {
    expect(rootGitArguments(command)).toBeUndefined();
  }
});
it("refuses repository helper/config includes and existing rebase execution state", () => {
  const { root } = fixture(); init(root);
  for (const key of ["filter.test.clean", "merge.test.driver", "include.path", "core.sshcommand", "extensions.worktreeconfig"]) {
    git(root, "config", key, key === "extensions.worktreeconfig" ? "true" : "test");
    expect(prepareRootGit("git add input", root, root)).toBeUndefined();
    git(root, "config", "--unset", key);
  }
  mkdirSync(join(root, ".git", "rebase-merge"));
  writeFileSync(join(root, ".git", "rebase-merge", "git-rebase-todo"), "exec touch marker\n");
  expect(prepareRootGit("git rebase main", root, root)).toBeUndefined();
});
(realSandbox ? it : it.skip)("ordinary shell cannot plant metadata links and trusted Git disables hooks and PATH substitution", async () => {
  const { base, root } = fixture(); init(root);
  const outside = join(base, "outside");
  const fake = join(root, "fake-bin"); mkdirSync(fake);
  writeFileSync(join(fake, "git"), `#!/bin/sh\ntouch '${outside}'\n`, { mode: 0o755 });
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\nln -s '${outside}' '${join(root, ".git", "COMMIT_EDITMSG")}'\ntouch '${outside}'\n`, { mode: 0o755 });
  const registry = new ToolRegistry(); registry.register(executeCommandTool({ defaultCwd: root }));
  const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => true,
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "required", allowUnsandboxed: false,
      sandbox: createPlatformSandbox({ rootWorkspaceGitWrites: true, tempRoot: join(base, "scratch") }) }) });
  const attack = await executor.execute("bash", { command: `ln -s '${outside}' .git/COMMIT_EDITMSG` });
  expect(attack.success).toBe(false);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${savedPath}`;
    const committed = await executor.execute("bash", { command: "git commit --allow-empty -m safe" });
    expect(committed.success).toBe(true);
    expect(committed.runtime?.broker?.sandboxEnforced).toBe(true);
  } finally { process.env.PATH = savedPath; }
  expect(existsSync(outside)).toBe(false);
  expect(readFileSync(join(root, ".git", "COMMIT_EDITMSG"), "utf8")).toBe("safe\n");
});


it("copies only global identity rather than executing global Git configuration", () => {
  const { base, root } = fixture(); init(root);
  git(root, "config", "--unset", "user.name"); git(root, "config", "--unset", "user.email");
  writeFileSync(join(base, ".gitconfig"), '[user]\nname = Global Fixture\nemail = global@example.invalid\n[core]\nhooksPath = /untrusted\n');
  const old = process.env.HOME;
  try {
    process.env.HOME = base;
    const prepared = prepareRootGit("git commit --allow-empty -m identity", root, root);
    expect(prepared?.environment.GIT_AUTHOR_NAME).toBe("Global Fixture");
    expect(prepared?.environment.GIT_COMMITTER_EMAIL).toBe("global@example.invalid");
    expect(prepared?.environment.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(prepared?.args).not.toContain("/untrusted");
  } finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; }
});

(realSandbox ? it : it.skip)("linked worktree Git writes use reciprocal metadata without opening the parent repository to shell", async () => {
  const { base, root } = fixture(); init(root);
  git(root, "branch", "feature");
  writeFileSync(join(root, "main-file"), "main\n"); git(root, "add", "main-file"); git(root, "commit", "-qm", "main");
  const linked = join(base, "linked"); git(root, "worktree", "add", "-q", linked, "feature");
  writeFileSync(join(linked, "feature"), "feature\n");
  const registry = new ToolRegistry(); registry.register(executeCommandTool({ defaultCwd: linked }));
  const executor = new ToolExecutor(registry, { cwd: linked, onApproval: async () => true,
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "required", allowUnsandboxed: false,
      sandbox: createPlatformSandbox({ rootWorkspaceGitWrites: true, tempRoot: join(base, "scratch") }) }) });
  const run = async (command: string) => {
    const result = await executor.execute("bash", { command });
    if (!result.success) throw new Error(result.error ?? result.output);
    expect(result.runtime?.broker?.sandboxEnforced).toBe(true);
  };
  await run("git add feature"); await run("git commit -m feature");
  writeFileSync(join(linked, "input"), "pending\n");
  await run("git stash push -m pending"); await run("git stash pop");
  git(linked, "restore", "input"); await run("git rebase main");
  expect(git(linked, "status", "--porcelain")).toBe("");
  const denied = await executor.execute("bash", { command: `touch '${join(root, ".git", "parent-marker")}'` });
  expect(denied.success).toBe(false);
}, 30_000);


it("accepts inert GitLab CLI remote metadata used by the user's repository", () => {
  const { root } = fixture(); init(root);
  git(root, "config", "remote.origin.glab-resolved-head", "main");
  expect(prepareRootGit("git add input", root, root)?.args.at(-2)).toBe("add");
});

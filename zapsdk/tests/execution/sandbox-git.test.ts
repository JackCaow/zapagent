import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import type { ToolEffects } from "../../tools/effects.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "zap-sandbox-git-"));
  cleanup.push(root);
  return root;
}

function effects(root: string): ToolEffects {
  return {
    filesystem: [{ kind: "filesystem", operation: "read", paths: [root] }, { kind: "filesystem", operation: "modify", paths: [root] }],
    network: [{ kind: "network", operation: "connect", destinations: ["*"], methods: [] }],
    process: [{ kind: "process", operation: "spawn", commandClass: "test" }],
    external: [],
    workspace: { mode: "root-integration" },
    confidence: "declared",
  };
}

function initRepo(root: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  spawnSync("git", ["init", "-q", root], { env });
  writeFileSync(join(root, "a.txt"), "a\n");
  spawnSync("git", ["-C", root, "add", "a.txt"], { env });
  spawnSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "init"], { env });
}

const macStatus = createPlatformSandbox().status();
const describeMac = process.platform === "darwin" && macStatus.available && spawnSync("git", ["--version"]).status === 0
  ? describe : describe.skip;

describeMac("git inside the macOS Seatbelt sandbox (real execution)", () => {
  function run(root: string, command: string): string {
    const e = effects(root);
    const context = createPlatformSandbox().createContext({ executionId: "git", workspace: { root, mode: "root" }, effects: e,
      grant: createCapabilityGrant("call", e, Date.now() + 120_000) });
    const prepared = context.prepareShell(command, { cwd: root });
    try {
      const result = spawnSync(prepared.executable, prepared.args, { env: prepared.env, cwd: root, encoding: "utf8", timeout: 60_000 });
      return `${result.stdout}${result.stderr}`.trim();
    } finally { prepared.release(); }
  }

  test("git is the real binary, not the xcrun shim", () => {
    const root = workspace();
    expect(run(root, "which git")).not.toBe("/usr/bin/git");
    expect(run(root, "git --version")).toContain("git version");
  });

  test("reading a repository works", () => {
    const root = workspace();
    initRepo(root);
    writeFileSync(join(root, "a.txt"), "changed\n");
    const out = run(root, "git status --short; git log --oneline | head -1; git diff --stat | tail -1; git show --stat HEAD | head -1; git ls-files; git blame a.txt | head -1");
    expect(out).toContain("a.txt");
    expect(out).toContain("init");
    expect(out).not.toContain("xcrun");
  });

  test("a networked git command that needs no repository write works", () => {
    const root = workspace();
    const out = run(root, "git ls-remote https://github.com/JackCaow/zapcode-releases.git HEAD 2>&1 | grep -c HEAD");
    expect(out).not.toContain("xcrun");
    expect(out).toContain("1");
  });

  test("a public clone into the workspace works", () => {
    const root = workspace();
    run(root, "git clone -q --depth 1 https://github.com/JackCaow/zapcode-releases.git cl 2>&1 | tail -1");
    expect(existsSync(join(root, "cl", "Formula"))).toBe(true);
  });

  test("the xcrun cache directory is not writable, so the cache cannot be poisoned", () => {
    const root = workspace();
    const dir = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim();
    // Names that merely START like the cache never touch the real cache file.
    const probes = [`${dir}xcrun_db-zap-probe-${process.pid}`, `${dir}xcrun_db_zap_probe_${process.pid}`];
    try {
      const out = run(root, probes.map((probe) => `(echo x > '${probe}') 2>&1 | head -1`).join("; "));
      expect((out.match(/not permitted/g) ?? []).length).toBe(2);
      for (const probe of probes) expect(existsSync(probe)).toBe(false);
    } finally { for (const probe of probes) rmSync(probe, { force: true }); }
  });

  test("the whole .git stays read-only: commits need an approved sandbox escape", () => {
    const root = workspace();
    initRepo(root);
    const configBefore = readFileSync(join(root, ".git", "config"), "utf8");
    const hooksBefore = readdirSync(join(root, ".git", "hooks")).sort();
    writeFileSync(join(root, "a.txt"), "more\n");
    const out = run(root, [
      "git -c user.name=T -c user.email=t@example.com commit -qam two",
      "(printf x >> .git/config)",
      "(printf '#!/bin/sh' > .git/hooks/pre-commit)",
      "(mv .git .g && mv .g .git)",
      "(mkdir -p .git/rebase-merge)",
      "(ln -s /tmp .git/refs/heads/x)",
    ].map((command) => `${command} 2>&1 | head -1`).join("; "));
    expect((out.match(/not permitted/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(configBefore);
    expect(readdirSync(join(root, ".git", "hooks")).sort()).toEqual(hooksBefore);
    expect(existsSync(join(root, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(root, ".git", "refs", "heads", "x"))).toBe(false);
    expect(spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" }).stdout.trim().split("\n").length).toBe(1);
  });
});

describe("the sandbox PATH", () => {
  test("is the host PATH, plus at most one root-owned directory holding the real git", () => {
    const root = workspace();
    const e = effects(root);
    const sandbox = createPlatformSandbox({ platform: "linux", bwrapPath: process.execPath, tempRoot: join(root, "..", "zap-sandbox-git-temp") });
    const context = sandbox.createContext({ executionId: "git", workspace: { root, mode: "root" }, effects: e,
      grant: createCapabilityGrant("call", e, Date.now() + 60_000) });
    const prepared = context.prepareShell("true", { cwd: root });
    try {
      const hostPath = process.env.PATH!;
      expect(prepared.env.PATH!.endsWith(hostPath)).toBe(true);
      const prefix = prepared.env.PATH!.slice(0, prepared.env.PATH!.length - hostPath.length);
      if (prefix) expect(process.platform).toBe("darwin");
    } finally { prepared.release(); }
  });
});

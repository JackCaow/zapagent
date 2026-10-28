import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePrivateGitHistory, materializePrivateGitMetadata } from "../../goal/git-history-snapshot.js";
import { protectedPathsForVm } from "../../execution/zapvm.js";
import { scanCopyTree } from "../../workspace/copy.js";

const suite = process.platform === "darwin" ? describe : describe.skip;
suite("restricted Goal Git history capture", () => {
  it("preserves reachable history without executing repository hooks or filters", async () => {
    const base = await mkdtemp(join(tmpdir(), "zap-history-"));
    try {
      const source = join(base, "source"), marker = join(base, "executed"), destination = join(base, "private");
      execFileSync("git", ["init", source]);
      execFileSync("git", ["-C", source, "config", "user.name", "test"]);
      execFileSync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
      await writeFile(join(source, "a"), "one\n");
      execFileSync("git", ["-C", source, "add", "a"]);
      execFileSync("git", ["-C", source, "commit", "-m", "first"]);
      await writeFile(join(source, "a"), "two\n");
      execFileSync("git", ["-C", source, "commit", "-am", "second"]);
      execFileSync("git", ["-C", source, "branch", "-m", "feature/版本+1"]);
      const expected = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const hook = join(source, ".git", "hooks", "post-checkout");
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      execFileSync("git", ["-C", source, "config", "filter.evil.clean", `touch '${marker}'`]);
      await writeFile(join(source, ".gitattributes"), "* filter=evil\n");
      await capturePrivateGitHistory(source, destination);
      expect(execFileSync("git", [`--git-dir=${destination}/repository.git`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expected);
      expect(execFileSync("git", [`--git-dir=${destination}/repository.git`, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()).toBe("2");
      expect(execFileSync("git", [`--git-dir=${destination}/repository.git`, "symbolic-ref", "HEAD"], { encoding: "utf8" }).trim()).toBe("refs/heads/feature/版本+1");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("fails closed if refs change during capture or alternates are present", async () => {
    const base = await mkdtemp(join(tmpdir(), "zap-history-race-"));
    try {
      const source = join(base, "source");
      execFileSync("git", ["init", source]);
      execFileSync("git", ["-C", source, "config", "user.name", "test"]);
      execFileSync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
      await writeFile(join(source, "a"), "one\n");
      execFileSync("git", ["-C", source, "add", "a"]);
      execFileSync("git", ["-C", source, "commit", "-m", "first"]);
      await expect(capturePrivateGitHistory(source, join(base, "race"), { afterRefsCaptured: async () => {
        execFileSync("git", ["-C", source, "branch", "new-ref"]);
      }})).rejects.toThrow("Git source changed");
      await mkdir(join(source, ".git", "objects", "info"), { recursive: true });
      await writeFile(join(source, ".git", "objects", "info", "alternates"), "/tmp/external\n");
      await expect(capturePrivateGitHistory(source, join(base, "alternate"))).rejects.toThrow("Unsupported Git repository metadata");
      await rm(join(source, ".git", "objects", "info", "alternates"));
      const linked = join(base, "linked"); await mkdir(linked);
      await symlink(join(source, ".git"), join(linked, ".git"));
      await expect(capturePrivateGitHistory(linked, join(base, "symlink"))).rejects.toThrow("symlinked Git");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("enforces the pack limit, timeout, cancellation and private destination", async () => {
    const base = await mkdtemp(join(tmpdir(), "zap-history-limits-"));
    try {
      const source = join(base, "source");
      execFileSync("git", ["init", source]);
      execFileSync("git", ["-C", source, "config", "user.name", "test"]);
      execFileSync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
      await writeFile(join(source, "a"), "payload\n");
      execFileSync("git", ["-C", source, "add", "a"]);
      execFileSync("git", ["-C", source, "commit", "-m", "first"]);
      const limited = join(base, "limited");
      await expect(capturePrivateGitHistory(source, limited, { maxPackBytes: 1 })).rejects.toThrow("pack exceeds resource limit");
      await expect(readFile(limited)).rejects.toMatchObject({ code: "ENOENT" });
      const abort = new AbortController(); abort.abort();
      await expect(capturePrivateGitHistory(source, join(base, "cancelled"), { signal: abort.signal })).rejects.toThrow("cancelled or timed out");
      await expect(capturePrivateGitHistory(source, join(base, "timeout"), { timeoutMs: 1 })).rejects.toThrow("cancelled or timed out");
      await expect(capturePrivateGitHistory(source, "/tmp/not-private-goal-destination")).rejects.toThrow("private owned directory");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("creates isolated Git metadata, carries child commits, and detects replacement", async () => {
    const base = await mkdtemp(join(tmpdir(), "zap-private-git-"));
    try {
      const source = join(base, "source"), work = join(base, "work"), child = join(base, "child");
      execFileSync("git", ["init", source]);
      execFileSync("git", ["-C", source, "config", "user.name", "test"]);
      execFileSync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
      await writeFile(join(source, "a"), "one\n");
      execFileSync("git", ["-C", source, "add", "a"]); execFileSync("git", ["-C", source, "commit", "-m", "original"]);
      const original = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      await capturePrivateGitHistory(source, join(base, "captured"));
      await mkdir(work); await writeFile(join(work, "a"), "one\n");
      const binding = await materializePrivateGitMetadata(join(base, "captured", "repository.git"), work, base);
      await expect(scanCopyTree(work)).rejects.toThrow("Unsafe copy workspace path");
      const files = await scanCopyTree(work, false, true, true, undefined, binding);
      expect(Object.keys(files)).toEqual(["a"]);
      expect(execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(original);
      await writeFile(join(work, "a"), "changed\n");
      execFileSync("git", ["-C", work, "add", "a"]);
      execFileSync("git", ["-C", work, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "private"]);
      const changed = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(changed).not.toBe(original);
      expect(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(original);
      await capturePrivateGitHistory(work, join(base, "child-snapshot"));
      await mkdir(child); await writeFile(join(child, "a"), "changed\n");
      await materializePrivateGitMetadata(join(base, "child-snapshot", "repository.git"), child, base);
      expect(execFileSync("git", ["-C", child, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(changed);
      const identity = { root: work, mode: "isolated-write" as const, privateGitDirectory: binding.directory, privateGitIdentity: { device: binding.device, inode: binding.inode } };
      expect(protectedPathsForVm(identity, false)).not.toContain(".git");
      await rm(binding.directory, { recursive: true }); await mkdir(binding.directory);
      expect(() => protectedPathsForVm(identity, false)).toThrow("identity changed");
      await expect(scanCopyTree(work, false, true, true, undefined, binding)).rejects.toThrow("identity changed");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

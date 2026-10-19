import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  legacyProjectDataSegment,
  resolveGitProjectIdentity,
  resolveProjectDataSegment,
} from "../../utils/project-paths.js";

describe("project data identity", () => {
  it("keeps the legacy cwd segment for non-git paths", () => {
    const cwd = "C:\\a/b:c";
    expect(legacyProjectDataSegment(cwd)).toBe("C--a-b-c");
    expect(resolveProjectDataSegment(cwd)).toBe("C--a-b-c");
  });

  it("uses the same git-backed segment from repo root and subdirectories", () => {
    const repo = mkdtempSync(join(tmpdir(), "zap-project-identity-"));
    try {
      git(repo, "init");
      git(repo, "remote", "add", "origin", "git@github.com:Acme/ZapCode.git");
      const subdir = join(repo, "packages", "app");
      mkdirSync(subdir, { recursive: true });

      const root = resolveProjectDataSegment(repo);
      const child = resolveProjectDataSegment(subdir);

      expect(child).toBe(root);
      expect(root).toMatch(/^git-zapcode-[a-f0-9]{12}$/);
      expect(resolveGitProjectIdentity(repo)).toBe(root);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

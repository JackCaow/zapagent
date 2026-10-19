import { describe, it, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  diffSnapshots,
  formatChangeSummary,
  gitStatusSnapshot,
  type Snapshot,
} from "../../builtin-tools/delegate-changes.js";

const snap = (entries: Array<[string, string]>): Snapshot => new Map(entries);

describe("diffSnapshots", () => {
  it("classifies added / modified / deleted vs before clean", () => {
    const before = snap([]);
    const after = snap([
      ["new.ts", "??"],
      ["edited.ts", " M"],
      ["gone.ts", " D"],
    ]);
    const change = diffSnapshots(before, after)!;
    expect(change.added).toEqual(["new.ts"]);
    expect(change.modified).toEqual(["edited.ts"]);
    expect(change.deleted).toEqual(["gone.ts"]);
  });

  it("reports a path missing from after but present in before as deleted", () => {
    const before = snap([["was-there.ts", "  "]]);
    const after = snap([]);
    const change = diffSnapshots(before, after)!;
    expect(change.deleted).toEqual(["was-there.ts"]);
  });

  it("ignores files dirty before the call when their status didn't change", () => {
    const before = snap([["already-dirty.ts", " M"]]);
    const after = snap([["already-dirty.ts", " M"]]);
    const change = diffSnapshots(before, after)!;
    expect(change.added).toEqual([]);
    expect(change.modified).toEqual([]);
  });

  it("counts a file as modified if its status changed between calls", () => {
    const before = snap([["x.ts", " M"]]);
    const after = snap([["x.ts", "MM"]]);
    const change = diffSnapshots(before, after)!;
    expect(change.modified).toEqual(["x.ts"]);
  });

  it("treats before=null OR after=null as no diff", () => {
    expect(diffSnapshots(null, snap([["x", " M"]]))).toBeNull();
    expect(diffSnapshots(snap([]), null)).toBeNull();
  });

  it("caps each category at 50 with `...and N more`", () => {
    const before = snap([]);
    const afterEntries: Array<[string, string]> = [];
    for (let i = 0; i < 60; i++) afterEntries.push([`f${i}.ts`, "??"]);
    const change = diffSnapshots(before, snap(afterEntries))!;
    expect(change.added.length).toBe(51);
    expect(change.added[50]).toMatch(/\.\.\.and 10 more/);
  });
});

describe("formatChangeSummary", () => {
  it("renders modified/added/deleted lines, omitting empty ones", () => {
    const out = formatChangeSummary("claude", "/r", {
      added: ["new.ts"],
      modified: ["a.ts", "b.ts"],
      deleted: [],
      renamed: [],
    });
    expect(out).toContain("Changes by claude (cwd: /r)");
    expect(out).toContain("Modified (2): a.ts, b.ts");
    expect(out).toContain("Added (1): new.ts");
    expect(out).not.toContain("Deleted");
    expect(out).toContain("Run `git diff` to inspect");
  });

  it("returns empty string when nothing actually changed", () => {
    const out = formatChangeSummary("codex", "/r", {
      added: [], modified: [], deleted: [], renamed: [],
    });
    expect(out).toBe("");
  });
});

function makeRepo(): string {
  const dir = join(tmpdir(), `zapcode-delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "init\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("gitStatusSnapshot", () => {
  it("captures untracked + modified state", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "untracked.ts"), "x\n");
      writeFileSync(join(dir, "README.md"), "changed\n");
      const snapResult = await gitStatusSnapshot(dir);
      expect(snapResult).not.toBeNull();
      expect(snapResult!.has("untracked.ts")).toBe(true);
      expect(snapResult!.has("README.md")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null in a non-git directory", async () => {
    const dir = join(tmpdir(), `zapcode-nogit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const snapResult = await gitStatusSnapshot(dir);
      expect(snapResult).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

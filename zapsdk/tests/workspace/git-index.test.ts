import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentIndexPaths, copyAgentIndex } from "../../workspace/git-index.js";

test("index names are literal relative paths, not traversal or control paths", () => {
  expect(agentIndexPaths("space name\0:(glob)literal\0line\nbreak\0space name\0"))
    .toEqual(["space name", ":(glob)literal", "line\nbreak"]);
  for (const path of ["../outside", "/outside", "C:/outside", "dir/../../outside", "dir\\outside", ".git/config", "dir/.GIT/config", "sparse/"]) {
    expect(() => agentIndexPaths(path + "\0")).toThrow("Unsafe or unsupported");
  }
  expect(() => agentIndexPaths("truncated")).toThrow("Truncated");
});

test("index ingestion rejects redirects and oversized files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-index-safety-")));
  try {
    const repo = join(root, "repo"); const destination = join(root, "copy");
    mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(destination);
    const outside = join(root, "outside"); writeFileSync(outside, "not an index");
    symlinkSync(outside, join(repo, ".git", "index"));
    await expect(copyAgentIndex(repo, destination)).rejects.toThrow();
    rmSync(join(repo, ".git", "index"));
    writeFileSync(join(repo, ".git", "index"), "");
    truncateSync(join(repo, ".git", "index"), 64 * 1024 * 1024 + 1);
    await expect(copyAgentIndex(repo, destination)).rejects.toThrow("bounded regular data");
    rmSync(join(repo, ".git"), { recursive: true });
    symlinkSync(destination, join(repo, ".git"), "junction");
    await expect(copyAgentIndex(repo, destination)).rejects.toThrow("standalone Git");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

(process.platform === "win32" ? test.skip : test)("index ingestion does not block on a FIFO", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-index-fifo-")));
  try {
    const repo = join(root, "repo"); const destination = join(root, "copy");
    mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(destination);
    execFileSync("mkfifo", [join(repo, ".git", "index")]);
    const module = new URL("../../workspace/git-index.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, ["-e", `import {copyAgentIndex} from ${JSON.stringify(module)}; try { await copyAgentIndex(${JSON.stringify(repo)}, ${JSON.stringify(destination)}); process.exit(1); } catch (error) { console.log(error.message); }`], { encoding: "utf8", timeout: 3000 });
    expect(output).toContain("bounded regular data");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

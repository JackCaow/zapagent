import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function futureRealpath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await futureRealpath(dirname(path)), basename(path));
  }
}

/** Only absence of Git or a repository selects copy isolation. Permission,
 * corrupt repository and other Git failures must retain their diagnostics. */
export async function workspaceContext(root: string, tempRoot?: string, copy = false) {
  const realRoot = await realpath(root);
  const git = (cwd: string, args: string[]) => exec("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  if (!copy) {
    let repo: string | undefined;
    try {
      repo = (await git(realRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code !== "ENOENT" && !failure.stderr?.includes("not a git repository")) throw error;
    }
    if (repo) {
      const repoRoot = await realpath(repo);
      if (!isWithin(repoRoot, realRoot)) throw new Error("Workspace root is outside Git repository");
      const common = (await git(repoRoot, ["rev-parse", "--git-common-dir"])).stdout.trim();
      return {
        mode: "isolated-git" as const,
        repoRoot,
        rootRelative: relative(repoRoot, realRoot),
        workspaceTempRoot: tempRoot ?? join(resolve(repoRoot, common), "zap-agent-workspaces"),
      };
    }
  }
  const id = createHash("sha256").update(realRoot).digest("hex");
  return {
    mode: "isolated-copy" as const,
    repoRoot: realRoot,
    rootRelative: "",
    workspaceTempRoot: tempRoot ?? join(tmpdir(), `zap-workspaces-${process.getuid?.() ?? "user"}`, id),
  };
}

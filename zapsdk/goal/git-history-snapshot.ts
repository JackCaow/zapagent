import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { withPersistentGitOperation } from "./git-operation-owner.js";
import type { PrivateGitBinding } from "../workspace/types.js";

/** macOS-only primitive for preparing a private Git object store. It is not a
 * Goal workspace backend: callers must still provide worktree snapshotting,
 * merge/delivery and durable ownership before exposing Git execution. */
const binaries = ["/Applications/Xcode.app/Contents/Developer/usr/bin/git", "/Library/Developer/CommandLineTools/usr/bin/git"];
const environment = { HOME: "/nonexistent", PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
const oid = /^[0-9a-f]{40}$/;

async function trustedGit(): Promise<string | undefined> {
  for (const binary of binaries) {
    if (!existsSync(binary)) continue;
    let path = binary;
    let valid = true;
    while (path !== "/") {
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) { valid = false; break; }
      path = dirname(path);
    }
    if (valid) return binary;
  }
  return undefined;
}

function quote(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error("Unsafe sandbox path");
  return JSON.stringify(path);
}
function profile(readRoot: string, git: string, writeRoot: string): string {
  return `(version 1)(allow default)(deny file-read-data (require-all (vnode-type REGULAR-FILE) (require-not (require-any (literal ${quote(git)}) (subpath ${quote(readRoot)})))))(deny file-write* (require-not (require-any (subpath ${quote(writeRoot)}) (subpath "/dev"))))(deny process-fork)(deny network*)`;
}
function execute(git: string, root: string, args: string[], signal: AbortSignal, input?: string, outputFile?: string, maxBytes = 512 * 1024 * 1024, writeRoot = "/dev"): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Git history capture cancelled or timed out")); return; }
    let fd: number | undefined;
    try { if (outputFile) fd = openSync(outputFile, "wx", 0o600); }
    catch (error) { reject(error); return; }
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile(root, git, writeRoot), git, "-c", "core.precomposeunicode=false", ...args], {
      cwd: root, env: environment, stdio: ["pipe", fd === undefined ? "pipe" : fd, "pipe"],
    });
    if (fd !== undefined) closeSync(fd);
    let overflow = false;
    const abort = () => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const sizeTimer = outputFile ? setInterval(() => {
      try { if (statSync(outputFile).size > maxBytes) { overflow = true; abort(); } } catch { overflow = true; abort(); }
    }, 50) : undefined;
    const out: Buffer[] = [], errors: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill(); else out.push(chunk); });
    child.stderr?.on("data", chunk => { if (Buffer.concat(errors).length < 65536) errors.push(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      if (sizeTimer) clearInterval(sizeTimer);
      if (outputFile) { try { overflow ||= statSync(outputFile).size > maxBytes; } catch { overflow = true; } }
      if (signal.aborted) reject(new Error("Git history capture cancelled or timed out"));
      else if (overflow) reject(new Error("Git history pack exceeds resource limit"));
      else if (code === 0 && size <= 8 * 1024 * 1024) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`Restricted Git command failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(0, 1000)}`));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
async function assertOrdinaryRepo(root: string): Promise<void> {
  const dotGit = await lstat(join(root, ".git"));
  if (!dotGit.isDirectory() || dotGit.isSymbolicLink()) throw new Error("Linked worktrees and symlinked Git directories are unsupported");
  for (const file of ["objects/info/alternates", "objects/info/http-alternates", "commondir", "shallow"]) {
    const entry = await lstat(join(root, ".git", file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry) throw new Error(`Unsupported Git repository metadata: ${file}`);
  }
}

/** Reconstruct reachable SHA-1 history in a new private bare repository.
 * Refs are pinned before packing and checked again afterward; Git's strict
 * index-pack validates the packed object hashes and connectivity. Callers must
 * separately validate a consistent source working-tree snapshot. */
export async function capturePrivateGitHistory(source: string, destination: string, options: { signal?: AbortSignal; timeoutMs?: number; maxPackBytes?: number; afterRefsCaptured?: () => Promise<void> } = {}): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Restricted Git history capture requires macOS Seatbelt");
  if (!isAbsolute(destination) || ["", ".", ".."].includes(basename(destination))) throw new Error("Invalid Git destination");
  const git = await trustedGit();
  if (!git || !existsSync("/usr/bin/sandbox-exec")) throw new Error("Trusted Git or Seatbelt is unavailable");
  const sourceRoot = await realpath(source);
  const destParent = await realpath(dirname(destination));
  const parentInfo = await lstat(destParent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (process.getuid && (parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o077) !== 0))) throw new Error("Git destination parent must be a private owned directory");
  const timeoutMs = options.timeoutMs ?? 120_000, maxPackBytes = options.maxPackBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maxPackBytes) || maxPackBytes < 1 || maxPackBytes > 512 * 1024 * 1024) throw new Error("Invalid Git capture resource limits");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const target = join(destParent, basename(destination));
  if (inside(sourceRoot, target) || inside(target, sourceRoot)) throw new Error("Private Git destination must be separate from the source");
  await assertOrdinaryRepo(sourceRoot);
  if ((await execute(git, sourceRoot, ["-C", sourceRoot, "rev-parse", "--show-object-format"], signal)).trim() !== "sha1") throw new Error("SHA-256 Git repositories are not supported");
  const refsArgs = ["-C", sourceRoot, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"];
  const refs = await execute(git, sourceRoot, refsArgs, signal);
  const records = refs.trimEnd() ? refs.trimEnd().split("\n").map(line => line.split("\0")) : [];
  if (records.some(record => record.length !== 3 || !record[0]!.startsWith("refs/") || !oid.test(record[1]!) || (record[2] && !record[2]!.startsWith("refs/")))) throw new Error("Invalid Git refs");
  let head: string;
  try { head = (await execute(git, sourceRoot, ["-C", sourceRoot, "rev-parse", "--verify", "HEAD"], signal)).trim(); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Git HEAD is unborn or unavailable; Goal requires an existing commit");
  }
  if (!oid.test(head)) throw new Error("Invalid Git HEAD");
  const headName = (await execute(git, sourceRoot, ["-C", sourceRoot, "rev-parse", "--symbolic-full-name", "HEAD"], signal)).trim();
  if (headName !== "HEAD") {
    if (!headName.startsWith("refs/heads/")) throw new Error("Unsupported Git HEAD");
    await execute(git, sourceRoot, ["check-ref-format", headName], signal);
  }
  await options.afterRefsCaptured?.();
  await mkdir(target, { mode: 0o700 });
  const pack = join(target, "source.pack");
  try {
    await execute(git, sourceRoot, ["-C", sourceRoot, "pack-objects", "--revs", "--stdout"], signal, [...new Set([head, ...records.map(record => record[1]!)])].join("\n") + "\n", pack, maxPackBytes, target);
    if (await execute(git, sourceRoot, refsArgs, signal) !== refs || (await execute(git, sourceRoot, ["-C", sourceRoot, "rev-parse", "--verify", "HEAD"], signal)).trim() !== head
      || (await execute(git, sourceRoot, ["-C", sourceRoot, "rev-parse", "--symbolic-full-name", "HEAD"], signal)).trim() !== headName) throw new Error("Git source changed during history capture");
    await assertOrdinaryRepo(sourceRoot);
    const repo = join(target, "repository.git");
    await execute(git, target, ["init", "--bare", "--template=/nonexistent", "--object-format=sha1", repo], signal, undefined, undefined, undefined, target);
    // The temporary pack was created exclusively by the Host and stays outside
    // the source workspace. index-pack reads it by stdin to avoid path escape.
    const packFd = openSync(pack, "r");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", profile(target, git, target), git, "-c", "core.precomposeunicode=false", `--git-dir=${repo}`, "index-pack", "--strict", "--stdin"], { cwd: target, env: environment, stdio: [packFd, "ignore", "pipe"] });
      closeSync(packFd);
      const abort = () => { child.kill("SIGKILL"); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      let errors = ""; child.stderr?.on("data", chunk => { errors += chunk.toString().slice(0, 1000); });
      child.on("error", reject); child.on("close", code => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(new Error("Git history capture cancelled or timed out")); else if (code === 0) resolve(); else reject(new Error(`Git index-pack failed (${code}): ${errors.slice(0, 1000)}`)); });
    });
    for (const [name, value, symref] of records) {
      if (!symref) await execute(git, target, [`--git-dir=${repo}`, "update-ref", name!, value!], signal, undefined, undefined, undefined, target);
    }
    for (const [name, , symref] of records) if (symref) await execute(git, target, [`--git-dir=${repo}`, "symbolic-ref", name!, symref], signal, undefined, undefined, undefined, target);
    if (headName !== "HEAD") await execute(git, target, [`--git-dir=${repo}`, "symbolic-ref", "HEAD", headName], signal, undefined, undefined, undefined, target);
    else await execute(git, target, [`--git-dir=${repo}`, "update-ref", "--no-deref", "HEAD", head], signal, undefined, undefined, undefined, target);
    await execute(git, target, [`--git-dir=${repo}`, "rev-list", "--objects", "--all", "--missing=error"], signal);
    await rm(pack);
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

/** Caller must hold a durable Git-operation marker. Compare source refs and
 * HEAD again after file snapshotting so a changed branch cannot silently bind
 * a worktree to an older captured history. */
export async function assertPrivateGitHistoryMatches(source: string, repository: string): Promise<void> {
  const git = await trustedGit();
  if (process.platform !== "darwin" || !git) throw new Error("Restricted Git history verification is unavailable");
  const root = await realpath(source), repo = await realpath(repository), signal = AbortSignal.timeout(120_000);
  await assertOrdinaryRepo(root);
  const format = "--format=%(refname)%00%(objectname)%00%(symref)";
  const sourceRefs = await execute(git, root, ["-C", root, "for-each-ref", format], signal);
  const savedRefs = await execute(git, repo, [`--git-dir=${repo}`, "for-each-ref", format], signal);
  const sourceHead = await execute(git, root, ["-C", root, "rev-parse", "--verify", "HEAD"], signal);
  const savedHead = await execute(git, repo, [`--git-dir=${repo}`, "rev-parse", "--verify", "HEAD"], signal);
  const sourceName = await execute(git, root, ["-C", root, "rev-parse", "--symbolic-full-name", "HEAD"], signal);
  const savedName = await execute(git, repo, [`--git-dir=${repo}`, "rev-parse", "--symbolic-full-name", "HEAD"], signal);
  if (sourceRefs !== savedRefs || sourceHead !== savedHead || sourceName !== savedName) throw new Error("Git source changed after history capture");
}

/** Host-only metadata preparation for an already isolated, idle workspace.
 * The captured bare store and workspace must both live under the private Goal
 * owner directory. The caller must keep all model tools stopped until this
 * operation returns, persist its binding, and never apply child commits to the
 * user's original repository. */
export async function materializePrivateGitMetadata(repository: string, workspace: string, owner: string, signal?: AbortSignal): Promise<PrivateGitBinding> {
  if (process.platform !== "darwin") throw new Error("Private Git metadata requires macOS Seatbelt");
  const ownerRoot = await realpath(owner), repo = await realpath(repository), work = await realpath(workspace);
  const info = await lstat(ownerRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error("Private Git owner directory must be private and owned");
  }
  if (!inside(ownerRoot, repo) || !inside(ownerRoot, work) || inside(repo, work) || inside(work, repo)) {
    throw new Error("Private Git paths must be separate and owned by the Goal");
  }
  const git = await trustedGit();
  if (!git) throw new Error("Trusted Git is unavailable");
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  async function validate(path: string): Promise<void> {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Private Git snapshot contains unsafe entries");
    if (entry.isDirectory()) for (const name of await readdir(path)) await validate(join(path, name));
  }
  const directory = join(work, ".git");
  return withPersistentGitOperation(ownerRoot, async () => {
    await validate(repo);
    await mkdir(directory, { mode: 0o700 }); // exclusive: never replace a user's .git
    try {
      await cp(repo, directory, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      await validate(directory);
      await writeFile(join(directory, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n", { mode: 0o600 });
      await execute(git, directory, [`--git-dir=${directory}`, "read-tree", "HEAD"], deadline, undefined, undefined, undefined, directory);
      const entry = await lstat(directory, { bigint: true });
      return { directory, device: entry.dev.toString(), inode: entry.ino.toString() };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  });
}

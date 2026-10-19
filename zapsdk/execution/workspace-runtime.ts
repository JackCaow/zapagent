import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/** Host-owned storage, keyed by workspace rather than a command's cwd. */
export function workspaceRuntimeDirectory(base: string, workspace: string): string {
  const key = createHash("sha256").update(realpathSync(workspace)).digest("hex");
  const root = join(base, key);
  for (const path of [base, root, join(root, "home"), join(root, "cache")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Sandbox runtime directory must be a real directory");
    if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Error("Sandbox runtime directory must be private and owned by this user");
  }
  return realpathSync(root);
}

/** Darwin Unix socket paths are limited to 104 bytes. A HOME-derived hashed
 * cache path can exceed that before a tool even appends its socket filename. */
export function workspaceRuntimeTemporaryDirectory(runtimeRoot: string): string {
  const base = process.platform === "darwin" ? "/private/tmp" : realpathSync(tmpdir());
  const owner = process.getuid?.() ?? createHash("sha256").update(homedir()).digest("hex").slice(0, 12);
  const parent = join(base, `zap-${owner}`);
  const root = join(parent, createHash("sha256").update(runtimeRoot).digest("hex").slice(0, 24));
  for (const path of [parent, root]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Sandbox scratch storage must be a private, owned directory");
    }
  }
  return root;
}

/** Only a reciprocal, standard Git linked-worktree layout may add read roots.
 * A repository-controlled .git file alone is not a filesystem grant. */
export function linkedWorktreeReadRoots(workspace: string): string[] {
  const entry = join(workspace, ".git");
  try {
    if (!lstatSync(entry).isFile()) return [];
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(readGitPointer(entry));
    if (!pointer) return [];
    const gitDir = realpathSync(resolve(workspace, pointer[1]!.trim()));
    const common = realpathSync(resolve(gitDir, readGitPointer(join(gitDir, "commondir")).trim()));
    if (dirname(gitDir) !== join(common, "worktrees")) return [];
    const back = realpathSync(resolve(gitDir, readGitPointer(join(gitDir, "gitdir")).trim()));
    if (back !== realpathSync(entry) || !statSync(join(common, "objects")).isDirectory()) return [];
    return [gitDir, common];
  } catch { return []; }
}

function readGitPointer(path: string): string {
  // Repository-controlled metadata must not block the host on a FIFO or read
  // an unbounded file before a sandboxed command has even started.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Git pointer must be a regular file");
    const bytes = Buffer.alloc(4097);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error("Git pointer exceeds path limit");
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

const resolvedTools = new Map<string, string | undefined>();
let sdkRoot: string | undefined;

/** Replace only Apple command shims selected by the original PATH. Prepending
 * Xcode's entire bin directory silently selects its Python and other tools. */
export function macToolShimPath(temp: string, originalPath = process.env.PATH ?? ""): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const shims = join(temp, "tool-shims");
  let count = 0;
  for (const name of ["git", "clang", "clang++", "cc", "c++", "swift", "swiftc"]) {
    const selected = originalPath.split(delimiter).map(dir => join(dir, name)).find(path => {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
    });
    if (selected !== `/usr/bin/${name}`) continue;
    const key = `${process.env.DEVELOPER_DIR ?? ""}:${name}`;
    if (!resolvedTools.has(key)) {
      let target: string | undefined;
      try {
        const found = execFileSync("/usr/bin/xcrun", ["--find", name], {
          encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const canonical = realpathSync(found);
        const dir = statSync(dirname(canonical));
        const file = statSync(canonical);
        if (canonical !== selected && dir.uid === 0 && file.uid === 0 && !((dir.mode | file.mode) & 0o022)) target = canonical;
      } catch { /* Keep the original executable if resolution is unavailable. */ }
      resolvedTools.set(key, target);
    }
    const target = resolvedTools.get(key);
    if (!target) continue;
    mkdirSync(shims, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(shims, name));
    count++;
  }
  return count ? shims : undefined;
}

export function workspaceRuntimeEnvironment(root: string, temp: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: join(root, "home"), TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CACHE_HOME: join(root, "cache"),
    CLANG_MODULE_CACHE_PATH: join(root, "cache", "clang"),
    SWIFT_MODULECACHE_PATH: join(root, "cache", "swift"),
  };
  // rustup's selection metadata must accompany its read-only toolchains.
  const rustup = join(homedir(), ".rustup");
  if (existsSync(rustup)) env.RUSTUP_HOME = rustup;
  if (process.platform === "darwin") {
    try {
      sdkRoot ??= execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
        encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      env.SDKROOT = process.env.SDKROOT ?? sdkRoot;
    } catch { /* SDK discovery failure is reported by the compiler. */ }
  }
  return env;
}

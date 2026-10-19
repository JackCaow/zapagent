import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isWithin } from "./context.js";

export type CopyEntry =
  | { kind: "file"; mode: number; hash: string; bytes: number }
  | { kind: "directory"; mode: number }
  | { kind: "symlink"; target: string };
export type CopyTree = Record<string, CopyEntry>;

/** For owned snapshots/backups only. Preserve read-only directory modes while
 * evidence is live, but permit deleting their contents at explicit cleanup. */
export async function removeOwnedCopyTree(root: string): Promise<void> {
  const info = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(root, (info.mode & 0o777) | 0o700);
    for (const name of await readdir(root)) await removeOwnedCopyTree(join(root, name));
  }
  await rm(root, { recursive: true, force: true });
}

// Same secret-name policy as untracked Git files. Repository control data is
// never copied into a non-Git workspace or accepted as an artifact.
const SECRET = /(^|\/)(\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;
export function excludedCopyPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git") || SECRET.test(path);
}

export function assertCopyPath(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || excludedCopyPath(path)) throw new Error(`Unsafe copy workspace path: ${path}`);
}

export function sameEntry(a?: CopyEntry, b?: CopyEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function copyRegularFile(source: string, destination: string, mode: number): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(destination, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (!bytesWritten) throw new Error("Copy workspace write made no progress");
          offset += bytesWritten;
        }
      }
      await output.chmod(mode);
    } finally { await output.close(); }
  } finally { await input.close(); }
}

export function changedCopyPaths(base: CopyTree, result: CopyTree): string[] {
  return [...new Set([...Object.keys(base), ...Object.keys(result)])]
    .filter((path) => !sameEntry(base[path], result[path])).sort();
}

export function copyTreeOid(tree: CopyTree): string {
  return createHash("sha256").update(JSON.stringify(
    Object.keys(tree).sort().map((path) => [path, tree[path]]),
  )).digest("hex");
}

export async function copyPathOid(path: string, directoryMode?: number): Promise<string | null> {
  const stat = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return copyTreeOid({ ".": { kind: "symlink", target: await readlink(path) } });
  if (stat.isDirectory()) return copyTreeOid({
    ".": { kind: "directory", mode: directoryMode ?? (stat.mode & 0o777) }, ...await scanCopyTree(path, false, false),
  });
  if (!stat.isFile()) throw new Error(`Unsupported merge entry: ${path}`);
  return copyTreeOid({ ".": await fileEntry(path, stat.mode & 0o777) });
}

async function fileEntry(path: string, mode: number): Promise<CopyEntry> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    return { kind: "file", mode, hash: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}

/** Never follows directory links. Hashing is streamed, including large inputs.
 * source=true excludes private/control files from the initial snapshot only;
 * introducing one in a child is rejected rather than silently losing edits. */
export async function scanCopyTree(root: string, source = false, validateLinks = true): Promise<CopyTree> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe copy workspace root: ${root}`);
  const tree: CopyTree = Object.create(null);
  async function walk(prefix: string): Promise<void> {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (source && name.startsWith(".zap-copy-merge-")) {
        throw new Error(`Interrupted copy merge requires recovery before continuing: ${join(root, path)}`);
      }
      if (source && excludedCopyPath(path)) continue;
      assertCopyPath(path);
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        const target = await readlink(full);
        if (validateLinks && (isAbsolute(target) || !isWithin(root, resolve(dirname(full), target)))) {
          throw new Error(`Symlink escapes copy workspace: ${path}`);
        }
        // Reject dangling/cyclic links, and links which escape indirectly.
        if (validateLinks) {
          const resolved = await realpath(full);
          if (!isWithin(root, resolved) || excludedCopyPath(relative(root, resolved).split(sep).join("/"))) {
            throw new Error(`Unsafe copy workspace symlink: ${path}`);
          }
        }
        tree[path] = { kind: "symlink", target };
      } else if (stat.isDirectory()) {
        tree[path] = { kind: "directory", mode: stat.mode & 0o777 };
        await walk(path);
      } else if (stat.isFile()) {
        tree[path] = await fileEntry(full, stat.mode & 0o777);
      } else {
        throw new Error(`Unsupported copy workspace entry (requires a regular file, directory or safe symlink): ${path}`);
      }
    }
  }
  await walk("");
  return tree;
}

/** A new destination only; no hard links and no writes through symlinks. */
export async function materializeCopyTree(
  source: string, target: string, tree: CopyTree, sources?: Map<string, string>,
): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  const paths = Object.keys(tree).sort();
  for (const path of paths) {
    assertCopyPath(path);
    const entry = tree[path];
    const destination = join(target, path);
    if (entry.kind === "directory") {
      await mkdir(destination, { mode: 0o700 });
    } else if (entry.kind === "symlink") {
      await symlink(entry.target, destination);
    } else {
      await copyRegularFile(join(sources?.get(path) ?? source, path), destination, entry.mode);
    }
  }
  // Set directory modes last so read-only directories can be populated.
  for (const path of paths.reverse()) {
    const entry = tree[path];
    if (entry.kind === "directory") await chmod(join(target, path), entry.mode);
  }
  if (copyTreeOid(await scanCopyTree(target)) !== copyTreeOid(tree)) {
    throw new Error("Copy workspace changed while its snapshot was being captured");
  }
}

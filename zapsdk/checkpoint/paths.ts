import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ResolvedCheckpointPath {
  abs: string;
  rel: string;
}

/** Resolve symlinked ancestors even when the leaf does not exist. Returning
 *  null on unexpected filesystem errors is intentional: checkpoint restore is
 *  a privileged write path and must fail closed rather than fall back to a
 *  merely lexical boundary. */
function canonicalizeWithNearestExistingAncestor(path: string): string | null {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missing.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function resolveCheckpointPath(cwd: string, path: string): ResolvedCheckpointPath | null {
  const root = resolve(cwd);
  const lexicalAbs = resolve(root, path);
  const canonicalRoot = canonicalizeWithNearestExistingAncestor(root);
  if (!canonicalRoot) return null;
  const canonicalAbs = canonicalizeWithNearestExistingAncestor(lexicalAbs);
  if (!canonicalAbs) return null;
  let relNative = relative(root, lexicalAbs);
  if (relNative === "" || relNative === ".." || relNative.startsWith(`..${sep}`) || isAbsolute(relNative)) {
    // Accept either spelling of an aliased workspace root. Do not accept an
    // arbitrary outside file symlink merely because its referent is inside.
    if (!isAbsolute(path)) return null;
    relNative = relative(canonicalRoot, canonicalAbs);
    if (!relNative || relNative === ".." || relNative.startsWith(`..${sep}`) || isAbsolute(relNative)) return null;
    const aliasRoot = resolve(lexicalAbs, ...relNative.split(sep).map(() => ".."));
    if (canonicalizeWithNearestExistingAncestor(aliasRoot) !== canonicalRoot) return null;
  }
  const canonicalRel = relative(canonicalRoot, canonicalAbs);
  if (
    canonicalRel === ""
    || canonicalRel === ".."
    || canonicalRel.startsWith(`..${sep}`)
    || isAbsolute(canonicalRel)
  ) {
    return null;
  }
  return { abs: canonicalAbs, rel: relNative.split(sep).join("/") };
}

/** Root aliases (e.g. macOS /var) are supported; links below that root are not. */
export function checkpointSkipReason(cwd: string, path: string): string | undefined {
  const root = resolve(cwd), absolute = resolve(root, path);
  if (absolute === root) return "directory";
  const resolved = resolveCheckpointPath(cwd, path);
  let rel = relative(root, absolute);
  let cursor = root;
  if (resolved && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    cursor = resolve(absolute, ...resolved.rel.split("/").map(() => ".."));
    rel = relative(cursor, absolute);
  }
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) return "symlink"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; return "unreadable"; }
    }
  }
  if (!resolved) return "outside_workspace";
  try {
    const stat = lstatSync(resolved.abs);
    if (stat.isSymbolicLink()) return "symlink";
    if (!stat.isFile()) return "directory";
    if (stat.nlink > 1) return "hardlink";
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable"; }
}

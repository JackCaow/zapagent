import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { AgentArtifact, MergeResult } from "../workspace/types.js";
import { changedCopyPaths, copyPathOid, copyTreeOid, materializeCopyTree, removeOwnedCopyTree, sameEntry, scanCopyTree, type CopyTree } from "../workspace/copy.js";

import { assertCopyMergeParents, COPY_MERGE_JOURNAL, operationOid, recoverCopyMerge, writeCopyMergeJournal, type CopyMergeJournal, type CopyMergeOperation } from "./copy-transaction.js";

const descendant = (path: string, parent: string) => path.startsWith(`${parent}/`);

async function exists(path: string) {
  return lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

/** Conservative file-level conflict resolution. Disjoint files (including new
 * siblings in one directory) compose; competing edits require an Agent decision. */
export async function mergeCopyArtifacts(
  manager: WorkspaceManager,
  artifacts: AgentArtifact[],
  onTrackEdit?: (paths: string[]) => Promise<void>,
): Promise<MergeResult> {
  const artifactIds = artifacts.map((artifact) => artifact.artifactId);
  const rejected = (error: string, conflicts: string[] = []): MergeResult => ({
    success: false, artifactIds, changedPaths: [], conflicts, error,
  });
  const root = manager.rootRepoPath();
  const snapshot = manager.snapshotRepoPath();
  const batch = dirname(snapshot);
  const recovered = await recoverCopyMerge(root, batch, onTrackEdit);
  if (recovered?.state === "committed"
    && JSON.stringify([...recovered.artifactIds].sort()) === JSON.stringify([...artifactIds].sort())) {
    return { success: true, artifactIds, changedPaths: [...new Set(artifacts.flatMap((artifact) => artifact.changedPaths))].sort() };
  }
  const base = await scanCopyTree(snapshot);
  if (copyTreeOid(base) !== artifacts[0].baseOid) return rejected("Copy workspace baseline was modified");
  const desired: CopyTree = Object.assign(Object.create(null), base);
  const sources = new Map<string, string>();
  const touched = new Set<string>();
  for (const artifact of artifacts) {
    const resultPath = manager.copyArtifactPath(artifact);
    if (await realpath(resultPath) !== resultPath) return rejected("Copy artifact escaped its recorded path");
    const result = await scanCopyTree(resultPath);
    const paths = changedCopyPaths(base, result);
    if (copyTreeOid(result) !== artifact.resultOid
      || JSON.stringify(paths) !== JSON.stringify(artifact.changedPaths)) {
      return rejected("Copy artifact content or changed paths were modified");
    }
    const previousPaths = new Set(touched);
    for (const path of paths) {
      for (const previous of previousPaths) {
        if (previous === path && !sameEntry(desired[path], result[path])) {
          return rejected("Agent artifacts contain competing changes", [path]);
        }
        if ((descendant(path, previous) && desired[previous]?.kind !== "directory"
            && !sameEntry(desired[path], result[path]))
          || (descendant(previous, path) && result[path]?.kind !== "directory"
            && !sameEntry(desired[previous], result[previous]))) {
          return rejected("Agent artifacts contain overlapping structural changes", [previous, path]);
        }
      }
      if (result[path]) desired[path] = result[path];
      else delete desired[path];
      sources.set(path, resultPath);
      touched.add(path);
    }
  }
  const changedPaths = changedCopyPaths(base, desired);
  if (!changedPaths.length) return { success: true, artifactIds, changedPaths: [] };
  const operations: CopyMergeOperation[] = [];
  for (const path of changedPaths) {
    if (operations.some((operation) => !operation.modeOnly && descendant(path, operation.path))) continue;
    const before = base[path];
    const after = desired[path];
    const modeOnly = before?.kind === "directory" && after?.kind === "directory";
    operations.push({ path, modeOnly, before: null, after: null,
      beforeMode: before?.kind === "directory" ? before.mode : undefined,
      afterMode: after?.kind === "directory" ? after.mode : undefined });
  }
  // A child may change a file and restore a read-only parent mode. Journal the
  // temporary owner access required to install it, even if the final mode is unchanged.
  for (const operation of [...operations]) {
    let parent = dirname(operation.path);
    while (parent !== ".") {
      const before = base[parent];
      const after = desired[parent];
      if (before?.kind === "directory" && after?.kind === "directory"
        && (before.mode & 0o700) !== 0o700 && !operations.some((item) => item.path === parent)) {
        operations.push({ path: parent, modeOnly: true, before: null, after: null,
          beforeMode: before.mode, afterMode: after.mode });
      }
      parent = dirname(parent);
    }
  }
  const directories = operations.filter((operation) => operation.modeOnly)
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const operation of directories) operation.workingMode = operation.beforeMode! | 0o700;
  async function checkRoot(): Promise<string[]> {
    const current = await scanCopyTree(root, true);
    const conflicts = new Set<string>();
    for (const path of changedPaths) {
      if (!sameEntry(current[path], base[path])) conflicts.add(path);
      // A replaced/deleted directory also owns its descendants. Never discard
      // concurrent additions or excluded private/control files inside it.
      if (base[path]?.kind === "directory" && desired[path]?.kind !== "directory") {
        for (const child of new Set([...Object.keys(base), ...Object.keys(current)])) {
          if (descendant(child, path) && !sameEntry(current[child], base[child])) conflicts.add(child);
        }
        await scanCopyTree(join(root, path));
      }
      let parent = dirname(path);
      while (parent !== ".") {
        if (base[parent]?.kind === "directory" && current[parent]?.kind !== "directory") conflicts.add(parent);
        parent = dirname(parent);
      }
    }
    return [...conflicts].sort();
  }
  let drift = await checkRoot();
  if (drift.length) return rejected("Root workspace changed after the Agent snapshot", drift);

  // Build and hash the combined tree before touching the root. This also catches
  // symlink cycles/escapes introduced by combining otherwise valid siblings.
  const staging = join(dirname(snapshot), `copy-merge-${randomUUID()}`);
  await materializeCopyTree(snapshot, staging, desired, sources);
  await onTrackEdit?.([...new Set([...changedPaths, ...directories.map((operation) => operation.path)])]
    .map((path) => join(root, path)));
  drift = await checkRoot();
  if (drift.length) return rejected("Root workspace changed while preparing the merge", drift);

  // Renames and backups must be on the destination filesystem. Keep the journal
  // on failure if rollback cannot complete; never discard the user's originals.
  const transaction = join(root, `.zap-copy-merge-${randomUUID()}`);
  for (const operation of operations) {
    operation.before = await operationOid(join(snapshot, operation.path), operation.modeOnly);
    operation.after = await operationOid(join(staging, operation.path), operation.modeOnly);
    if (!operation.modeOnly && operation.beforeMode !== undefined) {
      operation.beforeWorking = await copyPathOid(join(snapshot, operation.path), operation.beforeMode | 0o700);
    }
    if (!operation.modeOnly && operation.afterMode !== undefined) {
      operation.afterWorking = await copyPathOid(join(staging, operation.path), operation.afterMode | 0o700);
    }
  }
  const journal: CopyMergeJournal = { version: 1, root, transaction, artifactIds, operations, state: "applying" };
  await writeCopyMergeJournal(batch, journal);
  await mkdir(transaction, { mode: 0o700 });
  try {
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      const path = operation.path;
      if (operation.modeOnly || !desired[path]) continue;
      await cp(join(staging, path), join(transaction, `new-${index}`), {
        recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false,
      });
    }
    for (const operation of directories) {
      await assertCopyMergeParents(root, operation.path);
      const path = join(root, operation.path);
      if (await operationOid(path, true) !== operation.before) throw new Error(`Root directory mode changed: ${operation.path}`);
      await chmod(path, operation.workingMode!);
    }
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      if (operation.modeOnly) continue;
      await assertCopyMergeParents(root, operation.path);
      const target = join(root, operation.path);
      if (await operationOid(target, operation.modeOnly) !== operation.before) {
        throw new Error(`Root changed while applying copy merge: ${operation.path}`);
      }
      if (await exists(target)) {
        if (operation.beforeMode !== undefined) await chmod(target, operation.beforeMode | 0o700);
        await rename(target, join(transaction, `old-${index}`));
        if (operation.beforeMode !== undefined) await chmod(join(transaction, `old-${index}`), operation.beforeMode);
      }
      if (desired[operation.path]) {
        // macOS needs owner write/execute on a directory while moving it across
        // parents, even when both containing directories are writable.
        if (operation.afterMode !== undefined) await chmod(join(transaction, `new-${index}`), operation.afterMode | 0o700);
        await rename(join(transaction, `new-${index}`), target);
        if (operation.afterMode !== undefined) await chmod(target, operation.afterMode);
      }
    }
    for (const operation of [...directories].reverse()) await chmod(join(root, operation.path), operation.afterMode!);
  } catch (error) {
    try {
      await recoverCopyMerge(root, batch);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Copy merge rollback is incomplete; originals retained at ${transaction}`);
    }
    return rejected(error instanceof Error ? error.message : String(error));
  }
  journal.state = "committed";
  await writeCopyMergeJournal(batch, journal);
  await removeOwnedCopyTree(transaction);
  await rm(join(batch, COPY_MERGE_JOURNAL));
  return { success: true, artifactIds, changedPaths };
}

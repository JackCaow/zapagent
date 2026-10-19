import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertCopyPath, copyPathOid, removeOwnedCopyTree } from "../workspace/copy.js";

export interface CopyMergeOperation {
  path: string;
  modeOnly: boolean;
  beforeMode?: number;
  afterMode?: number;
  workingMode?: number;
  before: string | null;
  after: string | null;
  beforeWorking?: string | null;
  afterWorking?: string | null;
}
export interface CopyMergeJournal {
  version: 1;
  root: string;
  transaction: string;
  artifactIds: string[];
  operations: CopyMergeOperation[];
  state: "applying" | "committed";
}
export const COPY_MERGE_JOURNAL = "copy-merge-pending.json";

export async function writeCopyMergeJournal(batch: string, journal: CopyMergeJournal): Promise<void> {
  const target = join(batch, COPY_MERGE_JOURNAL);
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, target);
}

export async function assertCopyMergeParents(root: string, path: string): Promise<void> {
  assertCopyPath(path);
  let parent = dirname(join(root, path));
  while (parent !== root) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe merge parent: ${path}`);
    parent = dirname(parent);
  }
}

export async function operationOid(path: string, modeOnly: boolean): Promise<string | null> {
  if (!modeOnly) return copyPathOid(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Merge directory changed type: ${path}`);
  return `mode:${info.mode & 0o777}`;
}

/** Explicit merge retry recovers its own interrupted transaction. Every path
 * and content is validated before rollback; unknown user edits retain evidence.
 * This never runs as a side effect of merely inspecting/cleaning a workspace. */
export async function recoverCopyMerge(
  root: string, batch: string, onTrackEdit?: (paths: string[]) => Promise<void>,
): Promise<CopyMergeJournal | undefined> {
  const journalPath = join(batch, COPY_MERGE_JOURNAL);
  const stat = await lstat(journalPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe copy merge journal");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as CopyMergeJournal;
  if (journal.version !== 1 || journal.root !== root || !Array.isArray(journal.operations)
    || typeof journal.transaction !== "string" || dirname(journal.transaction) !== root
    || !/^\.zap-copy-merge-[a-f0-9-]{36}$/.test(basename(journal.transaction))
    || (journal.state !== "applying" && journal.state !== "committed")) {
    throw new Error("Invalid copy merge recovery journal");
  }
  const transaction = journal.transaction;
  const transactionStat = await lstat(transaction).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (transactionStat && (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()
    || await realpath(transaction) !== transaction)) throw new Error("Unsafe copy merge recovery directory");
  if (journal.state === "committed") {
    // A durable commit precedes backup removal. Retry only finishes cleanup;
    // it must not revert a successfully delivered change.
    await removeOwnedCopyTree(transaction);
    await rm(journalPath);
    return journal;
  }
  const restore: Array<{ operation: CopyMergeOperation; index: number; backup: boolean }> = [];
  const seen = new Set<string>();
  for (const operation of journal.operations) assertCopyPath(operation.path);
  await onTrackEdit?.(journal.operations.map((operation) => join(root, operation.path)));
  for (let index = 0; index < journal.operations.length; index++) {
    const operation = journal.operations[index];
    assertCopyPath(operation.path);
    if (seen.has(operation.path) || typeof operation.modeOnly !== "boolean"
      || ![operation.before, operation.after].every((id) => id === null || typeof id === "string")
      || ![operation.beforeMode, operation.afterMode].every((mode) => mode === undefined
        || (Number.isInteger(mode) && mode >= 0 && mode <= 0o777))) {
      throw new Error("Invalid copy merge operation");
    }
    seen.add(operation.path);
    await assertCopyMergeParents(root, operation.path);
    const current = await operationOid(join(root, operation.path), operation.modeOnly);
    if (operation.modeOnly) {
      if (operation.before !== `mode:${operation.beforeMode}` || operation.after !== `mode:${operation.afterMode}`
        || !Number.isInteger(operation.beforeMode) || operation.beforeMode! < 0 || operation.beforeMode! > 0o777
        || (operation.workingMode !== undefined && operation.workingMode !== (operation.beforeMode! | 0o700))) {
        throw new Error("Invalid copy merge mode change");
      }
      if (current !== operation.before && current !== operation.after
        && current !== `mode:${operation.workingMode}`) throw new Error(`Root changed during interrupted merge: ${operation.path}`);
      restore.push({ operation, index, backup: false });
      continue;
    }
    const backup = await copyPathOid(join(transaction, `old-${index}`));
    if (backup !== null) {
      if ((backup !== operation.before && backup !== operation.beforeWorking)
        || (current !== null && current !== operation.after && current !== operation.afterWorking)) {
        throw new Error(`Copy merge has conflicting recovery evidence: ${operation.path}`);
      }
    } else if (current !== operation.before && current !== operation.beforeWorking
      && !(operation.before === null && (current === operation.after || current === operation.afterWorking))) {
      throw new Error(`Copy merge original is missing or the root changed: ${operation.path}`);
    }
    restore.push({ operation, index, backup: backup !== null });
  }
  const directories = restore.filter(({ operation }) => operation.modeOnly)
    .sort((a, b) => a.operation.path.split("/").length - b.operation.path.split("/").length);
  for (const { operation } of directories) {
    await assertCopyMergeParents(root, operation.path);
    await chmod(join(root, operation.path), operation.beforeMode! | 0o700);
  }
  // Parent paths cannot overlap structural operations produced by the planner.
  for (const { operation, index, backup } of restore.reverse()) {
    await assertCopyMergeParents(root, operation.path);
    const target = join(root, operation.path);
    if (operation.modeOnly) continue;
    if (backup) {
      await removeOwnedCopyTree(target);
      const original = join(transaction, `old-${index}`);
      if (operation.beforeMode !== undefined) await chmod(original, operation.beforeMode | 0o700);
      await rename(original, target);
      if (operation.beforeMode !== undefined) await chmod(target, operation.beforeMode);
    } else if (operation.before === null) await removeOwnedCopyTree(target);
    else if (operation.beforeMode !== undefined) await chmod(target, operation.beforeMode);
  }
  for (const { operation } of directories.reverse()) {
    await chmod(join(root, operation.path), operation.beforeMode!);
  }
  await removeOwnedCopyTree(transaction);
  await rm(journalPath);
}

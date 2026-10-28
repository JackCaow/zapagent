import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const MARKER = "git-operation.json";
const tails = new Map<string, Promise<void>>();
const activeOwner = new AsyncLocalStorage<string>();

function ownerDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Goal Git owner directory must be absolute");
  const path = realpathSync(directory);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error("Goal Git owner directory must be private and owned");
  }
  return path;
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** A leftover marker is deliberately never inferred safe from a PID or timeout. */
export function assertNoUnresolvedGitOperation(directory: string): void {
  const path = join(ownerDirectory(directory), MARKER);
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("GOAL_GIT_OPERATION_UNCONFIRMED");
}

/** Mark ownership *before* starting any Git process. Only a successful action
 * whose subprocesses were awaited may retire the marker. A failure, abort, or
 * process death remains blocked until explicit reconciliation is available. */
export async function withPersistentGitOperation<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const root = ownerDirectory(directory);
  if (activeOwner.getStore() === root) throw new Error("GOAL_GIT_OPERATION_REENTRANT");
  const previous = tails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  tails.set(root, tail);
  await previous;
  try { return await activeOwner.run(root, () => executeOwned(root, action)); }
  finally { if (tails.get(root) === tail) tails.delete(root); release(); }
}

async function executeOwned<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = join(root, MARKER), id = randomUUID();
  const marker = JSON.stringify({ version: 1, id, pid: process.pid, startedAt: Date.now() });
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("GOAL_GIT_OPERATION_UNCONFIRMED"); throw error; }
  try { writeFileSync(fd, marker); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(root);
  const value = await action();
  // Refuse to retire a marker which was removed or replaced during the action.
  const readFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (readFileSync(readFd, "utf8") !== marker) throw new Error("GOAL_GIT_OPERATION_OWNER_CHANGED"); }
  finally { closeSync(readFd); }
  unlinkSync(path);
  syncDirectory(root);
  return value;
}

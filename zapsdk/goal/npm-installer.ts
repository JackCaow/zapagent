import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { copyPathOid, materializeCopyTree, removeOwnedCopyTree, scanCopyTree } from "../workspace/copy.js";
import { COPY_MERGE_JOURNAL, recoverCopyMerge, writeCopyMergeJournal, type CopyMergeJournal } from "../merge/copy-transaction.js";

/** Host preparation only. A caller must still execute the returned fixed argv
 * through an authorized, offline broker that proves all descendants stopped.
 * Merely running the command, or having an OS filesystem sandbox, is not that
 * proof. The immutable inputs must stay fenced until the command has stopped. */
export interface PreparedNpmInstall {
  readonly version: 1;
  readonly workspace: string;
  readonly privateRoot: string;
  readonly directory: string;
  readonly cleanupToken: string;
  readonly cachePath: string;
  /** Host-owned inputs for an eventual read-only VM mount. These are not
   * sufficient by themselves to fence a workspace-backed installation. */
  readonly snapshotPath: string;
  readonly lockDigest: string;
  readonly manifestDigest: string;
  readonly tarballs: number;
  readonly bytes: number;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface NpmInstallPreparation {
  workspace: string;
  /** Host-owned storage, outside the workspace and not writable by the Agent. */
  privateRoot: string;
  /** Host-selected, trusted absolute executables; never supplied by the model. */
  nodeExecutable?: string;
  npmCliScript?: string;
  /** VM-only preparation does not depend on a Host Node/npm installation. */
  vmOnly?: boolean;
  signal?: AbortSignal;
  /** Host/test transport. Implementations must perform the same GET request. */
  fetch?: typeof fetch;
  maxTarballBytes?: number;
  maxTotalBytes?: number;
}

export interface NpmVmWorkspace {
  /** A Host-owned directory, never the worker's writable workspace. */
  readonly workspace: string;
  /** Guest paths bind-mounted read-only by the execution backend. */
  readonly protectedPaths: readonly string[];
  /** Fixed guest arguments; the caller must launch via the sealed VM broker. */
  readonly argv: readonly string[];
}

const DEFAULT_TARBALL_LIMIT = 64 * 1024 * 1024;
const DEFAULT_TOTAL_LIMIT = 512 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGES = 5000;

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}
function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) throw new Error("Invalid npm preparation resource limit");
  return value;
}

async function readRegular(path: string, maximum: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw new Error("Npm input must be a bounded regular file");
    const data = new Uint8Array(Number(before.size));
    for (let offset = 0; offset < data.length;) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error("Npm input changed while reading");
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Npm input changed while reading");
    return data;
  } finally { await file.close(); }
}

async function assertNoProjectNpmrc(workspace: string): Promise<void> {
  try { await lstat(join(workspace, ".npmrc")); throw new Error("Project .npmrc must be removed or explicitly supported before Goal npm installation"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

interface LockedTarball { url: string; hex: string }
function lockedTarballs(lockBytes: Uint8Array): LockedTarball[] {
  let lock: unknown;
  try { lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes)); }
  catch { throw new Error("Invalid npm package-lock.json"); }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) throw new Error("Invalid npm package-lock.json");
  const record = lock as Record<string, unknown>;
  if (record.lockfileVersion !== 3 || !record.packages || typeof record.packages !== "object" || Array.isArray(record.packages)) throw new Error("Goal npm installation requires package-lock.json v3");
  const entries = Object.entries(record.packages as Record<string, unknown>);
  if (entries.length > MAX_PACKAGES + 1) throw new Error("Npm lockfile has too many packages");
  const byHash = new Map<string, LockedTarball>();
  for (const [path, value] of entries) {
    if (path === "") continue;
    if (!path.startsWith("node_modules/") || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || path.includes("\\")
      || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported local or linked npm dependency");
    const entry = value as Record<string, unknown>;
    if (entry.link || typeof entry.resolved !== "string" || typeof entry.integrity !== "string") throw new Error("Npm dependency must have a registry tarball and integrity");
    let url: URL;
    try { url = new URL(entry.resolved); } catch { throw new Error("Invalid npm tarball URL"); }
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password || url.search || url.hash
      || !/^\/(?:@[^/%]+\/)?[^/%]+\/-\/[^/%]+\.tgz$/.test(url.pathname)) throw new Error("Only direct official npm registry tarball URLs are supported");
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity);
    if (!match) throw new Error("Npm tarball requires a single SHA-512 integrity value");
    const digest = Buffer.from(match[1]!, "base64");
    if (digest.length !== 64 || digest.toString("base64") !== match[1]) throw new Error("Invalid npm SHA-512 integrity");
    const hex = digest.toString("hex");
    if (!byHash.has(hex)) byHash.set(hex, { url: url.toString(), hex });
  }
  return [...byHash.values()];
}

async function download(url: string, request: typeof fetch, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const response = await request(url, { method: "GET", redirect: "manual", credentials: "omit", signal });
  if (!response.ok || response.status >= 300 || response.redirected) throw new Error(`Npm tarball GET failed (${response.status}); redirects are not allowed`);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new Error("Npm tarball exceeds resource limit");
  if (!response.body) throw new Error("Npm tarball response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) throw new Error("Npm tarball exceeds resource limit");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes);
}

/** Only prefetches official immutable npm tarballs. No shell or package code
 * is executed. Network is exclusively the host's explicit, credential-free
 * GET requests; no CONNECT proxy is treated as an HTTP method boundary. */
export async function prepareNpmOfflineInstall(input: NpmInstallPreparation): Promise<PreparedNpmInstall> {
  const workspace = await realpath(input.workspace);
  if (!(await lstat(workspace)).isDirectory()) throw new Error("Npm workspace must be a directory");
  await mkdir(input.privateRoot, { recursive: true, mode: 0o700 });
  const privateStat = await lstat(input.privateRoot);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()
    || (process.getuid && (privateStat.uid !== process.getuid() || (privateStat.mode & 0o077) !== 0))) throw new Error("Npm private root must be a private owned directory");
  const privateRoot = await realpath(input.privateRoot);
  if (inside(workspace, privateRoot) || inside(privateRoot, workspace)) throw new Error("Npm private root must be separate from its workspace");
  let nodeExecutable: string | undefined, npmCliScript: string | undefined;
  if (!input.vmOnly) {
    if (!input.nodeExecutable || !input.npmCliScript || !isAbsolute(input.nodeExecutable) || !isAbsolute(input.npmCliScript)) throw new Error("Host npm toolchain paths must be absolute");
    nodeExecutable = await realpath(input.nodeExecutable); npmCliScript = await realpath(input.npmCliScript);
    if (inside(workspace, nodeExecutable) || inside(workspace, npmCliScript)
      || !(await lstat(nodeExecutable)).isFile() || !(await lstat(npmCliScript)).isFile()) throw new Error("Host npm toolchain must be regular files outside the workspace");
  }
  await assertNoProjectNpmrc(workspace);
  const manifest = await readRegular(join(workspace, "package.json"), MAX_LOCK_BYTES);
  const lock = await readRegular(join(workspace, "package-lock.json"), MAX_LOCK_BYTES);
  const tarballs = lockedTarballs(lock);
  const tarLimit = limit(input.maxTarballBytes, DEFAULT_TARBALL_LIMIT);
  const totalLimit = limit(input.maxTotalBytes, DEFAULT_TOTAL_LIMIT);
  const directory = await mkdtemp(join(privateRoot, `npm-${randomUUID()}-`));
  const cleanupToken = randomUUID();
  const cachePath = join(directory, "cache"), snapshotPath = join(directory, "inputs"), home = join(directory, "home"), userConfig = join(directory, "user.npmrc"), globalConfig = join(directory, "global.npmrc");
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(snapshotPath, { mode: 0o700 });
    await mkdir(cachePath, { mode: 0o700 });
    await writeFile(join(snapshotPath, "package.json"), manifest, { flag: "wx", mode: 0o600 });
    await writeFile(join(snapshotPath, "package-lock.json"), lock, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, ".goal-npm-owner"), cleanupToken, { flag: "wx", mode: 0o600 });
    await writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
    await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });
    let total = 0;
    for (const tarball of tarballs) {
      const data = await download(tarball.url, input.fetch ?? fetch, Math.min(tarLimit, totalLimit - total), input.signal);
      const digest = createHash("sha512").update(data).digest();
      if (!timingSafeEqual(digest, Buffer.from(tarball.hex, "hex"))) throw new Error("Npm tarball integrity mismatch");
      total += data.byteLength;
      const path = join(cachePath, "_cacache", "content-v2", "sha512", tarball.hex.slice(0, 2), tarball.hex.slice(2, 4), tarball.hex.slice(4));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
    }
    await assertNoProjectNpmrc(workspace);
    if (sha256(await readRegular(join(workspace, "package.json"), MAX_LOCK_BYTES)) !== sha256(manifest)
      || sha256(await readRegular(join(workspace, "package-lock.json"), MAX_LOCK_BYTES)) !== sha256(lock)) throw new Error("Npm manifests changed during preparation");
    return { version: 1, workspace, privateRoot, directory, cleanupToken, cachePath, snapshotPath, lockDigest: sha256(lock), manifestDigest: sha256(manifest), tarballs: tarballs.length, bytes: total,
      argv: nodeExecutable && npmCliScript ? [nodeExecutable, npmCliScript, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--cache", cachePath, "--userconfig", userConfig, "--globalconfig", globalConfig] : [],
      // Host must replace the process environment with this exact allowlist,
      // not merge it with its own credentials, NODE_OPTIONS or npm_config_*.
      environment: { HOME: home, PATH: "", npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Host must call immediately before execution, with the workspace fenced. */
export async function revalidateNpmOfflineInstall(prepared: PreparedNpmInstall): Promise<void> {
  if (prepared.version !== 1 || prepared.snapshotPath !== join(prepared.directory, "inputs") || await realpath(prepared.workspace) !== prepared.workspace) throw new Error("Npm workspace identity changed");
  await assertNoProjectNpmrc(prepared.workspace);
  const manifest = await readRegular(join(prepared.workspace, "package.json"), MAX_LOCK_BYTES);
  const lock = await readRegular(join(prepared.workspace, "package-lock.json"), MAX_LOCK_BYTES);
  if (sha256(manifest) !== prepared.manifestDigest || sha256(lock) !== prepared.lockDigest) throw new Error("Npm manifests changed before installation");
  const snapshotManifest = await readRegular(join(prepared.snapshotPath, "package.json"), MAX_LOCK_BYTES);
  const snapshotLock = await readRegular(join(prepared.snapshotPath, "package-lock.json"), MAX_LOCK_BYTES);
  if (sha256(snapshotManifest) !== prepared.manifestDigest || sha256(snapshotLock) !== prepared.lockDigest) throw new Error("Npm private inputs changed before installation");
}

/** Verify that a model has not changed the inputs of an already installed
 * dependency tree. The caller must ensure no model writer is still running. */
export async function assertNpmInputsUnchanged(workspace: string, proof: { manifestDigest: string; lockDigest: string }): Promise<void> {
  await assertNoProjectNpmrc(workspace);
  const manifest = await readRegular(join(workspace, "package.json"), MAX_LOCK_BYTES);
  const lock = await readRegular(join(workspace, "package-lock.json"), MAX_LOCK_BYTES);
  if (sha256(manifest) !== proof.manifestDigest || sha256(lock) !== proof.lockDigest) throw new Error("GOAL_NPM_INPUTS_MODIFIED");
}

/** Prepare a separate VM workspace for the downloaded inputs. The caller must
 * mount protectedPaths read-only, disable network, and verify the VM's seal
 * receipt before reading output. This function does not install or import
 * node_modules and does not establish a workspace lock. */
export async function createNpmVmWorkspace(prepared: PreparedNpmInstall): Promise<NpmVmWorkspace> {
  await revalidateNpmOfflineInstall(prepared);
  const workspace = join(prepared.directory, "vm-workspace");
  await mkdir(workspace, { mode: 0o700 });
  try {
    const manifest = await readRegular(join(prepared.snapshotPath, "package.json"), MAX_LOCK_BYTES);
    const lock = await readRegular(join(prepared.snapshotPath, "package-lock.json"), MAX_LOCK_BYTES);
    if (sha256(manifest) !== prepared.manifestDigest || sha256(lock) !== prepared.lockDigest) throw new Error("Npm private inputs changed during staging");
    await writeFile(join(workspace, "package.json"), manifest, { flag: "wx", mode: 0o444 });
    await writeFile(join(workspace, "package-lock.json"), lock, { flag: "wx", mode: 0o444 });
    const controls = join(workspace, ".zapcode");
    await mkdir(controls, { mode: 0o755 });
    await cp(prepared.cachePath, join(controls, "cache"), { recursive: true, errorOnExist: true, force: false });
    await verifyStagedCache(join(controls, "cache"), lock);
    await makeReadableCache(join(controls, "cache"));
    await writeFile(join(controls, "user.npmrc"), "", { flag: "wx", mode: 0o444 });
    await writeFile(join(controls, "global.npmrc"), "", { flag: "wx", mode: 0o444 });
    return { workspace, protectedPaths: [".zapcode", "package.json", "package-lock.json"],
      argv: ["/usr/bin/env", "-i", "HOME=/tmp", "PATH=/usr/bin:/bin", "/usr/bin/npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--logs-max=0", "--cache", "/workspace/.zapcode/cache", "--userconfig", "/workspace/.zapcode/user.npmrc", "--globalconfig", "/workspace/.zapcode/global.npmrc"] };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

/** Host-only integration contract. The lock must exclude every Goal operation
 * that can read or write this workspace, including child agents, until the
 * callback settles, with exclusive ownership of the source and both parent
 * directories. publishNoReplace must be the OS atomic no-replace rename
 * primitive, without a copy fallback. It does not prove source path identity.
 * Neither capability is model-controlled. */
export interface NpmImportCapabilities {
  withExclusiveWorkspace<T>(workspace: string, action: () => Promise<T>): Promise<T>;
  publishNoReplace(source: string, destination: string): Promise<void>;
}

/** Import only after the caller has authenticated the strict VM receipt for
 * this exact execution. A private journal remains after a process interruption;
 * parent directories are not fsynced, so power-loss recovery is not promised.
 * Recovery must itself run under the same lock. */
export async function importNpmVmWorkspace(prepared: PreparedNpmInstall, stage: NpmVmWorkspace,
  receipt: { state: "sealed"; executionId: string } | undefined, expectedExecutionId: string,
  capabilities: NpmImportCapabilities): Promise<void> {
  if (!receipt || receipt.state !== "sealed" || !expectedExecutionId || receipt.executionId !== expectedExecutionId) throw new Error("Npm VM process seal is unconfirmed");
  if (stage.workspace !== join(prepared.directory, "vm-workspace") || await realpath(stage.workspace) !== stage.workspace) throw new Error("Invalid npm VM workspace");
  await capabilities.withExclusiveWorkspace(prepared.workspace, async () => {
    await revalidateNpmOfflineInstall(prepared);
    const target = join(prepared.workspace, "node_modules");
    try { await lstat(target); throw new Error("node_modules already exists; refusing to replace it"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // An interrupted prior import is never silently reused or removed.
    try { await lstat(join(prepared.directory, COPY_MERGE_JOURNAL)); throw new Error("Npm import requires explicit recovery"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const modules = join(stage.workspace, "node_modules");
    const tree = await scanCopyTree(modules);
    const transaction = join(prepared.workspace, `.zap-copy-merge-${randomUUID()}`);
    await mkdir(transaction, { mode: 0o700 });
    let journaled = false;
    try {
      const staged = join(transaction, "new-0");
      await materializeCopyTree(modules, staged, tree);
      const after = await copyPathOid(staged);
      if (!after) throw new Error("Npm staged output disappeared");
      const journal: CopyMergeJournal = { version: 1, root: prepared.workspace, transaction,
        artifactIds: [`npm:${expectedExecutionId}`], operations: [{ path: "node_modules", modeOnly: false, before: null, after }], state: "applying" };
      await writeCopyMergeJournal(prepared.directory, journal);
      journaled = true;
      await revalidateNpmOfflineInstall(prepared);
      await capabilities.publishNoReplace(staged, target);
      journal.state = "committed";
      await writeCopyMergeJournal(prepared.directory, journal);
      await removeOwnedCopyTree(transaction);
      await rm(join(prepared.directory, COPY_MERGE_JOURNAL));
    } catch (error) {
      if (!journaled) await removeOwnedCopyTree(transaction);
      // Once intent is durable, even an error from the publish callback may
      // follow a completed rename; retain the journal for explicit recovery.
      throw error;
    }
  });
}

export async function recoverNpmVmImport(prepared: PreparedNpmInstall, capabilities: NpmImportCapabilities): Promise<void> {
  await capabilities.withExclusiveWorkspace(prepared.workspace, async () => { await recoverCopyMerge(prepared.workspace, prepared.directory); });
}

async function verifyStagedCache(cache: string, lock: Uint8Array): Promise<void> {
  const expected = new Map(lockedTarballs(lock).map(({ hex }) => [join("_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), hex]));
  let files = 0;
  const visit = async (path: string, rel: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Npm cache must not contain symlinks");
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry), join(rel, entry));
      return;
    }
    if (!info.isFile()) throw new Error("Npm cache must contain only regular files");
    const hex = expected.get(rel);
    if (!hex) throw new Error("Npm cache contains an unexpected file");
    const bytes = await readRegular(path, DEFAULT_TARBALL_LIMIT);
    if (createHash("sha512").update(bytes).digest("hex") !== hex) throw new Error("Npm staged cache integrity mismatch");
    files += 1;
  };
  await visit(cache, "");
  if (files !== expected.size) throw new Error("Npm staged cache is incomplete");
}

async function makeReadableCache(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Npm cache must not contain symlinks");
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path)) await makeReadableCache(join(path, entry));
    return;
  }
  if (!info.isFile()) throw new Error("Npm cache must contain only regular files");
  await chmod(path, 0o444);
}

/** The Host must establish process termination before removing the cache. */
export async function cleanupNpmOfflineInstall(prepared: PreparedNpmInstall, trustedPrivateRoot: string): Promise<void> {
  const root = await realpath(trustedPrivateRoot);
  const info = await lstat(prepared.directory);
  if (root !== prepared.privateRoot || dirname(prepared.directory) !== root || !info.isDirectory() || info.isSymbolicLink()
    || !/^npm-[0-9a-f-]{36}-[A-Za-z0-9]{6}$/.test(prepared.directory.slice(root.length + 1))
    || Buffer.from(await readRegular(join(prepared.directory, ".goal-npm-owner"), 128)).toString("utf8") !== prepared.cleanupToken) {
    throw new Error("Invalid Host-owned npm preparation");
  }
  try { await lstat(join(prepared.directory, COPY_MERGE_JOURNAL)); throw new Error("Npm import requires explicit recovery before cleanup"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rm(prepared.directory, { recursive: true, force: true });
}

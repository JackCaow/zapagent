import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AgentArtifact,
  WorkspaceLease,
  WorkspaceLifecycleHandler,
} from "./types.js";
import {
  readWorkspaceBatchMarker,
  validateWorkspaceBatchBoundary,
  writeWorkspaceBatchMarker,
  type WorkspaceOwnerIdentity,
} from "./marker.js";
import {
  WorkspaceRetentionManager,
  type WorkspaceRetentionPolicy,
  type WorkspaceRetentionReport,
} from "./retention.js";
import { futureRealpath, isWithin, workspaceContext } from "./context.js";
import { changedCopyPaths, copyTreeOid, materializeCopyTree, removeOwnedCopyTree, scanCopyTree } from "./copy.js";
import { COPY_MERGE_JOURNAL } from "../merge/copy-transaction.js";
import { agentIndexPaths, copyAgentIndex } from "./git-index.js";
import { assertPrivateGitHistoryMatches, capturePrivateGitHistory, materializePrivateGitMetadata } from "../goal/git-history-snapshot.js";
import { withPersistentGitOperation } from "../goal/git-operation-owner.js";

const execFileAsync = promisify(execFile);

interface GitOutput {
  stdout: string;
  stderr: string;
}

const SECRET_UNTRACKED = /(^|\/)(\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;

function safeRunId(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return safe || "agent";
}

function safeRepoPath(path: string): boolean {
  return path.length > 0 && path !== ".git" && !path.startsWith(`.git${sep}`) &&
    !path.startsWith("../") && path !== "..";
}

async function git(cwd: string, args: string[]): Promise<GitOutput> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Artifact commands never consult child-controlled config, hooks or objects.
 * An optional copied index is used only for a read-only filename inventory. */
async function artifactGit(cwd: string, args: string[], indexFile?: string): Promise<GitOutput> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = await execFileAsync("git", [
    "--no-optional-locks", "--literal-pathspecs",
    "-c", `core.hooksPath=${nullFile}`, "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_SYSTEM: nullFile,
      ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) } });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function copySnapshotEntry(sourceRoot: string, targetRoot: string, path: string): Promise<void> {
  if (!safeRepoPath(path)) return;
  const source = join(sourceRoot, path);
  const target = join(targetRoot, path);
  let info;
  try {
    info = await lstat(source);
  } catch {
    await rm(target, { recursive: true, force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    return;
  }
  await copyFile(source, target);
}

export interface WorkspaceManagerOptions {
  root: string;
  /** Fail closed if initialization discovers a Git backend. */
  forbidGit?: boolean;
  /** Host-only Goal hybrid: copy source files and attach independently
   * reconstructed metadata. Commits stay private and are never delivered. */
  copyWithPrivateGit?: { ownerDirectory: string; snapshotRepository: string };
  /** Snapshot the Host-bound parent clone when a Goal child is acquired. */
  capturePrivateGitFromRoot?: { ownerDirectory: string; sourceBinding: import("./types.js").PrivateGitBinding };
  tempRoot?: string;
  onLifecycle?: WorkspaceLifecycleHandler;
  owner?: WorkspaceOwnerIdentity;
  /** Crash-left workspace retention. Omitted for embedders that manage their
   * own lifecycle; production Runtime enables it by default. */
  retention?: false | Partial<WorkspaceRetentionPolicy>;
  protectedBatchPaths?: () => Iterable<string> | Promise<Iterable<string>>;
  onRetention?: (report: WorkspaceRetentionReport) => void | Promise<void>;
}

export interface HydrateWorkspaceInput {
  leases: WorkspaceLease[];
  artifacts: AgentArtifact[];
}

/** Creates a single immutable dirty-worktree snapshot, then clones that
 * snapshot for each writing Agent. It never modifies the root index or refs. */
export class WorkspaceManager {
  readonly root: string;
  private tempRoot?: string;
  private forbidGit: boolean;
  private copyWithPrivateGit?: WorkspaceManagerOptions["copyWithPrivateGit"];
  private capturePrivateGitFromRoot?: WorkspaceManagerOptions["capturePrivateGitFromRoot"];
  private batchRoot?: string;
  private workspaceTempRoot?: string;
  private repoRoot?: string;
  private rootRelative = "";
  private mode: "isolated-git" | "isolated-copy" = "isolated-git";
  private templatePath?: string;
  private baseOid?: string;
  private initializePromise?: Promise<void>;
  private artifacts = new Map<string, AgentArtifact>();
  private leases = new Map<string, WorkspaceLease>();
  private onLifecycle?: WorkspaceLifecycleHandler;
  private owner: WorkspaceOwnerIdentity;
  private retention?: false | Partial<WorkspaceRetentionPolicy>;
  private protectedBatchPaths?: WorkspaceManagerOptions["protectedBatchPaths"];
  private onRetention?: WorkspaceManagerOptions["onRetention"];

  constructor(options: WorkspaceManagerOptions) {
    this.root = resolve(options.root);
    this.forbidGit = options.forbidGit ?? false;
    this.copyWithPrivateGit = options.copyWithPrivateGit;
    this.capturePrivateGitFromRoot = options.capturePrivateGitFromRoot;
    this.tempRoot = options.tempRoot ? resolve(options.tempRoot) : undefined;
    this.onLifecycle = options.onLifecycle;
    this.owner = options.owner ?? {
      threadId: "unmanaged",
      instanceId: `workspace:${randomUUID()}`,
      pid: process.pid,
    };
    this.retention = options.retention;
    this.protectedBatchPaths = options.protectedBatchPaths;
    this.onRetention = options.onRetention;
  }

  async acquire(runId: string, writable: boolean): Promise<WorkspaceLease> {
    if (!writable) {
      const lease: WorkspaceLease = {
        workspaceId: `shared:${safeRunId(runId)}`,
        runId,
        mode: "shared-readonly",
        path: this.root,
      };
      this.leases.set(lease.workspaceId, lease);
      await this.onLifecycle?.({ type: "workspace_acquired", lease, timestamp: Date.now() });
      return lease;
    }

    const workspaceId = `ws_${safeRunId(runId)}`;
    const plannedLease: WorkspaceLease = {
      workspaceId,
      runId,
      mode: "isolated-git",
      path: "",
    };
    await this.onLifecycle?.({
      type: "workspace_acquire_started",
      lease: plannedLease,
      timestamp: Date.now(),
    });
    let repoPath: string;
    let privateGit: WorkspaceLease["privateGit"];
    try {
      await this.initialize();
      repoPath = join(this.batchRoot!, "runs", workspaceId);
      await mkdir(dirname(repoPath), { recursive: true });
      if (this.mode === "isolated-copy") {
        const tree = await scanCopyTree(this.templatePath!);
        if (copyTreeOid(tree) !== this.baseOid) throw new Error("Copy workspace baseline was modified");
        await materializeCopyTree(this.templatePath!, repoPath, tree);
        if (this.copyWithPrivateGit) privateGit = await materializePrivateGitMetadata(this.copyWithPrivateGit.snapshotRepository, repoPath, this.copyWithPrivateGit.ownerDirectory);
      } else {
        await git(this.batchRoot!, ["clone", "--local", "--no-hardlinks", this.templatePath!, repoPath]);
        await git(repoPath, ["checkout", "-b", `zap-agent-${safeRunId(runId)}`]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.onLifecycle?.({
          type: "workspace_acquire_failed",
          lease: plannedLease,
          error: message,
          timestamp: Date.now(),
        });
      } catch (lifecycleError) {
        throw new AggregateError(
          [error, lifecycleError],
          `Workspace setup failed and its terminal state could not be persisted: ${message}`,
        );
      }
      throw error;
    }
    const lease: WorkspaceLease = {
      workspaceId,
      runId,
      mode: this.mode,
      path: join(repoPath, this.rootRelative),
      repoPath,
      baseOid: this.baseOid,
      batchPath: this.batchRoot,
      ...(privateGit ? { privateGit } : {}),
    };
    this.leases.set(lease.workspaceId, lease);
    await this.onLifecycle?.({ type: "workspace_acquired", lease, timestamp: Date.now() });
    return lease;
  }

  async finalize(lease: WorkspaceLease): Promise<AgentArtifact | null> {
    if (lease.mode === "shared-readonly") return null;
    if (!lease.repoPath || !lease.baseOid) throw new Error("Invalid isolated workspace lease");
    if (lease.mode === "isolated-copy") return this.finalizeCopy(lease);
    const recorded = this.leases.get(lease.workspaceId);
    if (!recorded || JSON.stringify(recorded) !== JSON.stringify(lease)) throw new Error("Git workspace lease does not belong to this manager");
    const artifactId = `artifact_${safeRunId(lease.runId)}`;
    const artifactRoot = join(this.batchRoot!, "artifacts", artifactId);
    await mkdir(dirname(artifactRoot), { recursive: true });
    await artifactGit(this.batchRoot!, ["clone", "--local", "--no-hardlinks", this.templatePath!, artifactRoot]);
    const indexInput = await mkdtemp(join(artifactRoot, ".git", "agent-index-"));
    try {
      const indexFile = await copyAgentIndex(lease.repoPath, indexInput);
      const tracked = indexFile
        ? agentIndexPaths((await artifactGit(artifactRoot, ["ls-files", "--cached", "-z"], indexFile)).stdout)
        : [];
      const present: string[] = [];
      for (const path of tracked) {
        const info = await lstat(join(lease.repoPath, path)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
          throw error;
        });
        // A tracked file can have become a directory. Force-adding that directory
        // would recursively collect ignored neighbors, not just this index entry.
        if (info?.isFile() || info?.isSymbolicLink()) present.push(path);
      }
      // Retain trusted baseline entries (including uninitialized gitlinks).
      // Sync removed tracking by name, never importing child object IDs/config.
      const baselinePaths = agentIndexPaths((await artifactGit(artifactRoot, ["ls-files", "--cached", "-z"])).stdout);
      const trackedSet = new Set(tracked);
      const removed = baselinePaths.filter(path => !trackedSet.has(path));
      for (let start = 0; start < removed.length; start += 128) {
        await artifactGit(artifactRoot, ["update-index", "--force-remove", "--", ...removed.slice(start, start + 128)]);
      }
      if (present.length) {
        const pathsFile = join(indexInput, "tracked-paths");
        await writeFile(pathsFile, present.join("\0") + "\0", { mode: 0o600 });
        await artifactGit(artifactRoot, [`--work-tree=${lease.repoPath}`, "add", "-f", `--pathspec-from-file=${pathsFile}`, "--pathspec-file-nul"]);
      }
    } finally { await removeOwnedCopyTree(indexInput); }
    // Git reads only the child's working files, through an explicit work-tree.
    // Never execute host Git in the child's writable control directory.
    await artifactGit(artifactRoot, [`--work-tree=${lease.repoPath}`, "add", "-A"]);
    const staged = await artifactGit(artifactRoot, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.stdout.length > 0) {
      await artifactGit(artifactRoot, [
        "-c", "user.name=Zap Agent",
        "-c", "user.email=agent@zapcode.local",
        "commit", "-m", `zap agent artifact ${lease.runId}`,
      ]);
    }
    const resultOid = (await artifactGit(artifactRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const changedOutput = (await artifactGit(artifactRoot, [
      "diff", "--name-only", "-z", lease.baseOid, resultOid,
    ])).stdout;
    const changedPaths = changedOutput.split("\0").filter(Boolean);
    const numstat = (await artifactGit(artifactRoot, [
      "diff", "--numstat", lease.baseOid, resultOid,
    ])).stdout.trim();
    let additions = 0;
    let deletions = 0;
    for (const line of numstat ? numstat.split("\n") : []) {
      const [added, deleted] = line.split("\t", 3);
      if (/^\d+$/.test(added)) additions += Number(added);
      if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }

    const artifact: AgentArtifact = {
      artifactId,
      runId: lease.runId,
      workspaceId: lease.workspaceId,
      workspacePath: lease.path,
      repoPath: artifactRoot,
      baseOid: lease.baseOid,
      resultOid,
      changedPaths,
      diffStat: { additions, deletions, files: changedPaths.length },
    };
    this.artifacts.set(artifact.artifactId, artifact);
    await this.onLifecycle?.({
      type: "artifact_created",
      lease,
      artifact,
      timestamp: Date.now(),
    });
    return artifact;
  }

  /** Repair owns the still-private lease and may restore its frozen Git
   * history after replacing the file snapshot. Never touches source Git. */
  async restorePrivateGit(lease: WorkspaceLease, snapshotRepository: string): Promise<WorkspaceLease> {
    const recorded = this.leases.get(lease.workspaceId);
    if (!this.copyWithPrivateGit || !recorded || JSON.stringify(recorded) !== JSON.stringify(lease) || lease.mode !== "isolated-copy") throw new Error("Unknown private Git repair lease");
    const privateGit = await materializePrivateGitMetadata(snapshotRepository, lease.path, this.copyWithPrivateGit.ownerDirectory);
    const updated = { ...lease, privateGit };
    this.leases.set(updated.workspaceId, updated);
    return updated;
  }

  getArtifact(artifactId: string): AgentArtifact | undefined {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? structuredClone(artifact) : undefined;
  }

  private async finalizeCopy(lease: WorkspaceLease): Promise<AgentArtifact> {
    const recorded = this.leases.get(lease.workspaceId);
    if (!recorded || JSON.stringify(recorded) !== JSON.stringify(lease)) {
      throw new Error("Copy workspace lease does not belong to this manager");
    }
    const baseline = await scanCopyTree(this.templatePath!);
    if (copyTreeOid(baseline) !== lease.baseOid) throw new Error("Copy workspace baseline was modified");
    const excludedEnvironments = new Set<string>();
    const result = await scanCopyTree(lease.path, false, true, true, excludedEnvironments, lease.privateGit);
    for (const path of excludedEnvironments) {
      if (Object.hasOwn(baseline, path)) {
        throw new Error(`Cannot exclude existing snapshot path as a Python environment: ${path}. Create the environment in a new directory instead.`);
      }
    }
    const resultOid = copyTreeOid(result);
    const artifactId = `artifact_${safeRunId(lease.runId)}`;
    const artifactRoot = join(this.batchRoot!, "artifacts", artifactId);
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const resultPath = join(artifactRoot, resultOid);
    const existing = await lstat(resultPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) await materializeCopyTree(lease.path, resultPath, result);
    if (copyTreeOid(await scanCopyTree(resultPath)) !== resultOid) throw new Error("Copy artifact was modified");
    let privateGitHistory: AgentArtifact["privateGitHistory"];
    if (lease.privateGit && this.copyWithPrivateGit) {
      const history = join(artifactRoot, "git-history");
      await withPersistentGitOperation(this.copyWithPrivateGit.ownerDirectory, async () => {
        await capturePrivateGitHistory(lease.path, history);
        await assertPrivateGitHistoryMatches(lease.path, join(history, "repository.git"));
      });
      if (copyTreeOid(await scanCopyTree(lease.path, false, true, true, undefined, lease.privateGit)) !== resultOid) throw new Error("Copy workspace changed during Git history freezing");
      const repository = join(history, "repository.git");
      privateGitHistory = { repository, treeHash: copyTreeOid(await scanCopyTree(repository)) };
    }
    const changedPaths = changedCopyPaths(baseline, result);
    const artifact: AgentArtifact = {
      mode: "isolated-copy", artifactId, runId: lease.runId, workspaceId: lease.workspaceId,
      workspacePath: lease.path, repoPath: lease.repoPath!, baseOid: lease.baseOid!, resultOid,
      changedPaths,
      // Copy diffs include binary files and directories; line counts are not computed.
      diffStat: { additions: 0, deletions: 0, files: changedPaths.length },
      ...(privateGitHistory ? { privateGitHistory } : {}),
    };
    this.artifacts.set(artifactId, structuredClone(artifact));
    await this.onLifecycle?.({ type: "artifact_created", lease, artifact, timestamp: Date.now() });
    return artifact;
  }

  copyArtifactPath(artifact: AgentArtifact): string {
    if (artifact.mode !== "isolated-copy" || !/^[a-f0-9]{64}$/.test(artifact.resultOid)
      || artifact.artifactId !== `artifact_${safeRunId(artifact.runId)}` || !this.batchRoot) {
      throw new Error("Invalid copy artifact identity");
    }
    return join(this.batchRoot, "artifacts", artifact.artifactId, artifact.resultOid);
  }

  async hydrate(input: HydrateWorkspaceInput): Promise<void> {
    if (this.batchRoot || this.initializePromise) {
      throw new Error("WorkspaceManager is already initialized");
    }
    if (input.leases.length === 0) throw new Error("At least one workspace lease is required");
    const batchPath = input.leases[0].batchPath;
    if (!batchPath || input.leases.some((lease) => lease.batchPath !== batchPath)) {
      throw new Error("Hydrated workspace leases must share one recorded batch path");
    }

    const copy = input.leases[0].mode === "isolated-copy";
    if (!copy && this.forbidGit) throw new Error("Goal Git workspaces are unavailable: host Git execution is not sealed");
    if (input.leases.some((lease) => lease.mode !== input.leases[0].mode)) throw new Error("Mixed workspace backends");
    const context = await workspaceContext(this.root, this.tempRoot, copy, this.forbidGit);
    if (context.mode !== input.leases[0].mode) throw new Error("Recorded workspace backend is unavailable");
    await mkdir(context.workspaceTempRoot, { recursive: true, mode: 0o700 });
    const realTempRoot = await realpath(context.workspaceTempRoot);
    const realBatch = await validateWorkspaceBatchBoundary(batchPath, realTempRoot);
    const marker = await readWorkspaceBatchMarker(realBatch);
    const realWorkspaceRoot = await realpath(this.root);
    if (marker.batchId !== basename(realBatch)
      || marker.threadId !== this.owner.threadId
      || resolve(marker.workspaceRoot) !== realWorkspaceRoot
      || resolve(marker.repoRoot) !== context.repoRoot
      || marker.rootRelative !== context.rootRelative) {
      throw new Error("Workspace marker does not match the requested thread or repository");
    }
    if (input.leases.some((lease) => lease.baseOid !== input.leases[0].baseOid)) {
      throw new Error("Hydrated workspace leases do not share one snapshot");
    }

    const snapshotPath = join(realBatch, "snapshot");
    const runsPath = await realpath(join(realBatch, "runs"));
    for (const lease of input.leases) {
      if ((lease.mode !== "isolated-git" && lease.mode !== "isolated-copy") || !lease.repoPath || !lease.baseOid) {
        throw new Error(`Workspace lease ${lease.workspaceId} is not hydratable`);
      }
      if (copy && this.copyWithPrivateGit && !lease.privateGit) throw new Error("Private Git workspace binding is missing");
      const realRepoPath = await realpath(lease.repoPath);
      if (dirname(realRepoPath) !== runsPath) {
        throw new Error(`Workspace lease ${lease.workspaceId} escaped the recorded batch`);
      }
      const expectedWorkspacePath = await realpath(join(realRepoPath, context.rootRelative));
      if (await realpath(lease.path) !== expectedWorkspacePath) {
        throw new Error(`Workspace lease ${lease.workspaceId} has an invalid workspace path`);
      }
      if (lease.privateGit) await scanCopyTree(lease.path, false, true, true, undefined, lease.privateGit);
      // A private clone's metadata is writable by its Agent. Validate commits
      // against the host snapshot/artifact below, never against this directory.
    }
    for (const artifact of input.artifacts) {
      const lease = input.leases.find((item) => item.workspaceId === artifact.workspaceId);
      if (!lease
        || artifact.workspacePath !== lease.path
        || artifact.runId !== lease.runId
        || artifact.artifactId !== `artifact_${safeRunId(lease.runId)}`
        || artifact.repoPath !== (copy ? lease.repoPath : join(realBatch, "artifacts", artifact.artifactId))
        || artifact.baseOid !== lease.baseOid
        || (artifact.mode ?? "isolated-git") !== lease.mode) {
        throw new Error(`Artifact ${artifact.artifactId} does not match its workspace lease`);
      }
      if (copy) {
        if (!/^[a-f0-9]{64}$/.test(artifact.resultOid)
          || artifact.artifactId !== `artifact_${safeRunId(artifact.runId)}`
          || artifact.runId !== lease.runId) throw new Error("Invalid copy artifact identity");
        const resultPath = join(realBatch, "artifacts", artifact.artifactId, artifact.resultOid);
        if (await realpath(resultPath) !== resultPath) throw new Error("Copy artifact escaped its recorded path");
        const baseline = await scanCopyTree(snapshotPath);
        const result = await scanCopyTree(resultPath);
        if (copyTreeOid(result) !== artifact.resultOid
          || JSON.stringify(changedCopyPaths(baseline, result)) !== JSON.stringify(artifact.changedPaths)) {
          throw new Error("Copy artifact content or changed paths were modified");
        }
        if (artifact.privateGitHistory) {
          const expected = join(realBatch, "artifacts", artifact.artifactId, "git-history", "repository.git");
          if (artifact.privateGitHistory.repository !== expected || await realpath(expected) !== expected
            || copyTreeOid(await scanCopyTree(expected)) !== artifact.privateGitHistory.treeHash) throw new Error("Private Git artifact was modified");
        }
      } else {
        if (await realpath(artifact.repoPath) !== artifact.repoPath) throw new Error("Git artifact escaped its recorded path");
        await artifactGit(artifact.repoPath, ["cat-file", "-e", `${artifact.resultOid}^{commit}`]);
      }
    }
    if (copy) {
      if (await realpath(snapshotPath) !== snapshotPath
        || copyTreeOid(await scanCopyTree(snapshotPath)) !== input.leases[0].baseOid) {
        throw new Error("Copy workspace baseline was modified");
      }
    } else await git(snapshotPath, ["cat-file", "-e", `${input.leases[0].baseOid}^{commit}`]);

    this.mode = context.mode;
    this.repoRoot = context.repoRoot;
    this.rootRelative = context.rootRelative;
    this.workspaceTempRoot = realTempRoot;
    this.batchRoot = realBatch;
    this.templatePath = snapshotPath;
    this.baseOid = input.leases[0].baseOid;
    this.initializePromise = Promise.resolve();
    for (const lease of input.leases) this.leases.set(lease.workspaceId, { ...lease });
    for (const artifact of input.artifacts) this.artifacts.set(artifact.artifactId, { ...artifact });
    for (const lease of input.leases) {
      await this.onLifecycle?.({ type: "workspace_hydrated", lease, timestamp: Date.now() });
    }
  }

  async integrationWorkspace(label: string): Promise<{ path: string; baseOid: string }> {
    await this.initialize();
    const path = join(this.batchRoot!, "integration", safeRunId(label));
    await mkdir(dirname(path), { recursive: true });
    if (this.mode === "isolated-copy") {
      const baseline = await scanCopyTree(this.templatePath!);
      if (copyTreeOid(baseline) !== this.baseOid) throw new Error("Copy workspace baseline was modified");
      await materializeCopyTree(this.templatePath!, path, baseline);
      if (this.copyWithPrivateGit) await materializePrivateGitMetadata(this.copyWithPrivateGit.snapshotRepository, path, this.copyWithPrivateGit.ownerDirectory);
    } else await git(this.batchRoot!, ["clone", "--local", "--no-hardlinks", this.templatePath!, path]);
    return { path, baseOid: this.baseOid! };
  }

  snapshotRepoPath(): string {
    if (!this.templatePath) throw new Error("Workspace snapshot is not initialized");
    return this.templatePath;
  }

  rootRepoPath(): string {
    if (!this.repoRoot) throw new Error("Workspace snapshot is not initialized");
    return this.repoRoot;
  }

  async cleanup(): Promise<void> {
    const releasedAt = Date.now();
    if (this.batchRoot) {
      if (this.mode === "isolated-copy") {
        const pending = await lstat(join(this.batchRoot, COPY_MERGE_JOURNAL)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (pending) throw new Error("Copy merge recovery is pending; retain the batch and resume the merge before cleanup");
      }
      for (const lease of this.leases.values()) {
        await this.onLifecycle?.({
          type: "workspace_cleanup_started",
          lease,
          timestamp: releasedAt,
        });
      }
      if (this.mode === "isolated-copy") await removeOwnedCopyTree(this.batchRoot);
      else await rm(this.batchRoot, { recursive: true, force: true });
    }
    for (const lease of this.leases.values()) {
      await this.onLifecycle?.({ type: "workspace_released", lease, timestamp: releasedAt });
    }
    this.batchRoot = undefined;
    this.workspaceTempRoot = undefined;
    this.templatePath = undefined;
    this.baseOid = undefined;
    this.initializePromise = undefined;
    this.artifacts.clear();
    this.leases.clear();
  }

  private initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.initializeOnce().catch(async (error) => {
      // Concurrent acquires share one attempt. Discard its partial snapshot
      // before allowing a later acquire to retry the corrected source tree.
      try {
        if (this.batchRoot) await removeOwnedCopyTree(this.batchRoot);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Workspace initialization and partial snapshot cleanup failed");
      }
      this.batchRoot = undefined;
      this.workspaceTempRoot = undefined;
      this.templatePath = undefined;
      this.baseOid = undefined;
      this.repoRoot = undefined;
      this.initializePromise = undefined;
      throw error;
    });
    return this.initializePromise;
  }

  private async initializeOnce(): Promise<void> {
    const context = await workspaceContext(this.root, this.tempRoot, !!this.copyWithPrivateGit || !!this.capturePrivateGitFromRoot, this.forbidGit);
    if (context.mode === "isolated-git" && this.forbidGit) throw new Error("Goal Git workspaces are unavailable: host Git execution is not sealed");
    this.mode = context.mode;
    this.repoRoot = context.repoRoot;
    this.rootRelative = context.rootRelative;
    if (this.mode === "isolated-copy" && isWithin(this.repoRoot, await futureRealpath(context.workspaceTempRoot))) {
      throw new Error("Copy workspace temp root must be outside the source workspace");
    }
    await mkdir(context.workspaceTempRoot, { recursive: true, mode: 0o700 });
    this.workspaceTempRoot = await realpath(context.workspaceTempRoot);
    if (this.mode === "isolated-copy" && isWithin(this.repoRoot, this.workspaceTempRoot)) {
      throw new Error("Copy workspace temp root must be outside the source workspace");
    }
    if (this.retention !== undefined && this.retention !== false) {
      const report = await new WorkspaceRetentionManager({
        workspaceRoot: this.root,
        tempRoot: this.workspaceTempRoot,
        policy: this.retention,
        protectedBatchPaths: this.protectedBatchPaths,
      }).sweep();
      await this.onRetention?.(report);
    }
    this.batchRoot = await mkdtemp(join(this.workspaceTempRoot, "batch-"));
    await writeWorkspaceBatchMarker(this.batchRoot, {
      schemaVersion: 1,
      batchId: this.batchRoot.slice(this.workspaceTempRoot.length + 1),
      threadId: this.owner.threadId,
      instanceId: this.owner.instanceId,
      pid: this.owner.pid,
      workspaceRoot: await realpath(this.root),
      repoRoot: this.repoRoot,
      rootRelative: this.rootRelative,
      createdAt: Date.now(),
    });
    this.templatePath = join(this.batchRoot, "snapshot");
    if (this.mode === "isolated-copy") {
      if (this.capturePrivateGitFromRoot) {
        const { ownerDirectory, sourceBinding } = this.capturePrivateGitFromRoot;
        const before = await scanCopyTree(this.repoRoot, true, true, true, undefined, sourceBinding);
        const history = join(this.batchRoot, "parent-git-history");
        await withPersistentGitOperation(ownerDirectory, async () => {
          await capturePrivateGitHistory(this.repoRoot!, history);
          await assertPrivateGitHistoryMatches(this.repoRoot!, join(history, "repository.git"));
        });
        const after = await scanCopyTree(this.repoRoot, true, true, true, undefined, sourceBinding);
        if (copyTreeOid(before) !== copyTreeOid(after)) throw new Error("Parent workspace changed during child Git capture");
        this.copyWithPrivateGit = { ownerDirectory, snapshotRepository: join(history, "repository.git") };
      }
      const tree = await scanCopyTree(this.repoRoot, true);
      await materializeCopyTree(this.repoRoot, this.templatePath, tree);
      if (copyTreeOid(await scanCopyTree(this.repoRoot, true)) !== copyTreeOid(tree)) throw new Error("Copy workspace changed during snapshot");
      this.baseOid = copyTreeOid(tree);
      return;
    }
    await git(this.batchRoot, ["clone", "--no-hardlinks", this.repoRoot, this.templatePath]);

    const tracked = (await git(this.repoRoot, ["ls-files", "-z", "--cached"]))
      .stdout.split("\0").filter(Boolean);
    const untracked = (await git(this.repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]))
      .stdout.split("\0").filter((path) => path && !SECRET_UNTRACKED.test(path));
    for (const path of [...new Set([...tracked, ...untracked])]) {
      await copySnapshotEntry(this.repoRoot, this.templatePath, path);
    }
    await git(this.templatePath, ["add", "-A"]);
    await git(this.templatePath, [
      "-c", "user.name=Zap Snapshot",
      "-c", "user.email=snapshot@zapcode.local",
      "commit", "--allow-empty", "-m", "zap private workspace snapshot",
    ]);
    this.baseOid = (await git(this.templatePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

}

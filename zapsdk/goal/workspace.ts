import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { MergeCoordinator } from "../merge/coordinator.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { isWithin, workspaceContext } from "../workspace/context.js";
import { materializeCopyTree, removeOwnedCopyTree, scanCopyTree } from "../workspace/copy.js";
import type { AgentArtifact, MergeResult, WorkspaceLease } from "../workspace/types.js";
import { assertGoalAcceptance, assertGoalFinalAcceptance, type GoalAcceptanceReceipt, type GoalFinalAcceptanceReceipt } from "./acceptance.js";
import type { InlineAcceptanceStore } from "../runtime/inline-acceptance.js";
import { validateOutcome, type AgentOutcomeV1 } from "../runtime/outcome.js";
import { capturePrivateGitHistory, assertPrivateGitHistoryMatches } from "./git-history-snapshot.js";
import { withPersistentGitOperation } from "./git-operation-owner.js";

const exec = promisify(execFile);

/** A content fingerprint of an already isolated tree. It never follows symlinks.
 * This is an integrity check, not a substitute for filesystem sandboxing. */
export async function goalTreeHash(root: string, ignored: readonly string[] = []): Promise<string> {
  const hash = createHash("sha256");
  const normalized = ignored.map(path => {
    if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..") || path === ".git") {
      throw new Error("Invalid verifier generated path");
    }
    return path.replace(/\/$/, "");
  });
  async function visit(rel: string): Promise<void> {
    for (const name of (await readdir(join(root, rel))).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (path === ".git" || normalized.some(p => path === p || path.startsWith(`${p}/`))) continue;
      const full = join(root, path);
      const before = await lstat(full);
      let kind: string;
      let value = "";
      if (before.isSymbolicLink()) { kind = "link"; value = await readlink(full); }
      else if (before.isDirectory()) kind = "dir";
      else if (before.isFile()) { kind = "file"; value = createHash("sha256").update(await readFile(full)).digest("hex"); }
      else throw new Error(`Unsupported workspace entry: ${path}`);
      const after = await lstat(full);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
        throw new Error(`Workspace changed while fingerprinting: ${path}`);
      }
      hash.update(JSON.stringify([path, kind, before.mode & 0o777, value]));
      hash.update("\n");
      if (kind === "dir") await visit(path);
    }
  }
  await visit("");
  return hash.digest("hex");
}

export interface GoalWorkspaceCandidate {
  goalId: string;
  candidateId: string;
  attemptId: string;
  artifact: AgentArtifact;
  snapshotPath: string;
  treeHash: string;
  integrationHash: string;
  /** Isolated commits remain private; file delivery never updates user refs. */
  privateHistory?: { repository: string; treeHash: string };
}
export interface GoalWorker {
  lease: WorkspaceLease;
  integrationHash: string;
}
export interface GoalWorkspaceState {
  version: 1;
  goalId: string;
  root: string;
  hostDir: string;
  integrationPath: string;
  baseLease: WorkspaceLease;
  baseTreeHash: string;
  /** Private history is for isolated development only; delivery is file-only. */
  privateGit?: { ownerDirectory: string; snapshotRepository: string; treeHash: string };
  worker?: GoalWorker;
  workerOwnerRunId?: string;
  candidate?: GoalWorkspaceCandidate;
  previous?: Array<{ worker: GoalWorker; candidate: GoalWorkspaceCandidate }>;
  abandoned?: Array<{ worker: GoalWorker; ownerRunId: string; reason: string; stoppedAt: number }>;
  delivery?: { snapshotId: string; treeHash: string; artifact: AgentArtifact; status: "prepared" | "applied" };
}
export interface GoalVerifierWorkspace {
  candidateId: string;
  candidateHash: string;
  path: string;
  generatedPaths: string[];
}
export interface GoalFinalSnapshot {
  goalId: string;
  snapshotId: string;
  path: string;
  treeHash: string;
}

/**
 * Serial Goal workspace composition. The caller must persist exportState()
 * after acquisition/finalization and must use its Broker to restrict writes
 * to the selected lease; these directories alone are not a security boundary.
 */
export class GoalWorkspace {
  private workerManager?: WorkspaceManager;
  private constructor(private state: GoalWorkspaceState, private readonly baseManager: WorkspaceManager) {}

  private static owner(goalId: string, suffix: string) {
    return { threadId: `goal:${goalId}:${suffix}`, instanceId: randomUUID(), pid: process.pid };
  }

  static async create(root: string, goalId: string, hostDir: string): Promise<GoalWorkspace> {
    if (!goalId || goalId.includes("\0")) throw new Error("Invalid goal id");
    const realRoot = await realpath(root);
    await mkdir(hostDir, { recursive: true, mode: 0o700 });
    const realHost = await realpath(hostDir);
    if (isWithin(realRoot, realHost)) throw new Error("Goal host directory must be outside its source workspace");
    const ownerDirectory = dirname(realHost);
    let privateGit: GoalWorkspaceState["privateGit"];
    await withPersistentGitOperation(ownerDirectory, async () => {
      const context = await workspaceContext(realRoot, realHost, false, true);
      if (context.mode !== "isolated-git") return;
      if (context.repoRoot !== realRoot) throw new Error("Git Goal requires the repository root as its workspace");
      const before = await scanCopyTree(realRoot, true);
      const history = join(realHost, "private-git-history");
      await capturePrivateGitHistory(realRoot, history);
      const after = await scanCopyTree(realRoot, true);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Git working tree changed during history capture");
      const snapshotRepository = join(history, "repository.git");
      privateGit = { ownerDirectory, snapshotRepository, treeHash: await goalTreeHash(snapshotRepository) };
    });
    const manager = new WorkspaceManager({ root: realRoot, tempRoot: realHost, owner: this.owner(goalId, "base"), retention: false, forbidGit: true, copyWithPrivateGit: privateGit });
    try {
      const lease = await manager.acquire(`goal-base-${randomUUID()}`, true);
      if (!lease.repoPath) throw new Error("Goal snapshot has no repository path");
      const integration = await manager.integrationWorkspace(`goal-${randomUUID()}`);
      const integrationPath = join(integration.path, relative(lease.repoPath, lease.path));
      const baseTreeHash = await goalTreeHash(lease.path);
      if (privateGit) await withPersistentGitOperation(ownerDirectory, () => assertPrivateGitHistoryMatches(realRoot, privateGit!.snapshotRepository));
      return new GoalWorkspace({ version: 1, goalId, root: realRoot, hostDir: realHost, integrationPath, baseLease: lease, baseTreeHash, ...(privateGit ? { privateGit } : {}) }, manager);
    } catch (error) { await manager.cleanup(); throw error; }
  }

  static async open(input: GoalWorkspaceState): Promise<GoalWorkspace> {
    const state = structuredClone(input);
    if (state.version !== 1 || !state.goalId || !state.baseLease.batchPath || !state.baseLease.repoPath || !state.baseTreeHash) throw new Error("Invalid Goal workspace state");
    if (state.baseLease.mode !== "isolated-copy" || (state.worker && state.worker.lease.mode !== "isolated-copy")) {
      throw new Error("Goal Git workspaces are unavailable: host Git execution is not sealed");
    }
    if (state.privateGit) {
      const host = await realpath(state.hostDir), owner = await realpath(state.privateGit.ownerDirectory), repo = await realpath(state.privateGit.snapshotRepository);
      if (owner !== dirname(host) || !isWithin(host, repo) || await goalTreeHash(repo) !== state.privateGit.treeHash) throw new Error("Private Goal Git history is invalid");
    }
    const manager = new WorkspaceManager({ root: state.root, tempRoot: state.hostDir, owner: this.owner(state.goalId, "base"), retention: false, forbidGit: true, copyWithPrivateGit: state.privateGit });
    await manager.hydrate({ leases: [state.baseLease], artifacts: state.delivery ? [state.delivery.artifact] : [] });
    const expectedParent = join(state.baseLease.batchPath, "integration");
    const realIntegration = await realpath(state.integrationPath);
    if (!isWithin(await realpath(expectedParent), realIntegration)) throw new Error("Goal integration escaped its recorded batch");
    const goal = new GoalWorkspace(state, manager);
    if (state.worker) {
      const wm = new WorkspaceManager({ root: state.integrationPath, tempRoot: state.hostDir,
        owner: this.owner(state.goalId, `worker:${state.workerOwnerRunId ?? state.worker.lease.runId}`), retention: false, forbidGit: true, copyWithPrivateGit: state.privateGit });
      const previous = state.previous ?? [];
      const abandoned = (state.abandoned ?? []).filter(item => item.worker.lease.batchPath === state.worker!.lease.batchPath);
      await wm.hydrate({ leases: [...previous.map(item => item.worker.lease), ...abandoned.map(item => item.worker.lease), state.worker.lease],
        artifacts: [...previous.map(item => item.candidate.artifact), ...(state.candidate ? [state.candidate.artifact] : [])] });
      goal.workerManager = wm;
      if (state.candidate) await goal.assertCandidate(state.candidate);
    }
    return goal;
  }

  exportState(): GoalWorkspaceState { return structuredClone(this.state); }
  get integrationPath(): string { return this.state.integrationPath; }

  async acquireWorker(runId: string): Promise<GoalWorker> {
    if (this.state.worker) throw new Error("A Goal worker is already active");
    if (!runId || runId.includes("\0")) throw new Error("Invalid run id");
    const integrationHash = await goalTreeHash(this.state.integrationPath);
    const wm = new WorkspaceManager({ root: this.state.integrationPath, tempRoot: this.state.hostDir,
      owner: GoalWorkspace.owner(this.state.goalId, `worker:${runId}`), retention: false, forbidGit: true, copyWithPrivateGit: this.state.privateGit });
    const lease = await wm.acquire(runId, true);
    if (await goalTreeHash(this.state.integrationPath) !== integrationHash) { await wm.cleanup(); throw new Error("Goal integration changed during acquisition"); }
    this.workerManager = wm;
    this.state.worker = { lease, integrationHash };
    this.state.workerOwnerRunId = runId;
    return structuredClone(this.state.worker);
  }

  async finalizeWorker(worker: GoalWorker, outcome: AgentOutcomeV1): Promise<GoalWorkspaceCandidate> {
    if (!this.workerManager || JSON.stringify(worker) !== JSON.stringify(this.state.worker) || this.state.candidate) throw new Error("Unknown or already finalized worker");
    validateOutcome(outcome);
    if (outcome.execution.status !== "finished" || outcome.execution.unresolvedActions.length) throw new Error("Worker outcome is not eligible for freezing");
    const artifact = await this.workerManager.finalize(worker.lease);
    if (!artifact) throw new Error("Worker did not produce an isolated artifact");
    const dir = await mkdtemp(join(this.state.hostDir, "candidate-"));
    const checkoutRoot = join(dir, "snapshot");
    const rootRelative = worker.lease.repoPath ? relative(worker.lease.repoPath, worker.lease.path) : "";
    const prefix = rootRelative.split(sep).join("/");
    if (prefix && artifact.changedPaths.some(path => path !== prefix && !path.startsWith(`${prefix}/`))) {
      throw new Error("Worker artifact changed paths outside its Goal workspace");
    }
    const snapshotPath = join(checkoutRoot, rootRelative);
    if (artifact.mode === "isolated-copy") {
      await cp(this.workerManager.copyArtifactPath(artifact), checkoutRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    } else {
      await exec("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", artifact.repoPath, checkoutRoot], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      await exec("git", ["-C", checkoutRoot, "checkout", "--detach", artifact.resultOid], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    }
    const treeHash = await goalTreeHash(snapshotPath);
    let privateHistory: GoalWorkspaceCandidate["privateHistory"];
    if (worker.lease.privateGit && this.state.privateGit) {
      const historyDir = join(dir, "private-history");
      await withPersistentGitOperation(this.state.privateGit.ownerDirectory, async () => {
        await capturePrivateGitHistory(worker.lease.path, historyDir);
        await assertPrivateGitHistoryMatches(worker.lease.path, join(historyDir, "repository.git"));
      });
      if (await goalTreeHash(worker.lease.path) !== treeHash) throw new Error("Worker changed while its Git history was frozen");
      const repository = join(historyDir, "repository.git");
      privateHistory = { repository, treeHash: await goalTreeHash(repository) };
    }
    const candidate: GoalWorkspaceCandidate = { goalId: this.state.goalId, candidateId: randomUUID(), attemptId: outcome.attemptId,
      artifact, snapshotPath, treeHash, integrationHash: worker.integrationHash, ...(privateHistory ? { privateHistory } : {}) };
    this.state.candidate = candidate;
    return structuredClone(candidate);
  }

  /** Re-run from the failed immutable candidate while retaining the original
   * integration base. The caller persists exportState() before starting work. */
  async acquireRepair(candidate: GoalWorkspaceCandidate, runId: string): Promise<GoalWorker> {
    await this.assertCandidate(candidate);
    if (!this.workerManager || !this.state.worker || !runId || runId.includes("\0")) throw new Error("Cannot repair this Goal candidate");
    if (await goalTreeHash(this.state.integrationPath) !== candidate.integrationHash) throw new Error("Goal integration changed before repair");
    let lease = await this.workerManager.acquire(runId, true);
    if (lease.mode === "isolated-copy") {
      const tree = await scanCopyTree(candidate.snapshotPath);
      await removeOwnedCopyTree(lease.path);
      await materializeCopyTree(candidate.snapshotPath, lease.path, tree);
      if (this.state.privateGit) {
        if (!candidate.privateHistory) throw new Error("Frozen private Git history is missing");
        lease = await this.workerManager.restorePrivateGit(lease, candidate.privateHistory.repository);
      }
    } else {
      if (!lease.repoPath) throw new Error("Repair workspace has no private Git repository");
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
      await exec("git", ["-C", lease.repoPath, "fetch", "--no-tags", candidate.artifact.repoPath, candidate.artifact.resultOid], { env });
      await exec("git", ["-C", lease.repoPath, "checkout", "--detach", candidate.artifact.resultOid], { env });
    }
    if (await goalTreeHash(lease.path) !== candidate.treeHash) throw new Error("Repair workspace does not match its frozen candidate");
    this.state.previous ??= [];
    this.state.previous.push({ worker: this.state.worker, candidate: this.state.candidate! });
    this.state.worker = { lease, integrationHash: candidate.integrationHash };
    this.state.candidate = undefined;
    return structuredClone(this.state.worker);
  }

  /** Reconcile an interrupted, unfinalized worker only after the Host has
   * verified process-tree termination and absence of opaque side effects.
   * The worker lease is retained as evidence; no files are deleted. */
  async abandonWorker(input: { runId: string; stopped: true; externalEffects: "none"; reason: string }): Promise<void> {
    const worker = this.state.worker;
    if (!worker || this.state.candidate || input.runId !== worker.lease.runId || input.stopped !== true
      || input.externalEffects !== "none" || !input.reason.trim()) throw new Error("Worker abandonment requires confirmed safe reconciliation");
    this.state.abandoned ??= [];
    this.state.abandoned.push({ worker: structuredClone(worker), ownerRunId: this.state.workerOwnerRunId ?? worker.lease.runId,
      reason: input.reason, stoppedAt: Date.now() });
    const prior = this.state.previous?.pop();
    if (prior) {
      this.state.worker = prior.worker;
      this.state.candidate = prior.candidate;
      await this.assertCandidate(prior.candidate);
    } else {
      this.state.worker = undefined;
      this.state.workerOwnerRunId = undefined;
      this.workerManager = undefined;
    }
  }

  async assertCandidate(candidate: GoalWorkspaceCandidate): Promise<void> {
    if (!this.state.candidate || JSON.stringify(candidate) !== JSON.stringify(this.state.candidate)) throw new Error("Candidate is not owned by this Goal");
    const base = await realpath(this.state.hostDir);
    const snapshot = await realpath(candidate.snapshotPath);
    const parts = relative(base, snapshot).split(sep);
    if (!isWithin(base, snapshot) || !parts[0]?.startsWith("candidate-") || parts[1] !== "snapshot") throw new Error("Candidate snapshot escaped its host directory");
    if (await goalTreeHash(snapshot) !== candidate.treeHash) throw new Error("Candidate snapshot was modified after freezing");
    if (candidate.privateHistory) {
      const repository = await realpath(candidate.privateHistory.repository);
      if (!isWithin(dirname(snapshot), repository) || await goalTreeHash(repository) !== candidate.privateHistory.treeHash) throw new Error("Frozen private Git history was modified");
    }
    if (candidate.artifact.mode === "isolated-copy") {
      if (!this.workerManager || await goalTreeHash(this.workerManager.copyArtifactPath(candidate.artifact)) !== candidate.treeHash) throw new Error("Frozen artifact was modified");
    } else {
      // Resolve the object named at freeze; disable replace refs so it cannot be substituted.
      const value = (await exec("git", ["--no-replace-objects", "-C", candidate.artifact.repoPath, "rev-parse", `${candidate.artifact.resultOid}^{commit}`])).stdout.trim();
      if (value !== candidate.artifact.resultOid) throw new Error("Frozen Git artifact was modified");
    }
  }

  async prepareVerifier(candidate: GoalWorkspaceCandidate, generatedPaths: string[] = []): Promise<GoalVerifierWorkspace> {
    await this.assertCandidate(candidate);
    // Existing candidate paths can never be excluded from integrity checks.
    for (const path of generatedPaths) {
      if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("Invalid verifier generated path");
      try { await lstat(join(candidate.snapshotPath, path)); throw new Error(`Generated path is part of the candidate: ${path}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const dir = await mkdtemp(join(this.state.hostDir, "verifier-"));
    const path = join(dir, "workspace");
    await cp(candidate.snapshotPath, path, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    if (await goalTreeHash(path) !== candidate.treeHash) throw new Error("Verifier copy does not match the candidate");
    return { candidateId: candidate.candidateId, candidateHash: candidate.treeHash, path, generatedPaths: [...generatedPaths] };
  }

  async assertVerifierUnchanged(candidate: GoalWorkspaceCandidate, verifier: GoalVerifierWorkspace): Promise<void> {
    await this.assertCandidate(candidate);
    if (verifier.candidateId !== candidate.candidateId || verifier.candidateHash !== candidate.treeHash
      || await goalTreeHash(verifier.path, verifier.generatedPaths) !== candidate.treeHash) throw new Error("Verifier modified candidate source");
  }

  /** The store and receipt binding must come from host-owned state. */
  async merge(candidate: GoalWorkspaceCandidate, receipt: GoalAcceptanceReceipt, store: InlineAcceptanceStore): Promise<MergeResult> {
    await this.assertCandidate(candidate);
    await assertGoalAcceptance(candidate, receipt, store);
    if (!this.workerManager || await goalTreeHash(this.state.integrationPath) !== candidate.integrationHash) throw new Error("Goal integration changed before merge");
    const result = await new MergeCoordinator(this.workerManager).merge([candidate.artifact.artifactId]);
    if (result.success) {
      if (this.state.privateGit && candidate.privateHistory) this.state.privateGit = { ...this.state.privateGit, snapshotRepository: candidate.privateHistory.repository, treeHash: candidate.privateHistory.treeHash };
      this.state.worker = undefined; this.state.workerOwnerRunId = undefined; this.state.candidate = undefined; this.state.previous = undefined; this.workerManager = undefined;
    }
    return result;
  }

  async finalSnapshot(): Promise<GoalFinalSnapshot> {
    const before = await goalTreeHash(this.state.integrationPath);
    const dir = await mkdtemp(join(this.state.hostDir, "integration-snapshot-"));
    const path = join(dir, "snapshot");
    await cp(this.state.integrationPath, path, { recursive: true, verbatimSymlinks: true, errorOnExist: true,
      filter: source => relative(this.state.integrationPath, source) !== ".git" });
    if (await goalTreeHash(path) !== before || await goalTreeHash(this.state.integrationPath) !== before) throw new Error("Goal integration changed during snapshot");
    return { goalId: this.state.goalId, snapshotId: randomUUID(), path, treeHash: before };
  }

  async assertFinalSnapshot(snapshot: GoalFinalSnapshot): Promise<void> {
    const base = await realpath(this.state.hostDir);
    const path = await realpath(snapshot.path);
    const parts = relative(base, path).split(sep);
    if (snapshot.goalId !== this.state.goalId || !snapshot.snapshotId || !isWithin(base, path)
      || !parts[0]?.startsWith("integration-snapshot-") || parts[1] !== "snapshot"
      || await goalTreeHash(path) !== snapshot.treeHash || await goalTreeHash(this.state.integrationPath) !== snapshot.treeHash) {
      throw new Error("Final Goal snapshot is stale or invalid");
    }
  }

  async prepareFinalVerifier(snapshot: GoalFinalSnapshot, generatedPaths: string[] = []): Promise<GoalVerifierWorkspace> {
    await this.assertFinalSnapshot(snapshot);
    for (const path of generatedPaths) {
      if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("Invalid verifier generated path");
      try { await lstat(join(snapshot.path, path)); throw new Error(`Generated path is part of the candidate: ${path}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const dir = await mkdtemp(join(this.state.hostDir, "verifier-"));
    const path = join(dir, "workspace");
    await cp(snapshot.path, path, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    if (await goalTreeHash(path) !== snapshot.treeHash) throw new Error("Verifier copy does not match the final Goal snapshot");
    return { candidateId: snapshot.snapshotId, candidateHash: snapshot.treeHash, path, generatedPaths: [...generatedPaths] };
  }

  async assertFinalVerifierUnchanged(snapshot: GoalFinalSnapshot, verifier: GoalVerifierWorkspace): Promise<void> {
    await this.assertFinalSnapshot(snapshot);
    if (verifier.candidateId !== snapshot.snapshotId || verifier.candidateHash !== snapshot.treeHash
      || await goalTreeHash(verifier.path, verifier.generatedPaths) !== snapshot.treeHash) throw new Error("Verifier modified final Goal source");
  }

  /** Create the final artifact against the original user-disk baseline.
   * Host must persist its operation intent before calling and persist the
   * returned exportState() before applyDelivery(). Interrupted preparation is
   * not replay-safe and must be reconciled, not automatically restarted. */
  async prepareDelivery(snapshot: GoalFinalSnapshot, receipt: GoalFinalAcceptanceReceipt, store: InlineAcceptanceStore): Promise<AgentArtifact> {
    await assertGoalFinalAcceptance(this, snapshot, receipt, store);
    if (this.state.worker || this.state.delivery) throw new Error("Goal workspace is not ready to prepare delivery");
    const lease = this.state.baseLease;
    if (!lease.batchPath || !lease.repoPath) throw new Error("Missing Goal baseline workspace");
    const privatePath = await realpath(lease.path);
    const runsPath = await realpath(join(lease.batchPath, "runs"));
    if (!isWithin(runsPath, privatePath) || await goalTreeHash(privatePath) !== this.state.baseTreeHash) {
      throw new Error("Goal baseline workspace changed before delivery preparation");
    }
    // Only the Host-owned private baseline clone is modified. Its .git is
    // retained; the user's index and refs are never staged or committed.
    for (const entry of await readdir(privatePath)) {
      if (entry !== ".git") await rm(join(privatePath, entry), { recursive: true, force: true });
    }
    for (const entry of await readdir(snapshot.path)) {
      if (entry !== ".git") await cp(join(snapshot.path, entry), join(privatePath, entry), { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    }
    if (await goalTreeHash(privatePath) !== snapshot.treeHash) throw new Error("Delivery candidate differs from final verified snapshot");
    await assertGoalFinalAcceptance(this, snapshot, receipt, store);
    const artifact = await this.baseManager.finalize(lease);
    if (!artifact) throw new Error("Goal delivery did not produce an isolated artifact");
    this.state.delivery = { snapshotId: snapshot.snapshotId, treeHash: snapshot.treeHash, artifact, status: "prepared" };
    return structuredClone(artifact);
  }

  /** Apply one persisted prepared artifact. Host must persist an in-flight
   * claim before calling; a lost acknowledgement is unknown, not permission
   * to replay this method. Existing MergeCoordinator checks root drift and
   * performs the copy backend's journaled recovery. */
  async applyDelivery(snapshot: GoalFinalSnapshot, receipt: GoalFinalAcceptanceReceipt, store: InlineAcceptanceStore): Promise<MergeResult> {
    await assertGoalFinalAcceptance(this, snapshot, receipt, store);
    const delivery = this.state.delivery;
    if (!delivery || delivery.status !== "prepared" || delivery.snapshotId !== snapshot.snapshotId || delivery.treeHash !== snapshot.treeHash) {
      throw new Error("No matching prepared Goal delivery");
    }
    const result = await new MergeCoordinator(this.baseManager).merge([delivery.artifact.artifactId]);
    if (result.success) delivery.status = "applied";
    return result;
  }

  /** Explicit cleanup only; caller must retain batches needed for crash recovery. */
  async cleanup(): Promise<void> {
    if (this.workerManager) await this.workerManager.cleanup();
    if (this.state.candidate) await rm(dirname(this.state.candidate.snapshotPath), { recursive: true, force: true });
    await this.baseManager.cleanup();
  }
}

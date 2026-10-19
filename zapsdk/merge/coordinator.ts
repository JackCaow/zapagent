import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { AgentArtifact, MergeResult } from "../workspace/types.js";
import { mergeCopyArtifacts } from "./copy.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} exited ${code}`));
    });
    child.stdin.end(input);
  });
}

async function fingerprint(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (info.isDirectory()) return "directory";
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A child path is absent while its parent is still a file in the baseline.
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw err;
  }
}

export interface MergeCoordinatorOptions {
  onTrackEdit?: (paths: string[]) => Promise<void>;
  onLifecycle?: MergeLifecycleHandler;
}

export type MergeLifecycleEvent =
  | {
      type: "merge_started";
      mergeId: string;
      artifactIds: string[];
      timestamp: number;
    }
  | {
      type: "merge_completed";
      mergeId: string;
      artifactIds: string[];
      result: MergeResult;
      timestamp: number;
    }
  | {
      type: "merge_failed";
      mergeId: string;
      artifactIds: string[];
      error: string;
      timestamp: number;
    };

export type MergeLifecycleHandler = (
  event: MergeLifecycleEvent,
) => void | Promise<void>;

/** Pre-merges all artifacts in a disposable repository, checks root drift,
 * then applies one combined patch. Root files remain untouched on conflicts. */
export class MergeCoordinator {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private workspaces: WorkspaceManager,
    private options: MergeCoordinatorOptions = {},
  ) {}

  async merge(artifactIds: string[]): Promise<MergeResult> {
    const previous = this.chain.catch(() => undefined);
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const mergeId = `merge:${randomUUID()}`;
    try {
      await this.options.onLifecycle?.({
        type: "merge_started",
        mergeId,
        artifactIds: [...artifactIds],
        timestamp: Date.now(),
      });
      let result: MergeResult;
      try {
        result = await this.mergeUnlocked(artifactIds);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await this.options.onLifecycle?.({
            type: "merge_failed",
            mergeId,
            artifactIds: [...artifactIds],
            error: message,
            timestamp: Date.now(),
          });
        } catch (lifecycleError) {
          throw new AggregateError(
            [error, lifecycleError],
            `Merge failed and its terminal state could not be persisted: ${message}`,
          );
        }
        throw error;
      }
      await this.options.onLifecycle?.({
        type: "merge_completed",
        mergeId,
        artifactIds: [...artifactIds],
        result,
        timestamp: Date.now(),
      });
      return result;
    } finally {
      release();
    }
  }

  private async mergeUnlocked(artifactIds: string[]): Promise<MergeResult> {
    const artifacts = artifactIds.map((id) => this.workspaces.getArtifact(id));
    const missing = artifactIds.filter((_id, index) => !artifacts[index]);
    if (missing.length > 0) {
      return { success: false, artifactIds, changedPaths: [], error: `Unknown artifacts: ${missing.join(", ")}` };
    }
    const resolved = artifacts as AgentArtifact[];
    if (resolved.length === 0) {
      return { success: true, artifactIds: [], changedPaths: [] };
    }
    const baseOid = resolved[0].baseOid;
    if (resolved.some((artifact) => artifact.baseOid !== baseOid)) {
      return { success: false, artifactIds, changedPaths: [], error: "Artifacts do not share one workspace snapshot" };
    }
    const mode = resolved[0].mode ?? "isolated-git";
    if (resolved.some((artifact) => (artifact.mode ?? "isolated-git") !== mode)) {
      return { success: false, artifactIds, changedPaths: [], error: "Artifacts use different workspace backends" };
    }
    if (mode === "isolated-copy") return mergeCopyArtifacts(this.workspaces, resolved, this.options.onTrackEdit);

    const changedPaths = [...new Set(resolved.flatMap((artifact) => artifact.changedPaths))].sort();
    const rootRepo = this.workspaces.rootRepoPath();
    const snapshot = this.workspaces.snapshotRepoPath();
    const drifted: string[] = [];
    for (const path of changedPaths) {
      if (await fingerprint(join(rootRepo, path)) !== await fingerprint(join(snapshot, path))) {
        drifted.push(path);
      }
    }
    if (drifted.length > 0) {
      return {
        success: false,
        artifactIds,
        changedPaths: [],
        conflicts: drifted,
        error: "Root workspace changed after the Agent snapshot",
      };
    }

    const integration = await this.workspaces.integrationWorkspace(`merge-${Date.now()}`);
    try {
      for (const artifact of resolved) {
        if (artifact.changedPaths.length === 0) continue;
        const patch = await git(artifact.repoPath, ["diff", "--binary", artifact.baseOid, artifact.resultOid]);
        try {
          await gitWithInput(integration.path, ["apply", "--index", "--3way", "-"], patch);
          await git(integration.path, [
            "-c", "user.name=Zap Merge",
            "-c", "user.email=merge@zapcode.local",
            "commit", "-m", `merge artifact ${artifact.artifactId}`,
          ]);
        } catch (err) {
          return {
            success: false,
            artifactIds,
            changedPaths: [],
            conflicts: artifact.changedPaths,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const finalOid = (await git(integration.path, ["rev-parse", "HEAD"])).trim();
      const combinedPatch = await git(integration.path, ["diff", "--binary", baseOid, finalOid]);
      if (!combinedPatch) return { success: true, artifactIds, changedPaths: [] };
      try {
        await gitWithInput(rootRepo, ["apply", "--check", "-"], combinedPatch);
        if (this.options.onTrackEdit) {
          await this.options.onTrackEdit(changedPaths.map((path) => join(rootRepo, path)));
        }
        await gitWithInput(rootRepo, ["apply", "-"], combinedPatch);
      } catch (err) {
        return {
          success: false,
          artifactIds,
          changedPaths: [],
          conflicts: changedPaths,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return { success: true, artifactIds, changedPaths };
    } finally {
      // Integration paths live under the manager's batch root and are removed
      // together, retaining evidence for debugging until batch cleanup.
    }
  }
}

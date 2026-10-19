import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const WORKSPACE_BATCH_MARKER_FILE = ".zap-workspace-owner.json";
export const WORKSPACE_BATCH_MARKER_VERSION = 1 as const;

export interface WorkspaceOwnerIdentity {
  threadId: string;
  instanceId: string;
  pid: number;
}

export interface WorkspaceBatchMarker {
  schemaVersion: typeof WORKSPACE_BATCH_MARKER_VERSION;
  batchId: string;
  threadId: string;
  instanceId: string;
  pid: number;
  workspaceRoot: string;
  repoRoot: string;
  rootRelative: string;
  createdAt: number;
}

export class WorkspaceMarkerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceMarkerValidationError";
  }
}

export async function writeWorkspaceBatchMarker(
  batchPath: string,
  marker: WorkspaceBatchMarker,
): Promise<void> {
  const path = join(batchPath, WORKSPACE_BATCH_MARKER_FILE);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temp, 0o600);
    await rename(temp, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readWorkspaceBatchMarker(batchPath: string): Promise<WorkspaceBatchMarker> {
  const path = join(batchPath, WORKSPACE_BATCH_MARKER_FILE);
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new WorkspaceMarkerValidationError(`Workspace marker is missing or unsafe: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new WorkspaceMarkerValidationError(`Workspace marker is invalid: ${path}`);
  }
  if (!validWorkspaceBatchMarker(value)) {
    throw new WorkspaceMarkerValidationError(`Workspace marker has an unsupported shape: ${path}`);
  }
  return value;
}

export async function validateWorkspaceBatchBoundary(
  batchPath: string,
  workspaceTempRoot: string,
): Promise<string> {
  const [realBatch, realTempRoot] = await Promise.all([
    realpath(resolve(batchPath)),
    realpath(resolve(workspaceTempRoot)),
  ]);
  if (dirname(realBatch) !== realTempRoot || !basename(realBatch).startsWith("batch-")) {
    throw new WorkspaceMarkerValidationError(
      `Workspace batch is outside the managed temp root: ${realBatch}`,
    );
  }
  return realBatch;
}

function validWorkspaceBatchMarker(value: unknown): value is WorkspaceBatchMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<WorkspaceBatchMarker>;
  return marker.schemaVersion === WORKSPACE_BATCH_MARKER_VERSION
    && typeof marker.batchId === "string"
    && marker.batchId.length > 0
    && typeof marker.threadId === "string"
    && marker.threadId.length > 0
    && typeof marker.instanceId === "string"
    && marker.instanceId.length > 0
    && Number.isSafeInteger(marker.pid)
    && (marker.pid ?? 0) > 0
    && typeof marker.workspaceRoot === "string"
    && typeof marker.repoRoot === "string"
    && typeof marker.rootRelative === "string"
    && typeof marker.createdAt === "number"
    && Number.isFinite(marker.createdAt);
}

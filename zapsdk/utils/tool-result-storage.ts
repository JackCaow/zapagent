import { chmodSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, lstatSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { join, sep, basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getAppDataDir } from "./platform.js";
import { resolveProjectDataSegment } from "./project-paths.js";
import { writeFileAtomicSync } from "./atomic-write.js";
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints } from "./logical-lines.js";

/**
 * Persist oversized tool_result content to disk and replace the conversation
 * copy with a compact preview + marker.
 *
 * Why: a single `read_file` of an 18k-char report can consume ~5k tokens of
 * every subsequent API call. Over a long session this dominates token spend
 * and forces aggressive compaction. CCB's mitigation (ported here): when a
 * tool_result exceeds a size threshold, write the full content to a tagged
 * file on disk and return a short preview + marker. The marker format makes
 * the content recoverable if the agent later asks for it, and leaves a
 * human-readable breadcrumb in the conversation transcript.
 *
 * Storage path:
 * `~/.zapcode/projects/<project-id>/tool-outputs/<session-id>/<tool-call-id>.txt`
 *
 * This is safe to call multiple times with the same id (idempotent file
 * write). Failures (disk full, permission error) degrade to a bounded head/tail
 * preview with an explicit warning so one failed write cannot overflow every
 * later provider call.
 */

/** Char count above which the tool_result gets persisted. Ports CCB's
 *  `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`. */
export const PERSIST_THRESHOLD_CHARS = 50_000;

/** How many leading chars to keep inline as a preview. Short enough not to
 *  dominate context, long enough that a model can tell "yes this is the
 *  file I just asked for" without re-opening it. */
export const PREVIEW_CHARS = 2_000;

const FAILED_PREVIEW_HEAD_CHARS = 1_400;
const FAILED_PREVIEW_TAIL_CHARS = 600;
const MAX_FAILURE_REASON_CHARS = 240;
const MAX_PERSISTED_OUTPUT_FINGERPRINTS = 512;

/** Tag that wraps the preview block. Models can also be told to search for
 *  this tag to identify persisted content. Matches CCB's tag choice. */
export const PERSISTED_OUTPUT_TAG = "persisted-output";

const storageDirCache = new Map<string, string>();
interface PersistedOutputFingerprint {
  contentHash: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
const persistedOutputFingerprints = new Map<string, PersistedOutputFingerprint>();

function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  } catch {}
}

function getStorageDir(sessionId: string, projectCwd = process.cwd()): string {
  const dataDir = getAppDataDir();
  const projectId = resolveProjectDataSegment(projectCwd);
  const safeSessionId = sanitize(sessionId);
  const cacheKey = storageCacheKey(dataDir, projectId, safeSessionId);
  const cached = storageDirCache.get(cacheKey);
  if (cached) {
    ensurePrivateDir(cached);
    return cached;
  }
  const dir = join(dataDir, "projects", projectId, "tool-outputs", safeSessionId);
  ensurePrivateDir(dir);
  storageDirCache.set(cacheKey, dir);
  return dir;
}

function storageCacheKey(dataDir: string, projectId: string, safeSessionId: string): string {
  return `${dataDir}\0${projectId}\0${safeSessionId}`;
}

/** Filesystem-safe, non-traversing id with a stable fallback. */
function sanitize(id: string): string {
  const safe = id
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  if (safe && safe !== "." && safe !== "..") return safe;
  return `id_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** Stable id for a tool_result when the LLM-provided toolCallId is missing. */
function synthId(toolName: string, content: string): string {
  const hash = createHash("sha256").update(toolName).update(content).digest("hex").slice(0, 16);
  return `synth_${hash}`;
}

export interface PersistResult {
  /** Content to put in the conversation (preview + marker, or original if below threshold). */
  contentForConversation: string;
  /** Absolute path where the full output was written, or undefined if not persisted. */
  persistedPath?: string;
  /** Whether persistence actually happened. */
  persisted: boolean;
  /** Whether this call attempted a write. False means the content was below
   *  the threshold and returned unchanged. */
  attempted?: boolean;
  /** Bounded one-line storage error when a write was attempted but failed. */
  failureReason?: string;
  /** True when an unchanged file written earlier in this process was reused. */
  reused?: boolean;
}

export interface MaybePersistToolResultOptions {
  /** Project cwd used to derive `<project-id>`. Defaults to `process.cwd()` for
   *  backwards compatibility, but embedders should pass this explicitly. */
  projectCwd?: string;
  /** Persist even below the fixed global threshold. LoopAgent uses this when
   *  one result would consume too much of a smaller model's context window. */
  force?: boolean;
  /** LoopAgent supplies its session-scoped runtime output reader. */
  readerTool?: "read_tool_output";
}

/**
 * Maybe-persist oversized tool output.
 *
 * @param toolCallId  LLM-provided id; used as filename stem. Falls back to
 *                    a content hash if missing (e.g. non-streaming path).
 * @param sessionId   The current session id. Keeps outputs from different
 *                    sessions isolated so `/sessions` restore doesn't mix.
 * @param toolName    Tool name — included in the marker so the reader knows
 *                    which tool produced the output.
 * @param content     Original tool output.
 */
export function maybePersistToolResult(
  toolCallId: string | undefined,
  sessionId: string,
  toolName: string,
  content: string,
  options: MaybePersistToolResultOptions = {},
): PersistResult {
  const totalChars = countCodePoints(content);
  if (!options.force && totalChars < PERSIST_THRESHOLD_CHARS) {
    return {
      contentForConversation: content,
      persisted: false,
      attempted: false,
      reused: false,
    };
  }

  const id = toolCallId ?? synthId(toolName, content);
  const dir = getStorageDir(sessionId, options.projectCwd);
  const filePath = join(dir, `${sanitize(id)}.txt`);
  const contentHash = createHash("sha256").update(content).digest("hex");

  if (canReusePersistedOutput(filePath, contentHash)) {
    return {
      contentForConversation: buildPersistedOutputMarker(toolName, content, totalChars, filePath, options.readerTool),
      persistedPath: filePath,
      persisted: true,
      attempted: true,
      reused: true,
    };
  }

  try {
    writeFileAtomicSync(filePath, content, { mode: 0o600 });
    rememberPersistedOutput(filePath, contentHash);
  } catch (err) {
    persistedOutputFingerprints.delete(filePath);
    const failureReason = normalizeFailureReason(err);
    return {
      contentForConversation: buildPersistenceFailurePreview(
        toolName,
        content,
        totalChars,
        failureReason,
      ),
      persisted: false,
      attempted: true,
      failureReason,
      reused: false,
    };
  }

  return {
    contentForConversation: buildPersistedOutputMarker(toolName, content, totalChars, filePath, options.readerTool),
    persistedPath: filePath,
    persisted: true,
    attempted: true,
    reused: false,
  };
}

function buildPersistedOutputMarker(
  toolName: string,
  content: string,
  totalChars: number,
  filePath: string,
  readerTool?: "read_tool_output",
): string {
  const preview = sliceHeadCodePoints(content, PREVIEW_CHARS);
  return [
    preview,
    countCodePoints(preview) < totalChars ? "\n…(truncated)\n" : "",
    `<${PERSISTED_OUTPUT_TAG}>`,
    `  tool: ${toolName}`,
    `  full_chars: ${totalChars}`,
    `  path: ${filePath}`,
    readerTool
      ? `  hint: Use read_tool_output with this path; offset/limit are Unicode character counts. Use search for literal text lookup.`
      : `  hint: If you need the full output, read ${filePath} with read_file; use offset/limit for large files.`,
    `</${PERSISTED_OUTPUT_TAG}>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function canReusePersistedOutput(filePath: string, contentHash: string): boolean {
  const cached = persistedOutputFingerprints.get(filePath);
  if (!cached || cached.contentHash !== contentHash) return false;
  try {
    const stat = statSync(filePath);
    const unchanged = stat.isFile() &&
      stat.dev === cached.dev &&
      stat.ino === cached.ino &&
      stat.size === cached.size &&
      stat.mtimeMs === cached.mtimeMs &&
      stat.ctimeMs === cached.ctimeMs;
    if (unchanged) return true;
  } catch {}
  persistedOutputFingerprints.delete(filePath);
  return false;
}

function rememberPersistedOutput(filePath: string, contentHash: string): void {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return;
    setPersistedOutputFingerprint(filePath, {
      contentHash,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    });
  } catch {
    persistedOutputFingerprints.delete(filePath);
  }
}

function setPersistedOutputFingerprint(
  filePath: string,
  fingerprint: PersistedOutputFingerprint,
): void {
  persistedOutputFingerprints.delete(filePath);
  persistedOutputFingerprints.set(filePath, fingerprint);
  while (persistedOutputFingerprints.size > MAX_PERSISTED_OUTPUT_FINGERPRINTS) {
    const oldest = persistedOutputFingerprints.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    persistedOutputFingerprints.delete(oldest);
  }
}

function buildPersistenceFailurePreview(
  toolName: string,
  content: string,
  totalChars: number,
  failureReason: string,
): string {
  const previewBudget = FAILED_PREVIEW_HEAD_CHARS + FAILED_PREVIEW_TAIL_CHARS;
  const preview = totalChars <= previewBudget
    ? content
    : [
        sliceHeadCodePoints(content, FAILED_PREVIEW_HEAD_CHARS),
        `\n…(${totalChars - previewBudget} chars omitted; full output unavailable)…\n`,
        sliceTailCodePoints(content, FAILED_PREVIEW_TAIL_CHARS),
      ].join("");
  return [
    preview,
    `<${PERSISTED_OUTPUT_TAG} status="unavailable">`,
    `  tool: ${toolName}`,
    `  full_chars: ${totalChars}`,
    `  storage_error: ${failureReason}`,
    "  hint: Full output could not be stored; rerun the tool with narrower output if omitted content is needed.",
    `</${PERSISTED_OUTPUT_TAG}>`,
  ].join("\n");
}

function normalizeFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const oneLine = raw.replace(/\s+/g, " ").trim() || "unknown storage error";
  return countCodePoints(oneLine) <= MAX_FAILURE_REASON_CHARS
    ? oneLine
    : `${sliceHeadCodePoints(oneLine, MAX_FAILURE_REASON_CHARS - 1)}…`;
}

/** Read a persisted tool output back by path. Returns null on failure. */
export function readPersistedOutput(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** A host-owned session capability, independent of workspace file permissions.
 * Capture the namespace once; model arguments can select only direct output
 * files in it. Reopening the same saved session preserves access after resume.
 */
export function createPersistedOutputReader(sessionId: string, projectCwd: string): (path: string) => string {
  const dataDir = resolve(getAppDataDir());
  const segments = ["projects", resolveProjectDataSegment(projectCwd), "tool-outputs", sanitize(sessionId)];
  const outputDir = join(dataDir, ...segments);
  return (path) => {
    if (path !== join(outputDir, basename(path)) || dirname(path) !== outputDir || !path.endsWith(".txt")) {
      throw new Error("Output is not owned by this agent session");
    }
    // The configured data root may itself be a platform alias (e.g. /tmp on
    // macOS); no directory below that root may redirect this capability.
    let ancestor = dataDir;
    for (const segment of segments) {
      ancestor = join(ancestor, segment);
      const entry = lstatSync(ancestor);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Output storage directory was redirected");
    }
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1) throw new Error("Output must be a regular, unlinked session file");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Output changed while opening");
      }
      if (opened.size > 25_000_000) throw new Error("Output exceeds the 25 MB read limit");
      const buffer = Buffer.alloc(opened.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const n = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (n === 0) break;
        bytes += n;
      }
      const after = fstatSync(fd);
      const entryAfter = lstatSync(path);
      if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !entryAfter.isFile() || entryAfter.dev !== opened.dev || entryAfter.ino !== opened.ino || entryAfter.nlink !== 1) {
        throw new Error("Output changed while reading; retry the read");
      }
      ancestor = dataDir;
      for (const segment of segments) {
        ancestor = join(ancestor, segment);
        if (!lstatSync(ancestor).isDirectory()) throw new Error("Output storage directory was redirected");
      }
      return buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
  };
}

/** Remove full tool outputs after the owning saved session is deleted. */
export function deletePersistedToolOutputs(
  sessionId: string,
  options: { projectCwd?: string } = {},
): boolean {
  const dataDir = getAppDataDir();
  const projectId = resolveProjectDataSegment(options.projectCwd ?? process.cwd());
  const safeSessionId = sanitize(sessionId);
  const dir = join(dataDir, "projects", projectId, "tool-outputs", safeSessionId);
  storageDirCache.delete(storageCacheKey(dataDir, projectId, safeSessionId));
  for (const path of persistedOutputFingerprints.keys()) {
    if (path.startsWith(`${dir}${sep}`)) persistedOutputFingerprints.delete(path);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return !existsSync(dir);
  } catch {
    return false;
  }
}

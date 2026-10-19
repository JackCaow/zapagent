import { readFile, writeFile, readdir, mkdir, unlink, rename, link, stat, lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, join, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Tool, ToolExecutionContext } from "../tools/types.js";
import type { ToolEffects } from "../tools/effects.js";
import type { ContentBlock } from "../core/types.js";
import { walkAndMatch } from "./glob.js";
import { buildDiffMeta, isProbablyText, type DiffMeta } from "./diff-meta.js";
import { expandHome } from "../utils/path.js";
import { isSupportedImage, loadImageFromFile } from "../utils/image.js";
import { countCodePoints, sliceHeadCodePoints, splitLogicalLines } from "../utils/logical-lines.js";
import { validateSyntax } from "./syntax-check.js";

// ─── Shared helpers (also used by edit.ts) ───────────────────────────────────

export interface FileAccessOptions {
  allowedPaths?: string[];
  /** Host opt-in: the broker's per-call grant is authoritative. Direct SDK
   * handlers keep their configured roots unless this is explicitly enabled. */
  useExecutionGrants?: boolean;
}

export async function isToolPathAllowed(
  path: string,
  options: FileAccessOptions,
  context: ToolExecutionContext | undefined,
  operation: "read" | "write" = "read",
): Promise<boolean> {
  if (!options.useExecutionGrants) return isPathAllowed(path, options.allowedPaths);
  const grant = context?.grant;
  if (!grant || grant.expiresAt <= Date.now() || !context?.toolCallId || grant.callId !== context.toolCallId) return false;
  const canonical = await canonicalizeWithNearestExistingAncestor(path);
  // Grant roots were canonicalized before approval. Never re-resolve them:
  // a retargeted symlink must not expand a previously approved capability.
  return !!canonical && (grant.filesystem?.[operation] ?? []).some(root => isWithinPath(canonical, resolve(root)));
}

export async function isToolPathWriteAllowed(
  path: string,
  options: FileAccessOptions & { protectedPaths?: string[] },
  context: ToolExecutionContext | undefined,
): Promise<boolean> {
  if (!(await isToolPathAllowed(path, options, context, "write"))) return false;
  const canonical = canonicalizeWithNearestExistingAncestorSync(path);
  return !(options.protectedPaths ?? []).some(root => isWithinPath(canonical, canonicalizeWithNearestExistingAncestorSync(root)));
}

/** Resolve existing ancestors so directory symlinks cannot escape allowed roots. */
export async function isPathAllowed(filePath: string, allowed: string[] | undefined): Promise<boolean> {
  if (!allowed?.length) return true;
  const abs = resolve(filePath);
  for (const p of allowed) {
    const root = resolve(p);
    const [canonicalPath, canonicalRoot] = await Promise.all([
      canonicalizeWithNearestExistingAncestor(abs),
      canonicalizeWithNearestExistingAncestor(root),
    ]);
    if (canonicalPath && canonicalRoot && isWithinPath(canonicalPath, canonicalRoot)) {
      return true;
    }
  }
  return false;
}

export async function isPathWriteAllowed(
  filePath: string,
  allowed: string[] | undefined,
  protectedPaths: string[] | undefined,
): Promise<boolean> {
  if (!(await isPathAllowed(filePath, allowed))) return false;
  const canonical = canonicalizeWithNearestExistingAncestorSync(filePath);
  return !(protectedPaths ?? []).some((path) => isWithinPath(
    canonical,
    canonicalizeWithNearestExistingAncestorSync(path),
  ));
}

function isWithinPath(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalizeWithNearestExistingAncestor(path: string): Promise<string | null> {
  let current = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...missingSegments.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

export function resolveToolPath(path: string, defaultCwd: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(defaultCwd, expanded);
}

export function resolveToolPathCanonical(path: string, defaultCwd: string): string {
  return canonicalizeWithNearestExistingAncestorSync(resolveToolPath(path, defaultCwd));
}

/** Effect paths include both the directory entry being mutated and its
 * canonical target. This keeps symlink semantics correct for delete/move
 * while ensuring policy sees an outside target before execution. */
export function resolveToolEffectPaths(path: string, defaultCwd: string): string[] {
  const lexical = resolveToolPath(path, defaultCwd);
  const canonical = resolveToolPathCanonical(path, defaultCwd);
  try {
    if (lstatSync(lexical).isSymbolicLink()) return [...new Set([lexical, canonical])];
  } catch {}
  return [canonical];
}

export function declaredMutationEffects(paths: string[], operation: "modify" | "delete" = "modify"): ToolEffects {
  return {
    filesystem: [{ kind: "filesystem", operation, paths: [...new Set(paths)] }],
    network: [],
    process: [],
    external: [],
    workspace: { mode: "root-integration" },
    confidence: "declared",
  };
}

/** Canonicalize even when the final path does not exist. This closes the
 * classic "allowed/workspace-link -> /outside" authorization gap for both
 * existing files and new files created below a symlinked directory. */
export function canonicalizeWithNearestExistingAncestorSync(path: string): string {
  let current = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missingSegments.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return resolve(path);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

export interface AtomicWriteOptions {
  /** Fail atomically if the destination appeared after the caller observed it missing. */
  replaceExisting?: boolean;
}

/** Write via a same-directory temporary file, then atomically publish it. */
export async function atomicWrite(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const abs = resolve(filePath);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content, "utf-8");
    if (options.replaceExisting === false) {
      // A same-filesystem hard link is an atomic create-if-absent operation.
      // Unlike rename(), it cannot overwrite a destination created after the
      // caller's initial ENOENT observation.
      await link(tmp, abs);
      try { await unlink(tmp); } catch {}
      return;
    }
    await rename(tmp, abs);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export interface ReadFileOptions extends FileAccessOptions {
  maxLength?: number;
  allowedPaths?: string[];
  /** Base directory for relative paths and auto-resolution. Defaults to process.cwd(). */
  defaultCwd?: string;
}

export function readFileTool(options: ReadFileOptions = {}): Tool {
  const maxLength = options.maxLength ?? 100_000;
  const defaultCwd = options.defaultCwd ?? process.cwd();

  return {
    definition: {
      name: "read_file",
      description:
        "Read text with line numbers or load an image. Glob/basename matches return a candidate; retry with its exact path to read. " +
        "Use offset/limit for large files. SVG defaults to an image preview; use `as: \"text\"` for XML.",
      parameters: z.object({
        path: z.string().describe("File path, glob pattern, or basename"),
        offset: z.number().int().optional().describe("First line to read (1-based, inclusive)"),
        limit: z.number().int().optional().describe("Maximum number of lines to return"),
        as: z.enum(["text", "image"]).optional().describe("Override the default read mode. Useful for SVG: 'image' (default) shows the rendered preview, 'text' returns the XML source for editing."),
      }),
      permission: "confirm",
      readOnly: true,
      resolveEffects: (args) => ({
        filesystem: [{
          kind: "filesystem",
          operation: "read",
          paths: [resolveToolPathCanonical(String(args.path), defaultCwd)],
        }],
        network: [],
        process: [],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const inputPath = expandHome(args.path as string);
      const filePath = resolveToolPath(inputPath, defaultCwd);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const mode = args.as as ("text" | "image" | undefined);

      if (!(await isToolPathAllowed(filePath, options, context))) {
        return pathNotAllowed(filePath, options.allowedPaths);
      }

      // Fast path: literal file exists
      const first = await doRead(filePath, offset, limit, maxLength, mode);
      if (first.success || first.code !== "ENOENT") return stripCode(first);

      // ENOENT — attempt project-wide resolution
      const resolved = await resolvePath(inputPath, defaultCwd);
      if (resolved.kind === "unique") {
        // Candidate discovery retains the SDK's default roots; reading the
        // candidate requires a fresh exact-path grant on the next invocation.
        if (!(await isPathAllowed(resolved.path, options.allowedPaths))) {
          return pathNotAllowed(resolved.path, options.allowedPaths);
        }
        // The actual target must pass authorization on a new exact-path call.
        // Reading here would bypass a deny/ask rule for the resolved directory.
        return {
          success: false,
          output: `A unique candidate was found: ${resolved.path}. Call read_file again with that exact path so its permissions are checked.`,
          error: "Exact file path required after path resolution",
          meta: { pathCandidate: resolved.path },
        };
      }
      if (resolved.kind === "many") {
        return {
          success: false,
          output: "",
          error: `'${inputPath}' not found. ${resolved.paths.length} candidates in project:\n  ${resolved.paths.join("\n  ")}${resolved.truncated ? "\n  ...(more matches exist — narrow the path)" : ""}`,
        };
      }

      // No matches — fall back to fuzzy suggestions in the target dir
      const hints = await suggestPaths(inputPath, defaultCwd);
      if (hints.length > 0) {
        return {
          success: false,
          output: "",
          error: `${first.error}\n\nDid you mean:\n  ${hints.join("\n  ")}`,
        };
      }
      return stripCode(first);
    },
  };
}

function stripCode<T extends { code?: string }>(r: T): Omit<T, "code"> {
  const { code: _c, ...rest } = r;
  return rest;
}

interface DoReadResult {
  success: boolean;
  output: string;
  error?: string;
  code?: string;
  contentBlocks?: ContentBlock[];
}

/**
 * Default upper bound on lines returned when the caller doesn't specify `limit`.
 *
 * Mirrors Claude Code's cap. Without this, a 5k-line file dumped into the
 * assistant's context on a whim eats ~25% of a 100k window, and the model
 * often doesn't realize the page was truncated because the last line looks
 * unremarkable. With the cap, the header explicitly says how much remains
 * and nudges the model to use offset/limit or search_files first.
 */
const DEFAULT_LINE_LIMIT = 2000;

/**
 * Reject read_file outright for files above this size. We read the whole
 * file into memory before slicing by offset/limit, so very large files
 * cost RAM and stall the UI while Node decodes UTF-8. 50 MB catches
 * accidental `read_file` on giant logs / data dumps while still passing
 * any reasonable source file (even a minified bundle is usually <5 MB).
 * Users hitting this should switch to `grep`/`tail` via `bash`, or to
 * `search_files`.
 */
const READ_MAX_BYTES = 50 * 1024 * 1024;

async function doRead(
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  maxLength: number,
  mode?: "text" | "image",
): Promise<DoReadResult> {
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      return { success: false, output: "", error: `"${path}" is not a regular file.` };
    }

    // Image files: load as base64 content block and return alongside a short
    // text stub. Providers serialize the block into multimodal tool_result
    // (Anthropic) or a follow-up user message (OpenAI-compat). The agent
    // can override SVG's default-image behavior by passing as:"text" to
    // get the XML source instead (useful for editing).
    const wantImage = mode === "image" || (mode === undefined && isSupportedImage(path));
    if (wantImage) {
      try {
        const img = loadImageFromFile(path)
        return {
          success: true,
          output: `Loaded image ${path} (${img.mediaType}, ${(st.size / 1024).toFixed(1)} KB).`,
          contentBlocks: [img],
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        return { success: false, output: "", error: m }
      }
    }

    if (st.size > READ_MAX_BYTES) {
      const mb = (st.size / 1024 / 1024).toFixed(1);
      return {
        success: false,
        output: "",
        error: `"${path}" is ${mb} MB, above the ${READ_MAX_BYTES / 1024 / 1024} MB cap. Use bash (tail/head/grep), search_files, or glob_files for large files.`,
      };
    }
    const raw = await readFile(path, "utf-8");

    // Binary detection: >30% non-printable bytes in first 8 KB
    const sample = raw.slice(0, 8192);
    const nonPrintable = (sample.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g) ?? []).length;
    if (nonPrintable / sample.length > 0.3) {
      return { success: false, output: "", error: `"${path}" appears to be a binary file.` };
    }

    const lines = splitLogicalLines(raw);
    const off = offset ?? 1;
    // Explicit limit wins; otherwise clamp to DEFAULT_LINE_LIMIT so big files
    // don't silently flood the context.
    const lim = limit ?? DEFAULT_LINE_LIMIT;
    const start = Math.max(0, off - 1);
    const end = Math.min(lines.length, start + lim);
    const slice = lines.slice(start, end);

    // Line-number prefix: number left-aligned in a fixed-width slot, then
    // → and a space before content. The fixed width keeps all → arrows in
    // the same column; the trailing space gives visual breathing room
    // between the gutter and the code. E.g. with width=3:
    //   "1  → <!DOCTYPE html>"
    //   "100→ <body>"
    const width = String(end).length;
    let content = slice
      .map((line, i) => `${String(start + i + 1).padEnd(width, " ")}→ ${line}`)
      .join("\n");

    const truncated = countCodePoints(content) > maxLength;
    if (truncated) content = sliceHeadCodePoints(content, maxLength) + `\n...[truncated by maxLength]`;

    // Header strategies (explicit > implicit — the model needs to KNOW it
    // only got part of the file so it can decide whether to paginate):
    //  - No clamping (range covers whole file): no header
    //  - Partial read by offset OR hit default line cap: loud one-liner
    //    telling the model what it has and how to get more.
    const hitDefaultCap =
      limit === undefined && end < lines.length;
    let header = "";
    if (hitDefaultCap) {
      header = `# Lines ${start + 1}-${end} of ${lines.length} in ${path}. Default limit of ${DEFAULT_LINE_LIMIT} lines reached — use offset+limit to read more, or search_files/glob_files to locate specific sections.\n`;
    } else if (end < lines.length || start > 0) {
      header = `# Lines ${start + 1}-${end} of ${lines.length} (${path})\n`;
    }
    return { success: true, output: header + content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException)?.code;
    return { success: false, output: "", error: message, code };
  }
}

type ResolveResult =
  | { kind: "unique"; path: string }
  | { kind: "many"; paths: string[]; truncated: boolean }
  | { kind: "none" };

/** Resolve a non-existent path to a file in the project tree (literal basename first, then glob). */
async function resolvePath(input: string, defaultCwd: string): Promise<ResolveResult> {
  const cwd = resolve(defaultCwd);
  const absInput = resolveToolPath(input, cwd);

  // Don't auto-resolve absolute paths pointing outside cwd — user clearly meant an external location
  if (isAbsolute(input) && !absInput.startsWith(cwd + sep) && absInput !== cwd) {
    return { kind: "none" };
  }

  const hasGlobMeta = /[*?{}]/.test(input) || /\[.*\]/.test(input);
  const matches: string[] = [];
  const cap = 20;

  // Pass 1: literal basename walk (NO glob interpretation — `file[1].ts` is taken verbatim)
  try {
    await walkLiteral(cwd, cwd, basename(input), matches, cap);
  } catch {
    /* fall through */
  }

  // Pass 2: only if literal found nothing AND the input looks glob-shaped, try it as a pattern.
  if (matches.length === 0 && hasGlobMeta) {
    try {
      await walkAndMatch(cwd, cwd, stripLeadingSlashes(input), matches, cap);
    } catch {
      /* fall through */
    }
  }

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", path: join(cwd, matches[0]) };
  return {
    kind: "many",
    paths: matches.slice(0, 5).map((m) => join(cwd, m)),
    truncated: matches.length > 5,
  };
}

async function walkLiteral(
  baseDir: string,
  currentDir: string,
  target: string,
  matches: string[],
  cap: number,
): Promise<void> {
  if (matches.length >= cap) return;
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= cap) break;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkLiteral(baseDir, full, target, matches, cap);
    } else if (entry.isFile() && entry.name === target) {
      matches.push(relative(baseDir, full).replace(/\\/g, "/"));
    }
  }
}

function stripLeadingSlashes(p: string): string {
  return p.replace(/^\/+/, "");
}

/** On ENOENT, find similarly-named files in the parent dir or one level up. */
async function suggestPaths(target: string, defaultCwd: string): Promise<string[]> {
  const abs = resolveToolPath(target, defaultCwd);
  const needle = basename(abs).toLowerCase();
  if (!needle) return [];

  let dir = dirname(abs);
  for (let depth = 0; depth < 2; depth++) {
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return [];
      dir = parent;
      continue;
    }

    const exact = entries.filter((e) => e.name.toLowerCase() === needle);
    if (exact.length > 0) return exact.map((e) => join(dir, e.name));

    if (depth === 0) {
      const fuzzy = entries
        .map((e) => ({ name: e.name, d: editDistance(e.name.toLowerCase(), needle) }))
        .filter((x) => x.d > 0 && x.d <= 2)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      if (fuzzy.length > 0) return fuzzy.map((f) => join(dir, f.name));
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = tmp;
    }
  }
  return row[b.length];
}

function pathNotAllowed(path: string, allowedPaths: string[] | undefined) {
  return {
    success: false as const,
    output: "",
    error: `Path "${path}" is not allowed. Allowed paths: ${(allowedPaths ?? []).join(", ")}`,
  };
}

/** Soft size hint shared by write_file and edit_file. The write itself still
 * succeeds: this is feedback for the next model step, not a policy limit. */
const LARGE_WRITE_BYTES = 5_000;
export function chunkingHint(bytes: number, kind: "write" | "edit"): string {
  if (bytes <= LARGE_WRITE_BYTES) return "";
  const verb = kind === "edit" ? "edited" : "written";
  return (
    `\n\nNote: ${verb} ${bytes} bytes in one call. ` +
    "Re-read or validate the file before making further changes."
  );
}

export interface WriteFileOptions extends FileAccessOptions {
  allowedPaths?: string[];
  protectedPaths?: string[];
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
  /** Test seam: called after diff capture and before the final stale-write guard. */
  beforeWrite?: (filePath: string) => void | Promise<void>;
}

export function writeFileTool(options: WriteFileOptions = {}): Tool {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "write_file",
      description:
        "Create or overwrite a file and parent directories; prefer edit_file for partial changes. " +
        "Edits are backed up for rewind when file tracking is enabled; respect filesystem permissions.",
      parameters: z.object({
        path: z.string().describe("Absolute or relative path to the file"),
        content: z.string().describe("Content to write to the file"),
        skip_syntax_check: z.boolean().optional().describe("Skip the pre-write syntax check (TS/JS/JSON only). Use only when the validator gives a known false positive."),
      }),
      permission: "confirm",
      checkpointTracking: "files",
      writesPath: (args) => [resolveToolPath(args.path as string, defaultCwd)],
      resolveEffects: (args) => declaredMutationEffects(
        resolveToolEffectPaths(args.path as string, defaultCwd),
      ),
    },
    handler: async (args, signal, context) => {
      const filePath = resolveToolPath(args.path as string, defaultCwd);
      const content = args.content as string;
      const skipSyntaxCheck = (args.skip_syntax_check as boolean) ?? false;

      if (!(await isToolPathWriteAllowed(filePath, options, context))) {
        return {
          success: false,
          output: "",
          error: `Path "${filePath}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
        };
      }

      // Race guard: snapshot mtime/size before we read for diff, then re-stat
      // just before the write. Protects only this call's read-to-write window
      // (parallel to edit_file) — not the larger gap between the model last
      // observing the file and calling write_file.
      let statBefore: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        statBefore = await stat(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, output: "", error: message };
        }
      }

      // Read prior content (if any) and compute the diff right here, so the
      // UI never has to recompute and session storage only carries the compact
      // diff rather than the full old file. Size is proportional to CHANGES,
      // not to file size.
      const diffMeta = await captureWriteDiff(filePath, content);

      try {
        await options.beforeWrite?.(filePath);
        if (statBefore) {
          const statAfter = await stat(filePath);
          if (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size) {
            return {
              success: false,
              output: "",
              error: `File ${filePath} was modified concurrently (mtime/size changed). Re-read and retry.`,
            };
          }
        }
        // Pre-write syntax check (TS/JS/JSON; other extensions skip).
        if (!skipSyntaxCheck) {
          const syn = validateSyntax(filePath, content);
          if (!syn.ok) {
            return {
              success: false,
              output: "",
              error: `Pre-write syntax check failed for ${filePath}: ${syn.error}\nPass skip_syntax_check=true if this is a known false positive.`,
            };
          }
        }
        await atomicWrite(filePath, content, {
          replaceExisting: statBefore !== null,
        });
        return {
          success: true,
          output: `Written ${countCodePoints(content)} chars to ${filePath}` + chunkingHint(Buffer.byteLength(content, "utf-8"), "write"),
          meta: diffMeta,
        };
      } catch (err) {
        if (!statBefore && (err as NodeJS.ErrnoException)?.code === "EEXIST") {
          return {
            success: false,
            output: "",
            error: `File ${filePath} was created concurrently. Re-read and retry.`,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

/** Read prior file (if any), detect binary, build a DiffMeta. Pure best-effort;
 *  any failure yields a skipped meta rather than aborting the write. */
async function captureWriteDiff(filePath: string, newContent: string): Promise<DiffMeta> {
  let oldText = "";
  let skipped: DiffMeta["skipped"] | undefined;
  try {
    const raw = await readFile(filePath);
    if (!isProbablyText(raw)) skipped = "binary";
    else oldText = raw.toString("utf-8");
  } catch (err) {
    // ENOENT → new file, no skip; anything else → mark read_error
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") skipped = "read_error";
  }
  if (skipped) {
    return {
      diff: "",
      filetype: "",
      oldBytes: 0,
      newBytes: Buffer.byteLength(newContent, "utf-8"),
      skipped,
    };
  }
  return buildDiffMeta(oldText, newContent, filePath);
}

export interface DeleteFileOptions extends FileAccessOptions {
  allowedPaths?: string[];
  protectedPaths?: string[];
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
}

export function deleteFileTool(options: DeleteFileOptions = {}): Tool {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "delete_file",
      description: "Delete a file at the given path.",
      parameters: z.object({
        path: z.string().describe("Absolute or relative path to the file to delete"),
      }),
      permission: "confirm",
      checkpointTracking: "files",
      writesPath: (args) => [resolveToolPath(args.path as string, defaultCwd)],
      resolveEffects: (args) => declaredMutationEffects(
        resolveToolEffectPaths(args.path as string, defaultCwd), "delete",
      ),
    },
    handler: async (args, signal, context) => {
      const filePath = resolveToolPath(args.path as string, defaultCwd);
      if (!(await isToolPathWriteAllowed(filePath, options, context))) {
        return {
          success: false,
          output: "",
          error: `Path "${filePath}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
        };
      }
      try {
        await unlink(filePath);
        return { success: true, output: `Deleted ${filePath}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

export interface MoveFileOptions extends FileAccessOptions {
  allowedPaths?: string[];
  protectedPaths?: string[];
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
  /** Test seam: called after parent creation and before publishing the destination. */
  beforeMove?: (source: string, destination: string) => void | Promise<void>;
}

export function moveFileTool(options: MoveFileOptions = {}): Tool {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "move_file",
      description: "Move or rename a file without overwriting an existing destination by default. Creates destination parent directories. Pass overwrite=true only when replacing the destination is intentional.",
      parameters: z.object({
        source: z.string().describe("Source file path"),
        destination: z.string().describe("Destination file path"),
        overwrite: z.boolean().optional().describe("Replace an existing destination (default: false)"),
      }),
      permission: "confirm",
      checkpointTracking: "files",
      writesPath: (args) => [
        resolveToolPath(args.source as string, defaultCwd),
        resolveToolPath(args.destination as string, defaultCwd),
      ],
      resolveEffects: (args) => ({
        ...declaredMutationEffects([]),
        filesystem: [
          ...declaredMutationEffects(resolveToolEffectPaths(args.source as string, defaultCwd), "delete").filesystem,
          ...declaredMutationEffects(resolveToolEffectPaths(args.destination as string, defaultCwd)).filesystem,
        ],
      }),
    },
    handler: async (args, signal, context) => {
      const src = resolveToolPath(args.source as string, defaultCwd);
      const dst = resolveToolPath(args.destination as string, defaultCwd);
      const overwrite = (args.overwrite as boolean | undefined) ?? false;
      if (
        !(await isToolPathWriteAllowed(src, options, context)) ||
        !(await isToolPathWriteAllowed(dst, options, context))
      ) {
        return {
          success: false,
          output: "",
          error: `Move crosses allowed-paths boundary. Allowed: ${(options.allowedPaths ?? []).join(", ")}`,
        };
      }
      try {
        if (src === dst) {
          return { success: true, output: `Source and destination are already the same file: ${src}` };
        }
        const sourceStat = await lstat(src);
        if (sourceStat.isDirectory()) {
          return {
            success: false,
            output: "",
            error: `move_file only moves files; ${src} is a directory. Use an explicitly approved shell move for directory trees.`,
          };
        }
        await mkdir(dirname(dst), { recursive: true });
        await options.beforeMove?.(src, dst);
        if (overwrite) {
          await rename(src, dst);
        } else {
          // link() publishes the destination only when it does not already
          // exist, closing the check-then-rename race that would otherwise
          // silently clobber a file created between those operations.
          await link(src, dst);
          try {
            await unlink(src);
          } catch (unlinkError) {
            try { await unlink(dst); } catch {}
            throw unlinkError;
          }
        }
        return { success: true, output: `Moved ${src} → ${dst}` };
      } catch (err) {
        if (!overwrite && (err as NodeJS.ErrnoException)?.code === "EEXIST") {
          return {
            success: false,
            output: "",
            error: `Destination ${dst} already exists. Choose another path or pass overwrite=true to replace it intentionally.`,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

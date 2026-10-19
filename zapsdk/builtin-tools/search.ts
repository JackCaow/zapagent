import { readdir, open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tools/types.js";
import { compileGlob, type GlobMatcher } from "./glob-util.js";
import { loadGitignore, type IgnoreMatcher } from "./gitignore.js";
import { isToolPathAllowed, resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";
import type { ExecutionProcessBroker } from "../execution/types.js";
import { createLocalProcessBroker } from "../execution/process.js";
import { getRgBin, RIPGREP_SCOPE_ARGS, runRipgrepRecords } from "./ripgrep.js";

export interface SearchFilesOptions {
  allowedPaths?: string[];
  useExecutionGrants?: boolean;
  maxResults?: number;
  maxFileSize?: number;
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
}

interface SearchCoverage {
  backend: "javascript";
  skipped: { oversized: number; binary: number; unreadable: number };
  examples: Array<{ path: string; reason: keyof SearchCoverage["skipped"] }>;
  limitReached: boolean;
}

function recordSkipped(coverage: SearchCoverage, path: string, reason: keyof SearchCoverage["skipped"]): void {
  coverage.skipped[reason]++;
  // Paths are untrusted data. Bound examples independently of the match budget.
  if (coverage.examples.length < 3) coverage.examples.push({ path: path.slice(0, 200), reason });
}

function fallbackResult(matches: string[], coverage: SearchCoverage, maxResults: number, maxFileSize: number): ToolResult {
  coverage.limitReached = matches.length >= maxResults;
  const omissions: string[] = [];
  if (coverage.skipped.oversized) omissions.push(`${coverage.skipped.oversized} file(s) exceeded ${maxFileSize} bytes`);
  if (coverage.skipped.binary) omissions.push(`${coverage.skipped.binary} binary file(s) skipped`);
  if (coverage.skipped.unreadable) omissions.push(`${coverage.skipped.unreadable} path(s) could not be read`);
  if (coverage.limitReached) omissions.push(`output limit of ${maxResults} entries reached`);
  let output = matches.slice(0, maxResults).join("\n") || (omissions.length
    ? "No matches found in searched files." : "No matches found.");
  if (omissions.length) {
    const examples = coverage.examples.map(e => `${JSON.stringify(e.path)} (${e.reason})`).join(", ");
    output += `\n[Search incomplete: ${omissions.join("; ")}.${examples ? ` Examples: ${examples}.` : ""} Narrow the search or inspect omitted inputs with an authorized tool; absence of matches does not cover omitted content.]`;
  }
  return { success: true, output, meta: { search: coverage } };
}

export function searchFilesTool(options: SearchFilesOptions = {}): Tool {
  const maxResults = options.maxResults ?? 200;
  const maxFileSize = options.maxFileSize ?? 1_000_000;
  const defaultCwd = options.defaultCwd ?? process.cwd();

  return {
    definition: {
      name: "search_files",
      description:
        "Search file contents for a pattern (like grep). Searches recursively. Returns matching lines with file paths and line numbers, plus 2 lines of context before/after each match by default — often enough to answer without an additional read_file. Pass context_lines: 0 to disable when you only need hit counts, or a higher value to see more surrounding code. Uses ripgrep when available for speed. The JavaScript fallback reports skipped files and output limits; partial results do not establish absence in omitted content.",
      parameters: z.object({
        pattern: z.string().max(10_000).describe("Text or regex pattern to search for"),
        path: z.string().describe("Directory to search in"),
        glob: z
          .string()
          .optional()
          .describe("File glob to filter (e.g. '**/*.ts', '*.js'). Supports full glob syntax."),
        case_sensitive: z.boolean().optional().describe("Case-sensitive search (default: false)"),
        context_lines: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Lines of context to show before/after each match (default: 2)"),
        multiline: z
          .boolean()
          .optional()
          .describe("Allow patterns to span newlines (also makes `.` match newlines). Use for cross-line constructs like multi-line function signatures or import blocks. Default: false."),
      }),
      permission: "confirm",
      readOnly: true,
      sandboxAware: true,
      executionLocation: "host",
      limits: { maxFiles: maxResults, maxFileBytes: maxFileSize },
      resolveEffects: (args) => ({
        filesystem: [{
          kind: "filesystem",
          operation: "read",
          paths: [resolveToolPathCanonical(String(args.path), defaultCwd)],
        }],
        network: [],
        process: getRgBin()
          ? [{
              kind: "process",
              operation: "spawn",
              commandClass: "search",
              background: false,
              readOnly: true,
            }]
          : [],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const pattern = args.pattern as string;
      const directory = resolveToolPath(args.path as string, defaultCwd);
      const glob = args.glob as string | undefined;
      const caseSensitive = (args.case_sensitive as boolean | undefined) ?? false;
      // Default to 2 lines of context. Small result sets get a mini-diff-style
      // view inline — the model often doesn't need a follow-up read_file. On
      // large result sets the same 2-line context is usually still cheaper
      // than individual read_file calls for each hit, and ripgrep caps the
      // total output at maxResults anyway.
      const contextLines = (args.context_lines as number | undefined) ?? 2;
      const multiline = (args.multiline as boolean | undefined) ?? false;
      const effectiveMaxResults = Math.min(maxResults, context?.limits?.maxFiles ?? maxResults);
      const effectiveMaxFileSize = Math.min(maxFileSize, context?.limits?.maxFileBytes ?? maxFileSize);

      if (!(await isToolPathAllowed(directory, options, context))) {
        return {
          success: false,
          output: "",
          error: `Path "${directory}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
        };
      }

      let targetInfo;
      try {
        targetInfo = await stat(directory);
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const targetIsFile = targetInfo.isFile();
      if (!targetIsFile && !targetInfo.isDirectory()) {
        return { success: false, output: "", error: `Path \"${directory}\" is neither a file nor a directory.` };
      }

      const rgBin = getRgBin();
      if (rgBin) {
        const processBroker = context?.process ?? createLocalProcessBroker(signal);
        const rgResult = await runRipgrep(
          rgBin,
          pattern,
          directory,
          glob,
          caseSensitive,
          contextLines,
          effectiveMaxResults,
          multiline,
          processBroker,
          targetIsFile ? dirname(directory) : directory,
          signal,
          context?.limits?.maxOutputBytes,
          context?.limits?.timeoutMs,
        );
        if (rgResult !== null) return rgResult;
      }

      // Pure-JS fallback. Two flavors: line-streaming (default) and whole-file
      // (multiline). The streaming path is more memory-friendly but can't see
      // across newlines; multiline trades RAM for cross-line support.
      const matches: string[] = [];
      const coverage: SearchCoverage = { backend: "javascript", skipped: { oversized: 0, binary: 0, unreadable: 0 }, examples: [], limitReached: false };
      const result = () => fallbackResult(matches, coverage, effectiveMaxResults, effectiveMaxFileSize);
      try {
        if (signal?.aborted) throw new Error("aborted");
        const baseFlags = caseSensitive ? "" : "i";
        const matcher = glob ? compileGlob(glob) : null;

        if (targetIsFile) {
          const relPath = relative(defaultCwd, directory).replace(/\\/g, "/") || directory;
          if (matcher && !matcher(relPath) && !matcher(relPath.split("/").at(-1) ?? relPath)) {
            return result();
          }
          if (targetInfo.size > effectiveMaxFileSize) {
            recordSkipped(coverage, relPath, "oversized");
          } else if (await isBinary(directory)) {
            recordSkipped(coverage, relPath, "binary");
          } else {
            if (multiline) {
              const regex = new RegExp(pattern, `gs${baseFlags}`);
              await searchFileMultiline(directory, relPath, regex, matches, effectiveMaxResults);
            } else {
              const regex = new RegExp(pattern, baseFlags);
              await searchFileStreaming(directory, relPath, regex, contextLines, matches, effectiveMaxResults, signal);
            }
          }
          return result();
        }

        const ignore = await loadGitignore(directory);

        if (multiline) {
          // `s` makes . match newlines; `g` is required to enumerate matches.
          const regex = new RegExp(pattern, `gs${baseFlags}`);
          await searchDirMultiline(directory, directory, regex, matcher, ignore, matches, effectiveMaxResults, effectiveMaxFileSize, coverage, signal);
        } else {
          const regex = new RegExp(pattern, baseFlags);
          await searchDir(directory, directory, regex, matcher, ignore, contextLines, matches, effectiveMaxResults, effectiveMaxFileSize, coverage, signal);
        }

        return result();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const partial = result();
        return { ...partial, success: false, output: matches.length ? partial.output : "", error: message };
      }
    },
  };
}

async function runRipgrep(
  rgBin: string,
  pattern: string,
  directory: string,
  glob: string | undefined,
  caseSensitive: boolean,
  contextLines: number,
  maxResults: number,
  multiline: boolean,
  processBroker: ExecutionProcessBroker,
  cwd: string,
  signal?: AbortSignal,
  maxOutputBytes = 2_000_000,
  timeoutMs = 30_000,
): Promise<ToolResult | null> {
  const args: string[] = [
    ...RIPGREP_SCOPE_ARGS,
    "--json",
    "--line-number",
    // rg omits the filename when searching one explicit file. The tool's
    // contract promises file:line results, and callers need that path to
    // issue a follow-up read_file, so keep it even for the single-file form.
    "--with-filename",
    "--no-heading",
    "--color=never",
  ];
  if (!caseSensitive) args.unshift("--ignore-case");
  if (contextLines > 0) args.unshift(`--context=${contextLines}`);
  if (glob) args.unshift(`--glob=${glob}`);
  if (multiline) {
    // --multiline lets the pattern span newlines; --multiline-dotall makes
    // `.` match `\n` as well, matching the JS-fallback `s` flag semantics.
    args.unshift("--multiline", "--multiline-dotall");
  }
  args.push("-e", pattern, "--", directory);

  // Reserve room for coverage diagnostics after bounded match output.
  maxOutputBytes = Math.max(0, maxOutputBytes - 2048);
  const lines: string[] = [];
  let bytes = 0;
  let matches = 0;
  let contextThrough = 0;
  let pendingContext: string[] = [];
  let pendingBytes = 0;
  let binaryFiles = 0;
  const append = (records: string[]): "output_limit" | undefined => {
    const size = records.reduce((total, record) => total + Buffer.byteLength(record) + 1, 0);
    if (bytes + size > maxOutputBytes) return "output_limit";
    bytes += size;
    lines.push(...records);
  };
  const run = await runRipgrepRecords(rgBin, args, {
    // JSON escaping can expand a byte sixfold. Bound wire records separately
    // from rendered output, including framing and submatch metadata overhead.
    process: processBroker, cwd, signal, separator: "\n", timeoutMs,
    maxRecordBytes: Math.max(65_536, maxOutputBytes * 6 + 4096),
    onRecord(line) {
      const event = JSON.parse(line);
      if (event.type === "end" && event.data.binary_offset != null) binaryFiles++;
      if (event.type === "begin") {
        contextThrough = 0;
        pendingContext = [];
        pendingBytes = 0;
      }
      if (event.type !== "match" && event.type !== "context") return;
      if (event.type === "match" && matches >= maxResults) return "result_limit";
      const beforeContext = event.type === "context" && event.data.line_number > contextThrough;
      if (beforeContext && matches >= maxResults) return;
      const decode = (value: { text?: string; bytes?: string }): string =>
        value.text ?? Buffer.from(value.bytes ?? "", "base64").toString("utf8");
      const path = decode(event.data.path);
      const displayPath = /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
      const content = decode(event.data.lines).replace(/\n$/, "").split("\n");
      const separator = event.type === "match" ? ":" : "-";
      const records: string[] = [];
      let recordBytes = 0;
      for (const [index, text] of content.entries()) {
        const record = `${displayPath}${separator}${event.data.line_number + index}${separator}${text}`;
        recordBytes += Buffer.byteLength(record) + 1;
        // Repeating a long path on each line can expand a small multiline
        // JSON record substantially. Stop before allocating that whole block.
        if (bytes + pendingBytes + recordBytes > maxOutputBytes) return "output_limit";
        records.push(record);
      }
      if (event.type === "context") {
        if (event.data.line_number <= contextThrough) return append(records);
        // Before-context belongs to the next match. Do not emit it unless
        // that match is accepted, especially after exhausting the match budget.
        pendingBytes += recordBytes;
        pendingContext.push(...records);
        return;
      }
      const stopped = append([...pendingContext, ...records]);
      if (stopped) return stopped;
      pendingContext = [];
      pendingBytes = 0;
      matches++;
      contextThrough = event.data.line_number + content.length - 1 + contextLines;
    },
  });
  if (run.unavailable) return null;
  const diagnostics = [run.error, run.stopped, run.stderr,
    binaryFiles ? `${binaryFiles} binary file(s) detected; text results may be incomplete and line numbers unreliable` : undefined].filter(Boolean).join("; ");
  const incomplete = !!diagnostics;
  let output = lines.join("\n") || (incomplete ? "No matches returned from the incomplete search." : "No matches found.");
  if (incomplete) output += `\n[Search incomplete: ${diagnostics.slice(0, 512)}. Narrow the search; absence of matches does not cover omitted content.]`;
  return { success: !run.error, output, ...(run.error ? { error: run.error } : {}),
    meta: { search: { backend: "ripgrep", complete: !incomplete, limitReached: !!run.stopped,
      reason: run.stopped, binaryFiles, diagnostic: diagnostics || undefined } } };
}

async function searchDir(
  baseDir: string,
  currentDir: string,
  regex: RegExp,
  matcher: GlobMatcher | null,
  ignore: IgnoreMatcher,
  contextLines: number,
  matches: string[],
  maxResults: number,
  maxFileSize: number,
  coverage: SearchCoverage,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  if (matches.length >= maxResults) return;

  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (signal?.aborted) throw new Error("aborted");
    if (matches.length >= maxResults) break;
    if (entry.name === "node_modules" || entry.name === ".git") continue;

    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
    if (ignore(relPath)) continue;

    if (entry.isDirectory()) {
      try {
        await searchDir(baseDir, fullPath, regex, matcher, ignore, contextLines, matches, maxResults, maxFileSize, coverage, signal);
      } catch (err) {
        if ((err as Error)?.message === "aborted") throw err;
        recordSkipped(coverage, relPath, "unreadable");
      }
      continue;
    }
    if (!entry.isFile()) continue;

    if (matcher && !matcher(relPath) && !matcher(entry.name)) continue;

    try {
      const s = await stat(fullPath);
      if (s.size > maxFileSize) { recordSkipped(coverage, relPath, "oversized"); continue; }
      if (await isBinary(fullPath)) { recordSkipped(coverage, relPath, "binary"); continue; }

      await searchFileStreaming(fullPath, relPath, regex, contextLines, matches, maxResults, signal);
    } catch (err) {
      if ((err as Error)?.message === "aborted") throw err;
      recordSkipped(coverage, relPath, "unreadable");
    }
  }
}

/** Sample first 1 KB and skip files with >30% non-printable bytes. */
async function isBinary(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    if (bytesRead === 0) return false;
    const slice = buf.subarray(0, bytesRead);
    let nonPrintable = 0;
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i];
      // Treat control bytes as non-printable; whitelist tab/LF/CR.
      if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) nonPrintable++;
    }
    return nonPrintable / slice.length > 0.3;
  } finally {
    await fh.close();
  }
}

/** Stream a file line-by-line, emit matches with optional before/after context. */
async function searchFileStreaming(
  fullPath: string,
  relPath: string,
  regex: RegExp,
  contextLines: number,
  matches: string[],
  maxResults: number,
  signal?: AbortSignal,
): Promise<void> {
  const stream = createReadStream(fullPath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNum = 0;
  const before: string[] = []; // ring buffer of previous lines
  let afterNeeded = 0;
  let lastEmittedLine = 0;   // highest line number already emitted (dedup)
  let separatorPending = false; // a closed context-group awaits a "--" before the next one

  try {
    for await (const rawLine of rl) {
      if (signal?.aborted) throw new Error("aborted");
      lineNum++;
      if (matches.length >= maxResults) break;

      // Emit "after" context for a prior match
      if (afterNeeded > 0) {
        if (lineNum > lastEmittedLine) {
          matches.push(`${relPath}:${lineNum}-${rawLine}`);
          lastEmittedLine = lineNum;
        }
        afterNeeded--;
        if (afterNeeded === 0) separatorPending = true;
      }

      if (regex.test(rawLine)) {
        // Only emit separator if the next match's before-window does NOT
        // touch the last emitted line (otherwise the two groups merge).
        if (separatorPending) {
          const beforeStart = lineNum - contextLines;
          if (beforeStart > lastEmittedLine + 1) {
            matches.push("--");
          }
          separatorPending = false;
        }
        if (contextLines > 0) {
          const startIdx = Math.max(0, before.length - contextLines);
          for (let j = startIdx; j < before.length; j++) {
            const bLineNum = lineNum - (before.length - j);
            if (bLineNum > lastEmittedLine) {
              matches.push(`${relPath}:${bLineNum}-${before[j]}`);
              lastEmittedLine = bLineNum;
            }
          }
        }
        if (lineNum > lastEmittedLine) {
          matches.push(`${relPath}:${lineNum}: ${rawLine.trim()}`);
          lastEmittedLine = lineNum;
        }
        afterNeeded = contextLines;
      }

      if (contextLines > 0) {
        before.push(rawLine);
        if (before.length > contextLines) before.shift();
      }
    }
    // No trailing "--" at EOF — rg doesn't emit one for a single file.
  } finally {
    rl.close();
    stream.destroy();
  }
}

// ─── Multiline (whole-file) JS fallback ────────────────────────────────────
//
// When the model passes `multiline: true`, ripgrep would have handled this
// via --multiline; if rg isn't available, fall back to reading each file
// whole and running the regex globally. Memory-heavier per file but the
// existing maxFileSize cap keeps the worst case bounded.

async function searchDirMultiline(
  baseDir: string,
  currentDir: string,
  regex: RegExp,
  matcher: GlobMatcher | null,
  ignore: IgnoreMatcher,
  matches: string[],
  maxResults: number,
  maxFileSize: number,
  coverage: SearchCoverage,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  if (matches.length >= maxResults) return;
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (signal?.aborted) throw new Error("aborted");
    if (matches.length >= maxResults) break;
    if (entry.name === "node_modules" || entry.name === ".git") continue;

    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
    if (ignore(relPath)) continue;

    if (entry.isDirectory()) {
      try {
        await searchDirMultiline(baseDir, fullPath, regex, matcher, ignore, matches, maxResults, maxFileSize, coverage, signal);
      } catch (err) {
        if ((err as Error)?.message === "aborted") throw err;
        recordSkipped(coverage, relPath, "unreadable");
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (matcher && !matcher(relPath) && !matcher(entry.name)) continue;

    try {
      const s = await stat(fullPath);
      if (s.size > maxFileSize) { recordSkipped(coverage, relPath, "oversized"); continue; }
      if (await isBinary(fullPath)) { recordSkipped(coverage, relPath, "binary"); continue; }
      await searchFileMultiline(fullPath, relPath, regex, matches, maxResults);
    } catch (err) {
      if ((err as Error)?.message === "aborted") throw err;
      recordSkipped(coverage, relPath, "unreadable");
    }
  }
}

async function searchFileMultiline(
  fullPath: string,
  relPath: string,
  regex: RegExp,
  matches: string[],
  maxResults: number,
): Promise<void> {
  const fh = await open(fullPath, "r");
  let content: string;
  try {
    const buf = await fh.readFile({ encoding: "utf-8" });
    content = buf;
  } finally {
    await fh.close();
  }

  // Reset lastIndex so each file starts fresh — the regex was constructed once
  // with `g` and will retain state across files otherwise.
  regex.lastIndex = 0;

  // Pre-compute newline positions so we can convert match.index → line number
  // without rescanning from start every match. The first newline at position 0
  // entry is implicit (line 1 starts at 0).
  const newlineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) newlineOffsets.push(i + 1);
  }

  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (matches.length >= maxResults) break;
    const startLine = lineOf(m.index, newlineOffsets);
    const endLine = lineOf(m.index + m[0].length - 1, newlineOffsets);
    // Display: file:start-end: <first 200 chars of match, newlines → ⏎>.
    // Truncated single-line summary keeps it grep-like; the model can
    // re-read the file at the cited range for full context.
    const display = m[0].length > 200 ? m[0].slice(0, 200) + "…" : m[0];
    const oneLine = display.replace(/\n/g, "⏎ ");
    const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    matches.push(`${relPath}:${range}: ${oneLine}`);

    // Empty-match guard: avoid infinite loop on patterns like `a*`.
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
}

function lineOf(offset: number, newlineOffsets: number[]): number {
  // Binary search for the largest index with newlineOffsets[i] <= offset.
  let lo = 0, hi = newlineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (newlineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based line numbers
}

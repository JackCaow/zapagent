import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tools/types.js";
import { compileGlob, type GlobMatcher } from "./glob-util.js";
import { loadGitignore, type IgnoreMatcher } from "./gitignore.js";
import { createLocalProcessBroker } from "../execution/process.js";
import { getRgBin, RIPGREP_SCOPE_ARGS, runRipgrepRecords } from "./ripgrep.js";
import { isToolPathAllowed, resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";

export interface GlobFilesOptions {
  allowedPaths?: string[];
  useExecutionGrants?: boolean;
  maxResults?: number;
  maxVisitedEntries?: number;
  maxDepth?: number;
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
}

export function globFilesTool(options: GlobFilesOptions = {}): Tool {
  const maxResults = options.maxResults ?? 500;
  // An explicit SDK traversal budget is honored, but ordinary enumeration is
  // bounded by time/output rather than the number of unrelated directory entries.
  const maxVisitedEntries = options.maxVisitedEntries ?? Infinity;
  const maxDepth = options.maxDepth ?? 64;
  const defaultCwd = options.defaultCwd ?? process.cwd();

  return {
    definition: {
      name: "glob_files",
      description:
        "Find files matching a glob pattern recursively using rg --files. Supports * ** ? and {a,b}; patterns are relative to the requested directory. Includes hidden files, respects ignore files, and excludes .git/node_modules. Returns relative paths with explicit scope and incomplete-result notices. Narrow path/pattern after truncation; partial results do not prove absence.",
      parameters: z.object({
        pattern: z
          .string()
          .max(10_000)
          .describe("Glob pattern (e.g. '**/*.ts', 'src/*.{js,ts}', '*.md')"),
        path: z.string().describe("Directory to search in"),
      }),
      permission: "confirm",
      readOnly: true,
      sandboxAware: true,
      executionLocation: "host",
      limits: { maxFiles: maxResults, maxDepth },
      resolveEffects: (args) => ({
        filesystem: [{
          kind: "filesystem",
          operation: "read",
          paths: [resolveToolPathCanonical(String(args.path), defaultCwd)],
        }],
        network: [],
        process: getRgBin() ? [{ kind: "process", operation: "spawn", commandClass: "search", background: false, readOnly: true }] : [],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const pattern = args.pattern as string;
      const directory = resolveToolPath(args.path as string, defaultCwd);
      const effectiveMaxResults = Math.min(maxResults, context?.limits?.maxFiles ?? maxResults);
      const maxOutputBytes = Math.max(0, (context?.limits?.maxOutputBytes ?? 2_000_000) - 2048);
      const timeoutMs = context?.limits?.timeoutMs ?? 30_000;
      const effectiveMaxDepth = Math.min(maxDepth, context?.limits?.maxDepth ?? maxDepth);

      try {
        if (!(await isToolPathAllowed(directory, options, context))) {
          return {
            success: false,
            output: "",
            error: `Path "${directory}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
          };
        }
        if (signal?.aborted) throw new Error("aborted");
        const matcher = compileGlob(pattern);
        const matches: string[] = [];
        const rgBin = getRgBin();
        if (rgBin) {
          let visited = 0;
          let outputBytes = 0;
          const run = await runRipgrepRecords(rgBin, [
            ...RIPGREP_SCOPE_ARGS, "--files", "--null", `--max-depth=${effectiveMaxDepth + 1}`, "--", ".",
          ], {
            process: context?.process ?? createLocalProcessBroker(signal), cwd: directory, signal,
            separator: "\0", timeoutMs, maxRecordBytes: maxOutputBytes,
            onRecord(record) {
              if (++visited > maxVisitedEntries) return "traversal_limit";
              const path = record.replace(/^\.\//, "").replace(/\\/g, "/");
              if (!matcher(path)) return;
              if (matches.length >= effectiveMaxResults) return "result_limit";
              const size = Buffer.byteLength(displayPath(path)) + 1;
              if (outputBytes + size > maxOutputBytes) return "output_limit";
              outputBytes += size;
              matches.push(path);
            },
          });
          if (!run.unavailable) {
            const error = run.stopped === "traversal_limit"
              ? `glob traversal limit exceeded (${maxVisitedEntries} entries)` : run.error;
            return globResult(matches, "ripgrep", effectiveMaxDepth,
              [error?.slice(0, 512), run.stopped, run.stderr.slice(0, 512)].filter((s): s is string => !!s), error);
          }
        }
        const coverage = await walkAndMatch(directory, directory, pattern, matches, effectiveMaxResults, signal, {
          maxVisitedEntries, maxDepth: effectiveMaxDepth, timeoutMs, maxOutputBytes,
        });
        return globResult(matches, "javascript", effectiveMaxDepth, [
          ...coverage.reasons,
          "JavaScript fallback uses root .gitignore only; nested ignore files and negation are not fully supported",
        ], coverage.error);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

interface WalkCoverage {
  reasons: string[];
  error?: string;
}

function displayPath(path: string): string {
  return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
}

function globResult(matches: string[], backend: string, maxDepth: number, reasons: string[], error?: string): ToolResult {
  matches.sort();
  let output = matches.map(displayPath).join("\n") || (reasons.length
    ? "No files returned from the incomplete search." : "No files found matching the pattern within the search scope.");
  output += `\n[Glob scope: relative to requested directory; directory depth <= ${maxDepth}; hidden files included; ignore rules applied; .git/node_modules excluded.]`;
  if (reasons.length) output += `\n[Glob incomplete: ${reasons.join("; ")}. Narrow path/pattern or inspect omitted inputs; absence of matches does not cover omitted content.]`;
  return { success: !error, output, ...(error ? { error } : {}),
    meta: { search: { backend, complete: reasons.length === 0, reasons, returned: matches.length, maxDepth } } };
}

/** Legacy in-process callers (including path suggestions) share the bounded
 * fallback. A result cap retains matches; traversal failure is never absence. */
export async function walkAndMatch(
  baseDir: string,
  currentDir: string,
  pattern: string,
  matches: string[],
  maxResults: number,
  signal?: AbortSignal,
  limits: { maxVisitedEntries?: number; maxDepth?: number; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<WalkCoverage> {
  const matcher = compileGlob(pattern);
  const ignore = await loadGitignore(baseDir);
  const coverage: WalkCoverage = { reasons: [] };
  const budget: WalkBudget = { visited: 0, maxVisitedEntries: limits.maxVisitedEntries ?? Infinity,
    maxDepth: limits.maxDepth ?? 64, deadline: Date.now() + (limits.timeoutMs ?? 30_000),
    outputBytes: 0, maxOutputBytes: limits.maxOutputBytes ?? 2_000_000, stopped: false, coverage };
  try { await walkWithMatcher(baseDir, currentDir, matcher, ignore, matches, maxResults, signal, budget, 0); }
  catch (e) {
    coverage.error = e instanceof Error ? e.message : String(e);
    coverage.reasons.push(coverage.error);
  }
  return coverage;
}

interface WalkBudget {
  visited: number;
  maxVisitedEntries: number;
  maxDepth: number;
  deadline: number;
  outputBytes: number;
  maxOutputBytes: number;
  stopped: boolean;
  coverage: WalkCoverage;
}

async function walkWithMatcher(
  baseDir: string, currentDir: string, matcher: GlobMatcher, ignore: IgnoreMatcher,
  matches: string[], maxResults: number, signal: AbortSignal | undefined,
  budget: WalkBudget, depth: number,
): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  if (budget.stopped) return;
  if (depth > budget.maxDepth) {
    if (!budget.coverage.reasons.includes("depth_limit")) budget.coverage.reasons.push("depth_limit");
    return;
  }
  const directory = await opendir(currentDir);
  for await (const entry of directory) {
    if (signal?.aborted) throw new Error("aborted");
    if (Date.now() >= budget.deadline) throw new Error("Search timed out");
    if (budget.stopped) break;
    if (++budget.visited > budget.maxVisitedEntries) throw new Error(`glob traversal limit exceeded (${budget.maxVisitedEntries} entries)`);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
    if (ignore(relPath)) continue;
    if (entry.isDirectory()) {
      try { await walkWithMatcher(baseDir, fullPath, matcher, ignore, matches, maxResults, signal, budget, depth + 1); }
      catch (e) {
        if (!["EACCES", "EPERM", "ENOENT"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
        if (!budget.coverage.reasons.includes("unreadable_paths")) budget.coverage.reasons.push("unreadable_paths");
      }
    } else if (entry.isFile() && matcher(relPath)) {
      const size = Buffer.byteLength(displayPath(relPath)) + 1;
      if (matches.length >= maxResults || budget.outputBytes + size > budget.maxOutputBytes) {
        budget.coverage.reasons.push(matches.length >= maxResults ? "result_limit" : "output_limit");
        budget.stopped = true;
        break;
      }
      budget.outputBytes += size;
      matches.push(relPath);
    }
  }
}

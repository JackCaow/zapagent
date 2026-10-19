import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { loadGitignore, type IgnoreMatcher } from "./gitignore.js";
import { isToolPathAllowed, resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";

export interface ListTreeOptions {
  allowedPaths?: string[];
  useExecutionGrants?: boolean;
  /** Default depth when caller doesn't specify. */
  defaultDepth?: number;
  /** Hard upper bound on depth, even if caller asks for more. */
  maxDepth?: number;
  /** Hard upper bound on entries returned. */
  maxEntries?: number;
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
}

const DEFAULT_DEPTH = 2;
const MAX_DEPTH_CAP = 5;
const DEFAULT_MAX_ENTRIES = 200;

interface Node {
  name: string;
  isDir: boolean;
  detail?: string;
  children: Node[];
}

/**
 * Multi-level directory overview ("tree -L"). Saves the model the 4-5 round
 * trip of starting a new session by listing each subdirectory one at a time.
 *
 * Defaults to depth 2, gitignore-aware, skips node_modules and .git, hides
 * dotfiles unless asked. Truncated at 200 entries by default with an explicit
 * tail message so the model knows it didn't get everything.
 */
export function listTreeTool(options: ListTreeOptions = {}): Tool {
  const defaultDepth = options.defaultDepth ?? DEFAULT_DEPTH;
  const maxDepthCap = options.maxDepth ?? MAX_DEPTH_CAP;
  const maxEntriesDefault = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const defaultCwd = options.defaultCwd ?? process.cwd();

  return {
    definition: {
      name: "list_tree",
      description:
        `Show a multi-level directory tree (like "tree -L"). Use this at the start of a session to get the shape of the repo in one call. Defaults: depth ${defaultDepth}, hides dotfiles, respects .gitignore, skips node_modules/.git, caps at ${maxEntriesDefault} entries.`,
      parameters: z.object({
        path: z.string().describe("Directory to start from (use '.' for cwd)"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(maxDepthCap)
          .optional()
          .describe(`How many levels to descend (default: ${defaultDepth}, max: ${maxDepthCap})`),
        max_entries: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Cap total entries shown (default: ${maxEntriesDefault})`),
        include_hidden: z
          .boolean()
          .optional()
          .describe("Include dotfile entries (default: false)"),
        detail: z
          .boolean()
          .optional()
          .describe("Include file size and modified date metadata (default: false)"),
      }),
      permission: "confirm",
      readOnly: true,
      limits: { maxFiles: maxEntriesDefault, maxDepth: maxDepthCap },
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
      const startDir = resolveToolPath(args.path as string, defaultCwd);
      const depth = Math.min(maxDepthCap, (args.depth as number | undefined) ?? defaultDepth);
      const maxEntries = (args.max_entries as number | undefined) ?? maxEntriesDefault;
      const includeHidden = (args.include_hidden as boolean | undefined) ?? false;
      const detail = (args.detail as boolean | undefined) ?? false;

      try {
        if (!(await isToolPathAllowed(startDir, options, context))) {
          return {
            success: false,
            output: "",
            error: `Path "${startDir}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
          };
        }
        const ignore = await loadGitignore(startDir);
        const counter = { entries: 0, truncated: false };
        const root: Node = { name: ".", isDir: true, children: [] };

        await walk(startDir, startDir, depth, includeHidden, detail, ignore, root, counter, maxEntries);

        const lines: string[] = [];
        renderNode(root.children, "", lines);
        if (counter.truncated) {
          lines.push(
            `[truncated at ${maxEntries} entries — increase max_entries or call again on a narrower path]`,
          );
        }
        if (lines.length === 0) {
          return { success: true, output: `(empty: ${startDir})` };
        }
        return { success: true, output: lines.join("\n") };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

async function walk(
  baseDir: string,
  currentDir: string,
  remainingDepth: number,
  includeHidden: boolean,
  detail: boolean,
  ignore: IgnoreMatcher,
  parent: Node,
  counter: { entries: number; truncated: boolean },
  maxEntries: number,
): Promise<void> {
  if (remainingDepth <= 0) return;
  if (counter.truncated) return;

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort: directories first, then files; alphabetical within each group.
  entries.sort((a, b) => {
    const ad = a.isDirectory(), bd = b.isDirectory();
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (counter.truncated) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (!includeHidden && entry.name.startsWith(".")) continue;

    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");

    // Skip ignored files; for directories, gitignore patterns ending in /
    // should match the dir path with trailing /.
    if (entry.isDirectory() ? ignore(relPath + "/") || ignore(relPath) : ignore(relPath)) continue;

    if (counter.entries >= maxEntries) {
      counter.truncated = true;
      return;
    }
    counter.entries += 1;

    const node: Node = { name: entry.name, isDir: entry.isDirectory(), children: [] };
    if (detail && !node.isDir) {
      try {
        const fileStat = await stat(fullPath);
        node.detail = ` (${(fileStat.size / 1024).toFixed(1)} KB, ${fileStat.mtime.toISOString().slice(0, 10)})`;
      } catch {}
    }
    parent.children.push(node);

    if (entry.isDirectory()) {
      await walk(baseDir, fullPath, remainingDepth - 1, includeHidden, detail, ignore, node, counter, maxEntries);
    }
  }
}

function renderNode(nodes: Node[], indent: string, out: string[]): void {
  for (const n of nodes) {
    out.push(`${indent}${n.name}${n.isDir ? "/" : ""}${n.detail ?? ""}`);
    if (n.children.length > 0) {
      renderNode(n.children, indent + "  ", out);
    }
  }
}

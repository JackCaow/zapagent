import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { atomicWrite, declaredMutationEffects, isToolPathWriteAllowed, resolveToolEffectPaths, resolveToolPath } from "./filesystem.js";
import { buildDiffMeta } from "./diff-meta.js";
import { nearestLines, renderNearestLines } from "./edit-helpers.js";
import { validateSyntax } from "./syntax-check.js";

export interface MultiEditOptions {
  allowedPaths?: string[];
  useExecutionGrants?: boolean;
  protectedPaths?: string[];
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
}

// Each edit shares edit_file's semantics: exact-string match, uniqueness
// enforced unless replace_all is set. The batch is ordered — edit N sees the
// buffer produced by edits 0..N-1, which is what lets the model chain rewrites
// like (A→B, B→C) in a single call.
const editSchema = z.object({
  old_string: z.string().describe("Exact string to find and replace"),
  new_string: z.string().describe("Replacement string"),
  replace_all: z.boolean().optional().describe("Replace all occurrences (default: false)"),
});

export function multiEditTool(options: MultiEditOptions = {}): Tool {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "multi_edit",
      description:
        "Apply multiple edits to a single file in one call. Edits run sequentially — each sees the buffer produced by the previous ones, so you can chain rewrites. Either every edit succeeds and the file is written once, or nothing is written and you get the failing edit's index. Prefer this over multiple edit_file calls when changing several spots in the same file.",
      parameters: z.object({
        path: z.string().describe("Path to the file to edit"),
        edits: z.array(editSchema).min(1).describe("Edits applied in order to the same file"),
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
      const edits = args.edits as Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
      const skipSyntaxCheck = (args.skip_syntax_check as boolean) ?? false;

      if (!(await isToolPathWriteAllowed(filePath, options, context))) {
        return {
          success: false,
          output: "",
          error: `Path "${filePath}" is not allowed. Allowed paths: ${(options.allowedPaths ?? []).join(", ")}`,
        };
      }

      try {
        const statBefore = await stat(filePath);
        const original = await readFile(filePath, "utf-8");

        // Simulate the whole batch in memory first. If any edit fails we bail
        // before writing, so the file on disk never reflects a partial batch.
        let buffer = original;
        const perEditStats: Array<{ replacements: number }> = [];

        for (let i = 0; i < edits.length; i++) {
          const { old_string, new_string, replace_all } = edits[i];
          const replaceAll = replace_all ?? false;

          let count = 0;
          let searchPos = 0;
          while (true) {
            const idx = buffer.indexOf(old_string, searchPos);
            if (idx === -1) break;
            count++;
            searchPos = idx + old_string.length;
          }

          if (count === 0) {
            // Match against the live buffer (post-prior-edits), not the original.
            // Earlier edits may have produced the form the model was looking for.
            const hint = renderNearestLines(nearestLines(old_string, buffer, 3));
            return {
              success: false,
              output: "",
              error: `Edit #${i + 1} failed: string not found in ${filePath}: ${JSON.stringify(
                old_string.slice(0, 100),
              )}${hint}`,
            };
          }

          if (count > 1 && !replaceAll) {
            return {
              success: false,
              output: "",
              error: `Edit #${i + 1} failed: found ${count} occurrences in ${filePath}. Use replace_all=true to replace all, or provide a more specific string.`,
            };
          }

          if (replaceAll) {
            buffer = buffer.split(old_string).join(new_string);
          } else {
            const idx = buffer.indexOf(old_string);
            buffer = buffer.slice(0, idx) + new_string + buffer.slice(idx + old_string.length);
          }
          perEditStats.push({ replacements: replaceAll ? count : 1 });
        }

        // Race guard: same check as edit_file — detect concurrent writes
        // between our initial read and the atomic rename.
        const statAfter = await stat(filePath);
        if (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size) {
          return {
            success: false,
            output: "",
            error: `File ${filePath} was modified concurrently (mtime/size changed). Re-read and retry.`,
          };
        }

        // Validate the post-batch buffer as a whole — the model may have
        // produced an intermediate-broken state inside the batch but the
        // final form is what we're about to write. Same gate as edit_file.
        if (!skipSyntaxCheck) {
          const syn = validateSyntax(filePath, buffer);
          if (!syn.ok) {
            return {
              success: false,
              output: "",
              error: `Pre-write syntax check failed for ${filePath} after ${edits.length} edit${edits.length > 1 ? "s" : ""}: ${syn.error}\nPass skip_syntax_check=true if this is a known false positive.`,
            };
          }
        }

        await atomicWrite(filePath, buffer);

        const totalReplacements = perEditStats.reduce((a, b) => a + b.replacements, 0);
        const summary = perEditStats
          .map((s, i) => `  #${i + 1}: ${s.replacements} replacement${s.replacements > 1 ? "s" : ""}`)
          .join("\n");

        return {
          success: true,
          output: `Applied ${edits.length} edit${edits.length > 1 ? "s" : ""} to ${filePath} (${totalReplacements} replacement${totalReplacements > 1 ? "s" : ""} total):\n${summary}`,
          // Single diff spanning the original → final buffer. Hunk-level detail
          // is handled by jsdiff; individual edit boundaries inside the file
          // collapse naturally when they share context.
          meta: buildDiffMeta(original, buffer, filePath),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { atomicWrite, declaredMutationEffects, isToolPathWriteAllowed, chunkingHint, resolveToolEffectPaths, resolveToolPath } from "./filesystem.js";
import { buildDiffMeta } from "./diff-meta.js";
import { nearestLines, renderNearestLines } from "./edit-helpers.js";
import { validateSyntax } from "./syntax-check.js";

export interface EditFileOptions {
  allowedPaths?: string[];
  useExecutionGrants?: boolean;
  protectedPaths?: string[];
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
}

export function editFileTool(options: EditFileOptions = {}): Tool {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  return {
    definition: {
      name: "edit_file",
      description:
        "Edit a file by replacing a specific string with a new string. The old_string must uniquely identify the location to edit. Use replace_all=true to replace all occurrences. " +
        "**Do not use edit_file to rewrite an entire file**: when `new_string` (or `old_string`) would be more than ~50 lines, prefer an intentional full replacement with `write_file` instead.",
      parameters: z.object({
        path: z.string().describe("Path to the file to edit"),
        old_string: z.string().describe("The exact string to find and replace"),
        new_string: z.string().describe("The replacement string"),
        replace_all: z.boolean().optional().describe("Replace all occurrences (default: false, requires unique match)"),
        skip_syntax_check: z.boolean().optional().describe("Skip the pre-write syntax check (TS/JS/JSON only). Use only when the validator gives a known false positive — e.g. an intentional intermediate state, an exotic JSX form, or a fragment that will be valid after a follow-up edit."),
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
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const replaceAll = (args.replace_all as boolean) ?? false;
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
        const content = await readFile(filePath, "utf-8");

        let count = 0;
        let searchPos = 0;
        while (true) {
          const idx = content.indexOf(oldString, searchPos);
          if (idx === -1) break;
          count++;
          searchPos = idx + oldString.length;
        }

        if (count === 0) {
          const hint = renderNearestLines(nearestLines(oldString, content, 3));
          return {
            success: false,
            output: "",
            error: `String not found in ${filePath}: ${JSON.stringify(oldString.slice(0, 100))}${hint}`,
          };
        }

        if (count > 1 && !replaceAll) {
          return {
            success: false,
            output: "",
            error: `Found ${count} occurrences of the string in ${filePath}. Use replace_all=true to replace all, or provide a more specific string.`,
          };
        }

        let newContent: string;
        if (replaceAll) {
          newContent = content.split(oldString).join(newString);
        } else {
          const idx = content.indexOf(oldString);
          newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
        }

        // Race guard: fail if the file changed between our read and write
        const statAfter = await stat(filePath);
        if (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size) {
          return {
            success: false,
            output: "",
            error: `File ${filePath} was modified concurrently (mtime/size changed). Re-read and retry.`,
          };
        }

        // Pre-write syntax check (TS/JS/JSON; other extensions skip).
        // Reject before the atomic write so a broken edit never lands.
        if (!skipSyntaxCheck) {
          const syn = validateSyntax(filePath, newContent);
          if (!syn.ok) {
            return {
              success: false,
              output: "",
              error: `Pre-write syntax check failed for ${filePath}: ${syn.error}\nPass skip_syntax_check=true if this is a known false positive.`,
            };
          }
        }

        await atomicWrite(filePath, newContent);

        const replacements = replaceAll ? count : 1;
        // Charge against the LARGER of old / new — both halves stream as
        // output tokens for the model. A tiny new_string replacing a huge
        // old_string is just as expensive as the reverse.
        const editedBytes = Math.max(
          Buffer.byteLength(oldString, "utf-8"),
          Buffer.byteLength(newString, "utf-8"),
        );
        return {
          success: true,
          output: `Replaced ${replacements} occurrence${replacements > 1 ? "s" : ""} in ${filePath}:\n- ${JSON.stringify(oldString.slice(0, 60))} → ${JSON.stringify(newString.slice(0, 60))}` + chunkingHint(editedBytes, "edit"),
          // Diff of the changed region only (narrow old_string → new_string),
          // which is the natural editing unit — not the whole file.
          meta: buildDiffMeta(oldString, newString, filePath),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}

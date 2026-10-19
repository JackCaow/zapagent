import type { ToolDefinition } from "../tools/types.js";
import type { CheckpointCoverageFacts, CheckpointEditTracker } from "./types.js";

/** Descriptive only. Actual admission still runs the tracker for each path. */
export function describeCheckpointCoverage(
  tools: ToolDefinition[],
  tracker: CheckpointEditTracker | undefined,
  mode: "never" | "best-effort" | "before-destructive" | "before-write" | undefined,
): string | undefined {
  const required = tools.filter(tool => tool.checkpointRequirement === "required").map(tool => tool.name);
  if (!required.length && !tools.some(tool => tool.writesPath) && (!mode || mode === "never")) return undefined;
  let facts: Readonly<CheckpointCoverageFacts> | undefined;
  try { facts = tracker?.describeCoverage?.(); } catch { /* Unknown description never grants coverage. */ }
  const root = facts?.scope === "workspace" && typeof facts.root === "string" && facts.root.length ? JSON.stringify(facts.root) : undefined;
  const known = root && root.length <= 2048 && typeof facts?.enabled === "boolean"
    && Number.isSafeInteger(facts.maxFileBytes) && facts.maxFileBytes >= 0;
  const names = JSON.stringify(required.slice(0, 12));
  return [
    "[File-tool checkpoint coverage — Host facts]",
    `Host checkpoint mode: ${mode ?? "tool-declared requirements"}.`,
    `Tools declaring required coverage: ${names.length <= 1024 ? names : "names omitted"}${required.length > 12 ? ` (${required.length} total)` : ""}.`,
    !tracker ? "No checkpoint tracker is configured. Tools requiring coverage cannot modify files."
      : known ? `Tracker enabled: ${facts!.enabled}. Checkpoint workspace root: ${root}. Maximum snapshot file bytes: ${facts!.maxFileBytes}.\nPaths outside this root, including system temporary paths, are outside this tracker's coverage. Workspace paths can also fail coverage checks.`
        : "A checkpoint tracker is configured, but its coverage scope is unknown. Do not assume system temporary paths are covered.",
    "Ordinary file undo is best effort unless a tool or Host policy explicitly requires coverage. Missing optional coverage does not deny an otherwise authorized write. Bash and external process changes are not tracked for file undo.",
    "Choose authorized diagnostic paths respecting the user's scope and existing files. A denied write must not be routed through another tool to evade protection.",
    "These facts describe checkpoint coverage, not filesystem permission or shell/remote temporary storage. Required coverage is checked again before each write.",
  ].join("\n");
}

import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { MergeCoordinator } from "./coordinator.js";
import type { MergeResult } from "../workspace/types.js";

export interface MergeAgentArtifactsToolOptions {
  coordinator: MergeCoordinator;
  onStart?: (artifactIds: string[]) => void;
  onResult?: (result: MergeResult) => void;
}

export function mergeAgentArtifactsTool(options: MergeAgentArtifactsToolOptions): Tool {
  return {
    definition: {
      name: "merge_agent_artifacts",
      description: "Pre-merge one or more isolated writing-Agent artifacts, reject conflicts/root drift, and apply one combined patch to the root workspace.",
      parameters: z.object({
        artifact_ids: z.array(z.string()).min(1).max(16),
      }),
      permission: "confirm",
      resolveEffects: () => ({
        filesystem: [],
        network: [],
        process: [],
        external: [],
        workspace: { mode: "root-integration" },
        confidence: "declared",
      }),
    },
    handler: async (args) => {
      const artifactIds = args.artifact_ids as string[];
      options.onStart?.(artifactIds);
      const result = await options.coordinator.merge(artifactIds);
      options.onResult?.(result);
      if (!result.success) {
        return {
          success: false,
          output: "",
          error: `${result.error ?? "Artifact merge failed"}${result.conflicts?.length ? `\nConflicts: ${result.conflicts.join(", ")}` : ""}`,
          meta: result,
        };
      }
      return {
        success: true,
        output: result.changedPaths.length > 0
          ? `Merged ${result.artifactIds.length} Agent artifact(s):\n${result.changedPaths.join("\n")}`
          : "Agent artifacts contained no workspace changes.",
        meta: result,
      };
    },
  };
}

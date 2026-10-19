import { z } from "zod";
import type { Tool } from "../tools/types.js";

/**
 * Integration surface for plan mode. The tool handlers are thin wrappers
 * over these callbacks — the app layer owns the actual permission-mode state
 * and the approval UI.
 */
export interface PlanModeCallbacks {
  /** Flip the session into plan mode. Called when `enter_plan_mode` is
   *  approved (via the auto-permission since it's read-only side-effect-wise). */
  enter(): void;
  /** Present `plan` to the user, block until they decide. Resolve with
   *  `approved: true` (mode switched back to default + the caller can
   *  continue with implementation) or `approved: false` (mode stays `plan`;
   *  the caller should revise and re-present). */
  requestExit(plan: string): Promise<{ approved: boolean; reason?: string }>;
  /** True iff currently in plan mode. Used by the tools to reject
   *  `exit_plan_mode` when already outside plan mode, and to no-op
   *  `enter_plan_mode` when already inside. */
  isActive: () => boolean;
}

export interface PlanModeToolsOptions {
  callbacks: PlanModeCallbacks;
}

/**
 * `enter_plan_mode` — model's way to request "let me design before coding".
 *
 * Intended workflow:
 *   1. User says "add feature X"
 *   2. Model calls `enter_plan_mode` before touching the codebase
 *   3. Model uses read-only tools (read_file, grep, glob) to explore —
 *      write/edit/bash are blocked by the permission layer while mode=plan
 *   4. Model calls `exit_plan_mode` with a written plan
 *   5. User approves → mode flips back to default; model implements
 *      User rejects → mode stays `plan`; model revises
 */
export function enterPlanModeTool(options: PlanModeToolsOptions): Tool {
  return {
    definition: {
      name: "enter_plan_mode",
      description:
        "Enter plan mode for non-trivial implementation tasks: transitions the session into a read-only mode (blocks write_file / edit_file / delete_file / move_file / bash) so you can explore the codebase and design an approach without making changes. Exit with `exit_plan_mode` once the plan is ready for user approval.",
      parameters: z.object({}).strict(),
      permission: "auto",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [],
        external: [{ kind: "external", system: "runtime:permission-mode", operation: "mutate" }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: async () => {
      if (options.callbacks.isActive()) {
        return {
          success: true,
          output: "Already in plan mode. Continue exploring; call `exit_plan_mode` when ready.",
        };
      }
      options.callbacks.enter();
      return {
        success: true,
        output:
          "Entered plan mode. All write / edit / delete / move / bash tools are now blocked — use read_file / glob_files / search_files to explore. Call `exit_plan_mode` with a written plan when ready for user approval.",
      };
    },
  };
}

/**
 * `exit_plan_mode` — model presents a plan; user approves or rejects.
 *
 * On approval: permission mode flips back to `default` via the callback,
 * and the tool returns a success message the model uses to proceed with
 * implementation. On rejection: mode stays `plan`, tool returns a failure
 * with any user-provided reason so the model can revise.
 */
export function exitPlanModeTool(options: PlanModeToolsOptions): Tool {
  return {
    definition: {
      name: "exit_plan_mode",
      description:
        "Exit plan mode by presenting a written plan for user approval. On approval, the permission mode switches back to default and you can implement. On rejection, plan mode stays active and you should revise the plan per the user's feedback. The plan should be concrete: files to touch, approach, any open questions. Keep it under ~40 lines — longer plans overflow the approval dialog and the user has to scroll scrollback to see the tail.",
      parameters: z.object({
        plan: z
          .string()
          .min(1)
          .describe(
            "The implementation plan in markdown. Include: what files will change, the approach, trade-offs considered, and any open questions for the user.",
          ),
      }),
      permission: "auto",
      resolveEffects: () => ({
        filesystem: [], network: [], process: [],
        external: [{ kind: "external", system: "runtime:permission-mode", operation: "mutate" }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: async (args) => {
      if (!options.callbacks.isActive()) {
        return {
          success: false,
          output: "",
          error:
            "Not in plan mode — nothing to exit. Call `enter_plan_mode` first if you want to design before implementing.",
        };
      }
      const plan = args.plan as string;
      const { approved, reason } = await options.callbacks.requestExit(plan);
      if (approved) {
        return {
          success: true,
          output:
            "Plan approved. Permission mode is back to default — you can now proceed with implementation.",
        };
      }
      const reasonText = reason?.trim() ? ` User's feedback: ${reason.trim()}` : "";
      return {
        success: false,
        output: "",
        error: `Plan rejected — remain in plan mode and revise.${reasonText}`,
      };
    },
  };
}

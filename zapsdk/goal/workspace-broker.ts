import type { ToolResult } from "../tools/types.js";
import type { GoalVerifierWorkspace } from "./workspace.js";

/** Host machine checks remain unavailable until the platform can establish
 * that every descendant stopped. Process groups and OS filesystem/network
 * sandboxes do not prevent a command from forking and calling setsid(). */
export function createGoalVerifierCommandRunner(_workspace: GoalVerifierWorkspace, _options: { network?: boolean; timeoutMs?: number } = {}) {
  return async (_command: string, _signal?: AbortSignal): Promise<ToolResult> => {
    throw new Error("GOAL_VERIFIER_PROCESS_SEAL_UNSUPPORTED");
  };
}

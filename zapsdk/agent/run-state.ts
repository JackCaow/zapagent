import type { TokenUsage } from "../core/types.js";

/** Observable lifecycle of one independently scheduled agent run. */
export type AgentRunStatus =
  | "scheduled"
  | "waiting_dependency"
  | "waiting_capacity"
  | "starting"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "cancelling"
  | "validating"
  | "ready_to_merge"
  | "merging"
  | "completed"
  | "incomplete"
  | "blocked"
  | "failed"
  | "cancelled";

/** Latest immutable state for one agent run. `sequence` is monotonic per run
 * so consumers can safely ignore delayed/out-of-order events. */
export interface AgentRunSnapshot {
  runId: string;
  /** Host-authored tool execution id. Absent only for direct SDK calls that
   * bypass ToolExecutor and therefore have no parent tool call. */
  toolCallId?: string;
  parentRunId?: string;
  agentType: string;
  task: string;
  status: AgentRunStatus;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  statusDetail?: string;
  success?: boolean;
  steps?: number;
  usage?: TokenUsage;
  workspaceId?: string;
  workspaceMode?: "shared-readonly" | "isolated-git" | "isolated-copy";
  artifactId?: string;
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === "completed"
    || status === "incomplete"
    || status === "blocked"
    || status === "failed"
    || status === "cancelled";
}

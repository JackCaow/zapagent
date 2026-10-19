import type { AgentRunSnapshot, AgentRunStatus } from "../agent/run-state.js";
import type { TokenUsage } from "../core/types.js";
import type { ToolObservationSink } from "../tools/types.js";

/** Transient host bindings; excluded from persisted inputs and resumed runs. */
export interface AgentCoordinatorBindings {
  runtimeObservation?: import("../runtime/observation.js").RuntimeObservationContext;
  observations?: ToolObservationSink;
  deadlineAtMs?: number;
}

export const AGENT_COORDINATOR_STATE_VERSION = 1 as const;

export interface SpawnAgentInput {
  task: string;
  agentType: string;
  parentRunId?: string;
  toolCallId?: string;
  dependencies?: string[];
  resumeOfRunId?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AgentTaskNode {
  runId: string;
  dependencies: string[];
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  resumeOfRunId?: string;
  metadata?: Record<string, string | number | boolean>;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailboxMessage {
  messageId: string;
  threadId: string;
  toRunId: string;
  fromRunId?: string;
  kind: "message" | "steer" | "resume";
  text: string;
  createdAt: number;
  consumedAt?: number;
}

export interface AgentCoordinatorResult {
  runId: string;
  success: boolean;
  text: string;
  steps?: number;
  usage?: TokenUsage;
  workspaceId?: string;
  artifactId?: string;
  changedPaths?: string[];
  error?: string;
}

export interface AgentCoordinatorState {
  schemaVersion: typeof AGENT_COORDINATOR_STATE_VERSION;
  threadId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  runs: Record<string, AgentRunSnapshot>;
  tasks: Record<string, AgentTaskNode>;
  messages: AgentMailboxMessage[];
  results: Record<string, AgentCoordinatorResult>;
}

export interface AgentCoordinatorStateStore {
  load(threadId: string): Promise<AgentCoordinatorState | undefined>;
  save(state: AgentCoordinatorState): Promise<void>;
}

export interface AgentCoordinatorExecutorContext {
  runtimeObservation?: import("../runtime/observation.js").RuntimeObservationContext;
  observations?: ToolObservationSink;
  deadlineAtMs?: number;
  threadId: string;
  run: AgentRunSnapshot;
  metadata: Record<string, string | number | boolean>;
  signal: AbortSignal;
  reportStatus(status: AgentRunStatus, detail?: string): Promise<void>;
  drainMailbox(): Promise<AgentMailboxMessage[]>;
  waitForMessage(): Promise<AgentMailboxMessage>;
}

export interface AgentCoordinatorExecutor {
  execute(context: AgentCoordinatorExecutorContext): Promise<Omit<AgentCoordinatorResult, "runId">>;
}

export type AgentCoordinatorEvent =
  | { type: "run_state"; run: AgentRunSnapshot }
  | { type: "mailbox"; message: AgentMailboxMessage }
  | { type: "task_state"; task: AgentTaskNode };

export type AgentCoordinatorListener = (event: AgentCoordinatorEvent) => void;

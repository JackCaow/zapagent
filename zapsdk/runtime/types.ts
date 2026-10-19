import type { AgentOutcomeV1 } from "./outcome.js";
import type { AgentEvent } from "../agent/events.js";
import type { AgentRunSnapshot, AgentRunStatus } from "../agent/run-state.js";
import type { TokenUsage } from "../core/types.js";
import type {
  CompletionEvidence,
  CompletionRequirementAssessment,
  EvidenceState,
  InfrastructureOutcome,
} from "../harness/completion.js";

export const LEGACY_RUNTIME_EVENT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_EVENT_SCHEMA_VERSION = 3 as const;

export type RuntimeEventSchemaVersion =
  | typeof LEGACY_RUNTIME_EVENT_SCHEMA_VERSION
  | 2
  | typeof RUNTIME_EVENT_SCHEMA_VERSION;
export type ThreadId = string;
export type TurnId = string;
export type ItemId = string;
export type RunId = string;
export type ToolRunId = string;
export type WorkspaceId = string;

export type ThreadStatus = "idle" | "running" | "closed";
export type TurnStatus = "running" | "completed" | "incomplete" | "failed" | "cancelled";

export interface ThreadSnapshot {
  threadId: ThreadId;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  activeTurnId?: TurnId;
}

export interface TurnSnapshot {
  turnId: TurnId;
  threadId: ThreadId;
  rootRunId: RunId;
  resultSchema?: "outcome-v1";
  status: TurnStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** Runtime-level AgentRun identity. Existing AgentRunSnapshot fields remain
 * the lifecycle payload while thread/turn identity is no longer inferred from
 * task text or UI log order. */
export interface RuntimeRunSnapshot extends AgentRunSnapshot {
  threadId: ThreadId;
  turnId: TurnId;
}

export interface MessageRuntimeItem {
  itemId: ItemId;
  threadId: ThreadId;
  turnId: TurnId;
  runId: RunId;
  type: "message";
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface AgentEventRuntimeItem {
  itemId: ItemId;
  threadId: ThreadId;
  turnId: TurnId;
  runId: RunId;
  type: "agent_event";
  event: AgentEvent;
  createdAt: number;
}

export interface ErrorRuntimeItem {
  itemId: ItemId;
  threadId: ThreadId;
  turnId: TurnId;
  runId: RunId;
  type: "error";
  error: string;
  createdAt: number;
}

export type RuntimeItem = MessageRuntimeItem | AgentEventRuntimeItem | ErrorRuntimeItem;

export interface RuntimeResultSummary {
  text: string;
  steps: number;
  totalUsage: TokenUsage;
  stopped?: "max_steps" | "max_tokens" | "budget" | "timeout" | "max_repeat";
  completion: {
    status: "completed" | "incomplete";
    success: boolean;
    /** A natural, non-empty model completion. It is intentionally separate
     * from delivery evidence and must not be rendered as verified success. */
    modelClaimedSuccess: boolean;
    evidenceState: EvidenceState;
    infrastructureOutcome: InfrastructureOutcome;
    reason?: string;
    evidence: CompletionEvidence[];
    requirements: CompletionRequirementAssessment[];
  };
}

export type LegacyRuntimeEventPayload =
  | {
      type: "turn_started";
      thread: ThreadSnapshot;
      turn: TurnSnapshot;
      run: RuntimeRunSnapshot;
      item: MessageRuntimeItem;
    }
  | {
      type: "agent_event";
      item: AgentEventRuntimeItem;
    }
  | {
      type: "turn_completed";
      thread: ThreadSnapshot;
      turn: TurnSnapshot;
      run: RuntimeRunSnapshot;
      item: MessageRuntimeItem;
      result: RuntimeResultSummary;
    }
  | {
      type: "turn_incomplete";
      thread: ThreadSnapshot;
      turn: TurnSnapshot;
      run: RuntimeRunSnapshot;
      item: MessageRuntimeItem;
      result: RuntimeResultSummary;
    }
  | {
      type: "turn_failed";
      thread: ThreadSnapshot;
      turn: TurnSnapshot;
      run: RuntimeRunSnapshot;
      item: ErrorRuntimeItem;
      interrupted: boolean;
    };

export type LegacyTerminalPayload = Extract<LegacyRuntimeEventPayload, { type: "turn_completed" | "turn_incomplete" | "turn_failed" }>;
export type RuntimeEventPayload = LegacyRuntimeEventPayload | {
  type: "attempt_ended";
  outcome: AgentOutcomeV1;
  legacyTerminal: LegacyTerminalPayload;
};

export function projectLegacyEvent(event: RuntimeEvent): RuntimeEventV2 {
  return { ...event, schemaVersion: 2,
    correlationId: "correlationId" in event ? event.correlationId : event.turnId ?? event.threadId,
    payload: event.payload.type === "attempt_ended" ? event.payload.legacyTerminal : event.payload };
}

interface RuntimeEventEnvelope<T extends RuntimeEventPayload = RuntimeEventPayload> {
  eventId: string;
  sequence: number;
  timestamp: number;
  threadId: ThreadId;
  turnId?: TurnId;
  runId?: RunId;
  parentRunId?: RunId;
  toolRunId?: ToolRunId;
  workspaceId?: WorkspaceId;
  payload: T;
}

/** Legacy envelope retained so existing session event logs remain readable. */
export interface RuntimeEventV1<T extends RuntimeEventPayload = RuntimeEventPayload>
  extends RuntimeEventEnvelope<T> {
  schemaVersion: typeof LEGACY_RUNTIME_EVENT_SCHEMA_VERSION;
}

/** Versioned append-only fact envelope consumed by every host projection.
 * correlationId groups a complete operation (normally one turn), while
 * causationId links the immediately preceding fact when one is known. */
export interface RuntimeEventV2<T extends RuntimeEventPayload = RuntimeEventPayload>
  extends RuntimeEventEnvelope<T> {
  schemaVersion: 2;
  correlationId: string;
  causationId?: string;
}

export interface RuntimeEventV3<T extends RuntimeEventPayload = RuntimeEventPayload>
  extends RuntimeEventEnvelope<T> {
  schemaVersion: 3;
  correlationId: string;
  causationId?: string;
}

export type RuntimeEvent<T extends RuntimeEventPayload = RuntimeEventPayload> =
  | RuntimeEventV1<T>
  | RuntimeEventV2<T>
  | RuntimeEventV3<T>;

export interface RuntimeEventFilter {
  threadId?: ThreadId;
  turnId?: TurnId;
  runId?: RunId;
  payloadTypes?: RuntimeEventPayload["type"][];
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export function rootRunSnapshot(input: {
  runId: RunId;
  threadId: ThreadId;
  turnId: TurnId;
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
}): RuntimeRunSnapshot {
  return {
    runId: input.runId,
    threadId: input.threadId,
    turnId: input.turnId,
    agentType: "root",
    task: input.task,
    status: input.status,
    sequence: input.sequence,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    statusDetail: input.statusDetail,
    success: input.success,
    steps: input.steps,
    usage: input.usage,
  };
}

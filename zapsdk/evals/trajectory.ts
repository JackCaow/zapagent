import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeEvent } from "../runtime/types.js";
import {
  TRAJECTORY_SCHEMA_VERSION,
  type TrajectoryEntry,
  type TrajectoryEntryKind,
} from "./types.js";

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Keep lifecycle identity and metrics while excluding prompts, messages,
 * reasoning, tool arguments, and tool output bodies from benchmark traces. */
export function projectRuntimeEventForTrajectory(
  event: RuntimeEvent,
): Record<string, string | number | boolean | null | string[]> {
  const data: Record<string, string | number | boolean | null | string[]> = {
    eventId: event.eventId,
    eventSequence: event.sequence,
    eventTimestamp: event.timestamp,
    payloadType: event.payload.type,
    schemaVersion: event.schemaVersion,
    threadId: event.threadId,
    turnId: event.turnId ?? null,
    runId: event.runId ?? null,
    parentRunId: event.parentRunId ?? null,
    toolRunId: event.toolRunId ?? null,
    workspaceId: event.workspaceId ?? null,
  };
  if (event.schemaVersion === 2 || event.schemaVersion === 3) {
    data.correlationId = event.correlationId;
    data.causationId = event.causationId ?? null;
  }
  if (event.payload.type === "agent_event") {
    const agentEvent = event.payload.item.event;
    data.agentEventType = agentEvent.type;
    if (agentEvent.type === "content_final") {
      data.contentKind = agentEvent.kind;
      if (agentEvent.kind === "tool_call") {
        data.toolName = agentEvent.toolName;
        data.argumentsHash = hashText(JSON.stringify(agentEvent.arguments));
      } else if (agentEvent.kind === "tool_result") {
        data.toolName = agentEvent.toolName;
        data.toolSuccess = agentEvent.result.success;
      }
    } else if (agentEvent.type === "agent_run_state") {
      data.agentRunStatus = agentEvent.run.status;
      data.agentType = agentEvent.run.agentType;
    }
  } else if (event.payload.type === "attempt_ended") {
    data.executionStatus = event.payload.outcome.execution.status;
    data.executionStopReason = event.payload.outcome.execution.stopReason;
    data.acceptanceStatus = event.payload.outcome.acceptance.status;
    data.workflowStatus = event.payload.outcome.workflow.status;
    data.steps = event.payload.legacyTerminal.run.steps ?? 0;
    data.inputTokens = event.payload.legacyTerminal.run.usage?.inputTokens ?? 0;
    data.outputTokens = event.payload.legacyTerminal.run.usage?.outputTokens ?? 0;
  } else if (event.payload.type === "turn_completed" || event.payload.type === "turn_incomplete") {
    data.steps = event.payload.result.steps;
    data.inputTokens = event.payload.result.totalUsage.inputTokens;
    data.outputTokens = event.payload.result.totalUsage.outputTokens;
    data.completionStatus = event.payload.result.completion.status;
    data.completionSuccess = event.payload.result.completion.success;
  } else if (event.payload.type === "turn_failed") {
    data.interrupted = event.payload.interrupted;
    data.turnStatus = event.payload.turn.status;
  }
  return data;
}

export class TrajectoryRecorder {
  private sequence = 0;
  private readonly entries: TrajectoryEntry[] = [];

  constructor(
    readonly attemptId: string,
    readonly taskId: string,
    private readonly clock: () => number = Date.now,
  ) {}

  record(
    kind: TrajectoryEntryKind,
    data: TrajectoryEntry["data"],
  ): TrajectoryEntry {
    const entry: TrajectoryEntry = {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: this.clock(),
      attemptId: this.attemptId,
      taskId: this.taskId,
      kind,
      data: structuredClone(data),
    };
    this.entries.push(entry);
    return structuredClone(entry);
  }

  recordRuntimeEvent(event: RuntimeEvent): TrajectoryEntry {
    return this.record("runtime_event", projectRuntimeEventForTrajectory(event));
  }

  snapshot(): TrajectoryEntry[] {
    return structuredClone(this.entries);
  }

  async writeJsonl(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const body = this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  }
}

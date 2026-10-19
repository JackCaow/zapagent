import { createHash } from "node:crypto";
export type WatchNodeKind = "run" | "tool" | "request";
export type WatchCoverage = "full" | "partial" | "opaque";
export interface WatchScope { threadId: string; turnId: string; runId: string; parentRunId?: string; rootRunId?: string }
export interface WatchNode {
  id: string;
  kind: WatchNodeKind;
  scope: WatchScope;
  label: string;
  status: string;
  activity?: string;
  source: "runtime" | "executor" | "external_report";
  coverage: WatchCoverage;
  createdAt: number;
  updatedAt: number;
  elapsedMs: number;
  terminal: boolean;
  observationClosed?: boolean;
  pendingInputs?: number;
  unknownEvents?: number;
  step?: number;
  sequence?: number;
  toolCallId?: string;
  parentToolKey?: string;
  wasExecuted?: boolean;
  success?: boolean;
  argumentChars?: number;
  attempt?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  executionSpans?: Array<{ id: string; status: string }>;
  approval?: { id: string; status: string };
  textChars?: number;
  thinkingChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  usageIncomplete?: boolean;
}
export interface WatchEdge { id: string; from: string; to: string; kind: "owns" | "spawns" | "depends_on" }
export interface WatchSession { threadId: string; status: "idle" | "running" | "closed" }
export interface WatchOutcome { attemptId: string; execution: string; acceptance: string; workflow: string }
export interface WatchTimelineItem { id: number; at: number; nodeId?: string; kind: string; status: string }
export type WatchMutation =
  | { op: "node.upsert"; node: WatchNode }
  | { op: "node.remove"; id: string }
  | { op: "edge.upsert"; edge: WatchEdge }
  | { op: "edge.remove"; id: string }
  | { op: "session.upsert"; session: WatchSession }
  | { op: "session.remove"; id: string }
  | { op: "outcome.remove"; id: string }
  | { op: "outcome.set"; outcome: WatchOutcome }
  | { op: "timeline.append"; item: WatchTimelineItem }
  | { op: "diagnostic.set"; code: string; count: number }
  | { op: "process.set"; state: "running" | "stopping" };
export interface WatchFrame {
  schema: "zap.watch"; schemaVersion: 1; instanceId: string; seq: number; observedAt: number; changes: WatchMutation[];
}
export interface WatchSnapshot {
  schema: "zap.watch"; schemaVersion: 1; instanceId: string; throughSeq: number;
  processState: "running" | "stopping";
  sessions: WatchSession[]; nodes: WatchNode[]; edges: WatchEdge[]; outcomes: WatchOutcome[];
  recentTimeline: WatchTimelineItem[];
  coverage: { historyFromSeq: number; truncated: boolean; reasons: string[] };
  diagnostics: Record<string, number>;
}
export const watchKey = (kind: string, parts: unknown[]) => kind + ":" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const watchRunKey = (scope: WatchScope) => watchKey("run", [scope.threadId, scope.turnId, scope.runId]);
export const watchToolKey = (scope: WatchScope, step: number, callId: string) => watchKey("tool", [scope.threadId, scope.turnId, scope.runId, step, callId]);

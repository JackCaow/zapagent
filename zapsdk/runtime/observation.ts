import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEvent } from "../agent/events.js";
import type { ApprovalLifecycleEvent, ToolExecutionLifecycleEvent } from "../tools/executor.js";
import type { RuntimeEvent } from "./types.js";

export interface ObservationScope {
  threadId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  rootRunId?: string;
}
export type RuntimeObservation =
  | { kind: "tool_catalog"; names: string[] }
  | { kind: "runtime_event"; event: RuntimeEvent }
  | { kind: "tool_execution"; scope: ObservationScope; executionSpanId: string; event: ToolExecutionLifecycleEvent }
  | { kind: "approval"; scope: ObservationScope; approvalOccurrence: string; event: ApprovalLifecycleEvent }
  | { kind: "run_binding"; scope: ObservationScope; childRunId: string; toolCallId?: string; step?: number }
  | { kind: "input_wait"; scope: ObservationScope; toolCallId?: string; step?: number; phase: "requested" | "settled" }
  | { kind: "lifecycle"; scope: ObservationScope; phase: "sealing" | "cleanup"; at: number }
  | { kind: "external_run"; scope: ObservationScope; childRunId: string; toolCallId?: string; step?: number;
      phase: "starting" | "running" | "failed" | "cancelled" | "exited"; at: number; exitCode?: number }
  | { kind: "external_unknown"; scope: ObservationScope }
  | { kind: "dependencies"; scope: ObservationScope; childRunId: string; dependencies: string[] }
  | { kind: "external_event"; scope: ObservationScope; event: AgentEvent };

export interface RuntimeObserver { observe(event: RuntimeObservation): void }
/** Ephemeral Host binding, never serialized or restored during recovery. */
export interface RuntimeObservationContext {
  observer: RuntimeObserver;
  scope: ObservationScope;
  isActive: () => boolean;
}
const contexts = new AsyncLocalStorage<RuntimeObservationContext>();
export function currentRuntimeObservation(): RuntimeObservationContext | undefined { return contexts.getStore(); }
export function notifyRuntimeObserver(observer: RuntimeObserver | undefined, event: RuntimeObservation): void {
  try {
    const result = observer?.observe(event) as unknown;
    if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
  } catch { /* Observation cannot control execution. */ }
}
export function observeRuntime(event: RuntimeObservation, context = contexts.getStore()): void {
  if (context?.isActive()) notifyRuntimeObserver(context.observer, event);
}
export function withRuntimeObservation<T>(context: RuntimeObservationContext | undefined, operation: () => T): T {
  return context ? contexts.run(context, operation) : contexts.getStore() ? contexts.exit(operation) : operation();
}
export function withChildObservation<T>(childRunId: string, operation: () => T): T {
  const parent = contexts.getStore();
  return withRuntimeObservation(parent && { ...parent, scope: { ...parent.scope,
    parentRunId: parent.scope.runId, runId: childRunId } }, operation);
}

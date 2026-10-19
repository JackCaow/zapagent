import type { AgentRunSnapshot } from "./run-state.js";

export type AgentRunStoreListener = () => void;

/** In-memory source of truth for live AgentRun state. Transcript logs remain
 * history; UI components subscribe here for current status. */
export class AgentRunStore {
  private readonly runs = new Map<string, AgentRunSnapshot>();
  private readonly listeners = new Set<AgentRunStoreListener>();
  private snapshot: readonly AgentRunSnapshot[] = [];

  readonly subscribe = (listener: AgentRunStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly AgentRunSnapshot[] => this.snapshot;

  get(runId: string): AgentRunSnapshot | undefined {
    return this.runs.get(runId);
  }

  getByToolCallId(toolCallId: string): AgentRunSnapshot | undefined {
    return this.snapshot.find((run) => run.toolCallId === toolCallId);
  }

  apply(next: AgentRunSnapshot): boolean {
    const current = this.runs.get(next.runId);
    if (current && next.sequence <= current.sequence) return false;
    this.runs.set(next.runId, Object.freeze({ ...next }));
    this.publish();
    return true;
  }

  clear(): void {
    if (this.runs.size === 0) return;
    this.runs.clear();
    this.publish();
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.runs.values()]);
    for (const listener of this.listeners) listener();
  }
}

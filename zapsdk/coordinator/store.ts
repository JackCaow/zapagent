import type { AgentCoordinatorState, AgentCoordinatorStateStore } from "./types.js";
import type { RuntimeStateStore } from "../runtime/state-store.js";
import { createRuntimeStateSnapshot } from "../runtime/state-types.js";

function cloneState(state: AgentCoordinatorState): AgentCoordinatorState {
  return structuredClone(state);
}

export class InMemoryAgentCoordinatorStateStore implements AgentCoordinatorStateStore {
  private readonly states = new Map<string, AgentCoordinatorState>();

  async load(threadId: string): Promise<AgentCoordinatorState | undefined> {
    const state = this.states.get(threadId);
    return state ? cloneState(state) : undefined;
  }

  async save(state: AgentCoordinatorState): Promise<void> {
    this.states.set(state.threadId, cloneState(state));
  }
}

export interface RuntimeAgentCoordinatorStateStoreOptions {
  threadId: string;
  workspaceRoot: string;
  runtimeStateStore: RuntimeStateStore;
  clock?: () => number;
}

/** Stores scheduler state in the same atomic per-thread snapshot as approvals,
 * workspace leases, artifacts, and merge state. */
export class RuntimeAgentCoordinatorStateStore implements AgentCoordinatorStateStore {
  private readonly threadId: string;
  private readonly workspaceRoot: string;
  private readonly runtimeStateStore: RuntimeStateStore;
  private readonly clock: () => number;

  constructor(options: RuntimeAgentCoordinatorStateStoreOptions) {
    this.threadId = options.threadId;
    this.workspaceRoot = options.workspaceRoot;
    this.runtimeStateStore = options.runtimeStateStore;
    this.clock = options.clock ?? Date.now;
  }

  async load(threadId: string): Promise<AgentCoordinatorState | undefined> {
    if (threadId !== this.threadId) {
      throw new Error(`Coordinator state store is bound to ${this.threadId}`);
    }
    const state = await this.runtimeStateStore.load(threadId);
    return state?.coordinator ? cloneState(state.coordinator) : undefined;
  }

  async save(coordinator: AgentCoordinatorState): Promise<void> {
    if (coordinator.threadId !== this.threadId) {
      throw new Error(`Coordinator state store is bound to ${this.threadId}`);
    }
    const snapshot = cloneState(coordinator);
    await this.runtimeStateStore.update(this.threadId, (current) => {
      const state = current ?? createRuntimeStateSnapshot({
        threadId: this.threadId,
        workspaceRoot: this.workspaceRoot,
        now: this.clock(),
      });
      state.coordinator = snapshot;
      state.updatedAt = Math.max(state.updatedAt, snapshot.updatedAt);
      return state;
    });
  }
}

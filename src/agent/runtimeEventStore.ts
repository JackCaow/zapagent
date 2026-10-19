import { join } from "node:path"
import {
  AgentRuntime,
  RuntimeStateTracker,
  type RuntimeEventStore,
  JsonlRuntimeEventStore,
  JsonRuntimeStateStore,
} from "../../zapsdk/runtime/index.js"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import { resolveProjectDataSegment } from "../../zapsdk/utils/project-paths.js"

export function projectRuntimeEventsDir(cwd: string): string {
  return join(
    getAppDataDir(),
    "projects",
    resolveProjectDataSegment(cwd),
    "runtime-events",
  )
}

export function createProjectRuntimeEventStore(cwd: string): JsonlRuntimeEventStore {
  return new JsonlRuntimeEventStore({ directory: projectRuntimeEventsDir(cwd) })
}

export function projectRuntimeStateDir(cwd: string): string {
  return join(
    getAppDataDir(),
    "projects",
    resolveProjectDataSegment(cwd),
    "runtime-state",
  )
}

export function createProjectRuntimeStateStore(cwd: string): JsonRuntimeStateStore {
  return new JsonRuntimeStateStore({ directory: projectRuntimeStateDir(cwd) })
}

/** Reconnect recovery has no provider, tool registry or executable turn. */
export async function recoverProjectRuntimeOutcome(cwd: string, threadId: string, eventStore: RuntimeEventStore) {
  const runtime = new AgentRuntime({
    threadId, eventStore,
    stateTracker: new RuntimeStateTracker({ threadId, workspaceRoot: cwd, store: createProjectRuntimeStateStore(cwd) }),
    agent: {
      on() {}, off() {}, toolDefinitions: () => [], effectiveSystemPrompt: () => undefined,
      run: async () => { throw new Error("Recovery cannot execute an Agent turn") },
    },
  })
  await runtime.initialize()
  return runtime.lastOutcome()
}

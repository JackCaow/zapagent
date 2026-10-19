import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { ExecutionObservationSchema, OperationFailureSchema } from "../../execution/contracts.js";
import { operationFailure } from "../../execution/failure.js";
import { JsonlRuntimeEventStore } from "../../runtime/event-store.js";
import { JsonRuntimeStateStore } from "../../runtime/state-store.js";
import { RuntimeStateTracker } from "../../runtime/state-tracker.js";
import { createRuntimeStateSnapshot } from "../../runtime/state-types.js";
import type { RuntimeEvent } from "../../runtime/types.js";
import { emptyToolEffects } from "../../tools/effects.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolResult } from "../../tools/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function toolEvent(result: ToolResult, sequence = 1): RuntimeEvent {
  const createdAt = Date.now();
  return {
    schemaVersion: 2, sequence, eventId: `event-${sequence}`, timestamp: createdAt, correlationId: "turn-1",
    threadId: "thread-1", turnId: "turn-1", runId: "root-1",
    payload: { type: "agent_event", item: {
      itemId: `item-${sequence}`, type: "agent_event", threadId: "thread-1",
      turnId: "turn-1", runId: "root-1", createdAt,
      event: { type: "content_final", kind: "tool_result", id: "call-1", step: 1,
        toolName: "probe", result },
    } },
  };
}

describe("durable execution audit", () => {
  test("reopens JSONL and state with the same failure and receipt as the live lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-execution-audit-"));
    directories.push(directory);
    const store = new JsonRuntimeStateStore({ directory: join(directory, "state") });
    const state = createRuntimeStateSnapshot({ threadId: "thread-1", workspaceRoot: directory, now: Date.now() });
    state.thread.activeTurnId = "turn-1";
    state.turns["turn-1"] = { turnId: "turn-1", threadId: "thread-1", rootRunId: "root-1",
      status: "running", createdAt: 1, updatedAt: 1 };
    await store.update("thread-1", () => state);
    const tracker = new RuntimeStateTracker({ threadId: "thread-1", workspaceRoot: directory, store });
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "probe", description: "test", parameters: z.object({ value: z.string() }),
      resolveEffects: () => emptyToolEffects() },
      handler: async () => ({ success: false, output: "", error: "opaque sandbox denied" }) });
    const executor = new ToolExecutor(registry, { cwd: directory,
      executionBroker: new DefaultExecutionBroker(),
      onExecutionLifecycle: (event) => tracker.recordToolExecutionEvent(event) });
    const result = await executor.execute("probe", { value: "private-arguments" }, undefined,
      { sessionId: "thread-1", toolCallId: "call-1", step: 1 });
    const before = Object.values((await store.load("thread-1"))!.toolRuns)[0];
    expect(before.failure).toEqual(result.failure!);
    expect(before.execution).toEqual(result.runtime!.execution!);

    const eventsDirectory = join(directory, "events");
    const events = new JsonlRuntimeEventStore({ directory: eventsDirectory });
    const originalEvent = toolEvent(result);
    await events.append(originalEvent);
    await events.close();
    const reopened = new JsonlRuntimeEventStore({ directory: eventsDirectory });
    try {
      const replayed = (await reopened.list("thread-1"))[0];
      expect(replayed).toEqual(originalEvent);
      const payload = replayed.payload;
      if (payload.type !== "agent_event" || payload.item.event.type !== "content_final"
        || payload.item.event.kind !== "tool_result") throw new Error("incorrect replay");
      expect(OperationFailureSchema.parse(payload.item.event.result.failure)).toEqual(result.failure!);
      expect(ExecutionObservationSchema.parse(payload.item.event.result.runtime?.execution)).toEqual(result.runtime!.execution!);
      tracker.recordRuntimeEvent(replayed);
      await tracker.flush();
      const reloaded = await new JsonRuntimeStateStore({ directory: store.directory }).load("thread-1");
      const tool = Object.values(reloaded!.toolRuns)[0];
      expect(tool.failure).toEqual(result.failure!);
      expect(tool.execution).toEqual(result.runtime!.execution!);
      expect(tool.status).toBe("failed");
      expect(await readFile(store.filePath("thread-1"), "utf8")).not.toContain("private-arguments");
      expect(await readFile(reopened.filePath("thread-1"), "utf8")).not.toContain("private-arguments");
    } finally {
      await reopened.close();
    }
  });

  test("old tool results replay without fabricated failure or enforcement evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-legacy-execution-audit-"));
    directories.push(directory);
    const events = new JsonlRuntimeEventStore({ directory });
    const event = toolEvent({ success: false, output: "", error: "legacy error" });
    event.schemaVersion = 1;
    try {
      await events.append(event);
      const [read] = await events.list("thread-1");
      expect(read).toEqual(event);
      expect(JSON.stringify(read)).not.toContain('"execution"');
      expect(JSON.stringify(read)).not.toContain('"failure"');
    } finally {
      await events.close();
    }
  });

  test("tool-result projection does not overwrite authoritative cancellation with failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-cancelled-execution-audit-"));
    directories.push(directory);
    const store = new JsonRuntimeStateStore({ directory });
    const state = createRuntimeStateSnapshot({ threadId: "thread-1", workspaceRoot: directory, now: 1 });
    state.thread.activeTurnId = "turn-1";
    state.turns["turn-1"] = { turnId: "turn-1", threadId: "thread-1", rootRunId: "root-1",
      status: "running", createdAt: 1, updatedAt: 1 };
    await store.update("thread-1", () => state);
    const tracker = new RuntimeStateTracker({ threadId: "thread-1", workspaceRoot: directory, store });
    const failure = operationFailure("CANCELLED", "executor", "execution:call-1");
    await tracker.recordToolExecutionEvent({ executionId: "execution:call-1", toolCallId: "call-1",
      toolName: "probe", argumentsHash: "0".repeat(64), timestamp: 2, status: "cancelled", failure });
    tracker.recordRuntimeEvent(toolEvent({ success: false, output: "", error: "aborted", failure }));
    await tracker.flush();
    expect(Object.values((await store.load("thread-1"))!.toolRuns)[0]).toMatchObject({ status: "cancelled", failure });
    tracker.recordRuntimeEvent(toolEvent({ success: false, output: "", error: "aborted",
      failure: operationFailure("EXECUTION_FAILED", "unknown") }, 2));
    await tracker.flush();
    expect(Object.values((await store.load("thread-1"))!.toolRuns)[0].status).toBe("failed");
  });
});

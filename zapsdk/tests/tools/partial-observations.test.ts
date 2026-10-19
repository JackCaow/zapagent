import { test, expect } from "bun:test";
import { z } from "zod";
import { PartialObservations } from "../../tools/partial-observations.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { operationFailure } from "../../execution/failure.js";
import type { ToolObservationSink, ToolResult } from "../../tools/types.js";

const timeout = (): ToolResult => ({ success: false, output: "", error: "deadline", failure: operationFailure("DEADLINE_EXCEEDED", "executor") });

test("retention preserves interruption authority, diagnostics and existing outputs", () => {
  const buffer = new PartialObservations();
  expect(buffer.retain(timeout()).output).toBe("");
  buffer.record({ toolName: "inspect", success: false, output: "17 records inspected", error: "one record unreadable" });
  const failed = timeout();
  const retained = buffer.retain(failed);
  expect(retained.failure).toBe(failed.failure);
  expect(retained.success).toBe(false);
  expect(retained.output).toContain("[inspect: failed]");
  expect(retained.output).toContain("one record unreadable");
  expect(buffer.retain({ success: true, output: "finished" })).toEqual({ success: true, output: "finished" });
  expect(buffer.retain({ ...failed, output: "handler diagnostic" }).output).toBe("handler diagnostic");
  expect(buffer.retain({ success: false, output: "", error: "ordinary failure" }).output).toBe("");
});

test("retention is bounded in UTF-8, keeps recent content and cannot raise its limit", () => {
  const buffer = new PartialObservations();
  buffer.limit(256);
  buffer.record({ toolName: "read", success: true, output: "old".repeat(1000) });
  buffer.limit(100000);
  buffer.record({ toolName: "read", success: true, output: "新😀".repeat(1000) + "LATEST" });
  const output = buffer.retain(timeout()).output;
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256);
  expect(output).toContain("omitted");
  expect(output.endsWith("LATEST")).toBe(true);
  expect(output).not.toContain("\uFFFD");
  buffer.limit(1);
  expect(buffer.retain(timeout()).output).toBe("");
});

test("late observations are ignored and buffers cannot leak into subsequent invocations", async () => {
  const registry = new ToolRegistry();
  const sinks: ToolObservationSink[] = [];
  registry.register({
    definition: { name: "observe", description: "test", permission: "auto", parameters: z.object({ label: z.string() }), timeoutMs: 30 },
    handler: async (args, _signal, context) => {
      sinks.push(context!.observations!);
      context!.observations!.record({ toolName: "read", success: true, output: String(args.label) });
      return new Promise(() => {}); // Deliberately uncooperative; executor must not wait for cleanup.
    },
  });
  const executor = new ToolExecutor(registry);
  const results = await Promise.all(["ONE", "TWO"].map(label => executor.execute("observe", { label })));
  expect(results[0]!.output).toContain("ONE");
  expect(results[0]!.output).not.toContain("TWO");
  expect(results[1]!.output).toContain("TWO");
  for (const sink of sinks) sink.record({ toolName: "read", success: true, output: "LATE" });
  const third = await executor.execute("observe", { label: "THREE" });
  expect(third.output).toContain("THREE");
  expect(third.output).not.toContain("LATE");
  expect(third.output).not.toContain("ONE");
  expect(third.failure?.code).toBe("DEADLINE_EXCEEDED");
});

test("broker hard deadline and output ceiling govern retained observations", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "observe", description: "test", permission: "auto", parameters: z.object({}), timeoutMs: 1000 },
    handler: async (_args, _signal, context) => {
      context!.observations!.record({ toolName: "read", success: false, output: "字😀".repeat(1000), error: "LAST_DIAGNOSTIC" });
      return new Promise(() => {});
    },
  });
  const executor = new ToolExecutor(registry, { executionBroker: new DefaultExecutionBroker({ limits: { timeoutMs: 30, maxOutputBytes: 256 } }) });
  const result = await executor.execute("observe", {});
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(256);
  expect(result.output).toContain("LAST_DIAGNOSTIC");
  expect(result.output).not.toContain("\uFFFD");
  expect(result.runtime?.execution).toBeDefined();
});

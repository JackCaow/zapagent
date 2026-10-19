import { expect, test, spyOn } from "bun:test";
import { z } from "zod";
import { ToolExecutor, isToolAuthorization } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import { emptyToolEffects } from "../../tools/effects.js";

function fixture(handler: () => Promise<{ success: boolean; output: string }>) {
  const registry = new ToolRegistry();
  const tool = { definition: { name: "fixture", description: "synthetic", parameters: z.object({}), readOnly: true }, handler };
  registry.register(tool);
  return { registry, tool };
}

test("an expired deadline rejects before tool admission or handler execution", async () => {
  let calls = 0, admissions = 0;
  const { registry } = fixture(async () => { calls++; return { success: true, output: "unexpected" }; });
  const result = await new ToolExecutor(registry, { admitExecution: () => { admissions++; } })
    .execute("fixture", {}, undefined, { deadlineAtMs: Date.now() - 1 });
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
  expect(calls).toBe(0);
  expect(admissions).toBe(0);
});

test("authorization does not renew a deadline while waiting for scheduling", async () => {
  let now = Date.now(), calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { registry } = fixture(async () => { calls++; return { success: true, output: "unexpected" }; });
    const executor = new ToolExecutor(registry);
    const authorization = await executor.authorize("fixture", {}, undefined, { deadlineAtMs: now + 100 });
    expect(isToolAuthorization(authorization)).toBe(true);
    now += 101;
    if (!isToolAuthorization(authorization)) throw new Error("fixture authorization missing");
    expect((await executor.executeAuthorized(authorization)).failure?.code).toBe("DEADLINE_EXCEEDED");
    expect(calls).toBe(0);
  } finally { clock.mockRestore(); }
});

test("an awaited lifecycle hook cannot launch work after a wall-clock jump", async () => {
  let now = Date.now(), calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { registry } = fixture(async () => { calls++; return { success: true, output: "unexpected" }; });
    const executor = new ToolExecutor(registry, { onExecutionLifecycle: async event => {
      if (event.status === "started") now += 101;
    } });
    const result = await executor.execute("fixture", {}, undefined, { deadlineAtMs: now + 100 });
    expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
    expect(calls).toBe(0);
  } finally { clock.mockRestore(); }
});

test("an earlier context deadline bounds a running tool's wait", async () => {
  const { registry } = fixture(() => new Promise(() => {}));
  const started = performance.now();
  const result = await new ToolExecutor(registry, { timeoutMs: 1000 })
    .execute("fixture", {}, undefined, { deadlineAtMs: Date.now() + 30 });
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
  expect(performance.now() - started).toBeLessThan(500);
});

test("direct broker execution also refuses an expired deadline", async () => {
  let calls = 0;
  const { tool } = fixture(async () => { calls++; return { success: true, output: "unexpected" }; });
  const effects = emptyToolEffects();
  const result = await new DefaultExecutionBroker().execute({ executionId: "execution:fixture", tool,
    name: "fixture", args: {}, effects, grant: createCapabilityGrant("fixture", effects, Date.now() + 60_000),
    workspace: { root: process.cwd() }, context: { deadlineAtMs: Date.now() - 1 } });
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
  expect(calls).toBe(0);
});

test("checkpoint completion cannot dispatch after the original deadline", async () => {
  let now = Date.now(), calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { registry, tool } = fixture(async () => { calls++; return { success: true, output: "unexpected" }; });
    Object.assign(tool.definition, { writesPath: () => [".synthetic-deadline-fixture"] });
    const executor = new ToolExecutor(registry, { onApproval: async () => true,
      onTrackEdit: async () => { now += 101; } });
    const result = await executor.execute("fixture", {}, undefined, { deadlineAtMs: now + 100 });
    expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
    expect(calls).toBe(0);
  } finally { clock.mockRestore(); }
});

test("backend readiness completion cannot dispatch after the original deadline", async () => {
  let now = Date.now(), calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { tool } = fixture(async () => { calls++; return { success: true, output: "unexpected" }; });
    Object.assign(tool.definition, { sandboxAware: true });
    const effects = emptyToolEffects();
    effects.process.push({ kind: "process", operation: "spawn", commandClass: "synthetic" });
    const broker = new DefaultExecutionBroker({ processBrokerFactory: () => ({
      spawnCount: 0, sandboxedSpawnCount: 0,
      ensureReady: async () => { now += 101; },
      spawnCommand: () => { throw new Error("unexpected spawn"); },
      spawnShell: () => { throw new Error("unexpected spawn"); },
    }) });
    const result = await broker.execute({ executionId: "execution:fixture", tool,
      name: "fixture", args: {}, effects, grant: createCapabilityGrant("fixture", effects, now + 60_000),
      workspace: { root: process.cwd() }, context: { deadlineAtMs: now + 100 } });
    expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
    expect(calls).toBe(0);
  } finally { clock.mockRestore(); }
});

test("a broker called directly uses the earlier context deadline for its timer", async () => {
  const { tool } = fixture(() => new Promise(() => {}));
  const effects = emptyToolEffects();
  const started = performance.now();
  const result = await new DefaultExecutionBroker({ limits: { timeoutMs: 1000 } }).execute({
    executionId: "execution:fixture", tool, name: "fixture", args: {}, effects,
    grant: createCapabilityGrant("fixture", effects, Date.now() + 60_000),
    workspace: { root: process.cwd() }, context: { deadlineAtMs: Date.now() + 30 } });
  expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
  expect(result.error).toContain("context deadline");
  expect(performance.now() - started).toBeLessThan(500);
});

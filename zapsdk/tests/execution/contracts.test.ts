import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { z } from "zod";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { ExecutionObservationSchema, OperationFailureSchema } from "../../execution/contracts.js";
import { executionDigest, observeLegacyExecution } from "../../execution/observation.js";
import { executionFailureResult, operationFailure } from "../../execution/failure.js";
import type { ExecutionBrokerRequest, OsSandbox } from "../../execution/types.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS, emptyToolEffects } from "../../tools/effects.js";
import { ToolExecutor, type ToolExecutionLifecycleEvent } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolHandler } from "../../tools/types.js";

function request(handler: ToolHandler = async () => ({ success: true, output: "ok" })): ExecutionBrokerRequest {
  const effects = emptyToolEffects();
  return {
    executionId: "execution:call-1", name: "probe", args: { value: "private-content" },
    effects, grant: createCapabilityGrant("call-1", effects, Date.now() + 60_000),
    workspace: { root: tmpdir(), mode: "root", sandbox: "none" },
    context: { sessionId: "thread-1", toolCallId: "call-1", step: 1 },
    tool: { definition: { name: "probe", description: "probe", parameters: z.object({ value: z.string() }),
      resolveEffects: () => effects }, handler },
  };
}

function unavailableSandbox(): OsSandbox {
  return { status: () => ({ provider: "none", available: false }), createContext: () => { throw new Error("unreachable"); } };
}

describe("execution contract V2 legacy projection", () => {
  test("round-trips without arguments, credentials, fabricated isolation or revision", () => {
    const input = request();
    input.args = { sessionId: "forged-session", apiKey: "private-key", value: "private-content" };
    const observation = observeLegacyExecution(input, { provider: "none", available: false }, "disabled")("succeeded");
    expect(ExecutionObservationSchema.parse(JSON.parse(JSON.stringify(observation)))).toEqual(observation);
    expect(observation.operation.identity).toEqual({ sessionId: "thread-1", toolCallId: "call-1", step: 1 });
    expect(observation.operation.workspaceRef.revision).toBeNull();
    expect(observation.capabilities).toMatchObject({ generation: null, runtimeRevision: null,
      imageRevision: null, source: "status-only", fineNetwork: "unknown", ownerDeath: "unknown" });
    expect(observation.plan.authorizationBinding).toBe("legacy-unbound");
    expect(JSON.stringify(observation)).not.toContain("private-key");
    expect(JSON.stringify(observation)).not.toContain("private-content");
    expect(JSON.stringify(observation)).not.toContain("forged-session");
    expect(observation.receipt.constraints.some((item) => item.level === "kernel")).toBe(false);
  });

  test("hashes object keys canonically but never reorders argument arrays", () => {
    expect(executionDigest({ a: 1, b: { d: 4, c: 3 } })).toBe(executionDigest({ b: { c: 3, d: 4 }, a: 1 }));
    for (const key of ["enum", "required", "type", "oneOf", "allOf", "items"]) {
      expect(executionDigest({ [key]: ["first", "second"] })).not.toBe(executionDigest({ [key]: ["second", "first"] }));
    }
  });

  test("capability and plan digests ignore observation time and change on constraints or backend facts", () => {
    const input = request();
    const status = { provider: "none" as const, available: false };
    const first = observeLegacyExecution(input, status, "disabled", DEFAULT_TOOL_RESOURCE_LIMITS)("succeeded");
    const second = observeLegacyExecution(input, status, "disabled", DEFAULT_TOOL_RESOURCE_LIMITS)("failed");
    expect(first.plan).toEqual(second.plan);
    const constrained = observeLegacyExecution(input, status, "disabled", { ...DEFAULT_TOOL_RESOURCE_LIMITS, timeoutMs: 1 })("rejected");
    expect(constrained.plan.constraintsDigest).not.toBe(first.plan.constraintsDigest);
    expect(constrained.plan.executionPlanDigest).not.toBe(first.plan.executionPlanDigest);
    const different = observeLegacyExecution(input, { ...status, available: true }, "best-effort")("rejected");
    expect(different.capabilities.revision).not.toBe(first.capabilities.revision);
  });

  test("rejects cross-operation, backend, capability and receipt binding mismatches", () => {
    const value = observeLegacyExecution(request(), { provider: "none", available: false }, "disabled")("succeeded");
    const mutations = [
      { ...value, plan: { ...value.plan, operationId: "other" } },
      { ...value, plan: { ...value.plan, backendId: "other" } },
      { ...value, receipt: { ...value.receipt, capabilityRevision: "0".repeat(64) } },
      { ...value, receipt: { ...value.receipt, executionPlanDigest: "0".repeat(64) } },
      { ...value, operation: { ...value.operation, args: { secret: "not-allowed" } } },
      { ...value, version: 1 },
      { ...value, receipt: { ...value.receipt, sandboxedProcesses: 1, spawnedProcesses: 0 } },
    ];
    for (const mutation of mutations) expect(ExecutionObservationSchema.safeParse(mutation).success).toBe(false);
  });

  test("legacy exception strings never prove a sandbox or DNS denial", () => {
    for (const message of ["sandbox denied", "Private, local, or reserved network destination", "DNS failed", "aborted"]) {
      const result = executionFailureResult(new Error(message), "call-1");
      expect(result.failure).toMatchObject({ version: 2, code: "EXECUTION_FAILED", source: "unknown", retryable: false });
      expect(OperationFailureSchema.parse(result.failure)).toEqual(result.failure!);
      expect(result.error).toBe(message);
    }
    expect(OperationFailureSchema.safeParse({ ...operationFailure("POLICY_DENIED", "policy"), surprise: "value" }).success).toBe(false);
  });
});

describe("broker-authored failures and receipts", () => {
  test("a failed backend status probe returns unknown facts, never inferred availability", async () => {
    let invoked = false;
    const sandbox: OsSandbox = { status: () => { throw new Error("status probe crashed"); },
      createContext: () => { throw new Error("unreachable"); } };
    const result = await new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }).execute(request(async () => {
      invoked = true; return { success: true, output: "bad" };
    }));
    expect(invoked).toBe(false);
    expect(result.failure).toMatchObject({ code: "BACKEND_UNAVAILABLE", source: "backend" });
    expect(result.runtime?.execution?.capabilities).toMatchObject({ available: null, provider: null, source: "unavailable" });
    expect(ExecutionObservationSchema.safeParse(result.runtime?.execution).success).toBe(true);
  });
  test("disabled mode is explicit and still audited, without changing legacy output", async () => {
    const result = await new DefaultExecutionBroker().execute(request());
    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
    expect(result.runtime?.broker).toBeUndefined();
    expect(ExecutionObservationSchema.safeParse(result.runtime?.execution).success).toBe(true);
    expect(result.runtime?.execution?.receipt).toMatchObject({ outcome: "succeeded", spawnedProcesses: 0, sandboxedProcesses: 0 });
    expect(result.runtime?.execution?.receipt.constraints.find((item) => item.dimension === "process-sandbox"))
      .toEqual({ dimension: "process-sandbox", status: "not-enforced", level: "none" });
  });

  test("grant rejection does not invoke a handler and is not a sandbox denial", async () => {
    let invoked = false;
    const input = request(async () => { invoked = true; return { success: true, output: "bad" }; });
    input.grant.expiresAt = 0;
    const result = await new DefaultExecutionBroker().execute(input);
    expect(invoked).toBe(false);
    expect(result.failure).toMatchObject({ code: "POLICY_DENIED", source: "broker", evidenceRef: input.executionId });
    expect(result.runtime?.execution?.receipt.outcome).toBe("rejected");
  });

  test("required backend unavailable is distinguished from unsupported launcher", async () => {
    let invoked = false;
    const input = request(async () => { invoked = true; return { success: true, output: "bad" }; });
    input.effects.process.push({ kind: "process", operation: "spawn" });
    input.grant = createCapabilityGrant("call-1", input.effects, Date.now() + 60_000);
    const broker = new DefaultExecutionBroker({ sandbox: unavailableSandbox(), sandboxMode: "required" });
    expect((await broker.execute(input)).failure?.code).toBe("CAPABILITY_UNSUPPORTED");
    input.tool.definition.sandboxAware = true;
    const unavailable = await broker.execute(input);
    expect(unavailable.failure?.code).toBe("BACKEND_UNAVAILABLE");
    expect(unavailable.runtime?.execution?.receipt.outcome).toBe("rejected");
    expect(invoked).toBe(false);
  });

  test("launcher bypass is failed with no claim of enforced isolation", async () => {
    const input = request();
    input.effects.process.push({ kind: "process", operation: "spawn" });
    input.grant = createCapabilityGrant("call-1", input.effects, Date.now() + 60_000);
    input.tool.definition.sandboxAware = true;
    const result = await new DefaultExecutionBroker().execute(input);
    expect(result.failure?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(result.runtime?.execution?.receipt).toMatchObject({ outcome: "failed", spawnedProcesses: 0 });
  });

  test("input, output and cooperative meter limits get RESOURCE_LIMIT", async () => {
    const input = await new DefaultExecutionBroker({ limits: { maxInputBytes: 1 } }).execute(request());
    expect(input.failure?.code).toBe("RESOURCE_LIMIT");
    expect(input.runtime?.execution?.receipt.outcome).toBe("rejected");
    const output = await new DefaultExecutionBroker({ limits: { maxOutputBytes: 1 } }).execute(request());
    expect(output.failure?.code).toBe("RESOURCE_LIMIT");
    expect(output.output).toBe("o");
    expect(output.runtime?.execution?.receipt.outcome).toBe("failed");
    const metered = await new DefaultExecutionBroker({ limits: { maxFiles: 1 } }).execute(request(async (_args, _signal, context) => {
      context!.resources!.consumeFiles(2);
      return { success: true, output: "unreachable" };
    }));
    expect(metered.failure?.code).toBe("RESOURCE_LIMIT");
    expect(metered.runtime?.execution?.receipt.constraints.find((item) => item.dimension === "resource-meters"))
      .toEqual({ dimension: "resource-meters", status: "observed", level: "cooperative" });
  });

  test("deadline and cancellation are authoritative even for noncooperative handlers", async () => {
    const hanging = () => request(async () => new Promise(() => {}));
    const timed = await new DefaultExecutionBroker({ limits: { timeoutMs: 5 } }).execute(hanging());
    expect(timed.failure).toMatchObject({ code: "DEADLINE_EXCEEDED", source: "broker" });
    expect(timed.runtime?.execution?.receipt.constraints.find((item) => item.dimension === "await-deadline"))
      .toEqual({ dimension: "await-deadline", status: "enforced", level: "adapter" });
    const controller = new AbortController();
    const pending = new DefaultExecutionBroker().execute(hanging(), controller.signal);
    controller.abort();
    expect((await pending).failure).toMatchObject({ code: "CANCELLED", source: "broker" });
  });

  test("abort before execution does not invoke the handler", async () => {
    let invoked = false;
    const controller = new AbortController();
    controller.abort();
    const result = await new DefaultExecutionBroker().execute(request(async () => {
      invoked = true; return { success: true, output: "bad" };
    }), controller.signal);
    expect(invoked).toBe(false);
    expect(result.failure?.code).toBe("CANCELLED");
    expect(result.runtime?.execution?.receipt.outcome).toBe("rejected");
  });

  test("returned and thrown legacy errors keep their text and unknown attribution", async () => {
    for (const handler of [
      async () => ({ success: false, output: "original", error: "sandbox denied" }),
      async () => { throw new Error("sandbox denied"); },
    ]) {
      const result = await new DefaultExecutionBroker().execute(request(handler));
      expect(result.error).toBe("sandbox denied");
      expect(result.failure).toMatchObject({ code: "EXECUTION_FAILED", source: "unknown" });
      expect(result.runtime?.execution?.receipt.outcome).toBe("failed");
    }
  });

  test("a malformed legacy failure field cannot masquerade as structured denial evidence", async () => {
    const result = await new DefaultExecutionBroker().execute(request(async () => ({
      success: false, output: "original", error: "original error",
      failure: { code: "SANDBOX_DENIED", secret: "private-field" } as any,
    })));
    expect(result.failure).toMatchObject({ code: "EXECUTION_FAILED", source: "unknown" });
    expect(OperationFailureSchema.safeParse(result.failure).success).toBe(true);
    expect(JSON.stringify(result.failure)).not.toContain("private-field");
    expect(result.output).toBe("original");
  });

  test("abort during launcher preparation also prevents handler execution", async () => {
    let invoked = false;
    const controller = new AbortController();
    const input = request(async () => { invoked = true; return { success: true, output: "bad" }; });
    input.effects.process.push({ kind: "process", operation: "spawn" });
    input.grant = createCapabilityGrant("call-1", input.effects, Date.now() + 60_000);
    input.tool.definition.sandboxAware = true;
    const result = await new DefaultExecutionBroker({ processBrokerFactory: () => {
      controller.abort();
      return { spawnCount: 0, sandboxedSpawnCount: 0,
        spawnCommand: () => { throw new Error("unreachable"); }, spawnShell: () => { throw new Error("unreachable"); } };
    } }).execute(input, controller.signal);
    expect(result.failure?.code).toBe("CANCELLED");
    expect(result.runtime?.execution?.receipt.outcome).toBe("rejected");
    expect(invoked).toBe(false);
  });
});

describe("executor failure provenance", () => {
  function executor(handler?: ToolHandler, options: ConstructorParameters<typeof ToolExecutor>[1] = {}) {
    const input = request(handler);
    const registry = new ToolRegistry();
    registry.register(input.tool);
    return new ToolExecutor(registry, { cwd: tmpdir(), ...options });
  }

  test("policy, missing approval, user denial and arguments are distinct", async () => {
    expect((await executor().execute("missing", {})).failure?.code).toBe("TOOL_NOT_FOUND");
    expect((await executor().execute("probe", {})).failure?.code).toBe("INVALID_ARGUMENTS");
    const registry = new ToolRegistry();
    const input = request();
    input.tool.definition.permission = "confirm";
    registry.register(input.tool);
    expect((await new ToolExecutor(registry).execute("probe", input.args)).failure?.code).toBe("APPROVAL_REQUIRED");
    expect((await new ToolExecutor(registry, { onApproval: async () => false }).execute("probe", input.args)).failure).toMatchObject({ code: "POLICY_DENIED", source: "approval" });
    input.tool.definition.permission = "deny";
    expect((await new ToolExecutor(registry).execute("probe", input.args)).failure).toMatchObject({ code: "POLICY_DENIED", source: "policy" });
  });

  test("a legacy 'aborted' error is a failure, not user cancellation", async () => {
    const events: ToolExecutionLifecycleEvent[] = [];
    const result = await executor(async () => ({ success: false, output: "", error: "aborted" }), {
      onExecutionLifecycle: (event) => { events.push(event); },
    }).execute("probe", { value: "x" });
    expect(result.failure?.code).toBe("EXECUTION_FAILED");
    expect(events.map((event) => event.status)).toEqual(["started", "failed"]);
    expect(events[1].failure).toEqual(result.failure!);
    expect(events[1].execution).toEqual(result.runtime!.execution!);
  });

  test("formatter replacement cannot remove broker-authored audit", async () => {
    const result = await executor(async () => ({ success: false, output: "original", error: "error" }), {
      postProcess: (_name, _args, original) => ({ success: original.success, output: "formatted", error: original.error }),
    }).execute("probe", { value: "x" });
    expect(result.output).toBe("formatted");
    expect(result.failure).toMatchObject({ code: "EXECUTION_FAILED", source: "unknown" });
    expect(ExecutionObservationSchema.safeParse(result.runtime?.execution).success).toBe(true);
  });

  test("required checkpoint is identified before executing a destructive tool", async () => {
    let invoked = false;
    const input = request(async () => { invoked = true; return { success: true, output: "bad" }; });
    input.tool.definition.checkpointRequirement = "required";
    input.effects.filesystem.push({ kind: "filesystem", operation: "modify", paths: ["/nonexistent/probe"] });
    const registry = new ToolRegistry();
    registry.register(input.tool);
    const result = await new ToolExecutor(registry).execute("probe", input.args);
    expect(result.failure).toMatchObject({ code: "CHECKPOINT_REQUIRED", source: "checkpoint" });
    expect(invoked).toBe(false);
  });
});

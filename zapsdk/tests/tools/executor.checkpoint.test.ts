import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool, ToolExecutionContext } from "../../tools/types.js";

describe("ToolExecutor execution context", () => {
  it("passes host metadata separately from model-validated arguments", async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    let receivedContext: Readonly<ToolExecutionContext> | undefined;
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "contextual",
        description: "test",
        parameters: z.object({ value: z.string() }),
      },
      handler: async (args, _signal, context) => {
        receivedArgs = args;
        receivedContext = context;
        return { success: true, output: "ok" };
      },
    });
    const executor = new ToolExecutor(registry);
    const context = { sessionId: "session-1", toolCallId: "call-1", step: 3 } as const;

    const result = await executor.execute("contextual", { value: "input" }, undefined, context);

    expect(result.success).toBe(true);
    expect(receivedArgs).toEqual({ value: "input" });
    expect(receivedArgs?.sessionId).toBeUndefined();
    expect(receivedContext).toMatchObject(context);
    expect((receivedContext as any)?.effects?.confidence).toBe("unknown");
    expect((receivedContext as any)?.grant?.callId).toBe("call-1");
  });
});

describe("ToolExecutor onTrackEdit hook", () => {
  it("fires onTrackEdit with paths returned by writesPath before handler", async () => {
    const order: string[] = [];
    const tool: Tool = {
      definition: {
        name: "test_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        writesPath: (args) => [(args as any).path],
      },
      handler: async () => {
        order.push("handler");
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async (paths) => {
        order.push(`track:${paths.join(",")}`);
      },
    });
    await executor.execute("test_write", { path: "src/a.ts" });
    expect(order).toEqual(["track:src/a.ts", "handler"]);
  });

  it("does not call onTrackEdit when tool has no writesPath", async () => {
    let called = false;
    const tool: Tool = {
      definition: {
        name: "read_only",
        description: "test",
        parameters: z.object({}),
      },
      handler: async () => ({ success: true, output: "" }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async () => { called = true; },
    });
    await executor.execute("read_only", {});
    expect(called).toBe(false);
  });

  it("swallows onTrackEdit errors and runs handler", async () => {
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "test_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        writesPath: (args) => [(args as any).path],
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async () => { throw new Error("checkpoint kaboom"); },
    });
    const r = await executor.execute("test_write", { path: "src/a.ts" });
    expect(handlerRan).toBe(true);
    expect(r.success).toBe(true);
    expect(r.runtime?.checkpoint).toEqual({
      attempted: true,
      covered: false,
      error: "checkpoint kaboom",
    });
  });

  it("fails closed before a destructive handler when checkpoint coverage is unavailable", async () => {
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "destructive_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        writesPath: (args) => [args.path as string],
        checkpointRequirement: "required",
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "should not run" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async () => { throw new Error("backup unavailable"); },
    });

    const result = await executor.execute("destructive_write", { path: "src/a.ts" });

    expect(handlerRan).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("requires a checkpoint");
    expect(result.error).toContain("backup unavailable");
    expect(result.error).toContain("no handler was executed");
    expect(result.error).toContain("authorized path inside the workspace");
    expect(result.runtime?.checkpoint).toEqual({
      attempted: true,
      covered: false,
      error: "backup unavailable",
    });
  });

  it("records before and after write fingerprints outside model-visible output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zap-write-evidence-"));
    const path = join(directory, "note.txt");
    await writeFile(path, "before", "utf8");
    const tool: Tool = {
      definition: {
        name: "tracked_write",
        description: "test",
        parameters: z.object({}),
        writesPath: () => [path],
      },
      handler: async () => {
        await writeFile(path, "after", "utf8");
        return { success: true, output: "updated" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry);

    try {
      const result = await executor.execute("tracked_write", {});
      const evidence = result.runtime?.writeEvidence?.paths[0];

      expect(result.success).toBe(true);
      expect(await readFile(path, "utf8")).toBe("after");
      expect(result.output).toBe("updated");
      expect(evidence?.path).toBe(path);
      expect(evidence?.before.sha256).not.toBe(evidence?.after.sha256);
      expect(evidence?.before.size).toBe(6);
      expect(evidence?.after.size).toBe(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("denies confirm tools when no approval callback is configured", async () => {
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry);

    const r = await executor.execute("confirm_write", {});

    expect(handlerRan).toBe(false);
    expect(r.success).toBe(false);
    expect(r.error).toContain("requires approval");
  });

  it("can explicitly allow confirm tools without approval for trusted embedders", async () => {
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      allowConfirmWithoutApproval: true,
    });

    const r = await executor.execute("confirm_write", {});

    expect(handlerRan).toBe(true);
    expect(r.success).toBe(true);
  });

  it("does not track or run confirm tools denied by approval", async () => {
    let tracked = false;
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        permission: "confirm",
        writesPath: (args) => [(args as any).path],
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onApproval: async () => false,
      onTrackEdit: async () => { tracked = true; },
    });

    const r = await executor.execute("confirm_write", { path: "src/a.ts" });

    expect(r.success).toBe(false);
    expect(r.error).toContain("approval not granted");
    expect(tracked).toBe(false);
    expect(handlerRan).toBe(false);
  });

  it("validates confirm tool arguments before asking for approval", async () => {
    let approvalCalled = false;
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        permission: "confirm",
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onApproval: async () => {
        approvalCalled = true;
        return true;
      },
    });

    const r = await executor.execute("confirm_write", { path: 42 });

    expect(r.success).toBe(false);
    expect(r.error).toContain("Invalid arguments");
    expect(approvalCalled).toBe(false);
    expect(handlerRan).toBe(false);
  });

  it("passes parsed arguments to approval and handler", async () => {
    let approvalArgs: Record<string, unknown> | undefined;
    let handlerArgs: Record<string, unknown> | undefined;
    let postProcessArgs: Record<string, unknown> | undefined;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({
          path: z.string(),
          mode: z.enum(["fast", "safe"]).default("safe"),
        }),
        permission: "confirm",
      },
      handler: async (args) => {
        handlerArgs = args;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onApproval: async (_toolName, args) => {
        approvalArgs = args;
        return true;
      },
      postProcess: async (_toolName, args, result) => {
        postProcessArgs = args;
        return result;
      },
    });

    const r = await executor.execute("confirm_write", { path: "src/a.ts" });

    expect(r.success).toBe(true);
    expect(approvalArgs).toEqual({ path: "src/a.ts", mode: "safe" });
    expect(handlerArgs).toEqual({ path: "src/a.ts", mode: "safe" });
    expect(postProcessArgs).toEqual({ path: "src/a.ts", mode: "safe" });
  });

  it("returns a failure result when approval throws without running the handler", async () => {
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onApproval: async () => { throw new Error("approval UI closed"); },
    });

    const r = await executor.execute("confirm_write", {});

    expect(r.success).toBe(false);
    expect(r.error).toContain("approval failed");
    expect(r.error).toContain("approval UI closed");
    expect(handlerRan).toBe(false);
  });

  it("keeps the approval queue usable after an approval callback throws", async () => {
    let approvalCalls = 0;
    let handlerCalls = 0;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => {
        handlerCalls++;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onApproval: async () => {
        approvalCalls++;
        if (approvalCalls === 1) throw new Error("approval UI closed");
        return true;
      },
    });

    const first = await executor.execute("confirm_write", {});
    const second = await executor.execute("confirm_write", {});

    expect(first.success).toBe(false);
    expect(first.error).toContain("approval failed");
    expect(second.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it("returns aborted when caller aborts while approval is pending", async () => {
    let approvalStarted = false;
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "should not run" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    const executor = new ToolExecutor(registry, {
      onApproval: async () => {
        approvalStarted = true;
        return await new Promise<boolean>(() => {});
      },
    });

    const pending = executor.execute("confirm_write", {}, controller.signal);
    while (!approvalStarted) await Promise.resolve();
    controller.abort(new Error("user cancelled"));
    const r = await pending;

    expect(r.success).toBe(false);
    expect(r.error).toBe("aborted");
    expect(handlerRan).toBe(false);
  });

  it("passes the caller signal into the approval callback", async () => {
    let approvalSignal: AbortSignal | undefined;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => ({ success: true, output: "ok" }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    const executor = new ToolExecutor(registry, {
      onApproval: async (_toolName, _args, signal) => {
        approvalSignal = signal;
        return true;
      },
    });

    const r = await executor.execute("confirm_write", {}, controller.signal);

    expect(r.success).toBe(true);
    expect(approvalSignal).toBe(controller.signal);
  });

  it("does not let an aborted pending approval block later approvals", async () => {
    let approvalCalls = 0;
    let handlerCalls = 0;
    const tool: Tool = {
      definition: {
        name: "confirm_write",
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => {
        handlerCalls++;
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    const executor = new ToolExecutor(registry, {
      onApproval: async () => {
        approvalCalls++;
        if (approvalCalls === 1) {
          return await new Promise<boolean>(() => {});
        }
        return true;
      },
    });

    const first = executor.execute("confirm_write", {}, controller.signal);
    while (approvalCalls === 0) await Promise.resolve();
    controller.abort(new Error("user cancelled"));
    expect(await first).toMatchObject({ success: false, error: "aborted" });

    const second = await Promise.race([
      executor.execute("confirm_write", {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second approval blocked")), 50)),
    ]);

    expect(second.success).toBe(true);
    expect(approvalCalls).toBe(2);
    expect(handlerCalls).toBe(1);
  });

  it("shares the approval queue across withRegistry clones", async () => {
    let releaseFirstApproval!: () => void;
    let firstApprovalStarted = false;
    let firstApprovalFinished = false;
    let secondApprovalStartedAfterFirstFinished = false;
    const makeTool = (name: string): Tool => ({
      definition: {
        name,
        description: "test",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => ({ success: true, output: name }),
    });
    const registry1 = new ToolRegistry();
    registry1.register(makeTool("first"));
    const registry2 = new ToolRegistry();
    registry2.register(makeTool("second"));
    const executor1 = new ToolExecutor(registry1, {
      onApproval: async (toolName) => {
        if (toolName === "first") {
          firstApprovalStarted = true;
          await new Promise<void>((resolve) => { releaseFirstApproval = resolve; });
          firstApprovalFinished = true;
          return true;
        }
        secondApprovalStartedAfterFirstFinished = firstApprovalFinished;
        return true;
      },
    });
    const executor2 = executor1.withRegistry(registry2);

    const first = executor1.execute("first", {});
    while (!firstApprovalStarted) await Promise.resolve();
    const second = executor2.execute("second", {});
    await Promise.resolve();
    expect(secondApprovalStartedAfterFirstFinished).toBe(false);

    releaseFirstApproval();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(secondApprovalStartedAfterFirstFinished).toBe(true);
  });

  it("aborts the handler signal when the executor timeout fires", async () => {
    let handlerSignal: AbortSignal | undefined;
    let abortObserved = false;
    let abortReason = "";
    const tool: Tool = {
      definition: {
        name: "slow_tool",
        description: "test",
        parameters: z.object({}),
        timeoutMs: 5,
      },
      handler: async (_args, signal) => {
        handlerSignal = signal;
        return await new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            abortObserved = true;
            abortReason = signal.reason instanceof Error
              ? signal.reason.message
              : String(signal.reason);
            resolve({ success: true, output: "ignored late result" });
          }, { once: true });
          setTimeout(() => resolve({ success: true, output: "too late" }), 50);
        });
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, { timeoutMs: 1_000 });

    const r = await executor.execute("slow_tool", {});

    expect(r.success).toBe(false);
    // Executor and broker enforce the same absolute deadline; either timer
    // may settle first. The structured failure and handler abort must agree.
    expect(r.failure?.code).toBe("DEADLINE_EXCEEDED");
    expect(handlerSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
    expect(abortReason).toBe(r.error!);
  });

  it("forwards caller aborts to the handler signal", async () => {
    let handlerSignal: AbortSignal | undefined;
    let abortObserved = false;
    const tool: Tool = {
      definition: {
        name: "abortable_tool",
        description: "test",
        parameters: z.object({}),
      },
      handler: async (_args, signal) => {
        handlerSignal = signal;
        return await new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            abortObserved = true;
            resolve({ success: true, output: "ignored late result" });
          }, { once: true });
          setTimeout(() => resolve({ success: true, output: "too late" }), 50);
        });
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, { timeoutMs: 1_000 });
    const controller = new AbortController();

    const pending = executor.execute("abortable_tool", {}, controller.signal);
    controller.abort(new Error("user cancelled"));
    const r = await pending;

    expect(r.success).toBe(false);
    expect(r.error).toBe("aborted");
    expect(handlerSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
  });

  it("does not start the handler when caller aborts during edit tracking", async () => {
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "tracked_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        writesPath: (args) => [(args as any).path],
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "should not run" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async () => {
        controller.abort(new Error("cancelled while tracking"));
      },
    });

    const r = await executor.execute("tracked_write", { path: "src/a.ts" }, controller.signal);

    expect(r.success).toBe(false);
    expect(r.error).toBe("aborted");
    expect(handlerRan).toBe(false);
  });

  it("times out instead of hanging when edit tracking never settles", async () => {
    let trackingStarted = false;
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "tracked_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        timeoutMs: 5,
        writesPath: (args) => [(args as any).path],
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "should not run" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async () => {
        trackingStarted = true;
        return await new Promise<void>(() => {});
      },
    });

    const r = await executor.execute("tracked_write", { path: "src/a.ts" });

    expect(trackingStarted).toBe(true);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Tool "tracked_write" timed out after 5ms');
    expect(handlerRan).toBe(false);
  });

  it("returns aborted when caller aborts while edit tracking is pending", async () => {
    let trackingStarted = false;
    let handlerRan = false;
    const tool: Tool = {
      definition: {
        name: "tracked_write",
        description: "test",
        parameters: z.object({ path: z.string() }),
        writesPath: (args) => [(args as any).path],
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "should not run" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    const executor = new ToolExecutor(registry, {
      onTrackEdit: async () => {
        trackingStarted = true;
        return await new Promise<void>(() => {});
      },
    });

    const pending = executor.execute("tracked_write", { path: "src/a.ts" }, controller.signal);
    // Yield to filesystem I/O performed before the checkpoint hook.
    while (!trackingStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("user cancelled"));
    const r = await pending;

    expect(r.success).toBe(false);
    expect(r.error).toBe("aborted");
    expect(handlerRan).toBe(false);
  });

  it("times out instead of hanging when postProcess never settles", async () => {
    let postProcessStarted = false;
    const tool: Tool = {
      definition: {
        name: "post_processed_tool",
        description: "test",
        parameters: z.object({}),
        timeoutMs: 5,
      },
      handler: async () => ({ success: true, output: "handler result" }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      timeoutMs: 1_000,
      postProcess: async () => {
        postProcessStarted = true;
        return await new Promise(() => {});
      },
    });

    const r = await executor.execute("post_processed_tool", {});

    expect(postProcessStarted).toBe(true);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Tool "post_processed_tool" timed out after 5ms');
  });

  it("returns aborted when caller aborts while postProcess is pending", async () => {
    let postProcessStarted = false;
    const tool: Tool = {
      definition: {
        name: "post_processed_tool",
        description: "test",
        parameters: z.object({}),
      },
      handler: async () => ({ success: true, output: "handler result" }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const controller = new AbortController();
    const executor = new ToolExecutor(registry, {
      timeoutMs: 1_000,
      postProcess: async () => {
        postProcessStarted = true;
        return await new Promise(() => {});
      },
    });

    const pending = executor.execute("post_processed_tool", {}, controller.signal);
    while (!postProcessStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("user cancelled"));
    const r = await pending;

    expect(r.success).toBe(false);
    expect(r.error).toBe("aborted");
  });
});


describe("explicit checkpoint coverage", () => {
  for (const required of [false, true]) {
    it(`respects incomplete coverage with required=${required}`, async () => {
      let handlerRan = false;
      const registry = new ToolRegistry();
      registry.register({
        definition: {
          name: "coverage_probe",
          description: "test",
          parameters: z.object({}),
          writesPath: () => ["uncovered.txt"],
          ...(required ? { checkpointRequirement: "required" as const } : {}),
        },
        handler: async () => { handlerRan = true; return { success: true, output: "ok" }; },
      });
      const executor = new ToolExecutor(registry, {
        onTrackEdit: async () => ({ covered: false, uncoveredPaths: ["uncovered.txt"] }),
      });
      const result = await executor.execute("coverage_probe", {});
      expect(handlerRan).toBe(!required);
      expect(result.success).toBe(!required);
      expect(result.runtime?.checkpoint).toMatchObject({ attempted: true, covered: false });
      expect(result.runtime?.checkpoint?.error).toContain("uncovered.txt");
      if (required) expect(result.failure?.code).toBe("CHECKPOINT_REQUIRED");
    });
  }
});

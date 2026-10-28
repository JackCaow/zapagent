import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalWorkspaceGate } from "../../execution/goal-workspace-gate.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { ToolAuthorization } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { writeFileTool } from "../../builtin-tools/filesystem.js";
import type { ExecutionBroker, ExecutionBrokerRequest } from "../../execution/types.js";
import { z } from "zod";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "goal-gate-"))); roots.push(root); return root; }
const nextTick = () => new Promise(resolve => setTimeout(resolve, 40));
function request(root: string, name = "read_file"): ExecutionBrokerRequest {
  return { workspace: { root }, executionId: name, name, args: {}, effects: { process: [] }, tool: { definition: {} } } as unknown as ExecutionBrokerRequest;
}

describe("Goal workspace gate prototype", () => {
  it("serializes an exclusive Host operation with real file tools from separate executors", async () => {
    const root = fixture(), gate = new GoalWorkspaceGate();
    const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: root }));
    const broker = new DefaultExecutionBroker();
    const first = new ToolExecutor(registry, { cwd: root, workspace: { root }, workspaceGate: gate, executionBroker: broker, onApproval: async () => true });
    const second = new ToolExecutor(registry, { cwd: root, workspace: { root }, workspaceGate: gate, executionBroker: broker, onApproval: async () => true });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    const install = gate.withExclusiveWorkspace(root, async () => { started = true; await held; });
    await nextTick(); expect(started).toBe(true);
    let completed = 0;
    const a = first.execute("write_file", { path: "a.txt", content: "a" }).then(result => { completed++; return result; });
    const b = second.execute("write_file", { path: "b.txt", content: "b" }).then(result => { completed++; return result; });
    await nextTick(); expect(completed).toBe(0);
    release(); await install;
    const results = await Promise.all([a, b]); expect(results.every(result => result.success)).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a"); expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b");
  });

  it("fences authorization and checkpoint work before file handlers across cloned executors", async () => {
    const root = fixture(), gate = new GoalWorkspaceGate();
    const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: root }));
    let checkpoints = 0;
    const first = new ToolExecutor(registry, { cwd: root, workspace: { root }, workspaceGate: gate,
      checkpointMode: "before-write", onTrackEdit: async () => { checkpoints++; }, onApproval: async () => true });
    const second = first.withApprovalLifecycle(async () => {}).withExecutionLifecycle(async () => {});
    expect(second.workspaceGate).toBe(gate);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const install = gate.withExclusiveWorkspace(root, async () => { await held; });
    await nextTick();
    let completed = 0;
    const a = first.execute("write_file", { path: "a.txt", content: "a" }).then(result => { completed++; return result; });
    const b = second.execute("write_file", { path: "b.txt", content: "b" }).then(result => { completed++; return result; });
    await nextTick(); expect(completed).toBe(0); expect(checkpoints).toBe(0);
    release(); await install;
    const results = await Promise.all([a, b]); expect(results.every(result => result.success)).toBe(true);
    expect(checkpoints).toBe(2);
  });

  it("rejects a gated executor nested inside an exclusive action instead of waiting for its deadline", async () => {
    const root = fixture(), gate = new GoalWorkspaceGate();
    const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: root }));
    const executor = new ToolExecutor(registry, { cwd: root, workspace: { root }, workspaceGate: gate, onApproval: async () => true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      const operation = gate.withExclusiveWorkspace(root, async () => executor.execute("write_file", { path: "nested.txt", content: "x" }, controller.signal));
      await expect(operation).rejects.toThrow("GOAL_WORKSPACE_REENTRANT_LOCK");
      expect(controller.signal.aborted).toBe(false);
      await expect(gate.withExclusiveWorkspace(root, async () => "install")).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    } finally { clearTimeout(timeout); }
  });

  it("rejects nested acquisition of a different root to prevent lock-order cycles", async () => {
    const root = fixture(), other = fixture(), gate = new GoalWorkspaceGate();
    await expect(gate.withExclusiveWorkspace(root, async () => gate.withExclusiveWorkspace(other, async () => "nested")))
      .rejects.toThrow("GOAL_WORKSPACE_REENTRANT_LOCK");
  });

  it("poisons a workspace after timeout even when the handler later returns", async () => {
    const root = fixture(), gate = new GoalWorkspaceGate(); let calls = 0;
    const inner: ExecutionBroker = { sandboxStatus: () => ({ provider: "zapvm", available: true }),
      async execute() { calls++; return { success: false, output: "", failure: { code: "DEADLINE_EXCEEDED" } as any }; } };
    const auth = request(root) as unknown as ToolAuthorization;
    await expect(gate.execute(root, auth, () => inner.execute(request(root)))).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    await expect(gate.execute(root, auth, () => inner.execute(request(root)))).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    expect(calls).toBe(1);
  });

  it("does not reopen the workspace when a real checkpoint times out but remains pending", async () => {
    const root = fixture(), gate = new GoalWorkspaceGate();
    const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: root }));
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    const executor = new ToolExecutor(registry, { cwd: root, workspace: { root }, workspaceGate: gate,
      timeoutMs: 20, checkpointMode: "before-write", onTrackEdit: async () => { started = true; await pending; }, onApproval: async () => true });
    await expect(executor.execute("write_file", { path: "a.txt", content: "a" })).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    expect(started).toBe(true);
    await expect(gate.withExclusiveWorkspace(root, async () => "install")).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    release(); await nextTick();
    await expect(gate.withExclusiveWorkspace(root, async () => "install")).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
  });

  for (const stage of ["postProcess", "resultGuard"] as const) {
    it(`cannot erase a real broker timeout with ${stage}`, async () => {
      const root = fixture(), gate = new GoalWorkspaceGate();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const registry = new ToolRegistry();
      registry.register(writeFileTool({ defaultCwd: root, allowedPaths: [root], useExecutionGrants: true,
        beforeWrite: async () => { entered(); await held; } }));
      const executor = new ToolExecutor(registry, { cwd: root, workspace: { root, mode: "isolated-write" }, workspaceGate: gate,
        timeoutMs: 1000, executionBroker: new DefaultExecutionBroker({ limits: { timeoutMs: 30 } }), onApproval: async () => true,
        ...(stage === "postProcess" ? { postProcess: () => ({ success: true, output: "formatted" }) }
          : { resultGuard: () => ({ success: true, output: "formatted" }) }) });
      const operation = executor.execute("write_file", { path: "late.txt", content: "late" });
      await started;
      await expect(operation).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
      await expect(gate.withExclusiveWorkspace(root, async () => "install")).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
      release(); await nextTick();
      // The in-flight handler can still write after the broker has timed out.
      // The poisoned gate must remain closed even once presentation returns.
      expect(readFileSync(join(root, "late.txt"), "utf8")).toBe("late");
      await expect(gate.withExclusiveWorkspace(root, async () => "install")).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    });

    it(`cannot erase an unsealed process result with ${stage}`, async () => {
      const root = fixture(), gate = new GoalWorkspaceGate();
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "run_fixture", description: "fixture", parameters: z.object({}),
        permission: "auto", sandboxAware: true, executionLocation: "workspace",
        resolveEffects: () => ({ filesystem: [], network: [], process: [{ kind: "process", operation: "spawn" }],
          external: [], workspace: { mode: "isolated-write" }, confidence: "declared" }) },
        async handler() { throw new Error("fixture broker must own execution"); } });
      const broker: ExecutionBroker = { sandboxStatus: () => ({ provider: "zapvm", available: true }),
        async execute() { return { success: false, output: "", error: "receipt missing" }; } };
      const executor = new ToolExecutor(registry, { cwd: root, workspace: { root, mode: "isolated-write" }, workspaceGate: gate,
        executionBroker: broker, onApproval: async () => true,
        ...(stage === "postProcess" ? { postProcess: () => ({ success: true, output: "formatted" }) }
          : { resultGuard: () => ({ success: true, output: "formatted" }) }) });
      await expect(executor.execute("run_fixture", {})).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
      await expect(gate.withExclusiveWorkspace(root, async () => "install")).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    });

    it(`retains a valid broker seal when ${stage} replaces presentation fields`, async () => {
      const root = fixture(), gate = new GoalWorkspaceGate();
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "run_fixture", description: "fixture", parameters: z.object({}),
        permission: "auto", sandboxAware: true, executionLocation: "workspace",
        resolveEffects: () => ({ filesystem: [], network: [], process: [{ kind: "process", operation: "spawn" }],
          external: [], workspace: { mode: "isolated-write" }, confidence: "declared" }) },
        async handler() { throw new Error("fixture broker must own execution"); } });
      const broker: ExecutionBroker = { sandboxStatus: () => ({ provider: "zapvm", available: true }),
        async execute(request) { return { success: true, output: "ok", runtime: { processSeal: { state: "sealed", executionId: request.executionId } } }; } };
      const executor = new ToolExecutor(registry, { cwd: root, workspace: { root, mode: "isolated-write" }, workspaceGate: gate,
        executionBroker: broker, onApproval: async () => true,
        ...(stage === "postProcess" ? { postProcess: () => ({ success: true, output: "formatted" }) }
          : { resultGuard: () => ({ success: true, output: "formatted" }) }) });
      const result = await executor.execute("run_fixture", {});
      expect(result.success).toBe(true);
      expect(result.runtime?.processSeal?.state).toBe("sealed");
      expect(await gate.withExclusiveWorkspace(root, async () => "install")).toBe("install");
    });
  }

  it("rejects same-workspace agent orchestration instead of deadlocking", async () => {
    const root = fixture(), gate = new GoalWorkspaceGate(); let calls = 0;
    const inner: ExecutionBroker = { sandboxStatus: () => ({ provider: "none", available: false }),
      async execute() { calls++; return { success: true, output: "" }; } };
    const result = await gate.execute(root, request(root, "agent") as unknown as ToolAuthorization, () => inner.execute(request(root, "agent")));
    expect(result.success).toBe(false); expect(calls).toBe(0);
  });

  it("poisons overlapping but not unrelated workspace roots", async () => {
    const root = fixture(), other = fixture(), gate = new GoalWorkspaceGate();
    await expect(gate.withExclusiveWorkspace(root, async () => { throw new Error("unknown effects"); })).rejects.toThrow("unknown effects");
    await expect(gate.withExclusiveWorkspace(root, async () => 1)).rejects.toThrow("GOAL_WORKSPACE_EXECUTION_UNCONFIRMED");
    expect(await gate.withExclusiveWorkspace(other, async () => 2)).toBe(2);
  });

  it("serializes symlink aliases and children whose names begin with two dots", async () => {
    const root = fixture(), host = fixture(), gate = new GoalWorkspaceGate();
    const nested = join(root, "..hidden"); mkdirSync(nested);
    const alias = join(host, "alias"); symlinkSync(root, alias, "dir");
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const first = gate.withExclusiveWorkspace(root, async () => { await held; });
    let entered = 0;
    const second = gate.withExclusiveWorkspace(nested, async () => { entered++; });
    const third = gate.withExclusiveWorkspace(alias, async () => { entered++; });
    await nextTick(); expect(entered).toBe(0);
    release(); await Promise.all([first, second, third]); expect(entered).toBe(2);
  });

  it("rejects an alias retargeted while its original workspace lock is queued", async () => {
    const a = fixture(), b = fixture(), host = fixture(), gate = new GoalWorkspaceGate();
    const alias = join(host, "alias"); symlinkSync(a, alias, "dir");
    let releaseA!: () => void, releaseB!: () => void;
    const heldA = new Promise<void>(resolve => { releaseA = resolve; });
    const heldB = new Promise<void>(resolve => { releaseB = resolve; });
    const first = gate.withExclusiveWorkspace(a, async () => { await heldA; });
    const competing = gate.withExclusiveWorkspace(b, async () => { await heldB; });
    let entered = false;
    const waiting = gate.withExclusiveWorkspace(alias, async () => { entered = true; });
    await nextTick(); unlinkSync(alias); symlinkSync(b, alias, "dir");
    releaseA(); await first;
    await expect(waiting).rejects.toThrow("GOAL_WORKSPACE_IDENTITY_CHANGED");
    expect(entered).toBe(false);
    releaseB(); await competing;
  });

  it("rejects a directory replaced at the same path while queued", async () => {
    const host = fixture(), root = join(host, "workspace"), old = join(host, "old"); mkdirSync(root);
    const gate = new GoalWorkspaceGate();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const first = gate.withExclusiveWorkspace(root, async () => { await held; });
    let entered = false;
    const waiting = gate.withExclusiveWorkspace(root, async () => { entered = true; });
    await nextTick(); renameSync(root, old); mkdirSync(root);
    release(); await first;
    await expect(waiting).rejects.toThrow("GOAL_WORKSPACE_IDENTITY_CHANGED");
    expect(entered).toBe(false);
  });
});

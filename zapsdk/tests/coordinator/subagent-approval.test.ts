import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import type { LLMProvider } from "../../core/llm.js";
import { ToolRegistry } from "../../tools/registry.js";
import { WorkspaceManager } from "../../workspace/manager.js";

test("three isolated children with parallel tools share serial approvals without starving capacity", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-approval-wave-")));
  const manager = new WorkspaceManager({ root });
  const bridge = new DeferredAgentCoordinatorExecutor();
  const coordinator = new AgentCoordinator({ threadId: "approval-wave", executor: bridge, maxConcurrency: 2 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  let firstTurns = 0;
  let admitFirst!: () => void;
  const thirdStarted = new Promise<void>(resolve => { admitFirst = resolve; });
  let approvals = 0;
  let activeApprovals = 0;
  let peakApprovals = 0;
  let executions = 0;
  const registryFor = () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "read_file", description: "fixture read", parameters: z.object({ path: z.string() }),
        permission: "confirm", readOnly: true },
      handler: async () => { executions++; return { success: true, output: "fixture" }; },
    });
    return registry;
  };
  const provider: LLMProvider = {
    async call(messages) {
      if (messages.some(message => message.role === "tool_result")) {
        return { type: "text", text: "verified", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (++firstTurns === 3) admitFirst();
      return { type: "tool_call", text: "", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [
        { id: "first", name: "read_file", arguments: { path: "one" } },
        { id: "second", name: "read_file", arguments: { path: "two" } },
      ] };
    },
  };
  const tool = subagentTool({
    provider, registry: registryFor(), createRegistryForCwd: registryFor,
    workspaceManager: manager, storageProjectCwd: root, maxSteps: 3,
    coordinator, coordinatorExecutorBridge: bridge,
    executorOptions: { approvalCoordinator: { current: Promise.resolve() } },
    onApproval: async (_name, _args, signal) => {
      approvals++;
      activeApprovals++;
      peakApprovals = Math.max(peakApprovals, activeApprovals);
      try {
        // Reproduce the original interleaving: a waiting approval admits the
        // third child before the first callback returns.
        await Promise.race([thirdStarted, new Promise<void>(resolve => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        })]);
        await Promise.resolve();
        return true;
      } finally { activeApprovals--; }
    },
  });
  try {
    const results = await Promise.all([1, 2, 3].map(n => tool.handler(
      { task: `Inspect fixture ${n}`, agent_type: "general" }, controller.signal,
    )));
    expect(controller.signal.aborted).toBe(false);
    expect(results.every(result => result.success)).toBe(true);
    const fourth = await tool.handler({ task: "Inspect follow-up", agent_type: "general" }, controller.signal);
    expect(fourth.success).toBe(true);
    expect(executions).toBe(8);
    expect(approvals).toBe(8);
    expect(peakApprovals).toBe(1);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await manager.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

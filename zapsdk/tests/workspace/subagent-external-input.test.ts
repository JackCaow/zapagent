import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import type { LLMProvider } from "../../core/llm.js";
import { ToolExecutor } from "../../tools/executor.js";
import { WorkspaceManager } from "../../workspace/manager.js";

for (const coordinated of [false, true]) {
  test(`external input stays parent-owned while observations reach the child: coordinated=${coordinated}`, async () => {
    const base = mkdtempSync(join(tmpdir(), "zap-external-input-"));
    const root = join(base, "project");
    const external = join(base, "measurements.txt");
    mkdirSync(root);
    writeFileSync(join(root, "note.txt"), "Project note.\n");
    writeFileSync(external, "sample count: 17\n");
    const manager = new WorkspaceManager({ root });
    const registryFor = (cwd: string) => createBuiltinRegistry({
      executeCommand: { defaultCwd: cwd, disableBackgroundTasks: true },
    });
    const registry = registryFor(root);
    let parentApprovals = 0;
    let childApprovals = 0;
    let calls = 0;
    let childSystem = "";
    const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => {
      parentApprovals++;
      return true;
    } });
    const provider: LLMProvider = {
      async call(messages) {
        calls++;
        childSystem = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
        expect(messages.some(message => message.role === "user" && message.content.includes("sample count: 17"))).toBe(true);
        if (calls === 1) {
          return { type: "tool_call", text: "", toolCalls: [{ id: "external-read", name: "read_file", arguments: { path: external } }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        expect(messages.some(message => message.role === "tool_result" && message.content.includes("escape the isolated workspace"))).toBe(true);
        return { type: "text", text: "Parent reports 17 samples. I could not independently read the external file.", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "external-input-fixture", executor: bridge });
    const tool = subagentTool({
      provider, registry, workspaceManager: manager, createRegistryForCwd: registryFor,
      requireWriteIsolation: true, storageProjectCwd: root, maxSteps: 3,
      onApproval: async () => { childApprovals++; return true; },
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}),
    });
    try {
      const observation = await executor.execute("read_file", { path: external });
      expect(observation.success).toBe(true);
      expect(parentApprovals).toBe(1);
      const result = await tool.handler({
        agent_type: "general", system_prompt: "Report observed measurements and their source.",
        task: `Inspect the measurements at ${external}. Parent read result: ${observation.output}`,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("could not independently read");
      expect(calls).toBe(2);
      expect(childApprovals).toBe(0);
      expect(readFileSync(external, "utf8")).toBe("sample count: 17\n");
      expect(tool.definition.description).toContain("External paths are not shared");
      expect(tool.definition.description).toContain("pass relevant observations in the briefing");
      expect(childSystem).toContain("External paths are not included in this snapshot");
      expect(childSystem).toContain("Keep explicit requirements distinct from implementation assumptions and parent-reported observations");
      expect(childSystem).toContain("If that evidence is unavailable, qualify the conclusion");
    } finally {
      await manager.cleanup();
      rmSync(base, { recursive: true, force: true });
    }
  });
}

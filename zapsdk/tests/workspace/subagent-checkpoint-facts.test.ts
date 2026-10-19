import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { CheckpointManager } from "../../checkpoint/index.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import type { LLMProvider } from "../../core/llm.js";
import { WorkspaceManager } from "../../workspace/manager.js";

for (const coordinated of [false, true]) {
  test(`child checkpoint facts and writes use its own tracker: coordinated=${coordinated}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-child-checkpoint-"));
    const previous = process.env.ZAPCODE_DATA_DIR; process.env.ZAPCODE_DATA_DIR = join(root, ".test-data");
    writeFileSync(join(root, "note.txt"), "parent-original");
    const manager = new WorkspaceManager({ root });
    const parent = new CheckpointManager({ sessionId: "parent", cwd: root, config: { maxFileBytes: 1, blobDir: join(root, ".parent-blobs") } });
    const registryFor = (cwd: string) => createBuiltinRegistry({
      readFile: { defaultCwd: cwd }, writeFile: { defaultCwd: cwd },
      executeCommand: { defaultCwd: cwd, disableBackgroundTasks: true },
    });
    let privateRoot = "", calls = 0;
    const provider: LLMProvider = {
      async call(messages) {
        calls++;
        const content = messages.map(message => message.content).join("\n");
        expect(content).toContain(`Checkpoint workspace root: ${JSON.stringify(privateRoot)}`);
        expect(content).not.toContain(`Checkpoint workspace root: ${JSON.stringify(root)}`);
        expect(content).not.toContain("Maximum snapshot file bytes: 1.");
        if (calls === 1) return { type: "tool_call", text: "", toolCalls: [{ id: "child-write", name: "write_file", arguments: { path: "note.txt", content: "child-after" } }], usage: { inputTokens: 1, outputTokens: 1 } };
        expect(readFileSync(join(privateRoot, "note.txt"), "utf8")).toBe("child-after");
        return { type: "text", text: "Wrote only my isolated artifact.", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "child-checkpoint-facts", executor: bridge });
    const tool = subagentTool({ provider, registry: registryFor(root), workspaceManager: manager,
      createRegistryForCwd: cwd => { privateRoot = cwd; return registryFor(cwd); },
      requireWriteIsolation: true, storageProjectCwd: root, maxSteps: 3,
      executorOptions: { onTrackEdit: parent.createEditTracker() }, onApproval: async () => true,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}),
    });
    try {
      const result = await tool.handler({ task: "Edit your isolated note.", agent_type: "general", system_prompt: "Use the Host's actual workspace facts." });
      expect(result.success).toBe(true); expect(calls).toBe(2);
      expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("parent-original");
      const snapshot = await parent.makeSnapshot(0); expect(snapshot).toBeNull();
    } finally {
      await manager.cleanup(); rmSync(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previous;
    }
  });
}

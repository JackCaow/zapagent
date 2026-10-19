import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse } from "../../core/types.js";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { ToolExecutor } from "../../tools/executor.js";
import { WorkspaceManager } from "../../workspace/manager.js";
import { MergeCoordinator } from "../../merge/coordinator.js";

describe("writing subagent isolation", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  for (const useGit of [true, false]) {
    it(`writes only in its isolated workspace until the explicit merge gate (Git=${useGit})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "zap-subagent-isolation-"));
      cleanup.push(root);
      writeFileSync(join(root, "note.txt"), "root\n");
      if (useGit) {
        execFileSync("git", ["init"], { cwd: root });
        execFileSync("git", ["add", "-A"], { cwd: root });
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], { cwd: root });
      }

      let calls = 0;
      const provider: LLMProvider = {
        async call(_messages, tools): Promise<LLMResponse> {
          expect(tools?.some(tool => tool.name === "bash")).toBe(false);
          expect(tools?.some(tool => tool.name === "write_file")).toBe(true);
          calls += 1;
          if (calls === 1) {
            return {
              type: "tool_call",
              text: "",
              toolCalls: [{
                id: "write-1",
                name: "write_file",
                arguments: { path: "note.txt", content: "agent\n" },
              }],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          return { type: "text", text: "updated note", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };

      const registryFor = (cwd: string) => createBuiltinRegistry({
        executeCommand: { defaultCwd: cwd, disableBackgroundTasks: true },
      });
      const rootRegistry = registryFor(root);
      const manager = new WorkspaceManager({ root });
      const coordinator = new MergeCoordinator(manager);
      const approvalContexts: unknown[] = [];
      const agentTool = subagentTool({
        provider,
        registry: rootRegistry,
        onApproval: async (...args) => { approvalContexts.push(args[3]); return true; },
        workspaceManager: manager,
        mergeCoordinator: coordinator,
        createRegistryForCwd: registryFor,
        requireWriteIsolation: true,
        storageProjectCwd: root,
        maxSteps: 3,
      });
      rootRegistry.register(agentTool);
      const executor = new ToolExecutor(rootRegistry, { cwd: root, onApproval: async () => true });

      const agentResult = await executor.execute("agent", {
        task: "update note",
        agent_type: "general",
        thoroughness: "quick",
      }, undefined, { toolCallId: "agent-call" });
      expect(agentResult.success).toBe(true);
      expect(approvalContexts).toHaveLength(1);
      const approvalContext = approvalContexts[0] as { cwd: string; workspaceRoot: string };
      expect(approvalContext?.cwd).toBeDefined();
      expect(approvalContext?.cwd).not.toBe(root);
      expect(approvalContext?.workspaceRoot).toBe(approvalContext?.cwd);
      expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("root\n");
      const artifactId = (agentResult.meta as any).artifactId as string;
      expect(artifactId.startsWith("artifact_")).toBe(true);

      const mergeResult = await executor.execute("merge_agent_artifacts", {
        artifact_ids: [artifactId],
      });
      expect(mergeResult.success).toBe(true);
      expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("agent\n");
      await manager.cleanup();
    });
  }
});

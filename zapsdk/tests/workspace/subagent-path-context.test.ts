import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import type { LLMProvider } from "../../core/llm.js";
import { WorkspaceManager } from "../../workspace/manager.js";

for (const coordinated of [false, true]) {
  for (const customRole of [false, true]) {
    for (const useGit of [false, true]) {
      test(`isolated path context: coordinated=${coordinated}, customRole=${customRole}, git=${useGit}`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'zap child "paths"-'));
        mkdirSync(join(root, "nested"));
        writeFileSync(join(root, "nested/note.txt"), "PARENT_ORIGINAL\n");
        if (useGit) {
          execFileSync("git", ["init", "-q"], { cwd: root });
          execFileSync("git", ["add", "-A"], { cwd: root });
          execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
        }
        const manager = new WorkspaceManager({ root });
        const registry = createBuiltinRegistry({ executeCommand: { defaultCwd: root, disableBackgroundTasks: true } });
        let privateRoot = "";
        let calls = 0;
        let approvals = 0;
        const provider: LLMProvider = {
          async call(messages) {
            calls++;
            const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
            expect(system).toContain(`Parent workspace root: ${JSON.stringify(manager.root)}`);
            const prefix = "Your working directory and workspace root: ";
            const line = system.split("\n").find(line => line.startsWith(prefix));
            expect(line).toBeDefined();
            const disclosedRoot = JSON.parse(line!.slice(prefix.length));
            expect(disclosedRoot).toBe(privateRoot);
            expect(disclosedRoot).not.toBe(manager.root);
            expect(system).toContain("Use the same relative path inside your private workspace");
            expect(system).toContain("Parent changes made after the snapshot may be absent");
            expect(system).toContain("Preserve the host boundary.");
            if (customRole) expect(system).toContain("Inspect only the requested note.");
            if (calls === 1) {
              // Disclosure must not grant access to the original parent path.
              return { type: "tool_call", text: "", toolCalls: [{ id: "original-read", name: "read_file", arguments: { path: join(root, "nested/note.txt") } }], usage: { inputTokens: 1, outputTokens: 1 } };
            }
            if (calls === 2) {
              expect(messages.some(message => message.role === "tool_result" && message.content.includes("escape the isolated workspace"))).toBe(true);
              return { type: "tool_call", text: "", toolCalls: [{ id: "private-read", name: "read_file", arguments: { path: join(disclosedRoot, "nested/note.txt") } }], usage: { inputTokens: 1, outputTokens: 1 } };
            }
            expect(calls).toBe(3);
            const observations = messages.filter(message => message.role === "tool_result").map(message => message.content);
            expect(observations.join("\n")).toContain("PRIVATE_SNAPSHOT");
            return { type: "text", text: "Read the private snapshot; parent unchanged.", usage: { inputTokens: 1, outputTokens: 1 } };
          },
        };
        const bridge = new DeferredAgentCoordinatorExecutor();
        const coordinator = new AgentCoordinator({ threadId: "synthetic-path-context", executor: bridge });
        const tool = subagentTool({
          provider, registry, workspaceManager: manager, requireWriteIsolation: true,
          storageProjectCwd: join(root, "different-storage-label"), maxSteps: 4,
          inheritedInstructions: "Preserve the host boundary.",
          onApproval: async (name, args) => {
            expect(name).toBe("read_file");
            expect(args.path).toBe(join(privateRoot, "nested/note.txt"));
            approvals++;
            return true;
          },
          createRegistryForCwd: cwd => {
            privateRoot = cwd;
            writeFileSync(join(cwd, "nested/note.txt"), "PRIVATE_SNAPSHOT\n");
            return createBuiltinRegistry({ executeCommand: { defaultCwd: cwd, disableBackgroundTasks: true } });
          },
          ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}),
        });
        try {
          const result = await tool.handler({
            task: `Inspect ${join(root, "nested/note.txt")}.`, agent_type: "general",
            ...(customRole ? { system_prompt: "Inspect only the requested note." } : {}),
          });
          expect(result.error).toBeUndefined();
          expect(result.success).toBe(true);
          expect(result.output).toContain("Read the private snapshot");
          expect(calls).toBe(3);
          expect(approvals).toBe(1);
          expect(readFileSync(join(root, "nested/note.txt"), "utf8")).toBe("PARENT_ORIGINAL\n");
        } finally {
          await manager.cleanup();
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

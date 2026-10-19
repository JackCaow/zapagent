import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import type { LLMProvider } from "../../core/llm.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { WorkspaceManager } from "../../workspace/manager.js";

for (const coordinated of [false, true]) {
  for (const sandboxAvailable of [false, true]) {
    for (const workspaceBash of [false, true]) {
      test(`general shell disclosure: coordinated=${coordinated}, sandbox=${sandboxAvailable}, workspaceBash=${workspaceBash}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "zap-child-shell-"));
        const manager = new WorkspaceManager({ root });
        let calls = 0;
        let sandboxContexts = 0;
        const expectedBash = sandboxAvailable && workspaceBash;
        const provider: LLMProvider = {
          async call(messages, tools) {
            calls++;
            const system = messages.filter(message => message.role === "system")
              .map(message => message.content).join("\n");
            expect(tools?.some(tool => tool.name === "bash")).toBe(expectedBash);
            expect(tools?.some(tool => tool.name === "write_file")).toBe(true);
            expect(system).toContain("Preserve the host boundary.");
            expect(system).toContain(expectedBash
              ? "Shell access: bash requires the OS sandbox and remains subject to execution policy."
              : "Shell access: bash is unavailable in this isolated subagent.");
            if (!expectedBash) {
              expect(system).toContain("Report required builds, tests or diagnostics to the parent");
              expect(system).not.toContain("Shell commands are restricted by an OS sandbox to this workspace");
            }
            return { type: "text", text: "Capabilities inspected; no checks executed.", usage: { inputTokens: 1, outputTokens: 1 } };
          },
        };
        const registryFor = (cwd: string) => {
          const registry = createBuiltinRegistry({ executeCommand: { defaultCwd: cwd, disableBackgroundTasks: true } });
          if (!workspaceBash) registry.unregister("bash");
          return registry;
        };
        // Parent schemas need not match the rebuilt workspace registry.
        const registry = createBuiltinRegistry({ executeCommand: { defaultCwd: root, disableBackgroundTasks: true } });
        if (workspaceBash) registry.unregister("bash");
        const bridge = new DeferredAgentCoordinatorExecutor();
        const coordinator = new AgentCoordinator({ threadId: "synthetic-shell-capability", executor: bridge });
        const tool = subagentTool({
          provider, registry, workspaceManager: manager, createRegistryForCwd: registryFor,
          requireWriteIsolation: true, storageProjectCwd: root, maxSteps: 2,
          inheritedInstructions: "Preserve the host boundary.",
          executorOptions: { executionBroker: new DefaultExecutionBroker({
            sandboxMode: "required",
            sandbox: {
              status: () => ({ provider: "macos-seatbelt", available: sandboxAvailable }),
              createContext: () => { sandboxContexts++; throw new Error("No process should execute"); },
            },
          }) },
          ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}),
        });
        try {
          for (const custom of [false, true]) {
            const result = await tool.handler({ task: "Inspect available capabilities.", agent_type: "general",
              ...(custom ? { system_prompt: "Report capabilities." } : {}) });
            expect(result.success).toBe(true);
          }
          expect(tool.definition.description).toContain(sandboxAvailable
            ? "Isolated shell access: requires an OS sandbox and a workspace bash tool."
            : "Isolated shell access: unavailable (OS sandbox unavailable).");
          expect(calls).toBe(2);
          expect(sandboxContexts).toBe(0);
          expect(registry.has("bash")).toBe(!workspaceBash);
        } finally {
          await manager.cleanup();
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

test("legacy shared general agents retain parent shell capability without an isolation claim", async () => {
  const registry = createBuiltinRegistry({ executeCommand: { disableBackgroundTasks: true } });
  let calls = 0;
  const provider: LLMProvider = {
    async call(messages, tools) {
      calls++;
      expect(tools?.some(tool => tool.name === "bash")).toBe(true);
      expect(messages.filter(message => message.role === "system").map(message => message.content).join("\n"))
        .not.toContain("Shell commands are restricted by an OS sandbox to this workspace");
      return { type: "text", text: "No command executed.", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const tool = subagentTool({ provider, registry });
  expect(tool.definition.description).not.toContain("External paths are not shared");
  const result = await tool.handler({ task: "Inspect capabilities.", agent_type: "general" });
  expect(result.success).toBe(true);
  expect(calls).toBe(1);
});

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import type { LLMProvider } from "../../core/llm.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { privateGitWriteRoot } from "../../execution/workspace-runtime.js";
import { ToolExecutor } from "../../tools/executor.js";
import { WorkspaceManager } from "../../workspace/manager.js";
import { MergeCoordinator } from "../../merge/coordinator.js";

test("private Git metadata authority rejects root actors, redirects and unrelated directories", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-private-git-")));
  try {
    mkdirSync(join(root, "repo", "nested"), { recursive: true });
    mkdirSync(join(root, "repo", ".git"));
    mkdirSync(join(root, "other"));
    const privateGitDirectory = join(root, "repo", ".git");
    expect(privateGitWriteRoot({ root: join(root, "repo"), mode: "root", privateGitDirectory })).toBeUndefined();
    expect(privateGitWriteRoot({ root: join(root, "repo", "nested"), mode: "isolated-write", privateGitDirectory })).toBe(privateGitDirectory);
    expect(() => privateGitWriteRoot({ root: join(root, "other"), mode: "isolated-write", privateGitDirectory })).toThrow("standalone clone");
    rmSync(privateGitDirectory, { recursive: true });
    symlinkSync(join(root, "other"), privateGitDirectory, "junction");
    expect(() => privateGitWriteRoot({ root: join(root, "repo"), mode: "isolated-write", privateGitDirectory })).toThrow("standalone clone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const native = process.platform === "darwin" && createPlatformSandbox().status().available;
(native ? test : test.skip)("a real sandboxed writing Agent can stage its private clone without changing the parent index", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-agent-git-write-")));
  const manager = new WorkspaceManager({ root });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  try {
    git("init", "-q");
    writeFileSync(join(root, "note.txt"), "parent\n");
    git("add", "note.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const originalHead = git("rev-parse", "HEAD");
    let calls = 0;
    const provider: LLMProvider = {
      async call(messages) {
        if (++calls === 1) return { type: "tool_call", text: "", toolCalls: [{ id: "stage", name: "bash",
          arguments: { command: "printf 'child\\n' > note.txt && git add note.txt && git diff --cached --name-only"
            + ` && printf '#!/bin/sh\\ntouch ${root}/host-escape\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
            + " && git config core.fsmonitor .git/hooks/pre-commit" } }],
          usage: { inputTokens: 1, outputTokens: 1 } };
        const outputs = JSON.stringify(messages);
        expect(outputs).toContain("note.txt");
        expect(outputs).not.toContain("Operation not permitted");
        return { type: "text", text: "Staged private edit", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registryFor = (cwd: string) => createBuiltinRegistry({ executeCommand: { defaultCwd: cwd, disableBackgroundTasks: true } });
    const broker = new DefaultExecutionBroker({ sandboxMode: "required", sandbox: createPlatformSandbox() });
    // Root metadata remains protected even if Bash itself is approved.
    const rootExecutor = new ToolExecutor(registryFor(root), { cwd: root, onApproval: async () => true, executionBroker: broker });
    expect((await rootExecutor.execute("bash", { command: "git add note.txt" })).success).toBe(false);
    const child = subagentTool({ provider, registry: registryFor(root), workspaceManager: manager,
      createRegistryForCwd: registryFor, requireWriteIsolation: true, storageProjectCwd: root,
      executorOptions: { executionBroker: broker }, onApproval: async () => true, maxSteps: 3 });
    const result = await child.handler({ task: "Stage a private edit", agent_type: "general", thoroughness: "quick" });
    expect(result).toMatchObject({ success: true });
    expect(calls).toBe(2);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("parent\n");
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(git("rev-parse", "HEAD")).toBe(originalHead);
    expect(existsSync(join(root, "host-escape"))).toBe(false);
    const artifactId = (result.meta as { artifactId?: string } | undefined)?.artifactId;
    // The artifact is independently frozen; hostile private Git configuration
    // must not be consulted during finalization or later integration.
    expect(artifactId).toBeDefined();
    expect((await new MergeCoordinator(manager).merge([artifactId!])).success).toBe(true);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("child\n");
    expect(existsSync(join(root, "host-escape"))).toBe(false);
  } finally { await manager.cleanup(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { toolOutputTool } from "../../builtin-tools/tool-output.js";
import { readFileTool } from "../../builtin-tools/filesystem.js";
import { maybePersistToolResult } from "../../utils/tool-result-storage.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { LoopAgent } from "../../agent/loop.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import { buildHeadlessApproval } from "../../../src/headless/approval.js";
import type { LLMProvider } from "../../core/llm.js";

describe("session-scoped runtime output access", () => {
  let root: string;
  let cwd: string;
  let oldData: string | undefined;
  beforeEach(() => {
    oldData = process.env.ZAPCODE_DATA_DIR;
    root = mkdtempSync(join(tmpdir(), "zap-output-access-"));
    cwd = join(root, "project"); mkdirSync(cwd);
    process.env.ZAPCODE_DATA_DIR = join(root, "data");
  });
  afterEach(() => {
    if (oldData === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = oldData;
    rmSync(root, { recursive: true, force: true });
  });
  function persist(session: string, text = "😀".repeat(51_000) + "NEEDED_TAIL") {
    return maybePersistToolResult("fixture", session, "http_fetch", text, { projectCwd: cwd, force: true }).persistedPath!;
  }
  function executor(session: string, disallowedTools?: string[]) {
    const registry = new ToolRegistry();
    registry.register(toolOutputTool(session, cwd));
    registry.register(readFileTool({ defaultCwd: cwd }));
    return new ToolExecutor(registry, { cwd, onApproval: buildHeadlessApproval({ cwd, permissionMode: "default", disallowedTools }).onApproval });
  }
  test("recovers tail content and Unicode pages while ordinary outside reads remain denied", async () => {
    const path = persist("owner"); const exec = executor("owner");
    const denied = await exec.execute("read_file", { path });
    expect(denied.failure?.code).toBe("POLICY_DENIED");
    const page = await exec.execute("read_tool_output", { path, offset: 50_999, limit: 4 });
    expect(page.success).toBe(true);
    expect(JSON.parse(page.output)).toMatchObject({ content: "😀NEE", offset: 50_999, next_offset: 51_003 });
    const found = await exec.execute("read_tool_output", { path, search: "NEEDED_TAIL" });
    expect(JSON.parse(found.output)).toMatchObject({ content: "NEEDED_TAIL", offset: 51_000, next_offset: null, found: true });
    expect(JSON.parse((await exec.execute("read_tool_output", { path, search: "missing" })).output).found).toBe(false);
    expect(JSON.parse((await exec.execute("read_tool_output", { path, offset: 100_000 })).output).content).toBe("");
  });
  test("same saved session can reopen outputs but sibling, parent and arbitrary paths cannot", async () => {
    const own = persist("owner"); const sibling = persist("sibling"); const parent = persist("parent");
    const secret = join(root, "secret.txt"); writeFileSync(secret, "SECRET");
    const exec = executor("owner");
    expect((await exec.execute("read_tool_output", { path: own, search: "NEEDED_TAIL" })).success).toBe(true);
    for (const path of [sibling, parent, secret, `${dirname(own)}/../owner/fixture.txt`, dirname(own)]) {
      const result = await exec.execute("read_tool_output", { path });
      expect(result.success).toBe(false); expect(result.output).not.toContain("SECRET");
    }
    expect((await executor("owner").execute("read_tool_output", { path: own })).success).toBe(true);
  });
  test("rejects symlink files, hardlinks, and redirected storage directories", async () => {
    const own = persist("owner"); const secret = join(root, "secret.txt"); writeFileSync(secret, "SECRET");
    const exec = executor("owner");
    unlinkSync(own); symlinkSync(secret, own);
    expect((await exec.execute("read_tool_output", { path: own })).success).toBe(false);
    unlinkSync(own); linkSync(secret, own);
    expect((await exec.execute("read_tool_output", { path: own })).success).toBe(false);
    unlinkSync(own); writeFileSync(own, "original");
    const moved = `${dirname(own)}-moved`; renameSync(dirname(own), moved); symlinkSync(moved, dirname(own));
    expect((await exec.execute("read_tool_output", { path: own })).success).toBe(false);
  });
  test("explicit tool disallow and saved Read deny/ask rules remain authoritative", async () => {
    const path = persist("owner");
    expect((await executor("owner", ["read_tool_output"]).execute("read_tool_output", { path })).failure?.code).toBe("POLICY_DENIED");
    mkdirSync(join(cwd, ".zapcode"));
    for (const type of ["deny", "ask"]) {
      writeFileSync(join(cwd, ".zapcode/settings.json"), JSON.stringify({ rules: [{ type, pattern: "Read(**)" }] }));
      expect((await executor("owner").execute("read_tool_output", { path })).failure?.code).toBe("POLICY_DENIED");
    }
    let asked = 0;
    const registry = new ToolRegistry(); registry.register(toolOutputTool("owner", cwd));
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default", onAsk: async () => { asked++; return true; } });
    expect((await new ToolExecutor(registry, { onApproval: approval.onApproval }).execute("read_tool_output", { path })).success).toBe(true);
    expect(asked).toBe(1);
    const denied = new ToolExecutor(registry, { policyEngine: { evaluate: () => ({ decision: "deny", reason: "runtime output disabled" }) }, onApproval: approval.onApproval });
    expect((await denied.execute("read_tool_output", { path })).failure?.code).toBe("POLICY_DENIED");
    expect(asked).toBe(1);
  });
  for (const coordinated of [false, true]) test(`${coordinated ? "coordinated" : "direct"} explore child can recover its own long tool output`, async () => {
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "http_fetch", description: "synthetic fixture", parameters: z.object({}), permission: "auto" }, handler: async () => ({ success: true, output: "x".repeat(51_000) + "NEEDED_TAIL" }) });
    let calls = 0;
    const provider: LLMProvider = { async call(messages, tools) {
      calls++;
      expect(tools?.some(tool => tool.name === "read_tool_output")).toBe(true);
      if (calls === 1) return { type: "tool_call", usage: { inputTokens: 1, outputTokens: 1 }, text: "", toolCalls: [{ id: "large", name: "http_fetch", arguments: {} }] };
      const history = messages.filter(m => m.role === "tool_result").map(m => m.content).join("\n");
      if (calls === 2) {
        expect(history).toContain("Use read_tool_output");
        const path = history.match(/  path: ([^\n]+)/)![1]!;
        return { type: "tool_call", usage: { inputTokens: 1, outputTokens: 1 }, text: "", toolCalls: [{ id: "recover", name: "read_tool_output", arguments: { path, search: "NEEDED_TAIL" } }] };
      }
      expect(history).toContain('"content":"NEEDED_TAIL"');
      return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: "Recovered NEEDED_TAIL" };
    } };
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default" });
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "output-fixture", executor: bridge });
    registry.register(subagentTool({ provider, registry, storageProjectCwd: cwd, onApproval: approval.onApproval,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}) }));
    const result = await new ToolExecutor(registry).execute("agent", { agent_type: "explore", task: "Inspect the synthetic output." });
    expect(result.error).toBeUndefined(); expect(result.success).toBe(true); expect(result.output).toContain("Recovered NEEDED_TAIL");
    expect(calls).toBe(3); expect(approval.anyDenied()).toBe(false);
  });
  test("an inherited reader is rebound and cannot expose the parent's output", async () => {
    const parentPath = persist("parent");
    const registry = new ToolRegistry(); registry.register(toolOutputTool("parent", cwd));
    let calls = 0;
    const provider: LLMProvider = { async call(messages) {
      if (++calls === 1) return { type: "tool_call", text: "", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "read-parent", name: "read_tool_output", arguments: { path: parentPath } }] };
      expect(messages.filter(m => m.role === "tool_result").map(m => m.content).join("\n")).toContain("not owned by this agent session");
      return { type: "text", text: "Access denied as expected", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const approval = buildHeadlessApproval({ cwd, permissionMode: "default" });
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, { onApproval: approval.onApproval }), storageProjectCwd: cwd, storageSessionId: "child", maxSteps: 3 });
    await agent.run("Read the referenced output.");
    expect(calls).toBe(2);
  });
  test("output capability works in an isolated workspace without admitting external file reads", async () => {
    const path = persist("isolated");
    const registry = new ToolRegistry(); registry.register(toolOutputTool("isolated", cwd)); registry.register(readFileTool({ defaultCwd: cwd }));
    const exec = new ToolExecutor(registry, { cwd, workspace: { root: cwd, mode: "isolated-write" }, onApproval: buildHeadlessApproval({ cwd, permissionMode: "default" }).onApproval });
    expect((await exec.execute("read_tool_output", { path, search: "NEEDED_TAIL" })).success).toBe(true);
    expect((await exec.execute("read_file", { path })).failure?.code).toBe("POLICY_DENIED");
    expect((await exec.execute("read_tool_output", { path, offset: -1 })).failure?.code).toBe("INVALID_ARGUMENTS");
    expect((await exec.execute("read_tool_output", { path, limit: 8_001 })).failure?.code).toBe("INVALID_ARGUMENTS");
  });
  test("root registers its own reader without changing the caller's registry", () => {
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ provider: { async call() { return { type: "text", usage: { inputTokens: 1, outputTokens: 1 }, text: "done" }; } }, registry, executor: new ToolExecutor(registry), storageProjectCwd: cwd, storageSessionId: "root" });
    expect(agent.toolDefinitions().some(tool => tool.name === "read_tool_output")).toBe(true);
    expect(registry.has("read_tool_output")).toBe(false);
  });
});
